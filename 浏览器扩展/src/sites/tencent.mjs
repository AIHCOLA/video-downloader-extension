/**
 * 腾讯视频（v.qq.com）视频解析。
 *
 * 与 B 站 / 抖音的区别：
 *   - 腾讯有公开的播放信息接口 `vv.video.qq.com/getinfo`（返回 `QZOutputJson={...}`），
 *     不需要签名、不校验 Referer（实测 302 → CDN 直出 200，匿名可下）；
 *   - 但**版权内容（剧集 / 电影 / 综艺）走 DRM 加密**：`fl` 里标着 drm=0，
 *     实际 `vl.vi[0].drm=1` 且带 `encryption` 字段，字节流是加密的。这类内容本扩展不做绕过；
 *   - UGC / 免费短视频是普通 MP4（H.264 + AAC），整段直下即可。
 *
 * 支持的地址形态：
 *   /x/page/<vid>.html
 *   /x/cover/<cid>/<vid>.html        （剧集里具体某一集，vid 在路径里）
 *   /x/cover/<cid>.html、/detail/<cid>.html → 只是专辑页，没有具体 vid（提示用户点开某一集）
 *   m.v.qq.com 的 ?vid= / ?vids= 形式、iframe 播放器 ?vid=
 *
 * 接口注意：getinfo 对短时间内的重复请求很敏感，会返回 93.x「账号检测到可疑行为」，
 * 所以这里做全局节流（默认两次请求至少间隔 700ms）+ 93.x 时退避重试一次。
 */

export const TENCENT_REFERER = 'https://v.qq.com/';

const API_GETINFO = 'https://vv.video.qq.com/getinfo';
const HOST_RE = /(^|\.)v\.qq\.com$/i;
const VID_RE = /^[a-z0-9]{11}$/i;

/** 两次接口请求的最小间隔（毫秒）：调太快会被 93.2 拦 */
const MIN_GAP_MS = 700;
/** 命中频率限制后的退避时间 */
const RATE_LIMIT_BACKOFF_MS = 2000;

/** DRM 内容的统一提示 */
const DRM_HINT =
  '这是腾讯视频的版权内容（剧集 / 电影 / 综艺等），源站用 DRM 加密传输，本扩展不支持解密下载（也不做绕过）。免费 / UGC 视频（如 /x/page/ 开头的短片）可以正常下载。';

/**
 * 解析腾讯视频链接，纯函数。
 * @param {string} input
 * @returns {null | {kind:'video', vid:string, cid?:string, normalized:string}
 *                | {kind:'cover', cid:string, normalized:string}}
 */
export function parseTencentUrl(input) {
  if (!input || typeof input !== 'string') return null;
  const raw = input.trim();
  if (!raw) return null;

  let url;
  try {
    url = new URL(raw.startsWith('http') ? raw : `https://${raw}`);
  } catch {
    return null;
  }
  if (!HOST_RE.test(url.hostname.toLowerCase())) return null;

  const path = url.pathname;

  // /x/page/<vid>.html —— UGC 单集播放页
  const page = path.match(/^\/x\/page\/([a-z0-9]{11})(?:\.html)?/i);
  if (page) return { kind: 'video', vid: page[1].toLowerCase(), normalized: url.href };

  // /x/cover/<cid>/<vid>.html —— 剧集里的具体一集（vid 在路径里）
  const coverEp = path.match(/^\/x\/cover\/([a-z0-9]+)\/([a-z0-9]{11})(?:\.html)?/i);
  if (coverEp) {
    return { kind: 'video', cid: coverEp[1], vid: coverEp[2].toLowerCase(), normalized: url.href };
  }

  // /x/cover/<cid>.html、/detail/<cid>.html —— 只有专辑号
  const cover = path.match(/^\/x\/cover\/([a-z0-9]+)(?:\.html)?/i) || path.match(/^\/detail\/([a-z0-9]+)(?:\.html)?/i);
  if (cover) return { kind: 'cover', cid: cover[1], normalized: url.href };

  // 播放器 iframe / 移动端分享页：/txp/iframe/player.html?vid=、/x/m/play?vid=
  const queryVid = url.searchParams.get('vid') || url.searchParams.get('vids');
  if (VID_RE.test(queryVid || '')) {
    return {
      kind: 'video',
      vid: queryVid.toLowerCase(),
      cid: url.searchParams.get('cid') || '',
      normalized: url.href,
    };
  }

  return null;
}

