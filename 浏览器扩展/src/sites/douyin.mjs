/**
 * 抖音（douyin.com）视频解析。
 *
 * 特点：没有可用的公开接口（服务端还会返回 JS 挑战页），`aweme/v1/web/detail` 需要
 * a_bogus / X-Bogus 签名。所以这里不自己造接口，而是**读页面自己的数据**：
 *   window._ROUTER_DATA → RENDER_DATA → <video>.currentSrc
 * 具体提取在 src/core/page-data.mjs 里（MAIN world 注入），本文件只做 URL 解析与计划组装。
 *
 * 只支持：普通视频页 / 图文页里的视频 / v.douyin.com 短链。
 * 不支持：直播间、付费/课程、需要登录才能看的私密作品。
 */

/** 抖音 CDN 需要 Referer，缺了会 403 */
export const DOUYIN_REFERER = 'https://www.douyin.com/';

const HOST_RE = /(^|\.)(douyin\.com|iesdouyin\.com)$/i;

/** 这些路径只是账号/设置类页面，里面不会有可下载的视频 */
const NON_CONTENT_PATH = /^\/(login|passport|download|setting|verify|sso)\b/i;

/**
 * 解析抖音链接，纯函数。
 * @param {string} input
 * @returns {null | {kind:'video'|'short', awemeId?:string, shortUrl?:string, normalized:string}}
 */
export function parseDouyinUrl(input) {
  if (!input || typeof input !== 'string') return null;
  const raw = input.trim();
  if (!raw) return null;

  let url;
  try {
    url = new URL(raw.startsWith('http') ? raw : `https://${raw}`);
  } catch {
    return null;
  }
  const host = url.hostname.toLowerCase();
  if (!HOST_RE.test(host)) return null;

  // 短链：v.douyin.com / iesdouyin.com/share/...
  // 直播间不支持（地址形如 live.douyin.com/xxx）
  if (/^live\./.test(host)) return null;

  if (/^v\.douyin\.com$/.test(host)) {
    return { kind: 'short', shortUrl: url.href, normalized: url.href };
  }

  const video = url.pathname.match(/\/(?:share\/)?video\/(\d{6,})/);
  if (video) return { kind: 'video', awemeId: video[1], normalized: url.href };

  const note = url.pathname.match(/\/(?:share\/)?note\/(\d{6,})/);
  if (note) return { kind: 'video', awemeId: note[1], normalized: url.href };

  // 有些分享页把 id 放在 query 里（精选页点开某个作品就是这个形态）
  const queryId = url.searchParams.get('modal_id') || url.searchParams.get('aweme_id');
  if (/^\d{6,}$/.test(queryId || '')) {
    return { kind: 'video', awemeId: queryId, normalized: url.href };
  }

  // 信息流页面（首页推荐 / 精选 / 发现）：地址不随上滑下滑变化，
  // 当前是哪个作品只能到页面里现查，所以这里给一个 feed 类型，交给解析端处理。
  if (/^\/(discover|jingxuan|recommend|explore)?\/?$/.test(url.pathname) || url.searchParams.has('recommend')) {
    return { kind: 'feed', normalized: url.href };
  }

  // 个人主页 / 历史记录 / 合集 / 搜索 / 话题等：URL 里没有作品号，
  // 但页面上可能正播着一条（很多入口是原地弹层，地址都不变）。
  // 这里统一给 page 类型，由提取端按「正在播的那条」判定。
  if (!NON_CONTENT_PATH.test(url.pathname)) {
    return { kind: 'page', normalized: url.href };
  }
  return null;
}

