// 视频下载器 —— Manifest V3 Service Worker
//
// 职责：
//   1. 通过 chrome.webRequest 监听页面请求中的 .m3u8（含 query string），按标签页记录候选；
//   2. 候选写入 chrome.storage.session，Service Worker 休眠/重启后不丢失；
//   3. 每个标签页用紫色数字角标显示检测到的数量：m3u8 候选数优先，
//      站点页（B 站等）没有候选时按 1 个可下载视频计；
//   4. 提供消息 API：GET_CANDIDATES / CLEAR_CANDIDATES / GET_SETTINGS / SET_SETTINGS；
//   5. 标签页关闭时清理该标签页的候选。
//
// 本文件不引入任何远程代码，也不使用 eval / wasm。

import { detectSite } from './src/sites/index.mjs';

const CANDIDATES_KEY = 'm3u8Candidates';
const MAX_PER_TAB = 50;
const BADGE_COLOR = '#6D3BFF';
const DEFAULT_SETTINGS = Object.freeze({ concurrency: 16, format: 'mp4' });
const CONCURRENCY_MIN = 1;
const CONCURRENCY_MAX = 64;

/** @type {Record<string, Array<{url: string, time: number}>> | null} */
let candidatesByTab = null;
/** @type {Promise<any> | null} */
let loadPromise = null;
/** 串行化的存储写入链，避免并发 set 相互覆盖 */
let persistChain = Promise.resolve();

function quiet(promise) {
  try {
    if (promise && typeof promise.catch === 'function') promise.catch(() => {});
  } catch {
    /* 忽略 */
  }
}

function isM3u8Url(url) {
  return typeof url === 'string' && /\.m3u8/i.test(url);
}

function normalizeStore(raw) {
  /** @type {Record<string, Array<{url: string, time: number}>>} */
  const out = {};
  if (!raw || typeof raw !== 'object') return out;
  for (const [key, value] of Object.entries(raw)) {
    const tabId = Number(key);
    if (!Number.isInteger(tabId) || tabId < 0 || !Array.isArray(value)) continue;
    const seen = new Set();
    const list = [];
    for (const item of value) {
      if (!item || typeof item.url !== 'string' || !item.url) continue;
      if (seen.has(item.url)) continue;
      seen.add(item.url);
      list.push({ url: item.url, time: Number(item.time) || Date.now() });
    }
    if (list.length) out[tabId] = list.slice(-MAX_PER_TAB);
  }
  return out;
}

async function ensureLoaded() {
  if (!loadPromise) {
    loadPromise = (async () => {
      try {
        const got = await chrome.storage.session.get(CANDIDATES_KEY);
        candidatesByTab = normalizeStore(got && got[CANDIDATES_KEY]);
      } catch (err) {
        console.warn('[HLS] 读取候选缓存失败：', err);
        candidatesByTab = {};
      }
      return candidatesByTab;
    })();
  }
  return loadPromise;
}

function schedulePersist() {
  let snapshot;
  try {
    snapshot = JSON.parse(JSON.stringify(candidatesByTab || {}));
  } catch {
    snapshot = {};
  }
  persistChain = persistChain
    .then(() => chrome.storage.session.set({ [CANDIDATES_KEY]: snapshot }))
    .catch((err) => {
      console.warn('[HLS] 写入候选缓存失败：', err);
    });
}

function refreshBadge(tabId, count) {
  if (!Number.isInteger(tabId) || tabId < 0) return;
  const text = count > 0 ? (count > 99 ? '99+' : String(count)) : '';
  quiet(chrome.action.setBadgeText({ tabId, text }));
  if (text) {
    quiet(chrome.action.setBadgeBackgroundColor({ tabId, color: BADGE_COLOR }));
    if (typeof chrome.action.setBadgeTextColor === 'function') {
      quiet(chrome.action.setBadgeTextColor({ tabId, color: '#FFFFFF' }));
    }
  }
}

async function recordCandidate(tabId, url) {
  const map = await ensureLoaded();
  let list = map[tabId];
  if (!list) {
    list = [];
    map[tabId] = list;
  }
  if (list.some((item) => item.url === url)) return;
  list.push({ url, time: Date.now() });
  if (list.length > MAX_PER_TAB) list.splice(0, list.length - MAX_PER_TAB);
  schedulePersist();
  refreshBadge(tabId, list.length);
}

/** 站点页在角标上算 1 个可下载视频；番剧等不支持的类型不算 */
function siteBadgeCount(url) {
  const site = detectSite(url);
  if (!site) return 0;
  return site.parsed && site.parsed.kind === 'bangumi' ? 0 : 1;
}

/**
 * 统一刷新单个标签页的角标：m3u8 候选数优先；没有候选再看是不是站点视频页。
 * url 缺省时从 tabs.get 取（消息 API 里只有 tabId）。
 */
async function syncTabBadge(tabId, url) {
  if (!Number.isInteger(tabId) || tabId < 0) return;
  let target = url;
  if (!target) {
    try {
      const tab = await chrome.tabs.get(tabId);
      target = (tab && tab.url) || '';
    } catch {
      // 标签页已关闭 / 拿不到 URL：按无站点处理，至少把候选角标清掉
      target = '';
    }
  }
  const map = await ensureLoaded();
  const candidates = (map[tabId] || []).length;
  refreshBadge(tabId, candidates || siteBadgeCount(target));
}

// ---- 网络请求监听 ----------------------------------------------------------

