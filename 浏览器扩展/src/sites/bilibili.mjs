/**
 * B 站（bilibili.com）视频解析。
 *
 * 设计要点：
 *  - 纯逻辑（URL 解析 / 清晰度选择 / 文件名 / 错误映射）与网络调用分离，
 *    前者不依赖 fetch / chrome.*，可在 Node 里直接单测；
 *  - 只用公开的 web 接口：/x/web-interface/view 与 /x/player/wbi/playurl?fnval=1，
 *    后者返回**整段 MP4**（H.264 + AAC 已封装好），因此下载阶段无需解复用/重新封装；
 *  - 高清晰度需要 WBI 签名（w_rid）+ 登录态，两者都通过「在 B 站页面上下文里发请求」解决；
 *  - 不处理番剧（ep/ss）、付费/大会员、DRM 内容，遇到时给出明确中文提示。
 */

import { signWbi, extractWbiKey, encodeWbiParams } from './wbi.mjs';

const API_VIEW = 'https://api.bilibili.com/x/web-interface/view';
const API_PLAYURL = 'https://api.bilibili.com/x/player/playurl';
const API_PLAYURL_WBI = 'https://api.bilibili.com/x/player/wbi/playurl';
const API_NAV = 'https://api.bilibili.com/x/web-interface/nav';

/** durl（整段 MP4）通道能拿到的最高清晰度；更高档只有 DASH 分离轨道 */
export const DURL_MAX_QN = 80;

/** 清晰度编号 → 展示名 / 预估分辨率（B 站 qn 定义） */
export const QUALITY_TABLE = {
  127: { label: '8K', width: 7680, height: 4320 },
  126: { label: '杜比视界', width: 1920, height: 1080 },
  125: { label: 'HDR', width: 1920, height: 1080 },
  120: { label: '4K', width: 3840, height: 2160 },
  116: { label: '1080P60', width: 1920, height: 1080 },
  112: { label: '1080P+', width: 1920, height: 1080 },
  80: { label: '1080P', width: 1920, height: 1080 },
  74: { label: '720P60', width: 1280, height: 720 },
  64: { label: '720P', width: 1280, height: 720 },
  32: { label: '480P', width: 852, height: 480 },
  16: { label: '360P', width: 640, height: 360 },
  6: { label: '240P', width: 426, height: 240 },
};

/** B 站接口错误码 → 中文说明（只列常见/需要给用户解释的） */
export const ERROR_MESSAGES = {
  '-400': '请求参数有误，可能是视频地址不完整。',
  '-403': '接口拒绝访问（-403），通常是请求过于频繁，请稍后再试。',
  '-404': '视频不存在或已被删除。',
  '-10403': '该内容仅限特定地区观看，当前网络无法访问。',
  '87007': '该视频为付费内容，需要购买后才能观看。',
  '87008': '该视频仅限大会员观看。',
  '-10001': '账号未登录，无法获取该清晰度。',
};

/** 番剧 / 影视等需要登录或付费的内容，明确不支持 */
const UNSUPPORTED_HINT = '番剧、影视等 PGC 内容（/bangumi/）涉及登录与版权限制，本扩展不支持下载。';

/**
 * 解析 B 站链接，纯函数。
 * @param {string} input 完整 URL 或裸 BV 号
 * @returns {null | {kind:'video'|'bangumi'|'short', bvid?:string, aid?:number, page:number, shortUrl?:string, normalized:string}}
 */
