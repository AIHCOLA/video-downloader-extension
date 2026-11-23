// background.js（MV3 Service Worker）单测：用内存版 chrome.* mock 直接 import 真实 background.js，
// 验证 m3u8 检测、去重、上限、storage.session 持久化、角标、消息 API、设置校验、标签页关闭清理。
//
// 用法：node _extwork/shell-test/unit-background.mjs
// 退出码 0 = 全部通过。
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(HERE, '..', '..');
const EXT = path.join(ROOT, '浏览器扩展');

const passes = [];
const failures = [];

function eq(actual, expected, label) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) {
    passes.push(label);
    console.log(`PASS  ${label}`);
  } else {
    failures.push(`${label}：期望 ${e}，实际 ${a}`);
    console.log(`FAIL  ${label}：期望 ${e}，实际 ${a}`);
  }
}

function ok(condition, label, detail) {
  if (condition) {
    passes.push(label);
    console.log(`PASS  ${label}`);
  } else {
    failures.push(`${label}${detail ? `：${detail}` : ''}`);
    console.log(`FAIL  ${label}${detail ? `：${detail}` : ''}`);
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const clone = (value) => (value === undefined ? undefined : JSON.parse(JSON.stringify(value)));

function makeStorage(map) {
  return {
    async get(keys) {
      if (typeof keys === 'string') return map.has(keys) ? { [keys]: clone(map.get(keys)) } : {};
      if (Array.isArray(keys)) {
        const out = {};
        for (const key of keys) if (map.has(key)) out[key] = clone(map.get(key));
        return out;
      }
      if (keys && typeof keys === 'object') {
        const out = {};
        for (const [key, fallback] of Object.entries(keys)) {
          out[key] = map.has(key) ? clone(map.get(key)) : clone(fallback);
        }
        return out;
      }
      return {};
    },
    async set(items) {
      for (const [key, value] of Object.entries(items)) map.set(key, clone(value));
    },
    async remove(keys) {
      const list = Array.isArray(keys) ? keys : [keys];
      for (const key of list) map.delete(key);
    },
  };
}

function createChromeMock() {
  const session = new Map();
  const local = new Map();
  const messageListeners = [];
  const removedListeners = [];
  const updatedListeners = [];
  const activatedListeners = [];
  const requestListeners = [];
  const installedListeners = [];
  const startupListeners = [];
  const badgeText = new Map();
  const badgeColors = new Map();
  const tabRegistry = new Map();
  const action = {
    globalColor: null,
    textColorCalls: 0,
    async setBadgeText({ tabId, text }) {
      if (tabId === undefined || tabId === null) action.globalText = text;
      else badgeText.set(tabId, text);
    },
    async setBadgeBackgroundColor({ tabId, color }) {
      if (tabId === undefined || tabId === null) action.globalColor = color;
      else badgeColors.set(tabId, color);
    },
    async setBadgeTextColor() {
      action.textColorCalls += 1;
    },
  };
  const chrome = {
    storage: { session: makeStorage(session), local: makeStorage(local) },
    action,
    tabs: {
      onRemoved: { addListener: (fn) => removedListeners.push(fn) },
      onUpdated: { addListener: (fn) => updatedListeners.push(fn) },
      onActivated: { addListener: (fn) => activatedListeners.push(fn) },
      async query(queryInfo) {
        const all = [...tabRegistry.values()];
        if (queryInfo && queryInfo.active) return all.filter((tab) => tab.active);
        return all;
      },
      async get(tabId) {
        const tab = tabRegistry.get(tabId);
        if (!tab) throw new Error(`No tab with id: ${tabId}`);
        return tab;
      },
    },
    webRequest: {
      onBeforeRequest: { addListener: (fn) => requestListeners.push(fn) },
    },
    runtime: {
      onMessage: { addListener: (fn) => messageListeners.push(fn) },
      onInstalled: { addListener: (fn) => installedListeners.push(fn) },
      onStartup: { addListener: (fn) => startupListeners.push(fn) },
    },
  };
  return {
    chrome,
    session,
    local,
    messageListeners,
    removedListeners,
    updatedListeners,
    activatedListeners,
    requestListeners,
    installedListeners,
    startupListeners,
    badgeText,
    badgeColors,
    tabRegistry,
    action,
  };
}

/** 往 mock 里注册一个标签页（tabs.get / tabs.query 用） */
function registerTab(mock, tab) {
  mock.tabRegistry.set(tab.id, tab);
  return tab;
}

/** 触发 tabs.onUpdated */
function fireUpdated(mock, tabId, changeInfo) {
  const tab = mock.tabRegistry.get(tabId) || { id: tabId };
  const next = { ...tab, ...(changeInfo.url ? { url: changeInfo.url } : {}) };
  if (changeInfo.url) mock.tabRegistry.set(tabId, next);
  for (const fn of mock.updatedListeners) fn(tabId, changeInfo, next);
}

/** 触发 tabs.onActivated */
function fireActivated(mock, tabId) {
  for (const fn of mock.activatedListeners) fn({ tabId });
}

function dispatch(mock, message, sender = {}) {
  return new Promise((resolve) => {
    if (mock.messageListeners.length === 0) {
      resolve(undefined);
      return;
    }
    let responded = false;
    const sendResponse = (response) => {
      if (responded) return;
      responded = true;
      resolve(response);
    };
    for (const listener of mock.messageListeners) {
      listener(message, sender, sendResponse);
    }
    // 兜底：若没有任何监听器异步响应，也要在下一拍结束，避免单测挂起。
    setTimeout(() => sendResponse(undefined), 500);
  });
}

function fireRequest(mock, url, tabId) {
  for (const listener of mock.requestListeners) {
    listener({ url, tabId, type: 'xmlhttprequest', method: 'GET', requestId: String(Math.random()) });
  }
}

export async function runCheck() {
  console.log('=== background.js 单测（chrome.* mock）===');
  const mock = createChromeMock();
  globalThis.chrome = mock.chrome;
  await import(pathToFileURL(path.join(EXT, 'background.js')).href);
  await sleep(30); // 等待顶层 restoreBadges()

  ok(mock.messageListeners.length === 1, '注册了 chrome.runtime.onMessage 监听');
  ok(mock.requestListeners.length === 1, '注册了 webRequest.onBeforeRequest 监听');
  ok(mock.removedListeners.length === 1, '注册了 tabs.onRemoved 监听');
  ok(
    mock.updatedListeners.length === 1 && mock.activatedListeners.length === 1,
    '注册了 tabs.onUpdated / onActivated（站点页角标）'
  );
  ok(mock.installedListeners.length === 1 && mock.startupListeners.length === 1, '注册了 onInstalled / onStartup');
  eq(mock.action.globalColor, '#6D3BFF', '全局角标背景色为紫色 #6D3BFF');

  // ---- 设置 API 默认值 + 校验 ----
  const defaults = await dispatch(mock, { type: 'GET_SETTINGS' });
  eq(defaults, { settings: { concurrency: 16, format: 'mp4' } }, 'GET_SETTINGS 默认值 {concurrency:16, format:mp4}');

  const clamped = await dispatch(mock, { type: 'SET_SETTINGS', settings: { concurrency: 999, format: 'avi' } });
  eq(clamped, { ok: true, settings: { concurrency: 64, format: 'mp4' } }, 'SET_SETTINGS 并发截断到 64、非法格式回退 mp4');
  const afterSet = await dispatch(mock, { type: 'GET_SETTINGS' });
  eq(afterSet.settings, { concurrency: 64, format: 'mp4' }, 'SET_SETTINGS 已持久化（GET_SETTINGS 返回新值）');
  eq(mock.local.get('concurrency'), 64, 'storage.local 顶层字段 concurrency=64');
  eq(mock.local.get('format'), 'mp4', 'storage.local 顶层字段 format=mp4');
  const stored = await dispatch(mock, { type: 'SET_SETTINGS', settings: { concurrency: 8, format: 'ts' } });
  eq(stored.settings, { concurrency: 8, format: 'ts' }, 'SET_SETTINGS 合法值 ts/8');
  await dispatch(mock, { type: 'SET_SETTINGS', settings: { concurrency: 16, format: 'mp4' } });

  // ---- 检测 / 去重 / 过滤 ----
  const m3u8A = 'https://cdn.example.com/video/index.m3u8?token=abc';
  fireRequest(mock, m3u8A, 3);
  await sleep(30);
  const gotA = await dispatch(mock, { type: 'GET_CANDIDATES', tabId: 3 });
  eq(gotA.candidates.length, 1, 'webRequest 检测到 m3u8 并记录候选');
  eq(gotA.candidates[0].url, m3u8A, '候选 url 与请求地址一致');
  ok(Number.isFinite(gotA.candidates[0].time), '候选包含 time 时间戳');
  eq(mock.badgeText.get(3), '1', 'tab 3 角标显示候选数量 1');
  eq(mock.badgeColors.get(3), '#6D3BFF', 'tab 3 角标为紫色');

  fireRequest(mock, m3u8A, 3);
  await sleep(20);
  eq((await dispatch(mock, { type: 'GET_CANDIDATES', tabId: 3 })).candidates.length, 1, '重复 URL 去重（仍为 1 条）');

  fireRequest(mock, 'https://cdn.example.com/video/movie.mp4', 3);
  fireRequest(mock, 'https://cdn.example.com/not-m3u8.txt', 3);
  await sleep(20);
  eq((await dispatch(mock, { type: 'GET_CANDIDATES', tabId: 3 })).candidates.length, 1, '非 m3u8 请求被忽略');

  fireRequest(mock, 'https://cdn.example.com/VIDEO/UPPER.M3U8', 3);
  await sleep(20);
  eq((await dispatch(mock, { type: 'GET_CANDIDATES', tabId: 3 })).candidates.length, 2, '扩展名大小写不敏感（.M3U8）');
  eq(mock.badgeText.get(3), '2', '角标随候选数量更新为 2');

  fireRequest(mock, 'https://cdn.example.com/favicon.m3u8', -1);
  await sleep(10);
  eq((await dispatch(mock, { type: 'GET_CANDIDATES', tabId: -1 })).candidates.length, 0, 'tabId<0 的请求被忽略');

  // 排序：最新在前
  const tab12Url1 = 'https://cdn.example.com/t12/one.m3u8';
  const tab12Url2 = 'https://cdn.example.com/t12/two.m3u8';
  fireRequest(mock, tab12Url1, 12);
  await sleep(12);
  fireRequest(mock, tab12Url2, 12);
  await sleep(20);
  const sorted = await dispatch(mock, { type: 'GET_CANDIDATES', tabId: 12 });
  eq(sorted.candidates[0].url, tab12Url2, 'GET_CANDIDATES 按时间倒序（最新在前）');

  // 每标签页最多 50 条
  for (let i = 0; i < 60; i += 1) fireRequest(mock, `https://cdn.example.com/cap/seg${i}.m3u8`, 9);
  await sleep(150);
  const capped = await dispatch(mock, { type: 'GET_CANDIDATES', tabId: 9 });
  eq(capped.candidates.length, 50, '单标签页最多保留 50 条候选');
  eq(mock.badgeText.get(9), '50', '候选达到上限时角标显示 50');

  // storage.session 持久化（SW 重启不丢）
  const persisted = mock.session.get('m3u8Candidates');
  ok(persisted && typeof persisted === 'object', '候选已写入 chrome.storage.session');
  eq(persisted[9].length, 50, 'storage.session 中 tab 9 有 50 条');
  ok(persisted[3].length === 2, 'storage.session 中 tab 3 有 2 条');

  // sender.tab 兜底
  const viaSender = await dispatch(mock, { type: 'GET_CANDIDATES' }, { tab: { id: 3 } });
  eq(viaSender.candidates.length, 2, 'GET_CANDIDATES 未传 tabId 时回退 sender.tab.id');

  // ---- 清空 ----
  const cleared = await dispatch(mock, { type: 'CLEAR_CANDIDATES', tabId: 3 });
  eq(cleared, { ok: true, tabId: 3 }, 'CLEAR_CANDIDATES 返回 ok');
  eq((await dispatch(mock, { type: 'GET_CANDIDATES', tabId: 3 })).candidates.length, 0, '清空后候选为 0');
  eq(mock.badgeText.get(3), '', '清空后角标为空文本');
  const persistedAfterClear = mock.session.get('m3u8Candidates');
  ok(!persistedAfterClear[3], '清空后 storage.session 中不再有 tab 3');

  // ---- 标签页关闭清理 ----
  fireRequest(mock, 'https://cdn.example.com/t11/index.m3u8', 11);
  await sleep(25);
  eq((await dispatch(mock, { type: 'GET_CANDIDATES', tabId: 11 })).candidates.length, 1, 'tab 11 已记录 1 条');
  mock.removedListeners[0](11);
  await sleep(30);
  eq((await dispatch(mock, { type: 'GET_CANDIDATES', tabId: 11 })).candidates.length, 0, 'tabs.onRemoved 清理该标签页候选');
  const persistedAfterRemove = mock.session.get('m3u8Candidates');
  ok(!persistedAfterRemove[11], 'tabs.onRemoved 后 storage.session 同步清理');

  // ---- 站点视频角标（B 站）----
  registerTab(mock, { id: 21, url: 'https://www.bilibili.com/video/BV1GbWq6HEct', active: true });
  fireActivated(mock, 21);
  await sleep(30);
  eq(mock.badgeText.get(21), '1', 'B 站视频页角标显示 1');

  fireUpdated(mock, 21, { url: 'https://example.com/other' });
  await sleep(30);
  eq(mock.badgeText.get(21), '', '离开 B 站页面后角标清空');

  fireUpdated(mock, 21, { url: 'https://www.bilibili.com/bangumi/play/ep123' });
  await sleep(30);
  eq(mock.badgeText.get(21), '', '番剧页不显示角标（不支持下载）');

  // 稍后再看 / 收藏夹这类 URL，视频号在 query 里
  fireUpdated(mock, 21, { url: 'https://www.bilibili.com/list/watchlater?bvid=BV1GbWq6HEct&oid=12345' });
  await sleep(30);
  eq(mock.badgeText.get(21), '1', '稍后再看等 query 形式也识别为 B 站视频');

  // 有 m3u8 候选时优先显示候选数；清空后回落到站点计数
  fireRequest(mock, 'https://cdn.example.com/bili/index.m3u8', 21);
  await sleep(30);
  eq(mock.badgeText.get(21), '1', 'B 站页有 1 条候选时角标仍为 1');
  fireRequest(mock, 'https://cdn.example.com/bili/second.m3u8', 21);
  await sleep(30);
  eq(mock.badgeText.get(21), '2', '候选数优先于站点计数（显示 2）');
  await dispatch(mock, { type: 'CLEAR_CANDIDATES', tabId: 21 });
  await sleep(30);
  eq(mock.badgeText.get(21), '1', '清空候选后回落到站点计数 1');

  // 启动时恢复已打开的站点页角标
  mock.badgeText.set(21, '');
  mock.startupListeners[0]();
  await sleep(50);
  eq(mock.badgeText.get(21), '1', 'onStartup 后恢复站点页角标');

  // ---- 未知消息 ----
  const unknown = await dispatch(mock, { type: 'NOT_A_REAL_TYPE' });
  ok(typeof unknown.error === 'string' && unknown.error.includes('未知消息类型'), '未知消息类型返回中文错误');

  console.log('\n========== background 单测汇总 ==========');
  console.log(`通过：${passes.length}，失败：${failures.length}`);
  if (failures.length) console.log('失败：\n  - ' + failures.join('\n  - '));
  else console.log('结果：全部通过（exit 0）');
  return failures.length === 0 ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  process.exitCode = await runCheck();
}