/** 清洗文件名片段（与 B 站保持同一套规则） */
export function sanitizeDouyinName(text, maxLen = 60) {
  let s = String(text || '')
    .replace(/[\\/:*?"<>|\r\n\t#]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  s = s.replace(/[.\s]+$/g, '');
  if (s.length > maxLen) s = s.slice(0, maxLen).trim();
  return s || 'douyin';
}

/** 生成保存文件名：标题_awemeId.mp4 */
export function buildDouyinFilename({ title, awemeId }) {
  const parts = [sanitizeDouyinName(title, 60)];
  if (awemeId) parts.push(String(awemeId));
  let name = parts.filter(Boolean).join('_');
  if (name.length > 110) name = name.slice(0, 110).replace(/[.\s]+$/g, '');
  return `${name}.mp4`;
}

function abortError() {
  const err = new Error('已取消');
  err.name = 'AbortError';
  return err;
}

/** 把页面提取结果整理成「档位列表」，按码率从高到低 */
export function buildDouyinQualities(items) {
  const list = Array.isArray(items) ? items : [];
  return list
    .filter((item) => item && typeof item.url === 'string' && item.url.startsWith('http'))
    .map((item, index) => ({
      qn: Number(item.bitrate) || 1_000_000 - index,
      label: item.label || (item.height ? `${item.height}P` : '默认'),
      width: Number(item.width) || 0,
      height: Number(item.height) || 0,
      bitrate: Number(item.bitrate) || 0,
      sizeBytes: Number(item.size) || 0,
      url: item.url,
      backups: Array.isArray(item.backups) ? item.backups.filter((u) => typeof u === 'string') : [],
      supported: true,
    }))
    .sort((a, b) => b.bitrate - a.bitrate || b.height - a.height);
}

/**
 * 解析一个抖音视频页，返回下载计划。
 * @param {string} input 视频页 URL 或短链
 * @param {{signal?:AbortSignal, extractPageData?:Function, qn?:number, onLog?:Function}} options
 */
export async function resolveDouyin(input, options = {}) {
  const { onLog } = options;
  const parsed = parseDouyinUrl(input);
  if (!parsed) throw new Error('这不是可识别的抖音视频地址。');
  if (typeof options.extractPageData !== 'function') {
    throw new Error('缺少页面数据读取能力，无法解析抖音视频。');
  }
  if (options.signal && options.signal.aborted) throw abortError();

  if (typeof onLog === 'function') {
    onLog('info', parsed.kind === 'short' ? '正在展开抖音短链并读取页面数据…' : '正在读取抖音页面数据…');
  }
  const data = await options.extractPageData(parsed.normalized, {
    signal: options.signal,
    // 传入作品号，提取端会按 id 匹配，避免拿到信息流里「上一条」的数据
    expectedId: parsed.awemeId || '',
    // 页面形态：video / feed / page（个人主页、历史记录等）
    kind: parsed.kind,
  });
  if (!data || !data.ok) {
    if (parsed.kind === 'page') {
      throw new Error('这个页面没有正在播放的视频。请先点开目标视频（让它开始播放），再回来点「开始下载」。');
    }
    throw new Error('页面里没有找到视频信息。');
  }

  const qualities = buildDouyinQualities(data.qualities);
  if (qualities.length === 0) {
    throw new Error('这个页面没有可下载的视频（可能是图文作品、直播间或需要登录的作品）。');
  }

  const wantQn = Number(options.qn) > 0 ? Number(options.qn) : 0;
  const selected = (wantQn && qualities.find((q) => q.qn === wantQn)) || qualities[0];

  const durationSeconds = Number(data.durationMs) > 0 ? Number(data.durationMs) / 1000 : 0;
  // 页面给不出大小时按码率估算，用于进度显示
  const sizeBytes =
    selected.sizeBytes > 0
      ? selected.sizeBytes
      : selected.bitrate > 0 && durationSeconds > 0
        ? Math.round((selected.bitrate / 8) * durationSeconds)
        : 0;

  const SOURCE_LABEL = {
    capture: '页面接口（按作品号命中）',
    'capture-playing': '页面接口（按正在播放对齐）',
    'capture-last': '页面接口（最近一条）',
    router: '页面 SSR 数据',
    render: '旧版页面数据',
    video: '当前播放地址（无标题等元数据）',
  };
  if (typeof onLog === 'function') {
    onLog('info', `数据来源：${SOURCE_LABEL[data.source] || data.source || '未知'}`);
    onLog('info', `已获取 ${qualities.length} 档清晰度，选中 ${selected.label}${durationSeconds ? `，时长 ${durationSeconds.toFixed(1)}s` : ''}`);
  }

  const awemeId = String(data.awemeId || parsed.awemeId || '');
  return {
    site: 'douyin',
    siteLabel: '抖音',
    awemeId,
    title: String(data.title || '').trim(),
    owner: String(data.author || '').trim(),
    page: { index: 1, total: 1, part: '', durationSeconds },
    quality: {
      qn: selected.qn,
      label: selected.label,
      width: selected.width,
      height: selected.height,
    },
    qualities: qualities.map((q) => ({
      qn: q.qn,
      label: q.label,
      width: q.width,
      height: q.height,
      supported: true,
    })),
    selectedQn: selected.qn,
    requestedQn: wantQn,
    source: data.source || '',
    durationSeconds,
    sizeBytes,
    // 抖音给的是完整 MP4，直接存
    mode: 'file',
    url: selected.url,
    backupUrls: selected.backups,
    requiresReferer: true,
    referer: DOUYIN_REFERER,
    encrypted: false,
    container: 'mp4',
    muxed: true,
  };
}
