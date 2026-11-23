/**
 * B 站 WBI 签名（纯 JS，无依赖）。
 *
 * B 站 2023 年起对 playurl 等接口加了 w_rid 校验：没签名时即使登录也按匿名下发低清晰度。
 * 算法：
 *   1. 从 nav 接口的 wbi_img.img_url / sub_url 里取两个 key（文件名去掉扩展名）；
 *   2. 用固定的 64 位混淆表把 imgKey + subKey 重排成 32 位 mixinKey；
 *   3. 参数按 key 字典序排序、值去掉 !'()* 后 urlencode，拼成 query，再追加 wts（秒）；
 *   4. w_rid = md5(query + mixinKey)。
 *
 * 本模块不依赖 DOM / chrome.*，可直接在 Node 里用标准测试向量验证。
 */

const MIXIN_KEY_ENC_TAB = [
  46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35, 27, 43, 5, 49, 33, 9, 42, 19, 29, 28, 14, 39, 12, 38,
  41, 13, 37, 48, 7, 16, 24, 55, 40, 61, 26, 17, 0, 1, 60, 51, 30, 4, 22, 25, 54, 21, 56, 59, 6, 63, 57, 62, 11, 36,
  20, 34, 44, 52,
];

const SHIFT = [
  7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20,
  4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15,
  21,
];

/** MD5 常量表：floor(abs(sin(i+1)) * 2^32) */
const MD5_K = (() => {
  const table = new Uint32Array(64);
  for (let i = 0; i < 64; i += 1) table[i] = Math.floor(Math.abs(Math.sin(i + 1)) * 4294967296) >>> 0;
  return table;
})();

/**
 * 标准 MD5（输入按 UTF-8 处理，输出 32 位小写十六进制）。
 * @param {string} input
 * @returns {string}
 */
export function md5(input) {
  const bytes = new TextEncoder().encode(String(input));
  const bitLen = bytes.length * 8;
  // 补 0x80 + 若干 0，直到长度 ≡ 56 (mod 64)，再补 8 字节小端长度
  const totalLen = (((bytes.length + 8) >> 6) + 1) * 64;
  const buffer = new Uint8Array(totalLen);
  buffer.set(bytes);
  buffer[bytes.length] = 0x80;
  const view = new DataView(buffer.buffer);
  view.setUint32(totalLen - 8, bitLen >>> 0, true);
  view.setUint32(totalLen - 4, Math.floor(bitLen / 4294967296), true);

  let a0 = 0x67452301;
  let b0 = 0xefcdab89;
  let c0 = 0x98badcfe;
  let d0 = 0x10325476;

  const m = new Uint32Array(16);
  for (let offset = 0; offset < totalLen; offset += 64) {
    for (let i = 0; i < 16; i += 1) m[i] = view.getUint32(offset + i * 4, true);
    let a = a0;
    let b = b0;
    let c = c0;
    let d = d0;
    for (let i = 0; i < 64; i += 1) {
      let f;
      let g;
      if (i < 16) {
        f = (b & c) | (~b & d);
        g = i;
      } else if (i < 32) {
        f = (d & b) | (~d & c);
        g = (5 * i + 1) % 16;
      } else if (i < 48) {
        f = b ^ c ^ d;
        g = (3 * i + 5) % 16;
      } else {
        f = c ^ (b | ~d);
        g = (7 * i) % 16;
      }
      f = (f + a + MD5_K[i] + m[g]) >>> 0;
      a = d;
      d = c;
      c = b;
      const shift = SHIFT[i];
      b = (b + ((f << shift) | (f >>> (32 - shift)))) >>> 0;
    }
    a0 = (a0 + a) >>> 0;
    b0 = (b0 + b) >>> 0;
    c0 = (c0 + c) >>> 0;
    d0 = (d0 + d) >>> 0;
  }

  const out = new Uint8Array(16);
  const outView = new DataView(out.buffer);
  outView.setUint32(0, a0, true);
  outView.setUint32(4, b0, true);
  outView.setUint32(8, c0, true);
  outView.setUint32(12, d0, true);
  return Array.from(out, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

/** 从 wbi 图片 URL 里取 key（文件名去掉 .png） */
export function extractWbiKey(imageUrl) {
  if (!imageUrl || typeof imageUrl !== 'string') return '';
  const name = imageUrl.split('/').pop() || '';
  return name.replace(/\.(png|jpg|jpeg|webp)$/i, '');
}

/** 由 imgKey + subKey 派生 32 位 mixinKey */
export function getMixinKey(imgKey, subKey) {
  const raw = `${String(imgKey || '')}${String(subKey || '')}`;
  let out = '';
  for (const index of MIXIN_KEY_ENC_TAB) out += raw[index] || '';
  return out.slice(0, 32);
}

/** 按 B 站规则编码参数：key 字典序、值去掉 !'()* 后 encodeURIComponent */
export function encodeWbiParams(params) {
  return Object.keys(params)
    .sort()
    .map((key) => {
      const value = String(params[key] == null ? '' : params[key]).replace(/[!'()*]/g, '');
      return `${encodeURIComponent(key)}=${encodeURIComponent(value)}`;
    })
    .join('&');
}

/**
 * 生成带 w_rid 的 query string。
 * @param {Record<string, string|number>} params 业务参数（不含 wts）
 * @param {string} imgKey
 * @param {string} subKey
 * @param {number} [wts] 秒级时间戳（测试可传入固定值）
 * @returns {{query: string, wts: number, w_rid: string}}
 */
export function signWbi(params, imgKey, subKey, wts) {
  const timestamp = Number.isFinite(wts) ? wts : Math.floor(Date.now() / 1000);
  const withTs = { ...params, wts: timestamp };
  const query = encodeWbiParams(withTs);
  const wRid = md5(query + getMixinKey(imgKey, subKey));
  return { query: `${query}&w_rid=${wRid}`, wts: timestamp, w_rid: wRid };
}
