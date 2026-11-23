/**
 * 经标签页代理取字节（Referer 兜底方案）。
 *
 * 背景：B 站 CDN 强校验 `Referer`，扩展页发出的跨域请求是非法的 Referer，
 * 直接 403。首选方案是用 declarativeNetRequest 改写 Referer（rules/bilibili-referer.json），
 * 但那是「尽力而为」：如果规则没生效（被其它扩展覆盖、浏览器不支持等），
 * 就退回这里 —— 在真实的 B 站页面里执行 fetch，请求天然带正确的 Referer 与 Origin。
 *
 * 代价是数据要经 base64 从页面传回扩展（每块 4 MB → 约 5.3 MB 字符串），
 * 所以只在直连失败时才启用。
 */

const DEFAULT_CHUNK = 4 * 1024 * 1024;

/**
 * 找到任意一个已打开的站点标签页；没有就后台打开一个该站点首页。
 * @param {{origin?:string, url?:string, match?:string[]}} options
 *   origin：站点根地址（如 https://www.bilibili.com/），用于匹配已开标签页与新建标签页
 */
export async function ensureSiteTab(options = {}) {
  const origin = options.origin || 'https://www.bilibili.com/';
  const match = Array.isArray(options.match) ? options.match : [`${origin.replace(/\/$/, '')}/*`];
  const tabs = await chrome.tabs.query({ url: match });
  const usable = tabs.find((t) => t.id != null && t.status !== 'unloaded');
  if (usable) return usable.id;

  const created = await chrome.tabs.create({ url: options.url || origin, active: false });
  const tabId = created.id;
  // 等待页面完成加载（最多 15 秒），页面没加载完不能注入
  await new Promise((resolve) => {
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
    setTimeout(finish, 15000);
  });
  return tabId;
}

/** 找到任意一个已打开的 B 站标签页；没有就后台打开一个空白 B 站首页 */
export async function ensureBilibiliTab() {
  return ensureSiteTab({ origin: 'https://www.bilibili.com/', match: ['*://*.bilibili.com/*'] });
}

/** 在页面里执行的取字节函数（MAIN world，必须是自包含的） */
async function pageFetchRange(url, start, end) {
  try {
    const res = await fetch(url, {
      headers: { Range: `bytes=${start}-${end}` },
      credentials: 'include',
      cache: 'no-store',
    });
    if (!res.ok) return { ok: false, status: res.status };
    const buf = new Uint8Array(await res.arrayBuffer());
    let binary = '';
    const step = 0x8000;
    for (let i = 0; i < buf.length; i += step) {
      binary += String.fromCharCode.apply(null, buf.subarray(i, i + step));
    }
    const total = res.headers.get('content-range');
    return { ok: true, status: res.status, b64: btoa(binary), contentRange: total };
  } catch (err) {
    return { ok: false, status: 0, error: String((err && err.message) || err) };
  }
}

function decodeBase64(b64) {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) out[i] = bin.charCodeAt(i);
  return out;
}

/** 解析 `bytes 0-1023/12345` 里的总大小 */
export function parseTotalSize(contentRange) {
  if (!contentRange || typeof contentRange !== 'string') return 0;
  const m = contentRange.match(/\/(\d+)\s*$/);
  return m ? Number(m[1]) : 0;
}

/**
 * 生成一个 fetchChunk，供 downloadDirect 的 range 模式使用。
 * @param {{tabId?:number, onLog?:Function}} options
 */
export function createTabFetcher(options = {}) {
  const onLog = typeof options.onLog === 'function' ? options.onLog : () => {};
  let tabId = options.tabId;

  return async function fetchChunkViaTab(url, range, ctx = {}) {
    if (ctx.signal && ctx.signal.aborted) {
      const err = new Error('已取消');
      err.name = 'AbortError';
      throw err;
    }
    let attempts = 0;
    for (;;) {
      attempts += 1;
      if (!tabId || !(await tabStillThere(tabId))) {
        tabId = await ensureBilibiliTab();
        onLog('info', '已切换到 B 站标签页代理下载');
      }
      let injection;
      try {
        injection = await chrome.scripting.executeScript({
          target: { tabId },
          world: 'MAIN',
          args: [url, range.start, range.end],
          func: pageFetchRange,
        });
      } catch (err) {
        // 标签页被关闭 / 被导航到不允许注入的页面
        onLog('warn', `代理取字节失败（${err && err.message ? err.message : err}），将重开标签页`);
        tabId = null;
        if (attempts >= 3) throw new Error(`标签页代理不可用：${err && err.message ? err.message : err}`);
        continue;
      }
      const result = injection && injection[0] && injection[0].result;
      if (!result) {
        if (attempts >= 3) throw new Error('标签页代理没有返回数据');
        continue;
      }
      if (!result.ok) {
        if (result.status === 403 || result.status === 401) {
          throw new Error(`代理请求同样被源站拒绝（HTTP ${result.status}）`);
        }
        if (attempts >= 3) throw new Error(`代理请求失败（HTTP ${result.status}${result.error ? `，${result.error}` : ''}）`);
        await new Promise((r) => setTimeout(r, 500 * attempts));
        continue;
      }
      const bytes = decodeBase64(result.b64 || '');
      const size = parseTotalSize(result.contentRange);
      if (size > 0) bytes.totalSize = size;
      return bytes;
    }
  };
}

