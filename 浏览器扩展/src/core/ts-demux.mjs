/**
 * 有状态的 MPEG-TS 解复用器（流式）。
 *
 * 关键设计：**不按分片 flush**。解密后的 TS 字节按顺序 push 进来，内部维护：
 *   - 跨 push 的 TS 包残留字节（188 字节对齐）
 *   - 每个 PID 的 PES 重组缓冲（PES 可以跨越分片边界，下一个 PUSI 才结束）
 *   - H.264 访问单元（AU）组装状态（以 AUD 分隔，跨 PES 保持）
 *   - AAC ADTS 分帧状态（跨 PES / 跨分片累积）
 *
 * 输出回调：
 *   onVideoAu({ nals, pts90, dts90, isKey })
 *   onAudioFrame({ data, pts90, objectType, sampleRate, channels })
 *   onStreamInfo({ hasVideo, hasAudio, pmtPid, videoPid, audioPid })
 */

import { scanNalUnits, isVclNalType } from './h264.mjs';
import { AdtsFramer } from './aac.mjs';

const TS_PACKET_SIZE = 188;
const NAL_TYPE_AUD = 9;
const MAX_PES_SIZE = 8 * 1024 * 1024;

function readTimestamp(data, offset) {
  const b0 = data[offset];
  const b1 = data[offset + 1];
  const b2 = data[offset + 2];
  const b3 = data[offset + 3];
  const b4 = data[offset + 4];
  return ((b0 >> 1) & 0x07) * 1073741824
    + b1 * 4194304
    + ((b2 >> 1) & 0x7f) * 32768
    + b3 * 128
    + (b4 >> 1);
}

export class TsDemuxer {
  constructor(options = {}) {
    this.onVideoAu = options.onVideoAu || (() => {});
    this.onAudioFrame = options.onAudioFrame || (() => {});
    this.onStreamInfo = options.onStreamInfo || (() => {});
    this.onLog = options.onLog || (() => {});

    this._pending = new Uint8Array(0);
    this._pmtPid = -1;
    this._videoPid = -1;
    this._audioPid = -1;
    this._pes = new Map(); // pid -> { chunks: Uint8Array[], length: number }
    this._cc = new Map();
    this._curAu = null;
    this._warned = new Set();
    this._pmtAnnounced = false;
    this._patAnnounced = false;

    this._framer = new AdtsFramer((frame) => {
      try {
        this.onAudioFrame(frame);
      } catch (err) {
        this._warn('audio-cb', `音频帧处理异常：${err && err.message ? err.message : err}`);
      }
    });

    this.streamInfo = {
      hasVideo: false,
      hasAudio: false,
      pmtPid: -1,
      videoPid: -1,
      audioPid: -1,
    };
  }

  _warn(key, message) {
    if (this._warned.has(key)) return;
    this._warned.add(key);
    this.onLog('warn', message);
  }

  /** 输入任意长度的 TS 字节（解密后的明文）。 */
  push(bytes) {
    if (!bytes || bytes.length === 0) return;
    let buffer;
    if (this._pending.length > 0) {
      buffer = new Uint8Array(this._pending.length + bytes.length);
      buffer.set(this._pending, 0);
      buffer.set(bytes, this._pending.length);
    } else {
      buffer = bytes;
    }
    const total = buffer.length;
    let offset = 0;
    while (offset + TS_PACKET_SIZE <= total) {
      if (buffer[offset] !== 0x47) {
        const next = this._resync(buffer, offset);
        if (next < 0) {
          offset = total;
          break;
        }
        offset = next;
        continue;
      }
      this._parsePacket(buffer, offset);
      offset += TS_PACKET_SIZE;
    }
    this._pending = buffer.slice(offset);
  }

  _resync(buffer, from) {
    const total = buffer.length;
    for (let i = from + 1; i + TS_PACKET_SIZE <= total; i++) {
      if (buffer[i] !== 0x47) continue;
      if (i + TS_PACKET_SIZE * 2 > total || buffer[i + TS_PACKET_SIZE] === 0x47) {
        this._warn('sync', `TS 同步丢失，跳过 ${i - from} 个字节后重新同步`);
        return i;
      }
    }
    this._warn('sync-end', 'TS 同步丢失且无法重新同步，丢弃剩余字节');
    return -1;
  }