export function parseBilibiliUrl(input) {
  if (!input || typeof input !== 'string') return null;
  const raw = input.trim();
  if (!raw) return null;

  // 裸 BV 号
  const bare = raw.match(/^(BV[0-9A-Za-z]{10})$/);
  if (bare) {
    return { kind: 'video', bvid: bare[1], page: 1, normalized: `https://www.bilibili.com/video/${bare[1]}` };
  }

  let url;
  try {
    url = new URL(raw.startsWith('http') ? raw : `https://${raw}`);
  } catch {
    return null;
  }
  const host = url.hostname.toLowerCase();
  if (!/(^|\.)bilibili\.com$/.test(host) && host !== 'b23.tv' && host !== 'bili2233.cn') return null;

  if (host === 'b23.tv' || host === 'bili2233.cn') {
    return { kind: 'short', page: 1, shortUrl: url.href, normalized: url.href };
  }

  const path = url.pathname;
  if (path.startsWith('/bangumi/')) {
    return { kind: 'bangumi', page: 1, normalized: url.href };
  }

  const bv = path.match(/\/video\/(BV[0-9A-Za-z]{10})/);
  if (bv) {
    const page = Number.parseInt(url.searchParams.get('p') || '1', 10);
    return {
      kind: 'video',
      bvid: bv[1],
      page: Number.isFinite(page) && page > 0 ? page : 1,
      normalized: `https://www.bilibili.com/video/${bv[1]}`,
    };
  }
  const av = path.match(/\/video\/av(\d+)/i);
  if (av) {
    const page = Number.parseInt(url.searchParams.get('p') || '1', 10);
    return {
      kind: 'video',
      aid: Number.parseInt(av[1], 10),
      page: Number.isFinite(page) && page > 0 ? page : 1,
      normalized: `https://www.bilibili.com/video/av${av[1]}`,
    };
  }

  // 有些入口不在 /video/ 路径下，视频号在 query 里，例如：
  //   /list/watchlater?bvid=BV1xx&oid=123（稍后再看）
  //   /list/ml123456?bvid=BV1xx&oid=123（收藏夹播放）
  //   /medialist/play/ml123456?bvid=BV1xx
  //   /festival/xxx?bvid=BV1xx（活动页内嵌播放）
  // 这类页面同样在放视频，必须认出来，否则弹窗会退化成「检测到的 M3U8」。
  const pageParam = Number.parseInt(url.searchParams.get('p') || '1', 10);
  const pageNumber = Number.isFinite(pageParam) && pageParam > 0 ? pageParam : 1;

  const queryBv = url.searchParams.get('bvid');
  if (/^BV[0-9A-Za-z]{10}$/.test(queryBv || '')) {
    return {
      kind: 'video',
      bvid: queryBv,
      page: pageNumber,
      normalized: `https://www.bilibili.com/video/${queryBv}`,
    };
  }

  // oid 在部分页面是 cid / 季 id，只在明确的播放列表路径下才当作 av 号
  if (/^\/(list|medialist)\//.test(path)) {
    const queryAid = url.searchParams.get('oid') || url.searchParams.get('aid') || '';
    if (/^\d{1,12}$/.test(queryAid)) {
      return {
        kind: 'video',
        aid: Number.parseInt(queryAid, 10),
        page: pageNumber,
        normalized: `https://www.bilibili.com/video/av${queryAid}`,
      };
    }
  }
  return null;
}

/** 从 view 接口的 pages 里挑选第 N P（越界时退回第 1 P），纯函数 */
export function pickPage(pages, pageNumber) {
  if (!Array.isArray(pages) || pages.length === 0) return null;
  const index = Number.isFinite(pageNumber) && pageNumber > 0 ? pageNumber - 1 : 0;
  const page = pages[Math.min(index, pages.length - 1)];
  if (!page) return null;
  return {
    cid: Number(page.cid),
    index: Math.min(index, pages.length - 1) + 1,
    part: String(page.part || ''),
    durationSeconds: Number(page.duration) || 0,
    total: pages.length,
  };
}

/**
 * 在可接受清晰度里选最高的一档，纯函数。
 * @param {number[]} acceptQuality 接口返回的 accept_quality
 * @param {number} returned 接口实际返回的 quality
 */
export function pickQuality(acceptQuality, returned) {
  const list = Array.isArray(acceptQuality)
    ? acceptQuality.map((q) => Number(q)).filter((q) => Number.isFinite(q) && QUALITY_TABLE[q])
    : [];
  if (list.length === 0) {
    const fallback = QUALITY_TABLE[returned] || null;
    return { qn: Number(returned) || 0, ...(fallback || { label: '未知', width: 0, height: 0 }) };
  }
  const best = list.reduce((a, b) => (b > a ? b : a), list[0]);
  return { qn: best, ...QUALITY_TABLE[best] };
}

