/**
 * m3u8（HLS）播放列表解析：媒体播放列表 + 主（master）播放列表。
 * 纯前端实现，只依赖标准 Web API（URL）。
 *
 * 支持的标签：
 *  - 主列表：#EXT-X-STREAM-INF（BANDWIDTH / AVERAGE-BANDWIDTH / RESOLUTION / CODECS）
 *  - 媒体列表：#EXTINF、#EXT-X-TARGETDURATION、#EXT-X-MEDIA-SEQUENCE、#EXT-X-ENDLIST
 *             #EXT-X-KEY（AES-128 / NONE，支持密钥轮换、显式 IV、默认 IV=媒体序号）
 *             #EXT-X-DISCONTINUITY、#EXT-X-VERSION、#EXT-X-PLAYLIST-TYPE
 *  - 遇到 #EXT-X-MAP（fMP4 初始化段）/ #EXT-X-BYTERANGE / SAMPLE-AES 时记录告警（不支持）
 */

import { hlsError } from './errors.mjs';

/** 把 m3u8 里的相对地址解析成绝对地址。 */
export function resolveUri(uri, baseUrl) {
  try {
    return new URL(uri, baseUrl).href;
  } catch {
    return uri;
  }
}

/** 解析 #EXT-X-XXX: 之后的属性列表（支持带引号的值）。 */
export function parseAttributeList(text) {
  const out = Object.create(null);
  if (!text) return out;
  const re = /([A-Za-z0-9-]+)="([^"]*)"|([A-Za-z0-9-]+)=([^,]*)/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    if (m[1]) out[m[1].toUpperCase()] = m[2];
    else out[m[3].toUpperCase()] = m[4];
  }
  return out;
}

/** 是否是主播放列表（含 #EXT-X-STREAM-INF）。 */
export function isMasterPlaylist(text) {
  return /^#EXT-X-STREAM-INF\s*:/m.test(text);
}

/** 解析主播放列表，返回 { variants: [...] }。 */
export function parseMasterPlaylist(text, baseUrl) {
  const lines = String(text).replace(/^\uFEFF/, '').split(/\r?\n/);
  if (!lines[0] || lines[0].trim() !== '#EXTM3U') {
    throw hlsError('不是有效的 m3u8 播放列表（缺少 #EXTM3U 头）');
  }
  const variants = [];
  let pending = null;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    if (line.startsWith('#EXT-X-STREAM-INF:')) {
      pending = parseAttributeList(line.slice('#EXT-X-STREAM-INF:'.length));
      continue;
    }
    if (line.startsWith('#')) continue;
    if (!pending) continue;
    const bandwidth = Number.parseInt(pending.BANDWIDTH || pending.AVERAGEBANDWIDTH || '0', 10) || 0;
    const averageBandwidth = Number.parseInt(pending.AVERAGEBANDWIDTH || pending.BANDWIDTH || '0', 10) || 0;
    variants.push({
      bandwidth,
      averageBandwidth,
      resolution: pending.RESOLUTION || null,
      codecs: pending.CODECS || null,
      url: resolveUri(line, baseUrl),
    });
    pending = null;
  }
  return { variants };
}

/** 解析 16 进制 IV。 */
function parseIvHex(value) {
  if (!value) return null;
  const hex = value.startsWith('0x') || value.startsWith('0X') ? value.slice(2) : value;
  if (!/^[0-9a-fA-F]*$/.test(hex) || hex.length === 0) return null;
  let normalized = hex;
  if (normalized.length % 2 !== 0) normalized = '0' + normalized;
  if (normalized.length > 32) normalized = normalized.slice(normalized.length - 32);
  normalized = normalized.padStart(32, '0');
  const iv = new Uint8Array(16);
  for (let i = 0; i < 16; i++) iv[i] = Number.parseInt(normalized.slice(i * 2, i * 2 + 2), 16);
  return iv;
}

/**
 * 解析媒体播放列表。
 * 返回：
 * {
 *   segments: [{ index, seq, duration, startTime, endTime, url, key, discontinuity }],
 *   targetDuration, mediaSequence, isLive, totalDuration,
 *   encryptionMethods: string[], warnings: string[],
 * }
 * key = { method, uri, iv: Uint8Array|null, keyformat } | null
 */
