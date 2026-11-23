/**
 * H.264 辅助工具：
 *  - Annex-B 起始码扫描 / NAL 提取
 *  - Annex-B 访问单元（AU）→ AVCC（4 字节长度前缀）样本数据
 *  - SPS/PPS → AVCDecoderConfigurationRecord（avcC）
 *  - SPS 解析（宽高 / profile / level）
 */

const NAL_TYPE_AUD = 9;
const NAL_TYPE_SPS = 7;
const NAL_TYPE_PPS = 8;
const NAL_TYPE_IDR = 5;
const NAL_TYPE_SLICE = 1;

/** 是否是 VCL（切片）NAL。 */
export function isVclNalType(type) {
  return type === NAL_TYPE_SLICE || type === NAL_TYPE_IDR;
}

/**
 * 扫描一段 Annex-B 字节流中的 NAL 单元。
 * @param {Uint8Array} data
 * @returns {{type:number,start:number,end:number,data:Uint8Array}[]}
 */
export function scanNalUnits(data) {
  const nals = [];
  const n = data.length;
  if (n < 4) return nals;

  // 找第一个起始码
  let first = -1;
  for (let i = 0; i + 3 <= n; i++) {
    if (data[i] === 0 && data[i + 1] === 0 && data[i + 2] === 1) {
      first = i;
      break;
    }
  }
  if (first < 0) return nals;

  let startCodePos = first;
  for (;;) {
    const nalStart = startCodePos + 3;
    if (nalStart >= n) break;
    let next = -1;
    for (let j = nalStart; j + 3 <= n; j++) {
      if (data[j] === 0 && data[j + 1] === 0 && data[j + 2] === 1) {
        next = j;
        break;
      }
    }
    let end = next < 0 ? n : next;
    // 4 字节起始码（00 00 00 01）时，多出来的那个 0 属于下一个起始码
    if (next >= 0 && end > nalStart && data[end - 1] === 0) end -= 1;
    if (end > nalStart) {
      const type = data[nalStart] & 0x1f;
      nals.push({ type, start: nalStart, end, data: data.subarray(nalStart, end) });
    }
    if (next < 0) break;
    startCodePos = next;
  }
  return nals;
}

/**
 * 把一个访问单元（Annex-B NAL 列表）转换成 AVCC 格式的样本数据。
 * 去掉 AUD(9) / SPS(7) / PPS(8)（SPS/PPS 由 avcC 提供），其余 NAL 各加 4 字节长度前缀。
 * 没有 VCL NAL 时返回 null。
 * @param {{type:number,data:Uint8Array}[]} nals
 * @returns {Uint8Array|null}
 */
export function annexbToAvcc(nals) {
  if (!nals || nals.length === 0) return null;
  const keep = [];
  let hasVcl = false;
  for (const nal of nals) {
    const type = nal.type;
    if (type === NAL_TYPE_AUD || type === NAL_TYPE_SPS || type === NAL_TYPE_PPS) continue;
    if (isVclNalType(type)) hasVcl = true;
    keep.push(nal);
  }
  if (!hasVcl || keep.length === 0) return null;
  let total = 0;
  for (const nal of keep) total += 4 + nal.data.length;
  const out = new Uint8Array(total);
  let offset = 0;
  for (const nal of keep) {
    const len = nal.data.length;
    out[offset] = (len >>> 24) & 0xff;
    out[offset + 1] = (len >>> 16) & 0xff;
    out[offset + 2] = (len >>> 8) & 0xff;
    out[offset + 3] = len & 0xff;
    offset += 4;
    out.set(nal.data, offset);
    offset += len;
  }
  return out;
}

/**
 * 由 SPS/PPS 生成 AVCDecoderConfigurationRecord（avcC），lengthSize 固定为 4。
 * @param {Uint8Array} sps
 * @param {Uint8Array} pps
 * @returns {Uint8Array}
 */
export function buildAvcC(sps, pps) {
  if (!sps || sps.length < 4 || !pps || pps.length < 1) {
    throw new Error('SPS/PPS 数据不完整，无法生成 avcC');
  }
  const size = 11 + sps.length + pps.length;
  const out = new Uint8Array(size);
  let o = 0;
  out[o++] = 1; // configurationVersion
  out[o++] = sps[1]; // AVCProfileIndication
  out[o++] = sps[2]; // profile_compatibility
  out[o++] = sps[3]; // AVCLevelIndication
  out[o++] = 0xff; // 低 2 位 lengthSizeMinusOne = 3
  out[o++] = 0xe1; // numOfSequenceParameterSets = 1
  out[o++] = (sps.length >> 8) & 0xff;
  out[o++] = sps.length & 0xff;
  out.set(sps, o);
  o += sps.length;
  out[o++] = 1; // numOfPictureParameterSets
  out[o++] = (pps.length >> 8) & 0xff;
  out[o++] = pps.length & 0xff;
  out.set(pps, o);
  o += pps.length;
  return out.subarray(0, o);
}

