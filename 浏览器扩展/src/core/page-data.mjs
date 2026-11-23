/**
 * 在真实页面上下文里取站点数据（抖音这类没有公开接口、且服务端返回 JS 挑战页的站点）。
 *
 * 抖音的视频地址只有页面自己知道，而且**不同页面形态差别很大**：
 *   - 精选页 / 推荐页是信息流 SPA：没有 _ROUTER_DATA，视频地址只出现在它自己请求的
 *     `aweme/v1/web/aweme/detail/` 响应里；点击推荐视频是在弹层里换数据，URL 可能只变
 *     `?modal_id=`。
 *   - 老作品页可能带 _ROUTER_DATA / RENDER_DATA。
 *   - `<video>.currentSrc` 只在真的开始播放后才有，后台标签页会被禁自动播放，不能当主路径。
 *
 * 所以这里的分工是：
 *   1. `src/page/douyin-capture.js`（document_start 注入 MAIN world）先把页面自己拿到的
 *      作品详情按 aweme_id 缓存在 window 上；
 *   2. 本模块负责「把标签页导航到正确的那一条」并按 id 轮询取数；
 *   3. 取不到时才退回 _ROUTER_DATA / RENDER_DATA / <video>。
 */

/** 比较两个抖音页面是否指向同一个作品（modal_id / aweme_id 是身份，其余 query 不算） */
export function samePageUrl(a, b) {
  let ua;
  let ub;
  try {
    ua = new URL(a);
    ub = new URL(b);
  } catch {
    return false;
  }
  if (ua.hostname !== ub.hostname) return false;
  const idOf = (u) => {
    const fromQuery = u.searchParams.get('modal_id') || u.searchParams.get('aweme_id');
    if (fromQuery) return fromQuery;
    const fromPath = u.pathname.match(/\/(?:video|note)\/(\d{6,})/);
    return fromPath ? fromPath[1] : '';
  };
  const ida = idOf(ua);
  const idb = idOf(ub);
  if (ida || idb) return ida === idb;
  return ua.pathname.replace(/\/$/, '') === ub.pathname.replace(/\/$/, '');
}

