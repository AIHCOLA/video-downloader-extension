/**
 * AAC（ADTS）辅助工具：
 *  - 解析 ADTS 帧头（采样率 / 声道 / object type / 帧长）
 *  - 有状态的 ADTS 分帧器（跨 PES / 跨分片累积字节，输出裸 AAC 帧 + PTS）
 *  - 生成 AudioSpecificConfig（用于 MP4 的 esds）
 */

const ADTS_SAMPLE_RATES = [96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000, 7350];

/** 每帧 1024 个采样，在 90kHz 时钟下对应的 tick 数（1024/48000*90000 = 1920）。 */
export const AAC_FRAME_TICKS_90K = 1920;

/** 解析 offset 处的 ADTS 帧头；失败返回 null。 */
export function parseAdtsHeader(data, offset = 0) {
  if (!data || data.length - offset < 7) return null;
  if (data[offset] !== 0xff || (data[offset + 1] & 0xf0) !== 0xf0) return null;
  const protectionAbsent = data[offset + 1] & 0x01;
  const profile = (data[offset + 2] >> 6) & 0x03;
  const sampleRateIndex = (data[offset + 2] >> 2) & 0x0f;
  const channelConfig = ((data[offset + 2] & 0x01) << 2) | ((data[offset + 3] >> 6) & 0x03);
  const frameLength = ((data[offset + 3] & 0x03) << 11)
    | (data[offset + 4] << 3)
    | ((data[offset + 5] >> 5) & 0x07);
  const headerLength = protectionAbsent ? 7 : 9;
  if (sampleRateIndex >= ADTS_SAMPLE_RATES.length) return null;
  if (frameLength <= headerLength) return null;
  return {
    protectionAbsent: !!protectionAbsent,
    objectType: profile + 1, // AAC-LC = 2
    sampleRateIndex,
    sampleRate: ADTS_SAMPLE_RATES[sampleRateIndex],
    channels: channelConfig,
    headerLength,
    frameLength,
  };
}

/** 生成 AudioSpecificConfig（2 字节，适用于 AAC-LC / 标准采样率）。 */
export function buildAudioSpecificConfig(objectType, sampleRate, channels) {
  const sampleRateIndex = ADTS_SAMPLE_RATES.indexOf(sampleRate);
  if (sampleRateIndex < 0) {
    throw new Error(`不支持的 AAC 采样率：${sampleRate}`);
  }
  const aot = objectType || 2;
  const channelConfig = channels || 2;
  const b0 = ((aot & 0x1f) << 3) | ((sampleRateIndex >> 1) & 0x07);
  const b1 = ((sampleRateIndex & 0x01) << 7) | ((channelConfig & 0x0f) << 3);
  return new Uint8Array([b0, b1]);
}

/**
 * 有状态 ADTS 分帧器。
 * 输入 PES 载荷（可能从帧中间开始 / 结束），持续累积并输出完整裸 AAC 帧。
 * PTS 处理：每帧固定 1920 ticks；当缓冲区恰好为空（PES 起点正好是帧边界）时
 * 用 PES 自带 PTS 重新锚定，避免长时间漂移。
 */
export class AdtsFramer {
  constructor(onFrame) {
    this.onFrame = onFrame;
    this.buffer = new Uint8Array(0);
    this.nextPts90 = 0;
    this.lastPts90 = -1;
    this.frameCount = 0;
    this.droppedBytes = 0;
    this.config = null;
  }

  append(payload, pts90) {
    if (!payload || payload.length === 0) return;
    if (this.buffer.length === 0) {
      // 帧边界：用 PES 的 PTS 锚定（异常时退回恒帧率推进）
      if (this.lastPts90 < 0 || pts90 > this.lastPts90 + AAC_FRAME_TICKS_90K / 2) {
        this.nextPts90 = pts90;
      } else {
        this.nextPts90 = this.lastPts90 + AAC_FRAME_TICKS_90K;
      }
    }
    const merged = new Uint8Array(this.buffer.length + payload.length);
    merged.set(this.buffer, 0);
    merged.set(payload, this.buffer.length);
    this.buffer = merged;

    for (;;) {
      if (this.buffer.length < 7) break;
      if (!(this.buffer[0] === 0xff && (this.buffer[1] & 0xf0) === 0xf0)) {
        // 同步丢失：向后寻找下一个帧头
        let found = -1;
        for (let i = 1; i + 7 <= this.buffer.length; i++) {
          if (this.buffer[i] === 0xff && (this.buffer[i + 1] & 0xf0) === 0xf0) {
            found = i;
            break;
          }
        }
        if (found < 0) {
          const keep = Math.max(0, this.buffer.length - 1);
          this.droppedBytes += keep;
          this.buffer = this.buffer.slice(this.buffer.length - 1);
          break;
        }
        this.droppedBytes += found;
        this.buffer = this.buffer.slice(found);
      }
      const header = parseAdtsHeader(this.buffer, 0);
      if (!header) {
        this.droppedBytes += 1;
        this.buffer = this.buffer.slice(1);
        continue;
      }
      if (this.buffer.length < header.frameLength) break;
      if (!this.config) {
        this.config = {
          objectType: header.objectType,
          sampleRate: header.sampleRate,
          channels: header.channels,
        };
      }
      const data = this.buffer.subarray(header.headerLength, header.frameLength);
      const frame = {
        data,
        pts90: this.nextPts90,
        objectType: header.objectType,
        sampleRate: header.sampleRate,
        channels: header.channels,
      };
      this.lastPts90 = this.nextPts90;
      this.nextPts90 += AAC_FRAME_TICKS_90K;
      this.frameCount++;
      this.onFrame(frame);
      this.buffer = this.buffer.slice(header.frameLength);
    }
  }

  /** 结束：丢弃不完整的尾帧。 */
  flush() {
    if (this.buffer.length > 0) {
      this.droppedBytes += this.buffer.length;
      this.buffer = new Uint8Array(0);
    }
  }
}
