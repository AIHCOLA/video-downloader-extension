/**
 * HLS TS → MP4 的流式装配管线。
 *
 * 职责：
 *  - 从解复用器送来的视频 AU / 音频帧中收集解码配置（SPS/PPS → avcC，ADTS → AudioSpecificConfig）
 *  - 首个关键帧确定输出起点 t0（分片边界对齐关键帧）
 *  - 边下边写：除「裁剪段」外，样本到达即喂给 mp4-muxer
 *  - 裁剪段：整段样本先缓存，再按目标时长挑选前缀（保证 H.264 解码依赖完整、时长精确）
 */

import { Mp4Sink } from './muxer-sink.mjs';
import { annexbToAvcc, buildAvcC, parseSps } from './h264.mjs';
import { buildAudioSpecificConfig, AAC_FRAME_TICKS_90K } from './aac.mjs';
import { hlsError } from './errors.mjs';

const TICKS_PER_SEC = 90000;
/** 90kHz 时间戳 → 微秒。 */
function ticksToUs(ticks) {
  return ticks * (1e6 / TICKS_PER_SEC);
}

export class Mp4Pipeline {
  /**
   * @param {object} options
   * @param {number} options.targetDurationSeconds 目标时长（秒）
   * @param {boolean} options.trim 是否在 cutSegmentIndex 内按目标时长裁剪
   * @param {number} options.cutSegmentIndex 裁剪所在分片索引
   * @param {number} options.startSegmentIndex 起始分片索引
   * @param {(chunk: Uint8Array) => Promise<void>|void} options.write
   * @param {AbortSignal} [options.signal]
   * @param {(level: string, message: string) => void} [options.onLog]
   */
  constructor(options) {
    this.targetTicks = Math.round((options.targetDurationSeconds || 0) * TICKS_PER_SEC);
    this.trim = !!options.trim;
    this.cutSegmentIndex = options.cutSegmentIndex;
    this.startSegmentIndex = options.startSegmentIndex;
    this.write = options.write;
    this.writeSupportsPosition = options.writeSupportsPosition;
    this.signal = options.signal;
    this.log = options.onLog || (() => {});

    this.t0Pts90 = null;
    this.firstVideoDts90 = null;
    this.firstAudioPts90 = null;
    this.sps = null;
    this.pps = null;
    this.avcC = null;
    this.width = 0;
    this.height = 0;
    this.audioAsc = null;
    this.sampleRate = 0;
    this.channels = 0;
    this.streamInfo = { hasVideo: false, hasAudio: false };

    this.currentSegment = -1;
    this.queue = [];
    this.sink = null;
    this.cutApplied = false;
    this.cutVideo = [];
    this.cutAudio = [];
    this.videoFrameDur90 = Math.round(TICKS_PER_SEC / 24);
    this.prevVideoDts90 = null;
    this._audioMissingWarned = false;
  }

  setStreamInfo(info) {
    this.streamInfo = { ...this.streamInfo, ...info };
  }

  startSegment(index) {
    this.currentSegment = index;
  }

  onVideoAu(au) {
    if (this.sink && this.sink._aborted) return;
    if (this.t0Pts90 === null) {
      if (!au.isKey) {
        this.log('warn', '起始分片的第一个视频帧不是关键帧，已跳过直到关键帧');
        return;
      }
      this.t0Pts90 = au.pts90;
      this.log('info', `MP4 起点对齐关键帧：PTS ${(au.pts90 / TICKS_PER_SEC).toFixed(3)}s`);
    }
    if (au.pts90 < this.t0Pts90) return;

    for (const nal of au.nals) {
      if (nal.type === 7) {
        if (!this.sps) this.sps = nal.data.slice();
      } else if (nal.type === 8) {
        if (!this.pps) this.pps = nal.data.slice();
      }
    }
    if (!this.avcC) {
      if (!this.sps || !this.pps) return; // 等 SPS/PPS
      try {
        this.avcC = buildAvcC(this.sps, this.pps);
        const parsed = parseSps(this.sps);
        this.width = parsed.width;
        this.height = parsed.height;
        this.log('info', `视频编码：H.264 ${this.width}x${this.height}（profile ${parsed.profileIdc}，level ${parsed.levelIdc / 10}）`);
      } catch (err) {
        throw hlsError(`解析 SPS/生成 avcC 失败：${err && err.message ? err.message : err}`, err);
      }
    }

    // 观察帧间隔（用于裁剪时长计算）
    if (this.prevVideoDts90 !== null) {
      const delta = au.dts90 - this.prevVideoDts90;
      if (delta > 0 && delta < TICKS_PER_SEC) this.videoFrameDur90 = delta;
    }
    this.prevVideoDts90 = au.dts90;

    if (this.trim && this.currentSegment === this.cutSegmentIndex) {
      this.cutVideo.push(au);
      return;
    }
    this._deliverVideo(au);
  }

  onAudioFrame(frame) {
    if (this.sink && this.sink._aborted) return;
    if (!this.audioAsc) {
      try {
        this.audioAsc = buildAudioSpecificConfig(frame.objectType, frame.sampleRate, frame.channels);
        this.sampleRate = frame.sampleRate;
        this.channels = frame.channels;
        this.log('info', `音频编码：AAC-LC ${this.sampleRate}Hz ${this.channels} 声道`);
      } catch (err) {
        this.log('warn', `AAC 配置解析失败：${err && err.message ? err.message : err}`);
        return;
      }
    }
    if (this.trim && this.currentSegment === this.cutSegmentIndex) {
      this.cutAudio.push(frame);
      return;
    }
    this._deliverAudio(frame);
  }