/** 在页面里执行的抖音提取函数（MAIN world，自包含；导出仅为单测用） */
export function extractDouyinInPage(expectedId, kind) {
  const MAX_NODES = 20000;
  const out = { ok: false, source: '', awemeId: '', title: '', author: '', durationMs: 0, qualities: [] };
  const text = (value) => (typeof value === 'string' ? value.trim() : '');
  const wantId = typeof expectedId === 'string' ? expectedId : '';
  const pageKind = typeof kind === 'string' ? kind : '';

  const findAweme = (root) => {
    if (!root || typeof root !== 'object') return null;
    const seen = new Set();
    const stack = [root];
    let visited = 0;
    while (stack.length && visited < MAX_NODES) {
      const node = stack.pop();
      if (!node || typeof node !== 'object' || seen.has(node)) continue;
      seen.add(node);
      visited += 1;
      if (node.video && node.video.play_addr && Array.isArray(node.video.play_addr.url_list)) return node;
      for (const key of Object.keys(node)) {
        const value = node[key];
        if (value && typeof value === 'object') stack.push(value);
      }
    }
    return null;
  };

  const collect = (aweme) => {
    if (!aweme || !aweme.video) return false;
    const video = aweme.video;
    if (text(aweme.desc)) out.title = text(aweme.desc);
    if (aweme.author && text(aweme.author.nickname)) out.author = text(aweme.author.nickname);
    if (Number(video.duration)) out.durationMs = Number(video.duration);
    out.awemeId = text(aweme.aweme_id) || text(aweme.awemeId);

    const pushAddr = (addr, label, bitrate) => {
      const list = (addr && Array.isArray(addr.url_list) ? addr.url_list : []).filter(
        (u) => typeof u === 'string' && u.startsWith('http')
      );
      if (!list.length) return;
      out.qualities.push({
        label: label || '',
        width: Number(addr.width) || 0,
        height: Number(addr.height) || 0,
        bitrate: Number(bitrate) || 0,
        size: Number(addr.data_size) || 0,
        url: list[0],
        backups: list.slice(1),
      });
    };

    if (Array.isArray(video.bit_rate)) {
      for (const item of video.bit_rate) {
        const gear = text(item && item.gear_name);
        const digits = (gear.match(/(\d{3,4})/) || [])[1];
        const height = Number(item && item.play_addr && item.play_addr.height) || 0;
        const label = height ? `${height}P` : digits ? `${digits}P` : '';
        pushAddr(item && item.play_addr, label, item && item.bit_rate);
      }
    }
    pushAddr(video.play_addr, '', 0);
    pushAddr(video.download_addr, '', 0);

    const byUrl = new Map();
    for (const q of out.qualities) {
      const key = q.url.split('?')[0];
      const exist = byUrl.get(key);
      if (!exist || q.bitrate > exist.bitrate) byUrl.set(key, q);
    }
    out.qualities = [...byUrl.values()];
    return out.qualities.length > 0;
  };

  /** 页面里的 <video>：优先正在播的、其次面积最大的（可能是多个） */
  const pickBestVideo = () => {
    const videos = document.querySelectorAll ? Array.from(document.querySelectorAll('video')) : [];
    return (
      videos
        .map((video) => {
          const src = (video && (video.currentSrc || video.src)) || '';
          const area = (Number(video.videoWidth) || 0) * (Number(video.videoHeight) || 0);
          const playing = video.paused === false && video.ended !== true ? 1 : 0;
          return { src, video, area, playing };
        })
        .filter((entry) => entry.src)
        .sort((a, b) => b.playing - a.playing || b.area - a.area)[0] || null
    );
  };

  /** 取一个作品里所有可能的播放地址（含备用地址），用于和当前播放的 src 对齐 */
  const awemeUrls = (item) => {
    const urls = [];
    const video = (item && item.video) || {};
    const push = (addr) => {
      if (!addr) return;
      if (Array.isArray(addr.url_list)) urls.push(...addr.url_list.filter((u) => typeof u === 'string'));
      if (Array.isArray(addr.backup_url)) urls.push(...addr.backup_url.filter((u) => typeof u === 'string'));
    };
    push(video.play_addr);
    push(video.download_addr);
    if (Array.isArray(video.bit_rate)) for (const br of video.bit_rate) push(br && br.play_addr);
    return urls;
  };

  const pathOf = (u) => {
    try {
      return new URL(u).pathname;
    } catch {
      return '';
    }
  };

  /**
   * 判断「缓存里的这条作品」是不是画面上正在播的那条：
   *   地址路径完全一致 → 100 分（最可靠）
   *   时长一致（±0.8s）→ 60 分（换了码率时路径会变，但时长不变）
   * 只有 ≥60 分才算认出来，避免把邻近的视频当成当前那条。
   */
  const matchScore = (item, playing) => {
    const targetPath = playing.src && playing.src.startsWith('http') ? pathOf(playing.src) : '';
    if (targetPath && awemeUrls(item).some((u) => pathOf(u) === targetPath)) return 100;
    const playingDuration = Number(playing.video && playing.video.duration) || 0;
    const itemDuration = Number(item && item.video && item.video.duration) / 1000 || 0;
    if (playingDuration > 1 && itemDuration > 1 && Math.abs(playingDuration - itemDuration) < 0.8) return 60;
    return 0;
  };

  const bestMatch = (cache, playing) => {
    let best = null;
    let bestScore = 0;
    for (const item of Object.values(cache)) {
      if (!item || !item.video) continue;
      const score = matchScore(item, playing);
      if (score > bestScore) {
        best = item;
        bestScore = score;
      }
    }
    return bestScore >= 60 ? best : null;
  };

  /** 页面上显示的文案（认不出作品时用来当标题） */
  const captionFromDom = () => {
    const selectors = ['[data-e2e="video-desc"]', '[data-e2e="feed-video-desc"]', '[data-e2e="detail-video-desc"]'];
    for (const selector of selectors) {
      const node = document.querySelector ? document.querySelector(selector) : null;
      const value = node && node.textContent ? node.textContent.trim() : '';
      if (value) return value;
    }
    return '';
  };

  const idOf = (item) => text(item && (item.aweme_id || item.awemeId));

  // ---- 1) 先看页面捕获到的作品（滑动切换时唯一可靠的来源）----
  try {
    const cache = window.__WB_AWEMES__ || {};
    const playing = pickBestVideo();
    const playableSrc = playing && playing.src && playing.src.startsWith('http') ? playing.src : '';

    // A. 有目标作品号
    if (wantId && cache[wantId]) {
      // A1. 若画面正在播的是**另一条**（典型：滑动后 URL 还停在旧 modal_id），以画面为准
      if (playing) {
        const other = bestMatch(cache, playing);
        const otherId = idOf(other);
        if (otherId && otherId !== wantId && collect(other)) {
          out.source = 'capture-playing';
          out.ok = true;
          return out;
        }
      }
      if (collect(cache[wantId])) {
        out.source = 'capture';
        out.ok = true;
        return out;
      }
    }

    // B. 信息流 / 认不出 id：用画面去缓存里对齐
    if (playing) {
      const match = bestMatch(cache, playing);
      if (match && collect(match)) {
        out.source = 'capture-playing';
        out.ok = true;
        return out;
      }
      // 实在认不出是哪一条，但当前画面的地址是 http 的 → 直接下它（标题用页面文案）
      if (playableSrc) {
        if (!out.title) out.title = captionFromDom();
        out.qualities.push({
          label: playing.video.videoHeight ? `${playing.video.videoHeight}P` : '',
          width: Number(playing.video.videoWidth) || 0,
          height: Number(playing.video.videoHeight) || 0,
          bitrate: 0,
          size: 0,
          url: playableSrc,
          backups: [],
        });
        out.source = 'video';
        out.ok = true;
        return out;
      }
    }

    // C. 页面没在播（后台标签页）：退回按 id / 最近捕获
    if (wantId && cache[wantId] && collect(cache[wantId])) {
      out.source = 'capture';
      out.ok = true;
      return out;
    }
    const last = window.__WB_LAST_AWEME__;
    const lastAt = Number(window.__WB_LAST_AT__) || 0;
    const fresh = lastAt > 0 && Date.now() - lastAt < 120000;
    // 个人主页 / 历史记录这类页面里没有「当前正在播」的概念，猜最近一条容易拿错作品，
    // 所以只有信息流（feed）才允许这条兜底。
    if (!wantId && pageKind !== 'page' && fresh && last && collect(last)) {
      out.source = 'capture-last';
      out.ok = true;
      return out;
    }
  } catch (err) {
    /* 忽略 */
  }

  // 2) _ROUTER_DATA（作品页 SSR）
  try {
    const router = window._ROUTER_DATA;
    if (router && router.loaderData) {
      const aweme = findAweme(router.loaderData);
      const id = aweme ? text(aweme.aweme_id) || text(aweme.awemeId) : '';
      if (aweme && (!wantId || !id || id === wantId) && collect(aweme)) {
        out.source = 'router';
        out.ok = true;
        return out;
      }
    }
  } catch (err) {
    /* 忽略 */
  }

  // 3) RENDER_DATA（老页面）
  try {
    const node = document.getElementById('RENDER_DATA');
    if (node && node.textContent) {
      const aweme = findAweme(JSON.parse(decodeURIComponent(node.textContent)));
      const id = aweme ? text(aweme.aweme_id) || text(aweme.awemeId) : '';
      if (aweme && (!wantId || !id || id === wantId) && collect(aweme)) {
        out.source = 'render';
        out.ok = true;
        return out;
      }
    }
  } catch (err) {
    /* 忽略 */
  }

  // 4) 兜底：直接拿正在播的 <video>（拿不到标题/大小，但至少能下）
  const best = pickBestVideo();
  if (best && best.src.startsWith('http')) {
    out.qualities.push({
      label: best.video.videoHeight ? `${best.video.videoHeight}P` : '',
      width: Number(best.video.videoWidth) || 0,
      height: Number(best.video.videoHeight) || 0,
      bitrate: 0,
      size: 0,
      url: best.src,
      backups: [],
    });
    out.source = 'video';
    out.ok = true;
    return out;
  }

  if (!out.title) out.title = (document.title || '').replace(/-\s*抖音\s*$/, '').trim();
  return out;
}

