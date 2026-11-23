/**
 * fMP4（分片 MP4）解析器 —— 只做 B 站 DASH 轨道需要的那部分。
 *
 * B 站的 DASH 轨道长这样（.m4s，单轨）：
 *   ftyp | moov | sidx | [ moof | mdat ]*
 * 其中 moov 只有一条 trak（avc1 视频或 mp4a 音频），每个 moof/traf 描述紧跟其后的
 * mdat 里的一批样本。要合并音视频，就得把每个样本（H.264 访问单元 / AAC 帧）
 * 连同时间戳拆出来，再交给 mp4-muxer 重新封装。
 *
 * 不依赖 DOM / chrome.* / fetch / Node Buffer：读取通过 `pull(n)` 注入，
 * 因此可以用真实文件在 Node 里跑单测，也能直接在扩展页里跑。
 */

/** 轻量字节包装：浏览器与 Node 通用（不依赖 Buffer） */
export class ByteBuf {
  constructor(bytes) {
    this.bytes = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    this.view = new DataView(this.bytes.buffer, this.bytes.byteOffset, this.bytes.byteLength);
    this.length = this.bytes.length;
  }

  readUInt32BE(offset) {
    return this.view.getUint32(offset, false);
  }

  readInt32BE(offset) {
    return this.view.getInt32(offset, false);
  }

  readUInt16BE(offset) {
    return this.view.getUint16(offset, false);
  }

  readBigUInt64BE(offset) {
    return Number(this.view.getBigUint64(offset, false));
  }

  at(offset) {
    return this.bytes[offset];
  }

  ascii(start, end) {
    let out = '';
    for (let i = start; i < end && i < this.length; i += 1) out += String.fromCharCode(this.bytes[i]);
    return out;
  }

  slice(start, end) {
    return this.bytes.slice(start, end);
  }
}

function asBuf(value) {
  return value instanceof ByteBuf ? value : new ByteBuf(value);
}

/** 取 box 头：{type, size, headerSize, bodyStart, end}；数据不足返回 null */
export function parseBoxHeader(input, offset = 0) {
  const buf = asBuf(input);
  if (offset + 8 > buf.length) return null;
  let size = buf.readUInt32BE(offset);
  const type = buf.ascii(offset + 4, offset + 8);
  let headerSize = 8;
  if (size === 1) {
    if (offset + 16 > buf.length) return null;
    size = buf.readBigUInt64BE(offset + 8);
    headerSize = 16;
  } else if (size === 0) {
    size = buf.length - offset;
  }
  if (size < headerSize) return null;
  return { type, size, headerSize, bodyStart: offset + headerSize, end: offset + size };
}

/** 在 [start, end) 里按类型找第一个子 box */
export function findBox(input, start, end, type) {
  const buf = asBuf(input);
  let offset = start;
  while (offset + 8 <= end) {
    const box = parseBoxHeader(buf, offset);
    if (!box || box.end > end) return null;
    if (box.type === type) return box;
    offset = box.end;
  }
  return null;
}

/** 解析 esds，取出 AAC 的 AudioSpecificConfig（tag 0x05） */
export function extractAudioSpecificConfig(input, start, end) {
  const buf = asBuf(input);
  let p = start;
  const readDescriptor = () => {
    if (p >= end) return null;
    const tag = buf.at(p);
    p += 1;
    let length = 0;
    let bytesRead = 0;
    while (bytesRead < 4 && p < end) {
      const byte = buf.at(p);
      p += 1;
      bytesRead += 1;
      length = (length << 7) | (byte & 0x7f);
      if (!(byte & 0x80)) break;
    }
    return { tag, length, start: p };
  };
  // esds: version(1) + flags(3) 之后是 ES_Descriptor
  p = start + 4;
  const es = readDescriptor();
  if (!es || es.tag !== 0x03) return null;
  p = es.start + 2;
  const flags = buf.at(p);
  p += 1;
  if (flags & 0x80) p += 2;
  if (flags & 0x40) {
    const urlLen = buf.at(p);
    p += 1 + urlLen;
  }
  if (flags & 0x20) p += 2;
  const dcd = readDescriptor();
  if (!dcd || dcd.tag !== 0x04) return null;
  // DecoderConfigDescriptor: objectType(1)+streamType(1)+bufferSize(4)+maxBitrate(4)+avgBitrate(4)
  p = dcd.start + 13;
  const dsi = readDescriptor();
  if (!dsi || dsi.tag !== 0x05) return null;
  return buf.slice(dsi.start, dsi.start + dsi.length);
}

/**
 * 从 moov 解析轨道配置。
 * @returns {null | {kind:'video'|'audio', trackId:number, timescale:number, codec:string,
 *   description:Uint8Array|null, width:number, height:number, sampleRate:number, channels:number}}
 */