  _parsePacket(buffer, base) {
    const b1 = buffer[base + 1];
    if ((b1 & 0x80) !== 0) return; // transport_error_indicator
    const payloadUnitStart = (b1 & 0x40) !== 0;
    const pid = ((b1 & 0x1f) << 8) | buffer[base + 2];
    const b3 = buffer[base + 3];
    const adaptationFieldControl = (b3 >> 4) & 0x03;
    const continuityCounter = b3 & 0x0f;

    let p = base + 4;
    const end = base + TS_PACKET_SIZE;
    if (adaptationFieldControl === 2 || adaptationFieldControl === 3) {
      const afLength = buffer[p];
      if (afLength > 183) return;
      if (adaptationFieldControl === 2) return; // 只有自适应字段，无载荷
      p += 1 + afLength;
    } else if (adaptationFieldControl === 0) {
      return;
    }
    if (p >= end) return;
    const payload = buffer.subarray(p, end);

    if (pid === 0) {
      if (payloadUnitStart) this._parsePat(payload);
      return;
    }
    if (pid === this._pmtPid) {
      if (payloadUnitStart) this._parsePmt(payload);
      return;
    }
    if (pid !== this._videoPid && pid !== this._audioPid) return;

    const lastCc = this._cc.get(pid);
    if (lastCc !== undefined) {
      const expected = (lastCc + 1) & 0x0f;
      if (continuityCounter !== expected && continuityCounter !== lastCc) {
        this._warn(`cc-${pid}`, `TS 连续性计数不连续（PID 0x${pid.toString(16)}：${lastCc} → ${continuityCounter}），继续处理`);
      }
    }
    this._cc.set(pid, continuityCounter);

    if (payloadUnitStart) {
      this._flushPes(pid);
      this._pes.set(pid, { chunks: [payload], length: payload.length });
    } else {
      const record = this._pes.get(pid);
      if (!record) return;
      record.chunks.push(payload);
      record.length += payload.length;
      if (record.length > MAX_PES_SIZE) {
        this._warn(`pes-over-${pid}`, 'PES 数据异常过大，已丢弃');
        this._pes.delete(pid);
      }
    }
  }

  _parsePat(payload) {
    const pointer = payload[0];
    const section = payload.subarray(1 + pointer);
    if (section.length < 8 || section[0] !== 0x00) return;
    const sectionLength = ((section[1] & 0x0f) << 8) | section[2];
    const end = 3 + sectionLength - 4;
    let pmtPid = -1;
    for (let q = 8; q + 4 <= end; q += 4) {
      const programNumber = (section[q] << 8) | section[q + 1];
      const programPid = ((section[q + 2] & 0x1f) << 8) | section[q + 3];
      if (programNumber !== 0) {
        pmtPid = programPid;
        break;
      }
    }
    if (pmtPid >= 0 && pmtPid !== this._pmtPid) {
      this._pmtPid = pmtPid;
      if (!this._patAnnounced) {
        this._patAnnounced = true;
        this.onLog('info', `TS：PAT → PMT PID 0x${pmtPid.toString(16)}`);
      }
    }
  }

  _parsePmt(payload) {
    const pointer = payload[0];
    const section = payload.subarray(1 + pointer);
    if (section.length < 12 || section[0] !== 0x02) return;
    const sectionLength = ((section[1] & 0x0f) << 8) | section[2];
    const end = 3 + sectionLength - 4;
    const programInfoLength = ((section[10] & 0x0f) << 8) | section[11];
    let q = 12 + programInfoLength;
    let videoPid = -1;
    let audioPid = -1;
    while (q + 5 <= end) {
      const streamType = section[q];
      const elementaryPid = ((section[q + 1] & 0x1f) << 8) | section[q + 2];
      const esInfoLength = ((section[q + 3] & 0x0f) << 8) | section[q + 4];
      if (streamType === 0x1b && videoPid < 0) videoPid = elementaryPid;
      else if (streamType === 0x0f && audioPid < 0) audioPid = elementaryPid;
      q += 5 + esInfoLength;
    }
    const changed = videoPid !== this._videoPid || audioPid !== this._audioPid;
    this._videoPid = videoPid;
    this._audioPid = audioPid;
    this.streamInfo = {
      hasVideo: videoPid >= 0,
      hasAudio: audioPid >= 0,
      pmtPid: this._pmtPid,
      videoPid,
      audioPid,
    };
    if (changed || !this._pmtAnnounced) {
      this._pmtAnnounced = true;
      this.onLog('info', `TS：视频 PID 0x${videoPid.toString(16)}，音频 PID 0x${audioPid.toString(16)}`);
      try {
        this.onStreamInfo(this.streamInfo);
      } catch (err) {
        this._warn('streaminfo-cb', `流信息回调异常：${err && err.message ? err.message : err}`);
      }
    }
  }

