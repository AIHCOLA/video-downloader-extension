/**
 * HLS 下载核心（纯前端，无本地服务、无远程代码）。
 *
 * 对外 API（与 CONTRACT §3 完全一致）：
 *   probePlaylist(url, options)  → 播放列表探测
 *   downloadHls(options)         → 流式下载 + 解密 + 解复用 + MP4/TS 输出
 *
 * 仅依赖标准 Web API：fetch / AbortController / WebCrypto / TextDecoder / URL，
 * 以及 vendored 的 lib/mp4-muxer.mjs。
 */

import { fetchText } from './http.mjs';
import { parseMasterPlaylist, parseMediaPlaylist, isMasterPlaylist } from './m3u8.mjs';
import { abortError, hlsError, throwIfAborted, isAbortError } from './errors.mjs';
import { Aes128KeyStore } from './crypto-aes.mjs';
import { TsDemuxer } from './ts-demux.mjs';
import { Mp4Pipeline } from './pipeline.mjs';
import { fetchBytes } from './http.mjs';

const DEFAULT_CONCURRENCY = 16;
const DEFAULT_TIMEOUT_MS = 30000;
const DEFAULT_RETRIES = 4;
const PLAYLIST_TIMEOUT_MS = 30000;
const PLAYLIST_RETRIES = 2;
const OOM_CONCURRENCY_CAP = 64;

function clampInt(value, min, max, fallback) {
  if (value === undefined || value === null || value === '') return fallback;
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, Math.round(number)));
}