/** 等标签页加载完成（最多 timeout 毫秒） */
function waitForTabComplete(tabId, timeout = 20000) {
  return new Promise((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      chrome.tabs.onUpdated.removeListener(listener);
      resolve();
    };
    const listener = (id, info) => {
      if (id === tabId && info.status === 'complete') finish();
    };
    chrome.tabs.onUpdated.addListener(listener);
    setTimeout(finish, timeout);
  });
}

/**
 * 把捕获脚本补注入到页面（幂等：脚本内部有 FLAG 守卫）。
 * 用途：扩展刚更新、页面还是旧文档时，content_scripts 不会重新注入，
 * 这里补一次，让后续的接口响应也能被捕获。
 */
async function ensureCapture(tabId) {
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      world: 'MAIN',
      files: ['src/page/douyin-capture.js'],
    });
  } catch {
    /* 页面已关闭或不允许注入时忽略 */
  }
}

async function tabAlive(tabId) {
  if (!Number.isInteger(tabId)) return false;
  try {
    await chrome.tabs.get(tabId);
    return true;
  } catch {
    return false;
  }
}

/**
 * 生成一个「从页面里取抖音数据」的函数。
 * 内部维护一个助手标签页：需要换作品时**导航**它，而不是复用一个内容已经过期的那一个。
 * @param {{onLog?:Function}} options
 */