function unescapeRbsp(bytes) {
  const out = new Uint8Array(bytes.length);
  let o = 0;
  let zeros = 0;
  for (let i = 0; i < bytes.length; i++) {
    const b = bytes[i];
    if (zeros >= 2 && b === 0x03) {
      zeros = 0;
      continue;
    }
    out[o++] = b;
    zeros = b === 0 ? zeros + 1 : 0;
  }
  return out.subarray(0, o);
}

class BitReader {
  constructor(bytes) {
    this.bytes = bytes;
    this.pos = 0;
    this.bitLength = bytes.length * 8;
  }

  bit() {
    if (this.pos >= this.bitLength) return 0;
    const byte = this.bytes[this.pos >> 3];
    const value = (byte >> (7 - (this.pos & 7))) & 1;
    this.pos++;
    return value;
  }

  u(count) {
    let value = 0;
    for (let i = 0; i < count; i++) value = value * 2 + this.bit();
    return value;
  }

  ue() {
    let zeros = 0;
    while (this.pos < this.bitLength && this.bit() === 0) zeros++;
    if (zeros === 0) return 0;
    return 2 ** zeros - 1 + this.u(zeros);
  }

  se() {
    const value = this.ue();
    return value & 1 ? (value + 1) / 2 : -value / 2;
  }
}

function skipScalingList(reader, size) {
  let lastScale = 8;
  let nextScale = 8;
  for (let i = 0; i < size; i++) {
    if (nextScale !== 0) {
      const deltaScale = reader.se();
      nextScale = (lastScale + deltaScale + 256) % 256;
    }
    if (nextScale !== 0) lastScale = nextScale;
  }
}

const HIGH_PROFILE_IDS = new Set([100, 110, 122, 244, 44, 83, 86, 118, 128, 138, 139, 134, 135]);

function chromaUnits(chromaFormatIdc) {
  switch (chromaFormatIdc) {
    case 0: return { subWidth: 1, subHeight: 1 };
    case 1: return { subWidth: 2, subHeight: 2 };
    case 2: return { subWidth: 2, subHeight: 1 };
    default: return { subWidth: 1, subHeight: 1 };
  }
}

/**
 * 解析 SPS，得到 profile / level / 宽高。
 * @param {Uint8Array} sps NAL 数据（含 1 字节 NAL header）
 */
export function parseSps(sps) {
  // NAL 数据第 1 字节是 NAL header（type 7），profile_idc 从第 2 字节开始
  const rbsp = unescapeRbsp(sps.length > 1 ? sps.subarray(1) : sps);
  if (rbsp.length < 4) throw new Error('SPS 数据过短');
  const reader = new BitReader(rbsp);
  const profileIdc = reader.u(8);
  reader.u(8); // constraint_set flags
  const levelIdc = reader.u(8);
  reader.ue(); // sps id
  let chromaFormatIdc = 1;
  if (HIGH_PROFILE_IDS.has(profileIdc)) {
    chromaFormatIdc = reader.ue();
    if (chromaFormatIdc === 3) reader.u(1); // separate_colour_plane_flag
    reader.ue(); // bit_depth_luma_minus8
    reader.ue(); // bit_depth_chroma_minus8
    reader.u(1); // qpprime_y_zero_transform_bypass_flag
    if (reader.u(1)) {
      const count = chromaFormatIdc === 3 ? 12 : 8;
      for (let i = 0; i < count; i++) {
        if (reader.u(1)) skipScalingList(reader, i < 6 ? 16 : 64);
      }
    }
  }
  reader.ue(); // log2_max_frame_num_minus4
  const picOrderCntType = reader.ue();
  if (picOrderCntType === 0) {
    reader.ue();
  } else if (picOrderCntType === 1) {
    reader.u(1); // delta_pic_order_always_zero_flag
    reader.se();
    reader.se();
    const numRefFrames = reader.ue();
    for (let i = 0; i < numRefFrames; i++) reader.se();
  }
  reader.ue(); // max_num_ref_frames
  reader.u(1); // gaps_in_frame_num_value_allowed_flag
  const picWidthInMbsMinus1 = reader.ue();
  const picHeightInMapUnitsMinus1 = reader.ue();
  const frameMbsOnlyFlag = reader.u(1);
  if (!frameMbsOnlyFlag) reader.u(1); // mb_adaptive_frame_field_flag
  reader.u(1); // direct_8x8_inference_flag
  let cropLeft = 0;
  let cropRight = 0;
  let cropTop = 0;
  let cropBottom = 0;
  if (reader.u(1)) {
    cropLeft = reader.ue();
    cropRight = reader.ue();
    cropTop = reader.ue();
    cropBottom = reader.ue();
  }
  const { subWidth, subHeight } = chromaUnits(chromaFormatIdc);
  const width = (picWidthInMbsMinus1 + 1) * 16 - (cropLeft + cropRight) * subWidth;
  const height = (2 - frameMbsOnlyFlag) * (picHeightInMapUnitsMinus1 + 1) * 16
    - (cropTop + cropBottom) * subHeight * (2 - frameMbsOnlyFlag);
  return { profileIdc, levelIdc, chromaFormatIdc, frameMbsOnlyFlag, width, height };
}