function round(value, digits = 3) {
  if (!Number.isFinite(value)) return 0;
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function makeLogger(onLog) {
  return (level, message) => {
    if (typeof onLog !== 'function') return;
    try {
      onLog(level, message);
    } catch {
      /* 忽略日志回调异常 */
    }
  };
}

/** 加载播放列表（自动识别 master，选最高 BANDWIDTH）。 */
async function loadPlaylist(url, context) {
  const { signal, onLog, timeoutMs, retries } = context;
  const text = await fetchText(url, { signal, timeoutMs, retries, onLog, label: '播放列表' });
  if (isMasterPlaylist(text)) {
    const master = parseMasterPlaylist(text, url);
    if (master.variants.length === 0) {
      throw hlsError('主播放列表中没有可用的清晰度（#EXT-X-STREAM-INF 为空）');
    }
    let selected = master.variants[0];
    for (const variant of master.variants) {
      if (variant.bandwidth > selected.bandwidth) selected = variant;
    }
    onLog('info', `主播放列表：${master.variants.length} 个清晰度，已选择最高带宽 ${Math.round(selected.bandwidth / 1000)} kbps${selected.resolution ? `（${selected.resolution}）` : ''}`);
    const mediaText = await fetchText(selected.url, { signal, timeoutMs, retries, onLog, label: '媒体播放列表' });
    const media = parseMediaPlaylist(mediaText, selected.url);
    return { isMaster: true, variants: master.variants, selectedUrl: selected.url, media };
  }
  const media = parseMediaPlaylist(text, url);
  return { isMaster: false, variants: [], selectedUrl: url, media };
}

/**
 * 探测播放列表信息。
 * @param {string} url
 * @param {{signal?: AbortSignal, onLog?: (level: 'info'|'warn'|'error', message: string) => void}} options
 */
export async function probePlaylist(url, options = {}) {
  if (!url || typeof url !== 'string') throw hlsError('缺少播放列表地址（url）');
  const signal = options.signal;
  const onLog = makeLogger(options.onLog);
  try {
    const loaded = await loadPlaylist(url, {
      signal,
      onLog,
      timeoutMs: PLAYLIST_TIMEOUT_MS,
      retries: PLAYLIST_RETRIES,
    });
    const media = loaded.media;
    for (const warning of media.warnings) onLog('warn', warning);
    onLog('info', `播放列表解析完成：${media.segments.length} 个分片，总时长 ${media.totalDuration.toFixed(3)} 秒${media.encryptionMethods.length > 0 ? `，加密方式 ${media.encryptionMethods.join('/')}` : '，未加密'}`);
    return {
      url,
      finalUrl: url,
      isMaster: loaded.isMaster,
      variants: loaded.variants.map((variant) => ({
        bandwidth: variant.bandwidth,
        resolution: variant.resolution,
        url: variant.url,
      })),
      selectedUrl: loaded.selectedUrl,
      segments: media.segments.length,
      durationSeconds: round(media.totalDuration, 3),
      targetDuration: media.targetDuration,
      encrypted: media.encryptionMethods.length > 0,
      encryptionMethods: media.encryptionMethods.slice(),
      isLive: media.isLive,
    };
  } catch (err) {
    if (isAbortError(err) || (signal && signal.aborted)) throw abortError();
    throw err;
  }
}

/** 按顺序读取分片（并发下载 + 窗口限流 + 失败重试 + 解密）。 */
function createSegmentReader(context) {
  const {
    segments,
    firstIndex,
    lastIndex,
    concurrency,
    signal,
    timeoutMs,
    retries,
    onLog,
    keyStore,
    onSegmentFetched,
  } = context;
  const pending = new Map(); // index -> Promise<{ok, bytes?, error?}>
  const maxAhead = Math.max(concurrency * 2, 4);
  let nextSchedule = firstIndex;
  let expected = firstIndex;
  let active = 0;
  let started = false;

  async function fetchAndDecrypt(index) {
    const segment = segments[index];
    throwIfAborted(signal);
    const encrypted = await fetchBytes(segment.url, {
      signal,
      timeoutMs,
      retries,
      onLog,
      label: `分片 ${index + 1}/${segments.length}`,
    });
    throwIfAborted(signal);
    let plain = encrypted;
    if (segment.key) {
      plain = await keyStore.decryptSegment(segment, encrypted, { signal, timeoutMs, retries, onLog });
    }
    onSegmentFetched(index, encrypted.length);
    return plain;
  }

  function fill() {
    while (
      active < concurrency
      && nextSchedule <= lastIndex
      && nextSchedule - expected < maxAhead
    ) {
      const index = nextSchedule++;
      active++;
      const promise = (async () => {
        try {
          return { ok: true, bytes: await fetchAndDecrypt(index) };
        } catch (error) {
          return { ok: false, error };
        } finally {
          active--;
          fill();
        }
      })();
      pending.set(index, promise);
    }
  }

  fill();
  started = true;
  return {
    total: lastIndex - firstIndex + 1,
    async read(index) {
      throwIfAborted(signal);
      if (index !== expected) throw hlsError('内部错误：分片读取顺序错误');
      const promise = pending.get(index);
      if (!promise) throw hlsError('内部错误：分片未被调度');
      const result = await promise;
      pending.delete(index);
      expected = index + 1;
      fill();
      if (!result.ok) throw result.error;
      return result.bytes;
    },
  };
}

/**
 * 下载 HLS 流。
 * @param {object} options 见 CONTRACT §3.2
 */
export async function downloadHls(options = {}) {
  const startedAt = Date.now();
  const playlistUrl = options.playlistUrl;
  if (!playlistUrl || typeof playlistUrl !== 'string') throw hlsError('缺少 playlistUrl 参数');
  const output = options.output;
  if (!output || typeof output.write !== 'function') throw hlsError('缺少 output.write（用于写出文件数据）');
  if (output.type !== undefined && output.type !== 'mp4' && output.type !== 'ts') {
    throw hlsError(`不支持的输出格式：${output.type}（仅支持 mp4 / ts）`);
  }
  const type = output.type === 'ts' ? 'ts' : 'mp4';
  const concurrency = clampInt(options.concurrency, 1, OOM_CONCURRENCY_CAP, DEFAULT_CONCURRENCY);
  const timeoutMs = clampInt(options.timeoutMs, 1000, 300000, DEFAULT_TIMEOUT_MS);
  const retries = clampInt(options.retries, 0, 10, DEFAULT_RETRIES);
  const signal = options.signal;
  const onLog = makeLogger(options.onLog);
  const onProgress = options.onProgress;
  // output.supportsPosition === true 时，write 允许第二参数 position（覆盖写入绝对偏移），
  // MP4 才能使用 fastStart:false（普通渐进式，moov 在末尾）；
  // 否则（旧 shell / 无该标记）自动降级为 fragmented MP4（顺序写安全，moov 在文件开头）。
  const writeSupportsPosition = output.supportsPosition === true;
  const writeFn = output.write.bind(output);

  const startSec = options.start === undefined || options.start === null ? null : Number(options.start);
  const endSec = options.end === undefined || options.end === null ? null : Number(options.end);
  if (startSec !== null && (!Number.isFinite(startSec) || startSec < 0)) {
    throw hlsError('start 必须是不小于 0 的数字');
  }
  if (endSec !== null && (!Number.isFinite(endSec) || endSec <= 0)) {
    throw hlsError('end 必须是大于 0 的数字');
  }
  if (startSec !== null && endSec !== null && endSec <= startSec) {
    throw hlsError('end 必须大于 start');
  }

  const progressState = {
    phase: 'playlist',
    segmentsDone: 0,
    segmentsTotal: 0,
    bytesDownloaded: 0,
  };
  let lastEmitAt = 0;
  let lastMessage = '';
  function emitProgress(partial = {}, force = false, message = '') {
    Object.assign(progressState, partial);
    if (message) lastMessage = message;
    const now = Date.now();
    if (!force && now - lastEmitAt < 200) return;
    lastEmitAt = now;
    const elapsedSeconds = Math.max(0.001, (now - startedAt) / 1000);
    const done = progressState.segmentsDone;
    const total = progressState.segmentsTotal;
    const speed = done > 0 ? progressState.bytesDownloaded / elapsedSeconds : 0;
    const averageBytes = done > 0 ? progressState.bytesDownloaded / done : 0;
    const remainingBytes = total > done ? (total - done) * averageBytes : 0;
    let etaSeconds = null;
    if (remainingBytes > 0 && speed > 0) etaSeconds = round(remainingBytes / speed, 1);
    else if (total > 0 && done >= total) etaSeconds = 0;
    let percent = 0;
    if (progressState.phase === 'done') percent = 100;
    else if (progressState.phase === 'mux') percent = Math.max(99, total > 0 ? Math.min(99, done / total * 100) : 0);
    else if (progressState.phase === 'download') percent = total > 0 ? Math.min(99, done / total * 100) : 0;
    if (typeof onProgress === 'function') {
      try {
        onProgress({
          phase: progressState.phase,
          percent: round(percent, 2),
          segmentsDone: done,
          segmentsTotal: total,
          bytesDownloaded: progressState.bytesDownloaded,
          speedBps: Math.round(speed),
          etaSeconds,
          message: lastMessage,
        });
      } catch {
        /* 忽略进度回调异常 */
      }
    }
  }

  const keyStore = new Aes128KeyStore();
  let pipeline = null;

  try {
    throwIfAborted(signal);
    emitProgress({ phase: 'playlist' }, true, '正在解析播放列表');

    const loaded = await loadPlaylist(playlistUrl, {
      signal,
      onLog,
      timeoutMs: PLAYLIST_TIMEOUT_MS,
      retries: PLAYLIST_RETRIES,
    });
    const media = loaded.media;
    for (const warning of media.warnings) onLog('warn', warning);
    if (media.isLive) onLog('warn', '检测到直播播放列表（缺少 #EXT-X-ENDLIST），将仅下载当前已有分片');
    if (media.segments.length === 0) throw hlsError('播放列表中没有可下载的分片');

    const unsupportedMethods = media.encryptionMethods.filter((method) => method !== 'AES-128' && method !== 'NONE');
    if (unsupportedMethods.length > 0) {
      throw hlsError(`不支持的加密方式：${unsupportedMethods.join('、')}（当前仅支持 AES-128 与不加密）`);
    }
    const totalDuration = media.totalDuration;
    const segments = media.segments;
    onLog('info', `播放列表：${segments.length} 个分片，总时长 ${totalDuration.toFixed(3)} 秒${media.encryptionMethods.length > 0 ? `，加密方式 ${media.encryptionMethods.join('/')}` : '，未加密'}`);

    let clampedStart = startSec;
    let clampedEnd = endSec;
    if (clampedStart !== null && clampedStart > totalDuration + 1e-6) {
      throw hlsError(`start=${clampedStart}s 超出播放列表总时长 ${totalDuration.toFixed(3)}s`);
    }
    if (clampedEnd !== null && clampedEnd > totalDuration) {
      onLog('warn', `end=${clampedEnd}s 超出播放列表总时长，已按 ${totalDuration.toFixed(3)}s 处理`);
      clampedEnd = totalDuration;
    }

    const onSegmentFetched = (index, bytesLength) => {
      progressState.segmentsDone += 1;
      progressState.bytesDownloaded += bytesLength;
      emitProgress({}, false, '正在下载分片');
    };

    const readerContext = {
      segments,
      concurrency,
      signal,
      timeoutMs,
      retries,
      onLog,
      keyStore,
      onSegmentFetched,
    };

    // ---------------- TS 输出 ----------------
    if (type === 'ts') {
      const rangeStart = clampedStart ?? 0;
      const rangeEnd = clampedEnd ?? totalDuration;
      let firstIndex = segments.findIndex((segment) => segment.endTime > rangeStart + 1e-6);
      if (firstIndex < 0) firstIndex = segments.length - 1;
      let lastIndex = -1;
      for (let i = segments.length - 1; i >= 0; i--) {
        if (segments[i].startTime < rangeEnd - 1e-6) {
          lastIndex = i;
          break;
        }
      }
      if (lastIndex < 0) lastIndex = firstIndex;
      if (lastIndex < firstIndex) lastIndex = firstIndex;

      const reader = createSegmentReader({ ...readerContext, firstIndex, lastIndex });
      emitProgress({
        phase: 'download',
        segmentsTotal: reader.total,
        segmentsDone: 0,
        bytesDownloaded: 0,
      }, true, '开始下载分片（TS 输出）');
      onLog('info', `TS 输出：分片 #${firstIndex} ~ #${lastIndex}，共 ${reader.total} 个`);

      let written = 0;
      let writtenDuration = 0;
      for (let index = firstIndex; index <= lastIndex; index++) {
        const bytes = await reader.read(index);
        throwIfAborted(signal);
        await output.write(bytes);
        written++;
        writtenDuration += segments[index].duration;
      }
      emitProgress({ phase: 'done', segmentsDone: written }, true, '下载完成');
      return {
        durationSeconds: round(writtenDuration, 3),
        segments: written,
        videoBytes: 0,
        audioBytes: 0,
        muxed: false,
        moovFront: false,
        elapsedMs: Date.now() - startedAt,
        width: 0,
        height: 0,
        sampleRate: 0,
        channels: 0,
      };
    }

    // ---------------- MP4 输出 ----------------
    const startEff = clampedStart ?? 0;
    let startIndex = 0;
    let snappedStart = 0;
    if (clampedStart !== null) {
      let best = 0;
      let bestDiff = Infinity;
      for (let i = 0; i < segments.length; i++) {
        const diff = Math.abs(segments[i].startTime - clampedStart);
        if (diff < bestDiff - 1e-9) {
          bestDiff = diff;
          best = i;
        }
      }
      startIndex = best;
      snappedStart = segments[best].startTime;
    }
    const targetDuration = clampedEnd !== null
      ? clampedEnd - startEff
      : totalDuration - snappedStart;
    if (!(targetDuration > 0.001)) throw hlsError('裁剪区间为空：请确认 end 大于 start');
    const cutContent = snappedStart + targetDuration;
    const trim = cutContent < totalDuration - 1e-6;
    let cutIndex = segments.length - 1;
    if (trim) {
      cutIndex = segments.length - 1;
      for (let i = startIndex; i < segments.length; i++) {
        if (segments[i].startTime + segments[i].duration > cutContent) {
          cutIndex = i;
          break;
        }
      }
    }
    if (cutIndex < startIndex) cutIndex = startIndex;
    if (startIndex > 0) {
      onLog('info', `起点对齐关键帧：start=${startEff}s → 分片 #${startIndex}（${snappedStart.toFixed(3)}s 起）`);
    }
    onLog('info', `MP4 输出：分片 #${startIndex} ~ #${cutIndex}（目标时长 ${targetDuration.toFixed(3)}s${trim ? '，尾部分片按时间戳裁剪' : ''}）`);

    const reader = createSegmentReader({ ...readerContext, firstIndex: startIndex, lastIndex: cutIndex });
    emitProgress({
      phase: 'download',
      segmentsTotal: reader.total,
      segmentsDone: 0,
      bytesDownloaded: 0,
    }, true, '开始下载分片（MP4 输出）');

    pipeline = new Mp4Pipeline({
      targetDurationSeconds: targetDuration,
      trim,
      cutSegmentIndex: cutIndex,
      startSegmentIndex: startIndex,
      write: writeFn,
      writeSupportsPosition,
      signal,
      onLog,
    });
    const demuxer = new TsDemuxer({
      onVideoAu: (au) => pipeline.onVideoAu(au),
      onAudioFrame: (frame) => pipeline.onAudioFrame(frame),
      onStreamInfo: (info) => pipeline.setStreamInfo(info),
      onLog,
    });

    for (let index = startIndex; index <= cutIndex; index++) {
      const bytes = await reader.read(index);
      throwIfAborted(signal);
      pipeline.startSegment(index);
      demuxer.push(bytes);
      if (index === startIndex && startIndex !== cutIndex) {
        // 首个分片结束：确保 MP4 封装器尽早创建，后续分片继续流式写入
        pipeline.endSegment(index);
      }
    }
    demuxer.flush();
    pipeline.endSegment(cutIndex);

    emitProgress({ phase: 'mux', segmentsDone: reader.total }, true, '正在完成 MP4 封装');
    await pipeline.finish();
    const result = {
      durationSeconds: round(pipeline.durationSeconds, 3),
      segments: reader.total,
      videoBytes: pipeline.videoBytes,
      audioBytes: pipeline.audioBytes,
      muxed: true,
      moovFront: pipeline.moovFront,
      elapsedMs: Date.now() - startedAt,
      width: pipeline.width,
      height: pipeline.height,
      sampleRate: pipeline.sampleRate,
      channels: pipeline.channels,
    };
    emitProgress({ phase: 'done', segmentsDone: reader.total }, true, '下载完成');
    onLog('info', `MP4 完成：时长 ${result.durationSeconds}s，${result.width}x${result.height}，视频 ${result.videoBytes} 字节 / 音频 ${result.audioBytes} 字节，moov ${result.moovFront ? '在文件开头（fragmented）' : '在文件末尾（渐进式）'}`);
    return result;
  } catch (err) {
    if (isAbortError(err) || (signal && signal.aborted)) {
      try {
        if (pipeline) pipeline.abort();
      } catch {
        /* ignore */
      }
      throw abortError();
    }
    if (err instanceof Error) throw err;
    throw hlsError(String(err));
  }
}
