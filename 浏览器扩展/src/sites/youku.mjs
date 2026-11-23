/**
 * 优酷（youku.com）视频解析。
 *
 * 链路与前面几个站不同：优酷给的是 **HLS（m3u8）**，分片多为 TS + AES-128，
 * 所以下载走通用 HLS 核心（`src/core/index.mjs` 的 downloadHls），本文件只负责
 * 「解析 vid → 取 ups 播放信息 → 挑一档 m3u8 → 组装计划」。
 *
 * 关键接口（与 yt-dlp 的 Youku 实现一致）：
 *   GET https://ups.youku.com/ups/get.json
 *       ?vid=<vid>&ccode=0564&client_ip=192.168.1.1&utid=<cna>&client_ts=<秒/1000>
 *   返回 data.video（标题/时长/作者）+ data.stream[]（每档一条 m3u8_url）。
 *   utid 取 `https://log.mmstat.com/eg.js` 的 ETag（cna 设备标识）。
 *
 * 为什么优先在页面上下文里请求：
 *   优酷对匿名 / 陌生设备请求做了很强的风控（实测本机 IP 直接返回
 *   -6004「该账号检测到有可疑违规…已限制播放」，换 utid、换 ccode 都一样）。
 *   在用户自己的 youku.com 页面里发这个请求，Cookie 与网络出口都和真实播放一致，
 *   成功率最高；直连只作为回退。
 *
 * 不支持：需要会员 / 券 / 付费的内容；地区限制内容；DRM（优酷点播正片多为加密 DRM）。
 */

export const YOUKU_REFERER = 'https://v.youku.com/';

const UPS_API = 'https://ups.youku.com/ups/get.json';
const CNA_API = 'https://log.mmstat.com/eg.js';
const HOST_RE = /(^|\.)youku\.com$/i;

/** 清晰度档位的中文名（接口不给分辨率时兜底） */
const STREAM_LABEL = {
  hd3: '超清',
  mp4hd3: '超清',
  hd2: '高清',
  mp4hd2: '高清',
  mp4hd: '高清',
  mp4: '标清',
  flvhd: '高清',
  flv: '标清',
  '3gphd': '流畅',
  '3gp': '流畅',
};

/**
 * 解析优酷链接，纯函数。
 * @param {string} input
 * @returns {null | {kind:'video', vid:string, normalized:string}}
 */
export function parseYoukuUrl(input) {
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

  // /v_show/id_<vid>.html、/v_nextstage/id_<vid>.html、/alipay_video/id_<vid>.html
  const fromPath = url.pathname.match(/\/id_([A-Za-z0-9=]+?)(?:\.html)?$/i);
  if (fromPath) return { kind: 'video', vid: fromPath[1], normalized: url.href };

  // 兜底：/video?vid=<vid>、播放器 /embed/…?vid=
  const fromQuery = url.searchParams.get('vid');
  if (fromQuery && /^[A-Za-z0-9=]{6,}$/.test(fromQuery)) {
    return { kind: 'video', vid: fromQuery, normalized: url.href };
  }

  return null;
}