/** 清洗文件名片段 */
export function sanitizeTencentName(text, maxLen = 60) {
  let s = String(text || '')
    .replace(/[\\/:*?"<>|\r\n\t]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  s = s.replace(/[.\s]+$/g, '');
  if (s.length > maxLen) s = s.slice(0, maxLen).trim();
  return s || 'tencent';
}

/** 生成保存文件名：标题_vid.mp4 */
export function buildTencentFilename({ title, vid }) {
  const parts = [sanitizeTencentName(title, 60)];
  if (vid) parts.push(String(vid));
  let name = parts.filter(Boolean).join('_');
  if (name.length > 110) name = name.slice(0, 110).replace(/[.\s]+$/g, '');
  return `${name}.mp4`;
}

/** getinfo 返回的是 `QZOutputJson={...};` 这种伪 JSON，去掉前后缀再解析 */
export function parseGetinfoPayload(text) {
  const s = String(text || '').trim();
  if (!s) throw new Error('腾讯视频接口返回了空内容。');
  const start = s.indexOf('{');
  const end = s.lastIndexOf('}');
  if (start < 0 || end <= start) throw new Error('腾讯视频接口返回了无法解析的内容（可能被拦截）。');
  try {
    return JSON.parse(s.slice(start, end + 1));
  } catch {
    throw new Error('腾讯视频接口返回了无法解析的内容（JSON 解析失败）。');
  }
}

/**
 * 是否是加密（DRM）流。
 *
 * 只看 `vi.drm` 与 `vi.enc`：实测发现 `vi.encryption` 在**免费视频上也有值**
 * （同一个常量 8265898），拿它判断会把所有视频都误判成加密。
 */
export function isDrmProtected(vi) {
  if (!vi) return false;
  if (Number(vi.drm) === 1) return true;
  return String(vi.enc) === '1';
}

function qualityLabelOf(item) {
  const resolution = String((item && item.resolution) || '');
  const fromResolution = resolution.match(/(\d{3,4})P/i);
  if (fromResolution) return `${fromResolution[1]}P`;
  const cname = String((item && (item.cname || item.sname)) || '').replace(/[（(].*?[)）]/g, '');
  const cleaned = cname.replace(/[;；]/g, ' ').replace(/\s+/g, ' ').trim();
  return cleaned || String((item && item.name) || '默认');
}

function heightOf(item) {
  const resolution = String((item && item.resolution) || '');
  const match = resolution.match(/(\d{3,4})P/i);
  return match ? Number(match[1]) : 0;
}

/**
 * 把 getinfo 的 `fl.fi` 整理成清晰度列表（按 br 从高到低）。
 * `qn` 直接用接口里的 `br`（同一档在切换时会原样回传）。
 */
export function buildTencentQualities(fl) {
  const list = fl && Array.isArray(fl.fi) ? fl.fi : [];
  return list
    .filter((item) => item && item.name && Number(item.br) > 0)
    .map((item) => ({
      qn: Number(item.br),
      label: qualityLabelOf(item),
      width: 0,
      height: heightOf(item),
      bitrate: 0,
      sizeBytes: Number(item.fs) || 0,
      url: '',
      backups: [],
      // lmt=1 表示会员专享：匿名请求拿不到，标成不可选
      supported: Number(item.lmt) !== 1,
      defn: item.name,
      vip: Number(item.lmt) === 1,
    }))
    .sort((a, b) => b.qn - a.qn || b.height - a.height);
}

function normalizeBase(base) {
  const value = String(base || '');
  if (!value) return '';
  return value.endsWith('/') ? value : `${value}/`;
}

/**
 * 腾讯给的镜像地址是 http://…；同一路径 https 也能取（实测 200），
 * 扩展页优先用 https，http 原件留作备用地址。
 */
function preferHttps(url) {
  return /^http:\/\//i.test(url) ? url.replace(/^http:\/\//i, 'https://') : url;
}

function mirrorBases(vi) {
  const ui = vi && vi.ul && Array.isArray(vi.ul.ui) ? vi.ul.ui : [];
  return ui
    .map((entry) => normalizeBase(entry && entry.url))
    .filter((base) => /^https?:\/\//i.test(base));
}

/** 拼播放地址：<镜像目录>/<文件名>?vkey=<密钥>（优先 https） */
export function buildTencentPlayUrl(vi) {
  if (!vi || !vi.fn) return '';
  const bases = mirrorBases(vi);
  if (!bases.length) return '';
  const query = `?vkey=${encodeURIComponent(vi.fvkey || '')}`;
  return `${preferHttps(bases[0])}${vi.fn}${query}`;
}

/** 备用地址：原始 http 主地址（https 不通时兜底）+ 其余镜像（https 优先） */
export function buildTencentBackups(vi) {
  if (!vi || !vi.fn) return [];
  const bases = mirrorBases(vi);
  if (!bases.length) return [];
  const query = `?vkey=${encodeURIComponent(vi.fvkey || '')}`;
  const list = [];
  if (/^http:\/\//i.test(bases[0])) list.push(`${bases[0]}${vi.fn}${query}`);
  for (const base of bases.slice(1)) list.push(`${preferHttps(base)}${vi.fn}${query}`);
  return list;
}

function abortError() {
  const err = new Error('已取消');
  err.name = 'AbortError';
  return err;
}

function throwIfAborted(signal) {
  if (signal && signal.aborted) throw abortError();
}

function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal && signal.aborted) {
      reject(abortError());
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(abortError());
    };
    const timer = setTimeout(() => {
      if (signal) signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    if (signal) signal.addEventListener('abort', onAbort, { once: true });
  });
}

/** 业务错误码 → 人话 */
function describeGetinfoFailure(payload) {
  const code = String((payload && payload.code) || '');
  const msg = String((payload && payload.msg) || '').trim();
  if (/^61/.test(code)) return `该内容暂不可观看${msg ? `（${msg}）` : ''}，可能已下架或受地区限制。`;
  if (/^62/.test(code)) return `该视频暂时无法观看${msg ? `（${msg}）` : ''}。`;
  if (/^93/.test(code)) return '腾讯视频接口触发了频率限制，请等十几秒再点一次。';
  return `腾讯视频接口返回错误${code ? `（${code}）` : ''}${msg ? `：${msg}` : ''}`;
}

function isRateLimited(payload) {
  return /^93/.test(String((payload && payload.code) || ''));
}

/** 全局限流：连发两次请求会被腾讯判成可疑行为 */
let lastCallAt = 0;
function resetThrottleForTest() {
  lastCallAt = 0;
}

async function fetchGetinfoText(url, { signal, fetchImpl, timeoutMs = 20000 } = {}) {
  const doFetch = fetchImpl || fetch;
  if (typeof doFetch !== 'function') throw new Error('当前环境不支持 fetch');
  throwIfAborted(signal);
  const controller = new AbortController();
  const onAbort = () => controller.abort();
  if (signal) signal.addEventListener('abort', onAbort, { once: true });
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await doFetch(url, {
      signal: controller.signal,
      credentials: 'omit',
      headers: { Accept: '*/*' },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.text();
  } catch (err) {
    if (signal && signal.aborted) throw abortError();
    if (err && err.name === 'AbortError') throw new Error(`腾讯视频接口请求超时（${Math.round(timeoutMs / 1000)}s）`);
    throw new Error(`无法访问腾讯视频接口：${err && err.message ? err.message : err}`);
  } finally {
    clearTimeout(timer);
    if (signal) signal.removeEventListener('abort', onAbort);
  }
}

/** 取一次 getinfo（含节流 + 93.x 退避重试） */
async function requestGetinfo(vid, defn, options = {}, label = '') {
  const { signal, fetchImpl, onLog } = options;
  const minGap = Number.isFinite(options.minGapMs) ? Number(options.minGapMs) : MIN_GAP_MS;
  const backoffMs = Number.isFinite(options.rateLimitBackoffMs)
    ? Number(options.rateLimitBackoffMs)
    : RATE_LIMIT_BACKOFF_MS;
  const url = `${API_GETINFO}?vids=${encodeURIComponent(vid)}&platform=101001&charge=0&otype=json&defn=${encodeURIComponent(defn)}`;
  if (typeof onLog === 'function' && label) onLog('info', label);

  for (let attempt = 0; attempt < 2; attempt += 1) {
    const wait = lastCallAt + minGap - Date.now();
    if (wait > 0) await sleep(wait, signal);
    lastCallAt = Date.now();
    const text = await fetchGetinfoText(url, { signal, fetchImpl });
    const payload = parseGetinfoPayload(text);
    if (payload && payload.s === 'o') {
      if (payload.vl && payload.vl.vi && payload.vl.vi.length > 1) {
        throw new Error('这个视频在源站被切成了多段，当前版本暂不支持分段合并。');
      }
      return payload;
    }
    if (isRateLimited(payload) && attempt === 0) {
      if (typeof onLog === 'function') {
        onLog('warn', `腾讯视频接口提示频率限制，${Math.round(backoffMs / 100) / 10}s 后重试一次`);
      }
      await sleep(backoffMs, signal);
      continue;
    }
    throw new Error(describeGetinfoFailure(payload));
  }
  throw new Error('腾讯视频接口暂时不可用，请稍后再试。');
}

function pickVi(payload) {
  const vi = payload && payload.vl && Array.isArray(payload.vl.vi) ? payload.vl.vi[0] : null;
  if (!vi) throw new Error('腾讯视频没有返回播放信息。');
  return vi;
}

/**
 * 解析一个腾讯视频播放页，返回下载计划。
 * @param {string} input 播放页 URL
 * @param {{signal?:AbortSignal, fetchImpl?:Function, qn?:number, onLog?:Function, minGapMs?:number}} options
 */
export async function resolveTencent(input, options = {}) {
  const { signal, onLog } = options;
  const parsed = parseTencentUrl(input);
  if (!parsed) throw new Error('这不是可识别的腾讯视频地址。');
  if (parsed.kind === 'cover') {
    throw new Error(
      '这是腾讯视频的专辑 / 剧集页，地址里没有具体的视频号。请先点开某一集开始播放（地址形如 /x/cover/<专辑>/<视频>.html），再回来点下载。'
    );
  }

  throwIfAborted(signal);
  const wantQn = Number.isFinite(Number(options.qn)) && Number(options.qn) > 0 ? Number(options.qn) : 0;

  // 第一次：拿档位表（档位表与 defn 无关，用 shd 探一次即可）
  const probe = await requestGetinfo(parsed.vid, 'shd', options, '正在读取腾讯视频信息…');
  const probeVi = pickVi(probe);
  if (isDrmProtected(probeVi)) throw new Error(DRM_HINT);

  const qualities = buildTencentQualities(probe.fl);
  if (!qualities.length) throw new Error('这个视频没有返回可用的清晰度。');

  const target =
    (wantQn && qualities.find((item) => item.qn === wantQn && item.supported)) ||
    qualities.find((item) => item.supported) ||
    qualities[0];

  // 第二次：目标档不是探测到的那一档时，按该档的 defn 再取一次（每档的文件名不同）
  let vi = probeVi;
  if (Number(probeVi.br) !== target.qn) {
    const result = await requestGetinfo(parsed.vid, target.defn, options, `正在获取 ${target.label} 的播放地址…`);
    const nextVi = pickVi(result);
    if (isDrmProtected(nextVi)) throw new Error(DRM_HINT);
    vi = nextVi;
  }

  const url = buildTencentPlayUrl(vi);
  if (!url) throw new Error('腾讯视频没有返回可用的播放地址。');

  const title = sanitizeTencentName(vi.ti, 120) || parsed.vid;
  const durationSeconds = Number(vi.td) > 0 ? Number(vi.td) : 0;
  const sizeBytes = Number(vi.fs) > 0 ? Number(vi.fs) : target.sizeBytes;
  const width = Number(vi.vw) || 0;
  const height = Number(vi.vh) || target.height;
  const vid = parsed.vid;

  const selectedQuality = {
    ...target,
    width,
    height,
    sizeBytes,
    url,
    backups: buildTencentBackups(vi),
  };

  if (typeof onLog === 'function') {
    onLog('info', `已取到播放地址：${selectedQuality.label}，${vi.fn}`);
  }

  const acceptLabels = qualities.map((item) => item.label);
  const plan = {
    site: 'tencent',
    siteLabel: '腾讯视频',
    mode: 'file',
    container: 'mp4',
    encrypted: false,
    title,
    vid,
    cid: parsed.cid || String(vi.cid || ''),
    durationSeconds,
    sizeBytes,
    quality: selectedQuality,
    qualities: qualities.map((item) => (item.qn === selectedQuality.qn ? { ...selectedQuality } : { ...item })),
    url,
    backupUrls: selectedQuality.backups,
    referer: TENCENT_REFERER,
    requiresReferer: false,
    acceptLabels,
    requestedQn: wantQn || undefined,
    loggedIn: false,
    // 播放地址带时效：重新解析即可拿到新地址
    urlExpiresInSeconds: Number(probe.ret_valid_tm) || 0,
  };

  if (height <= 720) {
    plan.qualityHint = '（腾讯视频免费内容匿名最高 720P；会员 / 版权内容走 DRM 加密，本扩展不支持）';
  }
  return plan;
}

export { resetThrottleForTest };
