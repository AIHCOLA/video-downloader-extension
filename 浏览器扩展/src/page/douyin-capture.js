// 抖音页面数据捕获（MAIN world，document_start 注入）。
//
// 为什么要捕获：抖音精选页/推荐页是信息流 SPA，页面里没有 `_ROUTER_DATA`，
// 视频地址只出现在页面自己发出的接口响应里。而信息流的作品**不是**逐条走 `aweme/detail`，
// 主要是 `tab/feed`、`feed`、`related` 这类批量接口（响应里是 `aweme_list`）。
// 只监听 detail 会漏掉绝大多数滑动切换的场景——这正是 v1.2.1 没修好的原因。
//
// 所以这里对所有 `/aweme/vN/...` 的 JSON 响应做一次通用扫描，把带 `video.play_addr`
// 的对象按 `aweme_id` 存下来。只读不留痕：不发请求、不改请求、不动 DOM。
(() => {
  const FLAG = '__wbDouyinCapture__';
  if (window[FLAG]) return;
  window[FLAG] = true;

  if (!window.__WB_AWEMES__) window.__WB_AWEMES__ = {};
  if (typeof window.__WB_LAST_AWEME__ === 'undefined') window.__WB_LAST_AWEME__ = null;
  if (typeof window.__WB_LAST_AT__ === 'undefined') window.__WB_LAST_AT__ = 0;
  if (typeof window.__WB_SEQ__ === 'undefined') window.__WB_SEQ__ = 0;

  const MAX_NODES = 4000;

  // 任何 aweme 接口都可能是作品列表：detail / post / related / feed / tab/feed …
  const isAwemeUrl = (url) => typeof url === 'string' && /\/aweme\/v\d+\//.test(url);

  const remember = (item) => {
    if (!item || !item.video || !item.video.play_addr) return;
    const id = String(item.aweme_id || item.awemeId || '');
    if (!id) return;
    window.__WB_AWEMES__[id] = item;
    window.__WB_LAST_AWEME__ = item;
    window.__WB_LAST_AT__ = Date.now();
    window.__WB_SEQ__ += 1;
  };

  /** 在响应 JSON 里找所有「带 video.play_addr 的对象」，不依赖具体层级 */
  const scanText = (text) => {
    if (typeof text !== 'string' || text.length < 20) return;
    // 先廉价筛一下，避免把每个响应都 JSON.parse
    if (!text.includes('aweme_') && !text.includes('play_addr')) return;
    let json;
    try {
      json = JSON.parse(text);
    } catch (err) {
      return;
    }
    const seen = new Set();
    let visited = 0;
    const walk = (node, depth) => {
      if (!node || typeof node !== 'object' || depth > 6 || visited > MAX_NODES) return;
      if (seen.has(node)) return;
      seen.add(node);
      visited += 1;
      if (Array.isArray(node)) {
        for (const child of node) walk(child, depth + 1);
        return;
      }
      if (node.video && node.video.play_addr) remember(node);
      for (const key of Object.keys(node)) {
        const value = node[key];
        if (value && typeof value === 'object') walk(value, depth + 1);
      }
    };
    walk(json, 0);
  };

  // fetch
  const originalFetch = window.fetch;
  if (typeof originalFetch === 'function') {
    window.fetch = function patchedFetch(...args) {
      const input = args[0];
      const url = typeof input === 'string' ? input : (input && input.url) || '';
      const promise = originalFetch.apply(this, args);
      if (isAwemeUrl(url)) {
        promise
          .then((res) => {
            try {
              res
                .clone()
                .text()
                .then(scanText)
                .catch(() => {});
            } catch (err) {
              /* 忽略 */
            }
          })
          .catch(() => {});
      }
      return promise;
    };
  }

  // XMLHttpRequest
  const XP = window.XMLHttpRequest && window.XMLHttpRequest.prototype;
  if (XP && typeof XP.open === 'function' && typeof XP.send === 'function') {
    const originalOpen = XP.open;
    const originalSend = XP.send;
    XP.open = function patchedOpen(method, url, ...rest) {
      this.__wbUrl = url;
      return originalOpen.call(this, method, url, ...rest);
    };
    XP.send = function patchedSend(...args) {
      if (isAwemeUrl(this.__wbUrl)) {
        this.addEventListener('load', () => {
          try {
            scanText(this.responseText);
          } catch (err) {
            /* 忽略 */
          }
        });
      }
      return originalSend.apply(this, args);
    };
  }
})();