/** 清洗文件名片段 */
export function sanitizeYoukuName(text, maxLen = 60) {
  let s = String(text || '')
    .replace(/[\\/:*?"<>|\r\n\t]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  s = s.replace(/[.\s]+$/g, '');
  if (s.length > maxLen) s = s.slice(0, maxLen).trim();
  return s || 'youku';
}

/** 生成保存文件名：标题_视频号.mp4（去掉 vid 末尾的 base64 填充） */
export function buildYoukuFilename({ title, vid }) {
  const parts = [sanitizeYoukuName(title, 60)];
  const cleanVid = String(vid || '').replace(/=+$/, '');
  if (cleanVid) parts.push(cleanVid);
  let name = parts.filter(Boolean).join('_');
  if (name.length > 110) name = name.slice(0, 110).replace(/[.\s]+$/g, '');
  return `${name}.mp4`;
}

/**
 * 拼 ups 接口地址。
 * `utid` 默认用 `__CNA__` 占位：在页面上下文里会被替换成页面自己的 cna / __ysuid，
 * 免去扩展自己造设备号（扩展拿不到 httpOnly cookie，也拿不到 mmstat 的 ETag 以外信息）。
 */
export function buildUpsUrl(vid, { utid = '__CNA__', clientTs } = {}) {
  const ts = Number.isFinite(clientTs) ? Math.round(clientTs) : Math.floor(Date.now() / 1e6);
  const parts = [
    `vid=${encodeURIComponent(vid)}`,
    'ccode=0564',
    'client_ip=192.168.1.1',
    `utid=${utid === '__CNA__' ? '__CNA__' : encodeURIComponent(utid)}`,
    `client_ts=${ts}`,
  ];
  return `${UPS_API}?${parts.join('&')}`;
}

/** 优酷业务错误码 → 人话 */
export function describeYoukuError(error) {
  const code = Number(error && error.code);
  const note = String((error && error.note) || '').trim();
  if (note.includes('因版权原因无法观看')) {
    return '该视频因版权原因在当前地区无法观看（优酷的地区限制），无法下载。';
  }
  if (note.includes('私密')) return '该视频被设为私密，无法下载。';
  if (code === -6004) {
    return `优酷对当前网络 / 账号做了风控限制${note ? `（${note}）` : ''}。请先在浏览器里正常播放这个视频，确认能播后再点下载；仍不行时换网络（或登录后）再试。`;
  }
  if (code === -6005) return '优酷要求登录后才能取播放信息：请先在浏览器里登录优酷，再回来点「开始下载」。';
  if (code === -6003 || code === -6002) return '该视频需要会员 / 购买后才能观看，本扩展不支持。';
  if (code === -6001) return '视频不存在或已删除。';
  return `优酷接口返回错误${Number.isFinite(code) ? `（${code}）` : ''}${note ? `：${note}` : ''}`;
}

/**
 * 从 ups 响应里整理清晰度列表（按分辨率从高到低）。
 * `qn` 用高度（拿不到时用序号），切档时原样回传即可稳定命中。
 */
export function buildYoukuQualities(streams) {
  const list = (Array.isArray(streams) ? streams : [])
    .filter(
      (item) =>
        item &&
        typeof item.m3u8_url === 'string' &&
        /^https?:\/\//i.test(item.m3u8_url) &&
        item.channel_type !== 'tail'
    )
    .map((item, index) => {
      const height = Number(item.height) || 0;
      const width = Number(item.width) || 0;
      return {
        qn: height > 0 ? height : 900 - index,
        label: height > 0 ? `${height}P` : STREAM_LABEL[item.stream_type] || `档位 ${index + 1}`,
        width,
        height,
        bitrate: 0,
        sizeBytes: Number(item.size) || 0,
        url: item.m3u8_url,
        backups: [],
        supported: true,
        streamType: String(item.stream_type || ''),
      };
    })
    .sort((a, b) => b.height - a.height || b.sizeBytes - a.sizeBytes);

  // 同高度的不同封装（如 mp4hd / hd2）只保留体积最大的那条，避免下拉里出现两个 1080P
  const seen = new Map();
  for (const item of list) {
    const key = item.label;
    const exist = seen.get(key);
    if (!exist || item.sizeBytes > exist.sizeBytes) seen.set(key, item);
  }
  return [...seen.values()];
}

function abortError() {
  const err = new Error('已取消');
  err.name = 'AbortError';
  return err;
}

function throwIfAborted(signal) {
  if (signal && signal.aborted) throw abortError();
}

/** 取 cna（mmstat 的 ETag）：优酷 ups 的 utid 就用它 */
async function fetchCna({ signal, fetchImpl, timeoutMs = 15000 } = {}) {
  const doFetch = fetchImpl || fetch;
  if (typeof doFetch !== 'function') throw new Error('当前环境不支持 fetch');
  throwIfAborted(signal);
  const controller = new AbortController();
  const onAbort = () => controller.abort();
  if (signal) signal.addEventListener('abort', onAbort, { once: true });
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await doFetch(CNA_API, {
      signal: controller.signal,
      credentials: 'omit',
      cache: 'no-store',
      headers: { Accept: '*/*' },
    });
    if (!res.ok) return '';
    const etag = String(res.headers.get('etag') || '');
    return etag.replace(/^"+|"+$/g, '').trim();
  } catch {
    return '';
  } finally {
    clearTimeout(timer);
    if (signal) signal.removeEventListener('abort', onAbort);
  }
}

/** 直连请求 ups（扩展页 fetch，没有优酷 Cookie，作为回退） */
async function fetchUpsDirect(vid, options = {}) {
  const doFetch = options.fetchImpl || fetch;
  if (typeof doFetch !== 'function') throw new Error('当前环境不支持 fetch');
  throwIfAborted(options.signal);
  const cna = await fetchCna(options);
  const url = buildUpsUrl(vid, cna ? { utid: cna } : {});
  const controller = new AbortController();
  const onAbort = () => controller.abort();
  if (options.signal) options.signal.addEventListener('abort', onAbort, { once: true });
  const timer = setTimeout(() => controller.abort(), 20000);
  try {
    const res = await doFetch(url, {
      signal: controller.signal,
      credentials: 'omit',
      cache: 'no-store',
      headers: { Accept: 'application/json, text/plain, */*' },
    });
    if (!res.ok) throw new Error(`优酷接口返回 HTTP ${res.status}`);
    return await res.json();
  } catch (err) {
    if (options.signal && options.signal.aborted) throw abortError();
    if (err && err.name === 'AbortError') throw new Error('优酷接口请求超时');
    throw new Error(`无法访问优酷接口：${err && err.message ? err.message : err}`);
  } finally {
    clearTimeout(timer);
    if (options.signal) options.signal.removeEventListener('abort', onAbort);
  }
}

/**
 * 解析一个优酷播放页，返回下载计划。
 * @param {string} input 播放页 URL
 * @param {{signal?:AbortSignal, fetchImpl?:Function, fetchJsonInPage?:Function,
 *          qn?:number, onLog?:Function}} options
 */
export async function resolveYouku(input, options = {}) {
  const { signal, onLog } = options;
  const parsed = parseYoukuUrl(input);
  if (!parsed) throw new Error('这不是可识别的优酷视频地址。');

  throwIfAborted(signal);
  if (typeof onLog === 'function') onLog('info', '正在读取优酷播放信息…');

  let payload = null;
  let pageError = null;

  // 1) 页面上下文（带 Cookie、与真实播放同一网络出口）
  if (typeof options.fetchJsonInPage === 'function') {
    try {
      payload = await options.fetchJsonInPage(buildUpsUrl(parsed.vid), { signal });
    } catch (err) {
      pageError = err;
      if (typeof onLog === 'function') onLog('warn', `页面上下文取播放信息失败：${err.message}`);
    }
  }

  // 2) 直连回退（自己取 cna 当 utid）
  if (!payload) {
    try {
      payload = await fetchUpsDirect(parsed.vid, options);
      if (typeof onLog === 'function') onLog('info', '已改用直连方式读取优酷播放信息');
    } catch (err) {
      if (pageError) throw new Error(`${pageError.message}；直连也失败：${err.message}`);
      throw err;
    }
  }

  const data = payload && payload.data ? payload.data : {};
  if (data.error) throw new Error(describeYoukuError(data.error));

  const video = data.video || {};
  const qualities = buildYoukuQualities(data.stream);
  if (!qualities.length) {
    throw new Error('优酷没有返回可下载的播放列表（可能是会员 / 付费 / 地区限制内容）。');
  }

  const wantQn = Number.isFinite(Number(options.qn)) && Number(options.qn) > 0 ? Number(options.qn) : 0;
  const selected = (wantQn && qualities.find((item) => item.qn === wantQn)) || qualities[0];

  const title = sanitizeYoukuName(video.title, 120) || parsed.vid;
  const durationSeconds = Number(video.seconds) > 0 ? Number(video.seconds) : 0;

  const plan = {
    site: 'youku',
    siteLabel: '优酷',
    // 站点给的是 HLS：交给通用 HLS 核心下载（分片 + AES-128 + 封装 MP4）
    mode: 'hls',
    container: 'mp4',
    encrypted: true,
    title,
    vid: parsed.vid,
    owner: String(video.username || '').trim(),
    durationSeconds,
    sizeBytes: selected.sizeBytes,
    quality: selected,
    qualities,
    playlistUrl: selected.url,
    url: selected.url,
    referer: YOUKU_REFERER,
    requiresReferer: true,
    acceptLabels: qualities.map((item) => item.label),
    requestedQn: wantQn || undefined,
    loggedIn: false,
    qualityHint: '（优酷只给 HLS 播放列表；付费 / 会员内容多为 DRM，本扩展不支持）',
  };
  return plan;
}