/**
 * 把「真实可下载的清晰度编号」变成下拉选项，纯函数。
 * 只列出确实能下到的档位（DASH 有对应 H.264 轨，或 durl 直接给整段 MP4）。
 */
export function buildQualityOptions(qns) {
  const list = Array.isArray(qns) ? qns : [];
  return list
    .map((qn) => Number(qn))
    .filter((qn) => QUALITY_TABLE[qn])
    .sort((a, b) => b - a)
    .map((qn) => ({
      qn,
      label: QUALITY_TABLE[qn].label,
      width: QUALITY_TABLE[qn].width,
      height: QUALITY_TABLE[qn].height,
      supported: true,
    }));
}

/** 把任意标题清洗成安全的文件名片段，纯函数 */
export function sanitizeFilenamePart(text, maxLen = 60) {
  let s = String(text || '')
    .replace(/[\\/:*?"<>|\r\n\t]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  // Windows 不允许结尾的点与空格
  s = s.replace(/[.\s]+$/g, '');
  if (s.length > maxLen) s = s.slice(0, maxLen).trim();
  return s || 'video';
}

/**
 * 生成保存文件名：标题_BV号[_P2]_720P.mp4，纯函数。
 * 总长度控制在 120 字符以内，避免 Windows 路径过长。
 */
export function buildBilibiliFilename({ title, bvid, page, pageIndex, qualityLabel }) {
  const parts = [sanitizeFilenamePart(title, 60)];
  const id = String(bvid || '').trim();
  if (id) parts.push(id);
  if (Number(pageIndex) > 1) parts.push(`P${pageIndex}`);
  if (qualityLabel) parts.push(sanitizeFilenamePart(qualityLabel, 16));
  let name = parts.filter(Boolean).join('_');
  if (name.length > 110) name = name.slice(0, 110).replace(/[.\s]+$/g, '');
  return `${name}.mp4`;
}

/** 接口 code → 中文说明，纯函数 */
export function describeBilibiliError(code, message) {
  const key = String(code);
  if (ERROR_MESSAGES[key]) return ERROR_MESSAGES[key];
  if (key === '-101') return '账号未登录或登录已过期。';
  if (message) return `B 站接口返回错误（${key}）：${message}`;
  return `B 站接口返回错误（${key}）。`;
}

/** 判断接口返回是否成功，纯函数 */
export function assertApiOk(payload, label = 'B 站接口') {
  if (!payload || typeof payload !== 'object') {
    throw new Error(`${label}返回内容为空。`);
  }
  if (payload.code !== 0) {
    throw new Error(describeBilibiliError(payload.code, payload.message));
  }
  return payload.data;
}

function defaultFetch() {
  if (typeof fetch !== 'function') throw new Error('当前环境不支持 fetch');
  return fetch;
}

function abortError() {
  const err = new Error('已取消');
  err.name = 'AbortError';
  return err;
}

function throwIfAborted(signal) {
  if (signal && signal.aborted) throw abortError();
}

/** 带超时与重试的 JSON 请求（扩展页同源豁免 CORS，无需 Referer） */
async function getJson(url, { signal, fetchImpl, timeoutMs = 20000, retries = 2, onLog } = {}) {
  const doFetch = fetchImpl || defaultFetch();
  let lastError = null;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    throwIfAborted(signal);
    const controller = new AbortController();
    const onAbort = () => controller.abort();
    if (signal) signal.addEventListener('abort', onAbort, { once: true });
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await doFetch(url, {
        signal: controller.signal,
        credentials: 'include',
        headers: { Accept: 'application/json' },
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } catch (err) {
      lastError = err;
      if (signal && signal.aborted) throw abortError();
      if (attempt < retries) {
        const wait = 400 * 2 ** attempt;
        if (typeof onLog === 'function') onLog('warn', `B 站接口请求失败（${err.message}），${wait}ms 后重试`);
        await new Promise((r) => setTimeout(r, wait));
      }
    } finally {
      clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', onAbort);
    }
  }
  throw new Error(`无法访问 B 站接口：${lastError ? lastError.message : '未知错误'}`);
}

/** 展开 b23.tv 短链，返回真实 URL */
export async function resolveShortLink(shortUrl, options = {}) {
  const doFetch = options.fetchImpl || defaultFetch();
  const res = await doFetch(shortUrl, {
    signal: options.signal,
    redirect: 'follow',
    credentials: 'include',
  });
  const finalUrl = res.url || shortUrl;
  if (typeof res.body?.cancel === 'function') {
    try {
      await res.body.cancel();
    } catch {
      /* 忽略 */
    }
  }
  return finalUrl;
}

/** 查询登录状态与 WBI 密钥（仅用于取播放地址与界面提示，失败不影响下载） */
export async function fetchNavState(options = {}) {
  const empty = { loggedIn: false, vip: false, imgKey: '', subKey: '' };
  try {
    const payload =
      typeof options.fetchJsonInPage === 'function'
        ? await options.fetchJsonInPage(API_NAV, { signal: options.signal })
        : await getJson(API_NAV, { ...options, retries: 0 });
    const data = payload && payload.data;
    const wbi = data && data.wbi_img;
    return {
      loggedIn: Boolean(data && data.isLogin),
      vip: Boolean(data && data.vipStatus === 1),
      imgKey: extractWbiKey(wbi && wbi.img_url),
      subKey: extractWbiKey(wbi && wbi.sub_url),
    };
  } catch {
    return empty;
  }
}

/** 兼容旧名字 */
export async function fetchLoginState(options = {}) {
  const state = await fetchNavState(options);
  return { loggedIn: state.loggedIn, vip: state.vip };
}

/**
 * 取播放地址：优先在 B 站页面上下文里请求（带登录态 → 可到 1080P），
 * 失败或没给可用地址时回退到扩展页匿名请求（最高 720P）。
 */
async function loadPlayPayload(playUrl, options) {
  const { onLog } = options;
  if (typeof options.fetchJsonInPage === 'function') {
    try {
      const payload = await options.fetchJsonInPage(playUrl, { signal: options.signal });
      const data = (payload && payload.data) || {};
      const hasDurl = Array.isArray(data.durl) && data.durl.length > 0;
      const hasDash = Boolean(data.dash && Array.isArray(data.dash.video) && data.dash.video.length > 0);
      if (payload && payload.code === 0 && (hasDurl || hasDash)) {
        return { payload, via: 'page' };
      }
      if (typeof onLog === 'function') {
        const reason = payload && payload.code !== 0 ? describeBilibiliError(payload.code, payload.message) : '没有返回可下载地址';
        onLog('warn', `带登录态取播放地址未成功（${reason}），改用匿名请求`);
      }
    } catch (err) {
      if (typeof onLog === 'function') onLog('warn', `带登录态取播放地址失败（${err.message}），改用匿名请求`);
    }
  }
  const payload = await getJson(playUrl, options);
  return { payload, via: 'anonymous' };
}

/**
 * 解析一个 B 站视频页，返回可直接下载的计划。
 * @param {string} input 视频页 URL 或 BV 号
 * @param {{signal?:AbortSignal, fetchImpl?:Function, fetchJsonInPage?:Function, onLog?:Function}} options
 */
export async function resolveBilibili(input, options = {}) {
  const { signal, onLog } = options;
  let parsed = parseBilibiliUrl(input);
  if (!parsed) throw new Error('这不是可识别的 B 站视频地址。');
  if (parsed.kind === 'bangumi') throw new Error(UNSUPPORTED_HINT);

  if (parsed.kind === 'short') {
    if (typeof onLog === 'function') onLog('info', '正在展开 b23.tv 短链接…');
    const real = await resolveShortLink(parsed.shortUrl, options);
    parsed = parseBilibiliUrl(real);
    if (!parsed || parsed.kind !== 'video') throw new Error('短链接展开后不是 B 站视频页。');
    if (typeof onLog === 'function') onLog('info', `短链接已展开：${parsed.normalized}`);
  }

  throwIfAborted(signal);

  const viewQuery = parsed.bvid ? `bvid=${encodeURIComponent(parsed.bvid)}` : `aid=${parsed.aid}`;
  const viewPayload = await getJson(`${API_VIEW}?${viewQuery}`, options);
  const view = assertApiOk(viewPayload, '视频信息接口');
  if (!view) throw new Error('视频信息为空。');

  const pageInfo = pickPage(view.pages, parsed.page);
  if (!pageInfo || !pageInfo.cid) throw new Error('无法确定视频分 P（cid 缺失）。');

  if (view.is_upower_exclusive) throw new Error('该视频为充电专属内容，本扩展不支持。');
  if (view.rights && view.rights.pay && !view.rights.ugc_pay_preview) {
    // 付费课程等
    throw new Error('该视频为付费内容，本扩展不支持。');
  }

  throwIfAborted(signal);

  // 一次 nav 解决两件事：判断登录态（界面提示）+ 取 WBI 密钥（签名用）
  const nav = await fetchNavState({ ...options, signal });
  const wantQn = Number.isFinite(Number(options.qn)) && Number(options.qn) > 0 ? Number(options.qn) : 0;

  /** 带 WBI 签名请求 playurl；签名被拒时自动回退普通接口 */
  const requestPlay = async (params, label) => {
    const signed = nav.imgKey && nav.subKey ? signWbi(params, nav.imgKey, nav.subKey) : null;
    const plainUrl = `${API_PLAYURL}?${encodeWbiParams(params)}`;
    const firstUrl = signed ? `${API_PLAYURL_WBI}?${signed.query}` : plainUrl;
    if (typeof onLog === 'function') {
      onLog('info', `正在请求${label}（qn=${params.qn}${signed ? '，带 WBI 签名' : ''}）…`);
    }
    let { payload, via } = await loadPlayPayload(firstUrl, options);
    try {
      return { play: assertApiOk(payload, '播放地址接口'), via };
    } catch (err) {
      if (!signed) throw err;
      if (typeof onLog === 'function') onLog('warn', `WBI 签名请求失败（${err.message}），改用普通接口重试`);
      ({ payload, via } = await loadPlayPayload(plainUrl, options));
      return { play: assertApiOk(payload, '播放地址接口'), via };
    }
  };

  // ---- 1) DASH：按「真实存在的 H.264 轨道」确定可选清晰度 ----
  const dashResult = await requestPlay(
    { bvid: view.bvid, cid: pageInfo.cid, qn: wantQn || 120, fnval: 4048, fourk: 1 },
    '播放地址（DASH）'
  );
  const dashPlay = dashResult.play;
  const qualityVia = dashResult.via;
  const dash = dashPlay.dash || {};
  const avcTracks = new Map(); // qn -> 轨道（只留 H.264：合并器只支持 AVC）
  for (const track of Array.isArray(dash.video) ? dash.video : []) {
    if (!/^avc1/i.test(String(track.codecs || ''))) continue;
    const qn = Number(track.id);
    if (!QUALITY_TABLE[qn]) continue;
    const existing = avcTracks.get(qn);
    if (!existing || Number(track.bandwidth) > Number(existing.bandwidth)) avcTracks.set(qn, track);
  }
  const dashQns = [...avcTracks.keys()].sort((a, b) => b - a);

  // ---- 2) durl：1080P 及以下还能拿到「整段 MP4」，省掉合并 ----
  let durlPlay = null;
  if (!wantQn || wantQn <= DURL_MAX_QN) {
    try {
      const durlParams = { bvid: view.bvid, cid: pageInfo.cid, qn: wantQn || DURL_MAX_QN, fnval: 1, fourk: 1 };
      durlPlay = (await requestPlay(durlParams, '播放地址（整段 MP4）')).play;
    } catch (err) {
      if (typeof onLog === 'function') onLog('warn', `整段 MP4 通道不可用：${err.message}`);
    }
  }
  const durlList = durlPlay && Array.isArray(durlPlay.durl) ? durlPlay.durl.filter((d) => d && d.url) : [];
  // 只有单段时才用 durl；多段说明 B 站拆过，交给 DASH
  const durlQn = durlList.length === 1 ? Number(durlPlay.quality) : 0;

  const availableQns = [...new Set([...dashQns, ...(durlQn ? [durlQn] : [])])].sort((a, b) => b - a);
  if (availableQns.length === 0) {
    throw new Error('该视频没有可下载的清晰度（可能是互动视频、番剧或需要登录的内容）。');
  }
  const selectedQn = availableQns.includes(wantQn) ? wantQn : availableQns[0];
  const quality = { qn: selectedQn, ...QUALITY_TABLE[selectedQn] };
  const qualities = buildQualityOptions(availableQns);
  const durationSeconds =
    Number(dash.duration) || (Number(dashPlay.timelength) || 0) / 1000 || pageInfo.durationSeconds;

  // ---- 3) 决定下载方式 ----
  let mode = 'dash';
  let url = '';
  let backupUrls = [];
  let video = null;
  let audio = null;
  let sizeBytes = 0;

  if (durlQn === selectedQn) {
    mode = 'file';
    url = durlList[0].url;
    backupUrls = Array.isArray(durlList[0].backup_url) ? durlList[0].backup_url.slice() : [];
    sizeBytes = Number(durlList[0].size) || 0;
  } else {
    const track = avcTracks.get(selectedQn);
    if (!track) {
      throw new Error(`清晰度 ${QUALITY_TABLE[selectedQn].label} 没有 H.264 轨道，暂不支持合并，请换 1080P 及以下。`);
    }
    const audioList = Array.isArray(dash.audio) ? dash.audio.slice() : [];
    const bestAudio = audioList.sort((a, b) => Number(b.bandwidth) - Number(a.bandwidth))[0];
    if (!bestAudio) throw new Error('DASH 没有返回音频轨，无法合并。');
    const videoUrl = track.baseUrl || track.base_url;
    const audioUrl = bestAudio.baseUrl || bestAudio.base_url;
    if (!videoUrl || !audioUrl) throw new Error('DASH 轨道地址缺失。');
    video = {
      url: videoUrl,
      backupUrls: (track.backupUrl || track.backup_url || []).slice(),
      width: Number(track.width) || QUALITY_TABLE[selectedQn].width,
      height: Number(track.height) || QUALITY_TABLE[selectedQn].height,
    };
    audio = { url: audioUrl, backupUrls: (bestAudio.backupUrl || bestAudio.backup_url || []).slice() };
    const dur = durationSeconds || pageInfo.durationSeconds;
    sizeBytes = Math.round((((Number(track.bandwidth) || 0) + (Number(bestAudio.bandwidth) || 0)) / 8) * dur);
  }

  if (selectedQn < DURL_MAX_QN && typeof onLog === 'function') {
    if (!nav.loggedIn) {
      onLog('info', 'B 站未登录：接口最高只下发 720P；登录 bilibili.com 后可到 1080P（1080P+ / 4K 需大会员）。');
    } else {
      onLog('warn', `已登录，但接口只给了 ${quality.label}：可能是该视频最高就这档。`);
    }
  }

  return {
    site: 'bilibili',
    siteLabel: 'B站',
    bvid: view.bvid,
    aid: view.aid,
    title: String(view.title || '').trim(),
    owner: view.owner && view.owner.name ? String(view.owner.name) : '',
    page: pageInfo,
    quality,
    qualities,
    requestedQn: wantQn,
    selectedQn,
    qualityVia,
    loggedIn: nav.loggedIn,
    vip: nav.vip,
    acceptLabels: qualities.map((q) => q.label),
    durationSeconds,
    sizeBytes,
    // 下载方式：file = 整段 MP4 直存；dash = 视频轨 + 音频轨合并
    mode,
    url,
    backupUrls,
    video,
    audio,
    requiresReferer: true,
    referer: 'https://www.bilibili.com',
    encrypted: false,
    container: 'mp4',
    muxed: mode === 'file',
  };
}
