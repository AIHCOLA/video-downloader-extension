/**
 * MP4 封装（基于 lib/mp4-muxer.mjs，mp4-muxer 5.2.2）。
 *
 *  - fastStart: false（moov 在文件末尾，普通渐进式 MP4）
 *  - StreamTarget({ chunked: true, chunkSize: 4MiB }) + onData 串行 await output.write
 *  - 时间单位：微秒
 *  - 原始接口：addVideoChunkRaw / addAudioChunkRaw
 *  - 视频 ctts 采用 0 版本（无符号）；若遇到负的 pts-dts，clamp 到 0 并尽量维持 DTS 单调
 */

import { Muxer, StreamTarget } from '../../lib/mp4-muxer.mjs';
import { abortError } from './errors.mjs';

const AUDIO_FRAME_DURATION_US_FALLBACK = 1e6 / 48000 * 1024; // AAC 1024 采样

export class Mp4Sink {
  /**
   * @param {object} options
   * @param {number} options.width
   * @param {number} options.height
   * @param {Uint8Array} options.avcC
   * @param {Uint8Array|null} options.asc AudioSpecificConfig；为 null 表示无音频
   * @param {number} [options.sampleRate]
   * @param {number} [options.channels]
   * @param {(chunk: Uint8Array, position?: number) => Promise<void>|void} options.write
   * @param {boolean} [options.writeSupportsPosition] output.write 是否支持按文件偏移写入（第二个参数）
   * @param {AbortSignal} [options.signal]
   * @param {(level: string, message: string) => void} [options.onLog]
   */
  constructor(options) {
    this.signal = options.signal;
    this.write = options.write;
    this.onLog = options.onLog || (() => {});
    this.avcC = options.avcC;
    this.asc = options.asc || null;
    this.hasAudio = !!this.asc;
    this.writeSupportsPosition = !!options.writeSupportsPosition;
    this._aborted = false;
    this._queue = [];
    this._draining = null;
    this._writeError = null;
    this._drainWaiters = [];
    this._warnedCto = false;

    this.stats = {
      videoSamples: 0,
      audioSamples: 0,
      videoBytes: 0,
      audioBytes: 0,
      writtenBytes: 0,
      firstVideoDtsUs: null,
      lastVideoPtsUs: null,
      lastVideoDurUs: 0,
      firstAudioPtsUs: null,
      lastAudioPtsUs: null,
      lastAudioDurUs: 0,
    };
    this._lastVideoDecodeUs = -Infinity;

    const target = new StreamTarget({
      // 必须声明两个参数（data, position）：mp4-muxer 会校验参数个数
      onData: (data, position) => this._onData(data, position),
      chunked: true,
      chunkSize: 4 * 1024 * 1024,
    });
    // fastStart:false 会在 finalize 时回填文件开头 mdat 的大小（position≈28），
    // 只有支持按偏移写入的 output 才能正确落盘；否则退化为 fragmented MP4（顺序写安全）。
    const fastStart = this.writeSupportsPosition ? false : 'fragmented';
    this.fastStartMode = fastStart;
    const muxerOptions = {
      target,
      video: { codec: 'avc', width: options.width, height: options.height },
      firstTimestampBehavior: 'cross-track-offset',
      fastStart,
    };
    if (this.hasAudio) {
      muxerOptions.audio = {
        codec: 'aac',
        numberOfChannels: options.channels,
        sampleRate: options.sampleRate,
      };
    }
    this.muxer = new Muxer(muxerOptions);
    if (!this.writeSupportsPosition) {
      this.onLog('warn', '当前保存接口不支持随机位置写入（output.write 未提供 position 参数），已自动改用 fragmented MP4：文件可正常播放，但 moov 位于文件开头');
    }
    this.onLog('info', `MP4 封装模式：${fastStart === false ? '普通渐进式（moov 在文件末尾）' : '分片式（fragmented，moov 在文件开头）'}`);
  }

  _onData(data, position) {
    if (this._aborted || (this.signal && this.signal.aborted)) return;
    this._queue.push({ data, position });
    this._pump();
  }

  _pump() {
    if (this._draining) return;
    this._draining = (async () => {
      try {
        while (this._queue.length > 0) {
          if (this.signal && this.signal.aborted) {
            this._aborted = true;
            this._queue.length = 0;
            break;
          }
          const chunk = this._queue.shift();
          if (!chunk) continue;
          if (this.writeSupportsPosition) {
            await this.write(chunk.data, chunk.position);
          } else {
            await this.write(chunk.data);
          }
          this.stats.writtenBytes += chunk.data.length;
        }
      } catch (err) {
        this._writeError = err;
        this._queue.length = 0;
      } finally {
        this._draining = null;
        if (this._queue.length > 0 && !this._aborted && !this._writeError) {
          this._pump();
        } else {
          this._notifyDrained();
        }
      }
    })();
  }

  _notifyDrained() {
    const waiters = this._drainWaiters;
    this._drainWaiters = [];
    for (const resolve of waiters) resolve();
  }