export function parseMediaPlaylist(text, baseUrl) {
  const lines = String(text).replace(/^\uFEFF/, '').split(/\r?\n/);
  let sawHeader = false;
  let targetDuration = 0;
  let mediaSequence = 0;
  let isLive = true;
  let currentKey = null;
  let pendingDuration = null;
  let discontinuity = false;
  let pendingByteRange = null;
  const segments = [];
  const encryptionMethods = [];
  const warnings = [];
  const warnOnce = (msg) => {
    if (!warnings.includes(msg)) warnings.push(msg);
  };

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const line = raw.trim();
    if (!line) continue;
    if (!sawHeader) {
      if (line === '#EXTM3U') {
        sawHeader = true;
        continue;
      }
      // 允许 BOM / 空行之后出现 #EXTM3U
      if (line.startsWith('#')) continue;
      throw hlsError('不是有效的 m3u8 播放列表（缺少 #EXTM3U 头）');
    }
    if (line.startsWith('#')) {
      if (line.startsWith('#EXT-X-TARGETDURATION:')) {
        targetDuration = Number.parseFloat(line.slice('#EXT-X-TARGETDURATION:'.length)) || 0;
      } else if (line.startsWith('#EXT-X-MEDIA-SEQUENCE:')) {
        mediaSequence = Number.parseInt(line.slice('#EXT-X-MEDIA-SEQUENCE:'.length), 10) || 0;
      } else if (line.startsWith('#EXT-X-ENDLIST')) {
        isLive = false;
      } else if (line.startsWith('#EXT-X-KEY:')) {
        const attrs = parseAttributeList(line.slice('#EXT-X-KEY:'.length));
        const method = String(attrs.METHOD || 'NONE').toUpperCase();
        if (method === 'NONE') {
          currentKey = null;
        } else {
          const keyformat = String(attrs.KEYFORMAT || 'identity').toLowerCase();
          let uri = attrs.URI ? resolveUri(attrs.URI, baseUrl) : null;
          if (method === 'AES-128' && !uri) {
            throw hlsError('#EXT-X-KEY 缺少 URI，无法解密');
          }
          if (keyformat !== 'identity') {
            warnOnce(`不支持的 KEYFORMAT=${attrs.KEYFORMAT}，解密可能失败`);
          }
          currentKey = { method, uri, iv: parseIvHex(attrs.IV), keyformat };
          if (!encryptionMethods.includes(method)) encryptionMethods.push(method);
        }
      } else if (line.startsWith('#EXTINF:')) {
        const value = line.slice('#EXTINF:'.length);
        const commaIndex = value.indexOf(',');
        const parsed = Number.parseFloat(commaIndex >= 0 ? value.slice(0, commaIndex) : value);
        pendingDuration = Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
      } else if (line.startsWith('#EXT-X-DISCONTINUITY')) {
        discontinuity = true;
      } else if (line.startsWith('#EXT-X-BYTERANGE:')) {
        pendingByteRange = line.slice('#EXT-X-BYTERANGE:'.length).trim();
        warnOnce('#EXT-X-BYTERANGE（分片字节范围）未实现，将按整段下载');
      } else if (line.startsWith('#EXT-X-MAP:')) {
        warnOnce('#EXT-X-MAP（fMP4 初始化段）不支持，输出可能不完整');
      } else if (line.startsWith('#EXT-X-SKIP') || line.startsWith('#EXT-X-PRELOAD-HINT')) {
        warnOnce('检测到低延迟 HLS 标签，未实现（适用于点播流）');
      }
      continue;
    }
    // 媒体分片地址行
    if (pendingDuration === null) {
      warnOnce('发现缺少 #EXTINF 的地址行，已忽略');
      continue;
    }
    const seq = mediaSequence + segments.length;
    const segment = {
      index: segments.length,
      seq,
      duration: pendingDuration,
      startTime: 0,
      endTime: 0,
      url: resolveUri(line, baseUrl),
      key: currentKey,
      discontinuity,
      byteRange: pendingByteRange,
    };
    segments.push(segment);
    pendingDuration = null;
    pendingByteRange = null;
    discontinuity = false;
  }

  if (!sawHeader) throw hlsError('不是有效的 m3u8 播放列表（缺少 #EXTM3U 头）');

  let acc = 0;
  for (const seg of segments) {
    seg.startTime = acc;
    acc += seg.duration;
    seg.endTime = acc;
  }

  return {
    segments,
    targetDuration,
    mediaSequence,
    isLive,
    totalDuration: acc,
    encryptionMethods,
    warnings,
  };
}