  _deliverVideo(au) {
    if (this.sink) {
      this._feedVideo(au);
      return;
    }
    this.queue.push({ kind: 'video', au });
    this._ensureSink();
  }

  _deliverAudio(frame) {
    if (this.sink) {
      this._feedAudio(frame);
      return;
    }
    this.queue.push({ kind: 'audio', frame });
    this._ensureSink();
  }

  _ensureSink(force = false) {
    if (this.sink) return;
    if (!this.avcC) {
      if (!force) return;
      throw hlsError('未能从 TS 中解析出 H.264 的 SPS/PPS，无法封装 MP4');
    }
    if (this.streamInfo.hasAudio && !this.audioAsc && !force) return;
    const withAudio = !!this.audioAsc;
    if (this.streamInfo.hasAudio && !withAudio && !this._audioMissingWarned) {
      this._audioMissingWarned = true;
      this.log('warn', '未获取到 AAC 音频配置，将按无音频 MP4 封装');
    }
    this.sink = new Mp4Sink({
      width: this.width,
      height: this.height,
      avcC: this.avcC,
      asc: withAudio ? this.audioAsc : null,
      sampleRate: this.sampleRate,
      channels: this.channels,
      write: this.write,
      writeSupportsPosition: this.writeSupportsPosition,
      signal: this.signal,
      onLog: this.log,
    });
    const queued = this.queue;
    this.queue = [];
    for (const item of queued) {
      if (item.kind === 'video') this._feedVideo(item.au);
      else this._feedAudio(item.frame);
    }
  }

  _feedVideo(au) {
    if (!this.sink) return;
    const data = annexbToAvcc(au.nals);
    if (!data) return;
    const ptsUs = ticksToUs(au.pts90);
    const dtsUs = ticksToUs(au.dts90);
    if (this.firstVideoDts90 === null) this.firstVideoDts90 = au.dts90;
    this.sink.addVideo({
      data,
      isKey: au.isKey,
      ptsUs,
      dtsUs,
      durationUs: ticksToUs(this.videoFrameDur90),
    });
  }

  _feedAudio(frame) {
    if (!this.sink) return;
    if (!this.sink.hasAudio) {
      if (!this._audioMissingWarned) {
        this._audioMissingWarned = true;
        this.log('warn', '音频轨道未启用，已丢弃 AAC 数据');
      }
      return;
    }
    const ptsUs = ticksToUs(frame.pts90);
    if (this.firstAudioPts90 === null) this.firstAudioPts90 = frame.pts90;
    this.sink.addAudio({
      data: frame.data,
      ptsUs,
      durationUs: ticksToUs(AAC_FRAME_TICKS_90K),
    });
  }

  /** 一个分片的数据已全部送进解复用器。 */
  endSegment(index) {
    if (!this.sink) this._ensureSink(true);
    if (this.trim && !this.cutApplied && index === this.cutSegmentIndex) {
      this._applyCut();
    }
  }

  _applyCut() {
    this.cutApplied = true;
    this._ensureSink(true);
    const video = this.cutVideo;
    if (video.length === 0) {
      this.log('warn', '裁剪分片内没有视频样本，已跳过尾部裁剪');
      for (const frame of this.cutAudio) this._feedAudio(frame);
      return;
    }
    const base90 = Math.min(
      this.firstVideoDts90 !== null ? this.firstVideoDts90 : video[0].dts90,
      this.firstAudioPts90 !== null ? this.firstAudioPts90 : (this.cutAudio.length > 0 ? this.cutAudio[0].pts90 : Infinity),
    );
    const wantEndTicks = this.targetTicks + (Number.isFinite(base90) ? base90 : 0);
    const frameDur = this.videoFrameDur90;
    let maxPts = -Infinity;
    let bestCount = 1;
    let bestDiff = Infinity;
    for (let i = 0; i < video.length; i++) {
      if (video[i].pts90 > maxPts) maxPts = video[i].pts90;
      const endTicks = maxPts + frameDur;
      const diff = Math.abs(endTicks - wantEndTicks);
      if (diff < bestDiff) {
        bestDiff = diff;
        bestCount = i + 1;
      }
    }
    const chosen = video.slice(0, bestCount);
    for (const au of chosen) this._feedVideo(au);
    const videoEndPts90 = Math.max(...chosen.map((au) => au.pts90)) + frameDur;
    for (const frame of this.cutAudio) {
      if (frame.pts90 < videoEndPts90) this._feedAudio(frame);
    }
    this.log('info', `MP4 裁剪：保留 ${chosen.length}/${video.length} 个视频帧，预计时长 ${((videoEndPts90 - base90) / TICKS_PER_SEC).toFixed(3)}s`);
  }

  /** 所有分片处理完毕；完成 MP4 封装。 */
  async finish() {
    if (!this.sink) this._ensureSink(true);
    if (this.trim && !this.cutApplied) this._applyCut();
    await this.sink.finalize();
  }

  abort() {
    if (this.sink) this.sink.abort();
  }

  get durationSeconds() {
    return this.sink ? this.sink.durationSeconds : 0;
  }

  get videoBytes() {
    return this.sink ? this.sink.stats.videoBytes : 0;
  }

  get audioBytes() {
    return this.sink ? this.sink.stats.audioBytes : 0;
  }

  /** moov 是否在文件开头（fragmented 降级模式为 true）。 */
  get moovFront() {
    return this.sink ? this.sink.fastStartMode === 'fragmented' : false;
  }
}
