/**
 * DASH 音视频合并（B 站 1080P 及以上必须走这条路）。
 *
 * 为什么要合并：B 站 durl 通道最高只给 720P，1080P 只在 DASH 通道里，
 * 而且视频轨（.m4s）与音频轨（.m4s）是分开的，必须拆样本、按时间交错、
 * 重新封装成一个 MP4。
 *
 * 数据流：Range 顺序读取 → fMP4 解析（moof/trun）→ mp4-muxer 流式写出，
 * 全程不把整部视频读进内存（只有当前 fragment 在内存里）。
 */

import { Muxer, StreamTarget } from '../../lib/mp4-muxer.mjs';
import { Fmp4Reader } from './fmp4.mjs';

const READ_BLOCK = 4 * 1024 * 1024;
const WRITE_CHUNK = 4 * 1024 * 1024;

/**
 * 把「按 Range 取字节」包装成顺序读取器（供 fMP4 解析使用）。
 * @param {(url:string, range:{start:number,end:number}, ctx:{signal?:AbortSignal}) => Promise<Uint8Array>} fetchRange
 */
export function createRangeSource(url, fetchRange, { signal, onBytes } = {}) {
  let buffer = new Uint8Array(0);
  let base = 0; // buffer 起点在文件中的绝对偏移
  let eof = false;

  async function ensure(n) {
    while (buffer.length < n && !eof) {
      if (signal && signal.aborted) {
        const err = new Error('已取消');
        err.name = 'AbortError';
        throw err;
      }
      const start = base + buffer.length;
      let chunk;
      try {
        chunk = await fetchRange(url, { start, end: start + READ_BLOCK - 1 }, { signal });
      } catch (err) {
        // 416 = 起点超出文件末尾，视为读完
        if (err && (err.status === 416 || /416/.test(String(err.message)))) {
          eof = true;
          break;
        }
        throw err;
      }
      if (!chunk || chunk.length === 0) {
        eof = true;
        break;
      }
      const merged = new Uint8Array(buffer.length + chunk.length);
      merged.set(buffer, 0);
      merged.set(chunk, buffer.length);
      buffer = merged;
      if (typeof onBytes === 'function') onBytes(chunk.length);
    }
    return buffer.length >= n;
  }

  return {
    async pull(n) {
      if (n === 0) return new Uint8Array(0);
      if (!(await ensure(n))) {
        if (buffer.length === 0) return null;
        const rest = buffer;
        buffer = new Uint8Array(0);
        base += rest.length;
        return rest;
      }
      const out = buffer.slice(0, n);
      buffer = buffer.subarray(n);
      base += n;
      return out;
    },
  };
}

function abortError() {
  const err = new Error('已取消');
  err.name = 'AbortError';
  return err;
}

/**
 * 合并 DASH 视频轨与音频轨，输出一个普通 MP4。
 *
 * @param {object} options
 * @param {{url:string}} options.video 视频轨
 * @param {{url:string}} options.audio 音频轨
 * @param {Function} options.fetchRange (url, range, ctx) => Uint8Array
 * @param {{write:(chunk:Uint8Array, position?:number)=>Promise<void>}} options.output
 * @param {AbortSignal} [options.signal]
 * @param {number} [options.totalBytes] 两条轨合计字节数（进度用）
 * @param {(p:object)=>void} [options.onProgress]
 * @param {(level:string,message:string)=>void} [options.onLog]
 */