  _flushPes(pid) {
    const record = this._pes.get(pid);
    this._pes.delete(pid);
    if (!record || record.length < 9) return;

    let data;
    if (record.chunks.length === 1) {
      data = record.chunks[0];
    } else {
      data = new Uint8Array(record.length);
      let offset = 0;
      for (const chunk of record.chunks) {
        data.set(chunk, offset);
        offset += chunk.length;
      }
    }
    if (data[0] !== 0x00 || data[1] !== 0x00 || data[2] !== 0x01) return;

    const pesPacketLength = (data[4] << 8) | data[5];
    if (pesPacketLength > 0) {
      const total = 6 + pesPacketLength;
      if (data.length > total) data = data.subarray(0, total);
    }
    if (data.length < 9) return;
    const flags = data[7];
    const headerLength = data[8];
    const payloadStart = 9 + headerLength;
    if (payloadStart > data.length) return;

    let pts = null;
    let dts = null;
    if ((flags & 0x80) !== 0 && data.length >= 14) pts = readTimestamp(data, 9);
    if ((flags & 0x40) !== 0 && data.length >= 19) dts = readTimestamp(data, 14);
    const payload = data.subarray(payloadStart);

    if (pid === this._videoPid) {
      if (pts === null) {
        this._warn('video-no-pts', '视频 PES 缺少 PTS，已跳过该数据');
        return;
      }
      this._onVideoPes(payload, pts, dts === null ? pts : dts);
    } else if (pid === this._audioPid) {
      if (pts === null) return;
      try {
        this._framer.append(payload, pts);
      } catch (err) {
        this._warn('audio-parse', `AAC 分帧异常：${err && err.message ? err.message : err}`);
      }
    }
  }

  _onVideoPes(payload, pts90, dts90) {
    const nals = scanNalUnits(payload);
    if (nals.length === 0) return;
    const hasAud = nals.some((nal) => nal.type === NAL_TYPE_AUD);
    if (hasAud) {
      for (const nal of nals) {
        if (nal.type === NAL_TYPE_AUD) {
          this._flushAu();
          this._curAu = { nals: [], pts90, dts90 };
        } else if (this._curAu) {
          this._curAu.nals.push(nal);
        } else {
          // PES 开头（AUD 之前）的 NAL：直接归入新 AU
          this._curAu = { nals: [nal], pts90, dts90 };
        }
      }
      return;
    }
    // 兜底：没有 AUD 时把整个 PES 当作一个访问单元
    this._warn('no-aud', '视频 PES 中没有 AUD，已按 PES 边界切分访问单元');
    this._flushAu();
    this._curAu = { nals, pts90, dts90 };
    this._flushAu();
  }

  _flushAu() {
    const au = this._curAu;
    this._curAu = null;
    if (!au || au.nals.length === 0) return;
    if (!au.nals.some((nal) => isVclNalType(nal.type))) return;
    const isKey = au.nals.some((nal) => nal.type === 5);
    try {
      this.onVideoAu({
        nals: au.nals,
        pts90: au.pts90,
        dts90: au.dts90,
        isKey,
      });
    } catch (err) {
      this._warn('video-cb', `视频访问单元处理异常：${err && err.message ? err.message : err}`);
    }
  }

  /** 输入结束：flush 所有未完成的 PES / AU / 音频帧。 */
  flush() {
    for (const pid of Array.from(this._pes.keys())) this._flushPes(pid);
    this._flushAu();
    this._framer.flush();
    if (this._framer.droppedBytes > 0) {
      this._warn('audio-drop', `AAC 分帧结束：丢弃不完整字节 ${this._framer.droppedBytes} 个`);
    }
  }

  get videoFrameCount() {
    return this._framer.frameCount;
  }
}