export function createDouyinExtractor(options = {}) {
  const onLog = typeof options.onLog === 'function' ? options.onLog : () => {};
  let helperTabId = null;

  async function resolveTab(url) {
    let target;
    try {
      target = new URL(url);
    } catch {
      throw new Error('地址无法解析');
    }
    const pattern = `*://*.${target.hostname.replace(/^www\./, '')}/*`;
    let tabs = [];
    try {
      tabs = await chrome.tabs.query({ url: [pattern] });
    } catch {
      tabs = [];
    }
    // 1) 已经是同一个作品页（modal_id / aweme_id 相同）→ 直接复用，不动用户的页面
    const same = tabs.find((tab) => tab.id != null && tab.url && samePageUrl(tab.url, url));
    if (same) return { tabId: same.id, navigated: false };

    // 2) 复用自己开的助手标签页：导航过去（关键：不能把「同路径不同 modal_id」当成同一页）
    if (helperTabId && (await tabAlive(helperTabId))) {
      onLog('info', '正在切换助手标签页到目标作品…');
      try {
        await chrome.tabs.update(helperTabId, { url });
        await waitForTabComplete(helperTabId);
        return { tabId: helperTabId, navigated: true };
      } catch {
        helperTabId = null;
      }
    }

    // 3) 都没有就新开一个后台标签页
    onLog('info', '正在后台打开该页面以读取视频信息…');
    const created = await chrome.tabs.create({ url, active: false });
    if (!Number.isInteger(created.id)) throw new Error('无法打开页面标签');
    helperTabId = created.id;
    await waitForTabComplete(created.id);
    return { tabId: created.id, navigated: true };
  }

  return async function extractDouyin(url, ctx = {}) {
    const expectedId = ctx.expectedId ? String(ctx.expectedId) : '';
    const { tabId } = await resolveTab(url);
    await ensureCapture(tabId);

    // 页面数据晚于 complete 事件到达，按 id 轮询（最多约 12 秒）
    let lastResult = null;
    for (let attempt = 0; attempt < 16; attempt += 1) {
      if (ctx.signal && ctx.signal.aborted) {
        const err = new Error('已取消');
        err.name = 'AbortError';
        throw err;
      }
      let injected;
      try {
        injected = await chrome.scripting.executeScript({
          target: { tabId },
          world: 'MAIN',
          args: [expectedId, ctx.kind || ''],
          func: extractDouyinInPage,
        });
      } catch (err) {
        throw new Error(`无法读取页面数据：${(err && err.message) || err}`);
      }
      const result = injected && injected[0] && injected[0].result;
      if (result) {
        lastResult = result;
        if (result.ok && (!expectedId || result.awemeId === expectedId || !result.awemeId)) return result;
      }
      await new Promise((resolve) => setTimeout(resolve, 700));
    }

    if (lastResult && lastResult.ok) return lastResult;
    throw new Error('页面里没有找到视频信息（可能需要先播放一下，或该页面不是视频页）。');
  };
}
