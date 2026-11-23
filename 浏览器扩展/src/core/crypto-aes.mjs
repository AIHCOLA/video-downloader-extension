/**
 * AES-128-CBC 解密（HLS #EXT-X-KEY METHOD=AES-128）。
 * 使用标准 WebCrypto：crypto.subtle.decrypt，浏览器与 Node 20 均可用。
 */

import { fetchBytes } from './http.mjs';
import { hlsError } from './errors.mjs';

const IV_ZERO = new Uint8Array(16);

/** 默认 IV：#EXT-X-KEY 未显式给出 IV 时，使用媒体序号（16 字节大端）。 */
export function sequenceIv(sequence) {
  const iv = new Uint8Array(16);
  if (!Number.isFinite(sequence) || sequence < 0) {
    iv.set(IV_ZERO);
    return iv;
  }
  let value = BigInt(Math.floor(sequence));
  for (let i = 15; i >= 8; i--) {
    iv[i] = Number(value & 0xffn);
    value >>= 8n;
  }
  return iv;
}

function stripPkcs7(data, onLog) {
  const length = data.length;
  if (length === 0) return data;
  const pad = data[length - 1];
  if (pad >= 1 && pad <= 16 && pad <= length) {
    let valid = true;
    for (let i = length - pad; i < length; i++) {
      if (data[i] !== pad) {
        valid = false;
        break;
      }
    }
    if (valid) return data.subarray(0, length - pad);
  }
  // 兜底 1：按 TS 同步字节 0x47 / 188 字节对齐裁剪
  if (data[0] === 0x47) {
    if (length % 188 === 0) return data;
    for (let cut = 1; cut < 16 && cut < length; cut++) {
      if ((length - cut) % 188 === 0) {
        if (onLog) onLog('warn', `PKCS#7 去填充失败，已按 TS 188 字节对齐裁剪 ${cut} 字节`);
        return data.subarray(0, length - cut);
      }
    }
  }
  if (onLog) onLog('warn', 'PKCS#7 去填充校验失败，按原样使用解密数据');
  return data;
}

/**
 * AES-128 密钥缓存与分片解密器。
 */
export class Aes128KeyStore {
  constructor() {
    this._keys = new Map(); // uri -> Promise<CryptoKey>
  }

  _getCryptoKey(uri, context) {
    let promise = this._keys.get(uri);
    if (!promise) {
      promise = (async () => {
        const raw = await fetchBytes(uri, {
          signal: context.signal,
          timeoutMs: context.timeoutMs,
          retries: context.retries,
          onLog: context.onLog,
          label: 'AES-128 密钥',
        });
        if (raw.length !== 16) {
          throw hlsError(`AES-128 密钥长度必须为 16 字节，实际为 ${raw.length} 字节：${uri}`);
        }
        const subtle = globalThis.crypto && globalThis.crypto.subtle;
        if (!subtle) throw hlsError('当前环境不支持 WebCrypto（crypto.subtle），无法解密 AES-128 分片');
        return subtle.importKey('raw', raw, { name: 'AES-CBC' }, false, ['decrypt']);
      })();
      this._keys.set(uri, promise);
      promise.catch(() => {
        // 失败后允许重试（避免缓存被拒绝的 promise）
        if (this._keys.get(uri) === promise) this._keys.delete(uri);
      });
    }
    return promise;
  }

  /**
   * 解密一个分片。
   * @param {object} segment 媒体播放列表分片对象（含 key / seq）
   * @param {Uint8Array} encrypted 密文字节
   * @param {{signal?:AbortSignal, timeoutMs?:number, retries?:number, onLog?:Function}} context
   * @returns {Promise<Uint8Array>}
   */
  async decryptSegment(segment, encrypted, context = {}) {
    const onLog = context.onLog;
    const key = segment.key;
    if (!key) return encrypted;
    const method = String(key.method || '').toUpperCase();
    if (method === 'NONE') return encrypted;
    if (method !== 'AES-128') {
      throw hlsError(`不支持的 HLS 加密方式：${method}（当前仅支持 AES-128）`);
    }
    if (!key.uri) throw hlsError('加密分片缺少密钥地址（#EXT-X-KEY URI）');
    if (!encrypted || encrypted.length === 0) return encrypted;

    let data = encrypted;
    if (data.length % 16 !== 0) {
      const usable = data.length - (data.length % 16);
      if (onLog) onLog('warn', `分片密文长度 ${data.length} 不是 16 的倍数，尝试截断到 ${usable} 字节后解密`);
      if (usable === 0) return data;
      data = data.subarray(0, usable);
    }

    const cryptoKey = await this._getCryptoKey(key.uri, context);
    const iv = key.iv instanceof Uint8Array && key.iv.length === 16 ? key.iv : sequenceIv(segment.seq);
    const subtle = globalThis.crypto && globalThis.crypto.subtle;
    if (!subtle) throw hlsError('当前环境不支持 WebCrypto（crypto.subtle），无法解密 AES-128 分片');
    let plain;
    try {
      plain = new Uint8Array(await subtle.decrypt({ name: 'AES-CBC', iv }, cryptoKey, data));
    } catch (err) {
      throw hlsError(`AES-128 解密失败（分片 ${segment.index + 1}）：${err && err.message ? err.message : err}`, err);
    }
    return stripPkcs7(plain, onLog);
  }
}