export async function muxDashTracks(options) {
  const startedAt = Date.now();
  const { video, audio, fetchRange, output, signal } = options;
  const onLog = typeof options.onLog === 'function' ? options.onLog : () => {};
  const onProgress = typeof options.onProgress === 'function' ? options.onProgress : () => {};

  let loadedBytes = 0;
  let writtenBytes = 0;
  const totalBytes = Number(options.totalBytes) > 0 ? Number(options.totalBytes) : 0;
  let lastEmit = 0;

  const report = (phase, maxPercent = 99, force = false) => {
    const now = Date.now();
    if (!force && now - lastEmit < 200) return;
    lastEmit = now;
    const elapsed = Math.max(0.001, (now - startedAt) / 1000);
    const percent = totalBytes > 0 ? Math.min(maxPercent, (loadedBytes / totalBytes) * 100) : 0;
    const speed = loadedBytes / elapsed;
    const eta = totalBytes > 0 && speed > 0 ? Math.max(0, (totalBytes - loadedBytes) / speed) : null;
    try {
      onProgress({
        phase,
        percent,
        segmentsDone: totalBytes > 0 && loadedBytes >= totalBytes ? 1 : 0,
        segmentsTotal: 1,
        bytesDownloaded: loadedBytes,
        speedBps: Math.round(speed),
        etaSeconds: eta == null ? null : Math.round(eta * 10) / 10,
        message: phase === 'mux' ? '正在合并音视频' : '正在下载',
      });
    } catch {
      /* 忽略回调异常 */
    }
  };

  const onBytes = (n) => {
    loadedBytes += n;
    report('download');
  };

  const vSource = createRangeSource(video.url, fetchRange, { signal, onBytes });
  const aSource = createRangeSource(audio.url, fetchRange, { signal, onBytes });
  const vReader = new Fmp4Reader(vSource.pull);
  const aReader = new Fmp4Reader(aSource.pull);

  onLog('info', '正在读取视频轨初始化信息…');
  const vConf = await vReader.readInit();
  onLog('info', '正在读取音频轨初始化信息…');
  const aConf = await aReader.readInit();

  if (!vConf || vConf.kind !== 'video') throw new Error('视频轨初始化信息缺失');
  if (!aConf || aConf.kind !== 'audio') throw new Error('音频轨初始化信息缺失');
  if (!/^avc1|^avc3/i.test(vConf.codec)) {
    throw new Error(`视频轨编码为 ${vConf.codec}，当前只支持 H.264（AVC）合并`);
  }
  if (!vConf.description) throw new Error('视频轨缺少 avcC 配置');
  if (!aConf.description) throw new Error('音频轨缺少 AudioSpecificConfig 配置');

  // onData 是同步回调，写入必须串行排队，避免 FSA 并发写乱序
  let writeChain = Promise.resolve();
  const enqueueWrite = (data, position) => {
    writeChain = writeChain
      .then(() => output.write(data, position))
      .then(() => {
        writtenBytes += data.byteLength;
      });
  };

  const muxer = new Muxer({
    target: new StreamTarget({
      onData: enqueueWrite,
      chunked: true,
      chunkSize: WRITE_CHUNK,
    }),
    video: { codec: 'avc', width: vConf.width, height: vConf.height },
    audio: { codec: 'aac', sampleRate: aConf.sampleRate, numberOfChannels: aConf.channels },
    fastStart: false,
    // 两条轨统一基准偏移，保证音画同步（各自的第一个 DTS 可能不同）
    firstTimestampBehavior: 'cross-track-offset',
  });

  const vScale = 1e6 / vConf.timescale;
  const aScale = 1e6 / aConf.timescale;
  let videoSamples = 0;
  let audioSamples = 0;
  let videoBytes = 0;
  let audioBytes = 0;
  let durationUs = 0;
  let firstVideoMeta = true;
  let firstAudioMeta = true;

  const pushVideo = (fragment) => {
    let ticks = fragment.baseTime;
    for (const sample of fragment.samples) {
      // mp4-muxer 的 timestamp 是 PTS；DTS = PTS - cto，所以这里传 解码时间 + cto
      const compositionUs = Math.round(sample.cto * vScale);
      const timestamp = Math.round(ticks * vScale) + compositionUs;
      const duration = Math.max(1, Math.round(sample.duration * vScale));
      muxer.addVideoChunkRaw(
        sample.data,
        sample.isKey ? 'key' : 'delta',
        timestamp,
        duration,
        firstVideoMeta ? { decoderConfig: { description: vConf.description } } : undefined,
        compositionUs
      );
      firstVideoMeta = false;
      ticks += sample.duration;
      videoSamples += 1;
      videoBytes += sample.data.byteLength;
      durationUs = Math.max(durationUs, timestamp + duration);
    }
  };

  const pushAudio = (fragment) => {
    let ticks = fragment.baseTime;
    for (const sample of fragment.samples) {
      const timestamp = Math.round(ticks * aScale);
      const duration = Math.max(1, Math.round(sample.duration * aScale));
      muxer.addAudioChunkRaw(
        sample.data,
        'key',
        timestamp,
        duration,
        firstAudioMeta ? { decoderConfig: { description: aConf.description } } : undefined
      );
      firstAudioMeta = false;
      ticks += sample.duration;
      audioSamples += 1;
      audioBytes += sample.data.byteLength;
      durationUs = Math.max(durationUs, timestamp + duration);
    }
  };

  report('download', 99, true);
  onLog(
    'info',
    `开始合并：视频 ${vConf.width}x${vConf.height} ${vConf.codec}，音频 ${aConf.sampleRate}Hz ${aConf.channels}声道`
  );

  let vFragment = await vReader.nextFragment();
  let aFragment = await aReader.nextFragment();
  let guard = 0;

  while (vFragment) {
    if (signal && signal.aborted) throw abortError();
    guard += 1;
    if (guard > 100000) throw new Error('分片数量异常，已中止');
    const vStart = vFragment.baseTime * vScale;
    const vEnd = vStart + vFragment.samples.reduce((sum, s) => sum + s.duration, 0) * vScale;
    // 先把与这段视频时间重叠的音频写进去，保持交错顺序（播放器更友好）
    while (aFragment && aFragment.baseTime * aScale < vEnd) {
      pushAudio(aFragment);
      aFragment = await aReader.nextFragment();
    }
    pushVideo(vFragment);
    await writeChain; // 背压：每写一段就把积压的写入落盘
    report('download');
    vFragment = await vReader.nextFragment();
  }
  while (aFragment) {
    pushAudio(aFragment);
    aFragment = await aReader.nextFragment();
  }

  report('mux', 99, true);
  onLog('info', `样本交错完成：视频 ${videoSamples} 帧 / 音频 ${audioSamples} 帧，正在写出索引…`);
  muxer.finalize();
  await writeChain;

  const result = {
    durationSeconds: Math.round(durationUs / 1000) / 1000,
    width: vConf.width,
    height: vConf.height,
    sampleRate: aConf.sampleRate,
    channels: aConf.channels,
    videoBytes,
    audioBytes,
    bytes: writtenBytes,
    videoSamples,
    audioSamples,
    muxed: true,
    alreadyMuxed: false,
    moovFront: false,
    elapsedMs: Date.now() - startedAt,
  };
  try {
    onProgress({
      phase: 'done',
      percent: 100,
      segmentsDone: 1,
      segmentsTotal: 1,
      bytesDownloaded: loadedBytes,
      speedBps: 0,
      etaSeconds: 0,
      message: '合并完成',
    });
  } catch {
    /* 忽略 */
  }
  onLog('info', `合并完成：${result.durationSeconds.toFixed(2)}s，${result.width}x${result.height}，共 ${writtenBytes} 字节`);
  return result;
}