async function tabStillThere(tabId) {
  try {
    const tab = await chrome.tabs.get(tabId);
    return Boolean(tab && tab.id === tabId);
  } catch {
    return false;
  }
}

/** 在页面里执行的 JSON 请求函数（MAIN world，自包含） */
async function pageFetchJson(url) {
  try {
    let target = url;
    // 优酷需要一个设备标识（utid，等同于 mmstat 的 cna）。URL 里用 __CNA__ 占位，
    // 在页面里换成页面自己的 cna / __ysuid cookie：比扩展自己算更贴近真实播放请求。
    if (target.includes('__CNA__')) {
      const readCookie = (name) => {
        const match = document.cookie.match(new RegExp('(?:^|; )' + name + '=([^;]*)'));
        return match ? decodeURIComponent(match[1]) : '';
      };
      let deviceId = readCookie('cna') || readCookie('__ysuid');
      if (!deviceId) {
        deviceId = `${Math.floor(Date.now() / 1000)}${Math.random().toString(36).slice(2, 5)}`;
        document.cookie = `__ysuid=${deviceId}; domain=.youku.com; path=/`;
      }
      target = target.split('__CNA__').join(encodeURIComponent(deviceId));
    }
    const res = await fetch(target, { credentials: 'include', cache: 'no-store' });
    if (!res.ok) return { ok: false, status: res.status };
    return { ok: true, status: res.status, data: await res.json() };
  } catch (err) {
    return { ok: false, status: 0, error: String((err && err.message) || err) };
  }
}

/**
 * 生成一个「在指定站点页面里请求接口」的函数。
 *
 * 为什么必须放到页面里：
 *   扩展页发出的请求是跨站请求，SameSite=Lax 的 Cookie 不会被带上，站点会按未登录 / 陌生设备处理。
 *   放到站点页面里发，请求就是同站请求，Cookie 与网络出口都和真实播放一致
 *   —— 扩展本身不读取、不保存、不转发任何 Cookie。
 *
 * @param {{tabId?:number, onLog?:Function, origin?:string, url?:string, match?:string[], label?:string}} options
 */
export function createSiteJsonFetcher(options = {}) {
  const onLog = typeof options.onLog === 'function' ? options.onLog : () => {};
  const label = options.label || '站点';
  let tabId = options.tabId;

  return async function fetchJsonInPage(url, ctx = {}) {
    if (ctx.signal && ctx.signal.aborted) {
      const err = new Error('已取消');
      err.name = 'AbortError';
      throw err;
    }
    if (!tabId || !(await tabStillThere(tabId))) {
      tabId = await ensureSiteTab(options);
      onLog('info', `已连接${label}页面上下文（用于带上登录态取播放信息）`);
    }
    const injection = await chrome.scripting.executeScript({
      target: { tabId },
      world: 'MAIN',
      args: [url],
      func: pageFetchJson,
    });
    const result = injection && injection[0] && injection[0].result;
    if (!result) throw new Error('页面上下文没有返回数据');
    if (!result.ok) throw new Error(`页面上下文请求失败（HTTP ${result.status}${result.error ? `，${result.error}` : ''}）`);
    return result.data;
  };
}

/**
 * 生成一个「在 B 站页面里请求接口」的函数，用于带上登录态（Cookie）拿播放地址。
 * @param {{tabId?:number, onLog?:Function}} options
 */
export function createPageJsonFetcher(options = {}) {
  return createSiteJsonFetcher({
    ...options,
    origin: 'https://www.bilibili.com/',
    match: ['*://*.bilibili.com/*'],
    label: ' B 站',
  });
}

export { DEFAULT_CHUNK };