chrome.webRequest.onBeforeRequest.addListener(
  (details) => {
    if (!isM3u8Url(details.url)) return;
    if (!Number.isInteger(details.tabId) || details.tabId < 0) return;
    recordCandidate(details.tabId, details.url).catch((err) => {
      console.warn('[HLS] 记录候选失败：', err);
    });
  },
  { urls: ['<all_urls>'] }
);

// 清理已关闭标签页的候选
chrome.tabs.onRemoved.addListener((tabId) => {
  ensureLoaded()
    .then((map) => {
      if (map[tabId]) {
        delete map[tabId];
        schedulePersist();
      }
    })
    .catch(() => {});
});

// 站点页（B 站）也要有角标：进入页面 / 切换标签页时按链接类型补一个数量。
// 走同一个 syncTabBadge，保证「有候选就显示候选数」的优先级不被覆盖。
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (!changeInfo || (!changeInfo.url && changeInfo.status !== 'complete')) return;
  const url = changeInfo.url || (tab && tab.url) || '';
  syncTabBadge(tabId, url).catch(() => {});
});

chrome.tabs.onActivated.addListener((info) => {
  if (!info || !Number.isInteger(info.tabId)) return;
  syncTabBadge(info.tabId).catch(() => {});
});

// ---- 设置 ------------------------------------------------------------------

function sanitizeSettings(input) {
  const settings = { concurrency: DEFAULT_SETTINGS.concurrency, format: DEFAULT_SETTINGS.format };
  if (input && typeof input === 'object') {
    const n = Number(input.concurrency);
    if (Number.isFinite(n)) {
      settings.concurrency = Math.min(CONCURRENCY_MAX, Math.max(CONCURRENCY_MIN, Math.round(n)));
    }
    if (input.format === 'ts' || input.format === 'mp4') settings.format = input.format;
  }
  return settings;
}

async function readSettings() {
  try {
    // 传入默认值对象：storage 返回已存值 + 缺省值，天然完成合并。
    const got = await chrome.storage.local.get(DEFAULT_SETTINGS);
    return sanitizeSettings(got);
  } catch (err) {
    console.warn('[HLS] 读取设置失败：', err);
    return { ...DEFAULT_SETTINGS };
  }
}

async function saveSettings(patch) {
  const current = await readSettings();
  const next = sanitizeSettings({ ...current, ...(patch || {}) });
  await chrome.storage.local.set(next);
  return next;
}

async function ensureDefaultSettings() {
  try {
    const got = await chrome.storage.local.get(DEFAULT_SETTINGS);
    await chrome.storage.local.set(sanitizeSettings(got));
  } catch (err) {
    console.warn('[HLS] 初始化设置失败：', err);
  }
}

// ---- 消息 API --------------------------------------------------------------

async function resolveActiveTabId() {
  try {
    const tabs = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    const tab = tabs && tabs[0];
    return tab && Number.isInteger(tab.id) ? tab.id : null;
  } catch {
    return null;
  }
}

function normalizeTabId(value) {
  const n = Number(value);
  return Number.isInteger(n) && n >= 0 ? n : null;
}

async function handleMessage(message, sender) {
  const type = message && message.type;
  switch (type) {
    case 'GET_CANDIDATES': {
      const tabId = normalizeTabId(message.tabId) ?? (sender && sender.tab ? normalizeTabId(sender.tab.id) : null) ?? (await resolveActiveTabId());
      const map = await ensureLoaded();
      if (tabId == null) return { candidates: [], tabId: null };
      const list = (map[tabId] || []).slice().sort((a, b) => b.time - a.time);
      return { candidates: list, tabId };
    }
    case 'CLEAR_CANDIDATES': {
      const tabId = normalizeTabId(message.tabId) ?? (sender && sender.tab ? normalizeTabId(sender.tab.id) : null) ?? (await resolveActiveTabId());
      const map = await ensureLoaded();
      if (tabId != null) {
        delete map[tabId];
        schedulePersist();
        // 清空候选后如果本页是站点视频，角标应回到 1 而不是消失
        await syncTabBadge(tabId);
      }
      return { ok: true, tabId };
    }
    case 'GET_SETTINGS':
      return { settings: await readSettings() };
    case 'SET_SETTINGS':
      return { ok: true, settings: await saveSettings(message.settings) };
    default:
      return { error: `未知消息类型：${String(type)}` };
  }
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  handleMessage(message, sender).then(sendResponse, (err) => {
    sendResponse({ error: (err && err.message) || String(err) });
  });
  // 异步 sendResponse，必须返回 true 保持消息通道。
  return true;
});

// ---- 生命周期 --------------------------------------------------------------

async function restoreBadges() {
  try {
    const map = await ensureLoaded();
    const tabs = await chrome.tabs.query({});
    for (const tab of tabs) {
      if (!Number.isInteger(tab.id)) continue;
      const candidates = (map[tab.id] || []).length;
      // 站点视频页即使没有 m3u8 候选也要有角标
      refreshBadge(tab.id, candidates || siteBadgeCount(tab.url));
    }
  } catch (err) {
    console.warn('[HLS] 恢复角标失败：', err);
  }
}

quiet(chrome.action.setBadgeBackgroundColor({ color: BADGE_COLOR }));

chrome.runtime.onInstalled.addListener(() => {
  void ensureDefaultSettings();
  void restoreBadges();
});

chrome.runtime.onStartup.addListener(() => {
  void ensureDefaultSettings();
  void restoreBadges();
});

void restoreBadges();