  _waitDrained() {
    if (!this._draining && this._queue.length === 0) return Promise.resolve();
    return new Promise((resolve) => this._drainWaiters.push(resolve));
  }

  /** 外部取消：立即停止继续写盘。 */
  abort() {
    this._aborted = true;
    this._queue.length = 0;
    this._notifyDrained();
  }

  /**
   * 添加一个视频样本。
   * @param {{data: Uint8Array, isKey: boolean, ptsUs: number, dtsUs: number, durationUs: number}} sample
   */
  addVideo(sample) {
    if (this._aborted) return;
    const stats = this.stats;
    const { data, isKey } = sample;
    let ptsUs = sample.ptsUs;
    const durationUs = sample.durationUs;
    let dtsUs = sample.dtsUs;
    if (stats.firstVideoDtsUs === null) stats.firstVideoDtsUs = dtsUs;

    let compositionOffset = ptsUs - dtsUs;
    if (!(compositionOffset >= 0)) {
      if (!this._warnedCto) {
        this._warnedCto = true;
        this.onLog('warn', '检测到负的 pts-dts（B 帧），已 clamp 到 0 处理（该帧显示时间可能轻微偏移）');
      }
      compositionOffset = 0;
    }
    let decodeUs = ptsUs - compositionOffset;
    if (decodeUs < this._lastVideoDecodeUs) {
      // 修补非单调 DTS：优先压低 cto，必要时抬高显示时间
      const minDecode = this._lastVideoDecodeUs + 1;
      if (minDecode <= ptsUs) {
        compositionOffset = ptsUs - minDecode;
        decodeUs = minDecode;
      } else {
        if (!this._warnedCto) {
          this._warnedCto = true;
          this.onLog('warn', '检测到 DTS 非单调，已微调显示时间以维持时间轴单调');
        }
        // 退无可退：抬高这一帧的显示时间，保证 mp4-muxer 的 DTS 单调性
        ptsUs = minDecode;
        compositionOffset = 0;
        decodeUs = minDecode;
      }
    }
    this._lastVideoDecodeUs = decodeUs;

    this.muxer.addVideoChunkRaw(
      data,
      isKey ? 'key' : 'delta',
      ptsUs,
      durationUs,
      { decoderConfig: { codec: 'avc', description: this.avcC } },
      compositionOffset,
    );
    stats.videoSamples++;
    stats.videoBytes += data.length;
    stats.lastVideoPtsUs = ptsUs;
    stats.lastVideoDurUs = durationUs;
  }

  /**
   * 添加一个音频样本。
   * @param {{data: Uint8Array, ptsUs: number, durationUs: number}} sample
   */
  addAudio(sample) {
    if (this._aborted) return;
    if (!this.hasAudio) return;
    const stats = this.stats;
    if (stats.firstAudioPtsUs === null) stats.firstAudioPtsUs = sample.ptsUs;
    if (stats.lastAudioPtsUs !== null && sample.ptsUs <= stats.lastAudioPtsUs) return; // 丢弃非单调帧
    const durationUs = sample.durationUs || AUDIO_FRAME_DURATION_US_FALLBACK;
    this.muxer.addAudioChunkRaw(
      sample.data,
      'key',
      sample.ptsUs,
      durationUs,
      { decoderConfig: { codec: 'aac', description: this.asc } },
    );
    stats.audioSamples++;
    stats.audioBytes += sample.data.length;
    stats.lastAudioPtsUs = sample.ptsUs;
    stats.lastAudioDurUs = durationUs;
  }

  /** 输出文件的实际时长（秒），按 mp4-muxer 的时长算法：max(轨道最大 presentation + duration) - 基准。 */  get durationSeconds() {
    const stats = this.stats;
    let baseUs = Infinity;
    if (stats.firstVideoDtsUs !== null) baseUs = Math.min(baseUs, stats.firstVideoDtsUs);
    if (stats.firstAudioPtsUs !== null) baseUs = Math.min(baseUs, stats.firstAudioPtsUs);
    if (!Number.isFinite(baseUs)) return 0;
    let endUs = 0;
    if (stats.lastVideoPtsUs !== null) endUs = Math.max(endUs, stats.lastVideoPtsUs + stats.lastVideoDurUs);
    if (stats.lastAudioPtsUs !== null) endUs = Math.max(endUs, stats.lastAudioPtsUs + stats.lastAudioDurUs);
    return Math.max(0, (endUs - baseUs) / 1e6);
  }

  /** 完成写盘（调用 mp4-muxer finalize 并等待所有 output.write 结束）。 */
  async finalize() {
    if (this._aborted) throw abortError();
    if (this.signal && this.signal.aborted) throw abortError();
    this.muxer.finalize();
    await this._waitDrained();
    if (this._writeError) throw this._writeError;
    if (this._aborted || (this.signal && this.signal.aborted)) throw abortError();
  }
}