export function extractTrackConfig(input, moovBodyStart = 8) {
  const buf = asBuf(input);
  const trak = findBox(buf, moovBodyStart, buf.length, 'trak');
  if (!trak) return null;
  const tkhd = findBox(buf, trak.bodyStart, trak.end, 'tkhd');
  const mdia = findBox(buf, trak.bodyStart, trak.end, 'mdia');
  if (!mdia || !tkhd) return null;
  const mdhd = findBox(buf, mdia.bodyStart, mdia.end, 'mdhd');
  const hdlr = findBox(buf, mdia.bodyStart, mdia.end, 'hdlr');
  const minf = findBox(buf, mdia.bodyStart, mdia.end, 'minf');
  if (!mdhd || !hdlr || !minf) return null;

  const timescale = buf.at(mdhd.bodyStart) === 1
    ? buf.readUInt32BE(mdhd.bodyStart + 4 + 16)
    : buf.readUInt32BE(mdhd.bodyStart + 4 + 8);
  const trackId = buf.readUInt32BE(tkhd.bodyStart + 4 + (buf.at(tkhd.bodyStart) === 1 ? 16 : 8));
  const handler = buf.ascii(hdlr.bodyStart + 8, hdlr.bodyStart + 12);

  const stbl = findBox(buf, minf.bodyStart, minf.end, 'stbl');
  const stsd = stbl ? findBox(buf, stbl.bodyStart, stbl.end, 'stsd') : null;
  if (!stsd) return null;
  const entry = parseBoxHeader(buf, stsd.bodyStart + 8);
  if (!entry) return null;

  if (handler === 'vide') {
    return {
      kind: 'video',
      trackId,
      timescale,
      codec: entry.type,
      description: (() => {
        const avcC = findBox(buf, entry.bodyStart + 78, entry.end, 'avcC');
        return avcC ? buf.slice(avcC.bodyStart, avcC.end) : null;
      })(),
      width: buf.readUInt16BE(entry.bodyStart + 24),
      height: buf.readUInt16BE(entry.bodyStart + 26),
      sampleRate: 0,
      channels: 0,
    };
  }
  if (handler === 'soun') {
    const esds = findBox(buf, entry.bodyStart + 28, entry.end, 'esds');
    return {
      kind: 'audio',
      trackId,
      timescale,
      codec: entry.type,
      description: esds ? extractAudioSpecificConfig(buf, esds.bodyStart, esds.end) : null,
      width: 0,
      height: 0,
      sampleRate: buf.readUInt16BE(entry.bodyStart + 24),
      channels: buf.readUInt16BE(entry.bodyStart + 16),
    };
  }
  return null;
}

/** 从 trex 读默认样本参数 */
export function parseTrex(input, moovBodyStart = 8) {
  const buf = asBuf(input);
  const mvex = findBox(buf, moovBodyStart, buf.length, 'mvex');
  if (!mvex) return null;
  const trex = findBox(buf, mvex.bodyStart, mvex.end, 'trex');
  if (!trex) return null;
  const p = trex.bodyStart + 4;
  return {
    trackId: buf.readUInt32BE(p),
    defaultSampleDuration: buf.readUInt32BE(p + 8),
    defaultSampleSize: buf.readUInt32BE(p + 12),
    defaultSampleFlags: buf.readUInt32BE(p + 16),
  };
}

/**
 * 解析一个 moof 的**内容**（不含 8 字节 box 头），返回样本表（偏移为文件绝对偏移）。
 * @param {Uint8Array|ByteBuf} body moof 内容
 * @param {number} moofStart 该 moof 在文件中的绝对偏移（用于默认 base_data_offset）
 */
export function parseMoofSamples(body, moofStart) {
  const buf = asBuf(body);
  const traf = findBox(buf, 0, buf.length, 'traf');
  if (!traf) return null;

  const tfhd = findBox(buf, traf.bodyStart, traf.end, 'tfhd');
  const tfdt = findBox(buf, traf.bodyStart, traf.end, 'tfdt');
  const trun = findBox(buf, traf.bodyStart, traf.end, 'trun');
  if (!tfhd || !trun) return null;

  const tfhdFlags = buf.readUInt32BE(tfhd.bodyStart) & 0xffffff;
  let p = tfhd.bodyStart + 8; // version/flags + track_ID
  let baseDataOffset = moofStart;
  if (tfhdFlags & 0x000001) {
    baseDataOffset = buf.readBigUInt64BE(p);
    p += 8;
  }
  if (tfhdFlags & 0x000002) p += 4;
  let defaultDuration = 0;
  if (tfhdFlags & 0x000008) {
    defaultDuration = buf.readUInt32BE(p);
    p += 4;
  }
  let defaultSize = 0;
  if (tfhdFlags & 0x000010) {
    defaultSize = buf.readUInt32BE(p);
    p += 4;
  }
  let defaultFlags = 0;
  if (tfhdFlags & 0x000020) defaultFlags = buf.readUInt32BE(p);

  let baseTime = 0;
  if (tfdt) {
    baseTime = buf.at(tfdt.bodyStart) === 1
      ? buf.readBigUInt64BE(tfdt.bodyStart + 4)
      : buf.readUInt32BE(tfdt.bodyStart + 4);
  }

  const trunVersion = buf.at(trun.bodyStart);
  const trunFlags = buf.readUInt32BE(trun.bodyStart) & 0xffffff;
  const sampleCount = buf.readUInt32BE(trun.bodyStart + 4);
  let q = trun.bodyStart + 8;
  let dataOffset = 0;
  if (trunFlags & 0x000001) {
    dataOffset = buf.readInt32BE(q);
    q += 4;
  }
  let firstSampleFlags = 0;
  const hasFirstSampleFlags = (trunFlags & 0x000004) !== 0;
  if (hasFirstSampleFlags) {
    firstSampleFlags = buf.readUInt32BE(q);
    q += 4;
  }

  const samples = [];
  let offset = baseDataOffset + dataOffset;
  for (let i = 0; i < sampleCount; i += 1) {
    let duration = defaultDuration;
    let size = defaultSize;
    let flags = defaultFlags;
    let cto = 0;
    if (trunFlags & 0x000100) {
      duration = buf.readUInt32BE(q);
      q += 4;
    }
    if (trunFlags & 0x000200) {
      size = buf.readUInt32BE(q);
      q += 4;
    }
    if (trunFlags & 0x000400) {
      flags = buf.readUInt32BE(q);
      q += 4;
    }
    if (trunFlags & 0x000800) {
      cto = trunVersion === 0 ? buf.readUInt32BE(q) : buf.readInt32BE(q);
      q += 4;
    }
    // 首样本的 flags 由 first_sample_flags 覆盖（规范如此，否则首帧会被当成非关键帧）
    if (i === 0 && hasFirstSampleFlags) flags = firstSampleFlags;
    samples.push({
      offset,
      size,
      duration,
      cto,
      // sample_flags bit16 = sample_is_non_sync，置位表示非关键帧
      isKey: (flags & 0x00010000) === 0,
    });
    offset += size;
  }
  return { baseTime, samples };
}

/**
 * 流式读取一条 .m4s：先读 init（ftyp + moov），再逐个 fragment 产出样本。
 * `pull(n)` 必须返回恰好 n 字节（EOF 时可返回更少）。
 */
export class Fmp4Reader {
  constructor(pull) {
    this.pull = pull;
    this.offset = 0;
    this.config = null;
  }

  async readHeader() {
    const head = await this.pull(8);
    if (!head || head.length < 8) return null;
    const box = parseBoxHeader(head, 0);
    if (!box) throw new Error('fMP4 结构异常：box 头不完整');
    const start = this.offset;
    this.offset += 8;
    return { ...box, offset: start };
  }

  async readInit() {
    for (;;) {
      const header = await this.readHeader();
      if (!header) throw new Error('fMP4 初始化段为空');
      const bodyLen = header.size - 8;
      const body = bodyLen > 0 ? await this.pull(bodyLen) : new Uint8Array(0);
      if (!body || body.length < bodyLen) throw new Error('fMP4 初始化段被截断');
      this.offset += bodyLen;
      if (header.type === 'moov') {
        // body 已经去掉 box 头，子 box 从 0 开始
        const moov = new ByteBuf(body);
        this.config = extractTrackConfig(moov, 0);
        this.trex = parseTrex(moov, 0);
        if (!this.config) throw new Error('无法从 moov 中解析轨道配置');
        return this.config;
      }
      if (header.type === 'mdat') throw new Error('fMP4 结构异常：moov 之前出现 mdat');
    }
  }

  /** 读下一个 fragment；文件结束返回 null */
  async nextFragment() {
    let header = await this.readHeader();
    if (!header) return null;
    while (header && header.type !== 'moof') {
      const skipLen = header.size - 8;
      if (skipLen > 0) {
        const skipped = await this.pull(skipLen);
        if (!skipped) return null;
      }
      this.offset += skipLen;
      header = await this.readHeader();
      if (!header) return null;
    }
    const moofStart = header.offset;
    const moofBody = await this.pull(header.size - 8);
    if (!moofBody) return null;
    this.offset += header.size - 8;

    const mdatHeader = await this.readHeader();
    if (!mdatHeader || mdatHeader.type !== 'mdat') throw new Error('fMP4 结构异常：moof 之后不是 mdat');
    const mdatDataStart = mdatHeader.offset + 8; // 数据从 box 头之后开始
    const mdatSize = mdatHeader.size - 8;
    const mdatBody = await this.pull(mdatSize);
    if (!mdatBody || mdatBody.length < mdatSize) throw new Error('fMP4 数据段被截断');
    this.offset += mdatSize;

    const parsed = parseMoofSamples(new ByteBuf(moofBody), moofStart);
    if (!parsed) throw new Error('无法解析 moof 样本表');

    const samples = parsed.samples.map((sample) => {
      const start = sample.offset - mdatDataStart;
      if (start < 0 || start + sample.size > mdatBody.length) throw new Error('fMP4 样本偏移越界');
      return {
        data: mdatBody.subarray(start, start + sample.size),
        duration: sample.duration,
        cto: sample.cto,
        isKey: sample.isKey,
      };
    });
    return { baseTime: parsed.baseTime, samples };
  }
}
