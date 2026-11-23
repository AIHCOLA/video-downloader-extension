// puppeteer 冒烟测试：在能正常启动 Chrome 的环境里加载 MV3 扩展，验证外壳真实可用。
//
// 用法（在普通桌面 / 提权环境执行；DSH 沙箱内 Chromium 会因命名管道被禁而 FATAL，无法运行）：
//   node _extwork/shell-test/smoke.mjs
//   SMOKE_HEADFUL=1 node _extwork/shell-test/smoke.mjs       # 有界面模式（排查问题时）
//   CHROME_PATH="C:/path/to/chrome.exe" node ...             # 指定 Chrome / Chrome for Testing
//   SMOKE_CORE=mock node ...                                 # 强制用 mock core（UI 外壳验证）
//   SMOKE_NO_SANDBOX=1 node ...                              # 追加 --no-sandbox（部分 CI 需要）
//
// 说明：
//   - 真实 core 已就绪时直接加载 `浏览器扩展/`；否则把扩展复制到 build/ext 并注入 _extwork/shell-test/mock-core。
//   - Chrome 137+ 正式版限制命令行加载扩展，自动化请使用 Chrome for Testing；
//     脚本已附加 --disable-features=DisableLoadExtensionCommandLineSwitch 以兼容。
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');
const EXT_REAL = path.join(ROOT, '浏览器扩展');
const CHROME = process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const PUPPETEER_PATH =
  process.env.PUPPETEER_PATH || path.join(ROOT, '_extwork', 'e2e', 'node_modules', 'puppeteer-core');
const BUILD_DIR = path.join(HERE, 'build');
const PROFILE_DIR = path.join(HERE, '.profile-smoke');
const CHECK = path.join(HERE, '.check');
const require = createRequire(import.meta.url);

const passes = [];
const failures = [];

function pass(label, detail) {
  passes.push(label);
  console.log(`PASS  ${label}${detail ? `  (${detail})` : ''}`);
}
function fail(label, detail) {
  failures.push(`${label}${detail ? `：${detail}` : ''}`);
  console.log(`FAIL  ${label}${detail ? `：${detail}` : ''}`);
}
function check(condition, label, detail) {
  if (condition) pass(label, detail);
  else fail(label, detail);
  return Boolean(condition);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ---- 扩展目录准备（真实 core 优先，缺失时用 mock 构建副本） -----------------

function prepareExtension() {
  const coreIndex = path.join(EXT_REAL, 'src', 'core', 'index.mjs');
  const mode = process.env.SMOKE_CORE || 'auto';
  if (mode === 'mock' || (mode === 'auto' && !fs.existsSync(coreIndex))) {
    fs.rmSync(BUILD_DIR, { recursive: true, force: true });
    fs.mkdirSync(BUILD_DIR, { recursive: true });
    const target = path.join(BUILD_DIR, 'ext');
    fs.cpSync(EXT_REAL, target, { recursive: true });
    fs.mkdirSync(path.join(target, 'src', 'core'), { recursive: true });
    fs.copyFileSync(path.join(HERE, 'mock-core', 'index.mjs'), path.join(target, 'src', 'core', 'index.mjs'));
    console.log(`! 真实 core 缺失或强制 mock：使用构建副本 ${path.relative(ROOT, target)}`);
    return { dir: target, core: 'mock' };
  }
  console.log('使用真实扩展目录：浏览器扩展/（core 已就绪）');
  return { dir: EXT_REAL, core: 'real' };
}

// ---- 本地 HTTP 服务：提供测试页 + m3u8，用于验证 webRequest 检测链路 ---------

function startLocalServer() {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const url = new URL(req.url, 'http://127.0.0.1');
      if (url.pathname === '/index.html') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end('<!doctype html><meta charset="utf-8"><title>smoke page</title><body>smoke</body>');
        return;
      }
      if (url.pathname.endsWith('.m3u8')) {
        const port = server.address().port;
        res.writeHead(200, {
          'Content-Type': 'application/vnd.apple.mpegurl',
          'Access-Control-Allow-Origin': '*',
        });
        res.end(
          [
            '#EXTM3U',
            '#EXT-X-VERSION:3',
            '#EXT-X-TARGETDURATION:5',
            '#EXT-X-MEDIA-SEQUENCE:0',
            `#EXTINF:5.0,\nhttp://127.0.0.1:${port}/seg0.ts`,
            '#EXT-X-ENDLIST',
            '',
          ].join('\n')
        );
        return;
      }
      if (url.pathname.endsWith('.ts')) {
        res.writeHead(200, { 'Content-Type': 'video/mp2t' });
        res.end(Buffer.alloc(188, 0x47));
        return;
      }
      res.writeHead(404);
      res.end('not found');
    });
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });
}

// ---- 页面错误收集 ----------------------------------------------------------

function collectPageErrors(page) {
  const errors = [];
  page.on('pageerror', (err) => errors.push(`pageerror: ${err.message}`));
  page.on('console', (message) => {
    if (message.type() !== 'error') return;
    const text = message.text();
    // 浏览器对 favicon 的 404 不计入扩展错误。
    if (/favicon/i.test(text)) return;
    errors.push(`console.error: ${text}`);
  });
  return errors;
}

// ---- 主流程 ----------------------------------------------------------------

async function main() {
  const ext = prepareExtension();
  const extDir = ext.dir;
  if (!fs.existsSync(CHROME)) throw new Error(`找不到 Chrome：${CHROME}（可用 CHROME_PATH 指定）`);
  if (!fs.existsSync(PUPPETEER_PATH)) throw new Error(`找不到 puppeteer-core：${PUPPETEER_PATH}（可用 PUPPETEER_PATH 指定）`);

  const puppeteer = require(PUPPETEER_PATH);
  fs.rmSync(PROFILE_DIR, { recursive: true, force: true });

  const headless = process.env.SMOKE_HEADFUL === '1' ? false : 'new';
  const args = [
    `--disable-extensions-except=${extDir}`,
    `--load-extension=${extDir}`,
    '--disable-features=DisableLoadExtensionCommandLineSwitch',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-sync',
    '--disable-background-networking',
    '--disable-gpu',
    '--window-size=1280,900',
  ];
  if (process.env.SMOKE_NO_SANDBOX === '1') args.push('--no-sandbox');

  console.log('启动 Chrome：', CHROME);
  console.log('扩展目录：', extDir, `（core=${ext.core}）`);

  let browser = null;
  let serverInfo = null;
  let webPage = null;
  try {
    serverInfo = await startLocalServer();
    try {
      browser = await puppeteer.launch({
        executablePath: CHROME,
        headless,
        userDataDir: PROFILE_DIR,
        args,
        protocolTimeout: 120000,
      });
    } catch (err) {
      const message = String((err && err.message) || err);
      if (/EPERM|spawn|pipe/i.test(message)) {
        console.log(`\n[环境限制] Chrome 启动失败：${message}`);
        console.log('提示：当前环境的沙箱禁止进程创建命名管道，Chromium/Chrome 无法运行；');
        console.log('      请在普通桌面环境或使用 Chrome for Testing 运行本冒烟测试。');
      }
      throw err;
    }
    console.log('Chrome 版本：', await browser.version());

    // 1) Service Worker 存在 → 扩展加载成功、拿到扩展 ID
    const swTarget = await browser.waitForTarget(
      (target) => target.type() === 'service_worker' && target.url().startsWith('chrome-extension://'),
      { timeout: 30000 }
    );
    const extId = new URL(swTarget.url()).host;
    console.log('扩展 ID：', extId, '| SW：', swTarget.url());
    check(/^[a-p]{32}$/.test(extId), '扩展成功加载并获得扩展 ID', extId);
    check(swTarget.url().endsWith('/background.js'), 'MV3 Service Worker 为 background.js');

    // 2) popup 页面：可打开、无错误、manifest 正确、后台消息 API 可用
    const popup = await browser.newPage();
    const popupErrors = collectPageErrors(popup);
    await popup.goto(`chrome-extension://${extId}/popup/popup.html`, { waitUntil: 'domcontentloaded' });
    await popup.waitForSelector('#start', { timeout: 15000 });
    check(true, 'popup/popup.html 可打开');

    const manifest = await popup.evaluate(() => chrome.runtime.getManifest());
    check(manifest.manifest_version === 3, '运行时 manifest_version = 3');
    check(
      ['webRequest', 'storage', 'tabs', 'activeTab'].every((permission) => manifest.permissions.includes(permission)),
      'permissions 含 webRequest/storage/tabs/activeTab'
    );
    check(
      manifest.host_permissions && manifest.host_permissions.includes('<all_urls>'),
      'host_permissions 含 <all_urls>'
    );
    check(!manifest.permissions.includes('downloads'), '未申请 downloads 权限');
    check(
      manifest.background && manifest.background.service_worker === 'background.js' && manifest.background.type === 'module',
      'background SW type=module'
    );
    check(manifest.action && manifest.action.default_popup === 'popup/popup.html', 'action.default_popup 正确');

    const popupText = await popup.$eval('body', (body) => body.innerText);
    check(popupText.includes('HLS 视频下载器') && popupText.includes('开始下载'), 'popup 渲染中文界面');

    const defaults = await popup.evaluate(() => chrome.runtime.sendMessage({ type: 'GET_SETTINGS' }));
    check(
      defaults && defaults.settings && defaults.settings.concurrency === 16 && defaults.settings.format === 'mp4',
      'GET_SETTINGS 返回默认设置',
      JSON.stringify(defaults)
    );
    const updated = await popup.evaluate(() =>
      chrome.runtime.sendMessage({ type: 'SET_SETTINGS', settings: { concurrency: 24, format: 'ts' } })
    );
    check(
      updated && updated.settings && updated.settings.concurrency === 24 && updated.settings.format === 'ts',
      'SET_SETTINGS 生效（24 / ts）'
    );
    await popup.evaluate(() => chrome.runtime.sendMessage({ type: 'SET_SETTINGS', settings: { concurrency: 16, format: 'mp4' } }));

    // 3) 后台 webRequest 检测 m3u8 + 角标 + 候选 API
    webPage = await browser.newPage();
    await webPage.goto(`http://127.0.0.1:${serverInfo.port}/index.html`, { waitUntil: 'domcontentloaded' });
    const m3u8Url = `http://127.0.0.1:${serverInfo.port}/stream.m3u8`;
    await webPage.evaluate(async (target) => {
      const response = await fetch(target);
      await response.text();
    }, m3u8Url);
    await sleep(700);

    const detection = await popup.evaluate(async (portPart) => {
      const tabs = await chrome.tabs.query({});
      const targetTab = tabs.find((tab) => tab.url && tab.url.includes(portPart));
      if (!targetTab) return { error: '未找到测试页面标签页' };
      const response = await chrome.runtime.sendMessage({ type: 'GET_CANDIDATES', tabId: targetTab.id });
      const badge = await chrome.action.getBadgeText({ tabId: targetTab.id });
      return { tabId: targetTab.id, candidates: response.candidates || [], badge };
    }, `127.0.0.1:${serverInfo.port}`);
    check(
      !detection.error && detection.candidates.length === 1 && /stream\.m3u8/.test(detection.candidates[0].url),
      'webRequest 检测到 m3u8 候选',
      JSON.stringify(detection)
    );
    check(detection.badge === '1', '扩展角标显示候选数量 1', String(detection.badge));

    const cleared = await popup.evaluate(async (tabId) => {
      await chrome.runtime.sendMessage({ type: 'CLEAR_CANDIDATES', tabId });
      return chrome.action.getBadgeText({ tabId });
    }, detection.tabId);
    check(cleared === '', 'CLEAR_CANDIDATES 清空候选并清除角标', JSON.stringify(cleared));

    // 4) downloader 页面（无 url）：可打开、E2E 钩子初始状态存在、给出中文提示
    const downloader = await browser.newPage();
    const downloaderErrors = collectPageErrors(downloader);
    await downloader.goto(`chrome-extension://${extId}/downloader/downloader.html`, { waitUntil: 'domcontentloaded' });
    await downloader.waitForSelector('#start', { timeout: 15000 });
    check(true, 'downloader/downloader.html 可打开');
    const emptyState = await downloader.evaluate(() => window.__HLS_STATE);
    check(
      emptyState && emptyState.phase === 'error' && /缺少/.test(String(emptyState.error)),
      'downloader 缺少 url 时写入 __HLS_STATE 中文错误',
      JSON.stringify(emptyState)
    );
    check(
      typeof (await downloader.evaluate(() => typeof window.__HLS_START)) === 'string' &&
        (await downloader.evaluate(() => typeof window.__HLS_START)) === 'function',
      'downloader 暴露 __HLS_START 钩子'
    );

    // 5) downloader 页面（带 url + autosave=1）：自动 probe 后进入 ready，E2E 钩子字段齐全
    const downloader2 = await browser.newPage();
    const downloader2Errors = collectPageErrors(downloader2);
    const query = new URLSearchParams({
      url: m3u8Url,
      format: 'mp4',
      concurrency: '4',
      autosave: '1',
    });
    await downloader2.goto(
      `chrome-extension://${extId}/downloader/downloader.html?${query.toString()}`,
      { waitUntil: 'domcontentloaded' }
    );
    await downloader2.waitForSelector('#start', { timeout: 15000 });
    try {
      await downloader2.waitForFunction(
        () => window.__HLS_STATE && window.__HLS_STATE.phase === 'ready' && window.__HLS_STATE.segmentsTotal > 0,
        { timeout: 30000 }
      );
      check(true, 'downloader 自动 probe 成功并进入 ready（segmentsTotal > 0）');
    } catch {
      check(false, 'downloader 自动 probe 成功并进入 ready', JSON.stringify(await downloader2.evaluate(() => window.__HLS_STATE)));
    }
    const stateKeys = await downloader2.evaluate(() => Object.keys(window.__HLS_STATE).sort());
    check(
      ['bytes', 'done', 'error', 'filename', 'percent', 'phase', 'segmentsDone', 'segmentsTotal'].every((key) =>
        stateKeys.includes(key)
      ),
      '__HLS_STATE 字段齐全',
      stateKeys.join(',')
    );

    // 6) 页面级错误汇总（扩展页面必须零 pageerror / console.error）
    check(popupErrors.length === 0, 'popup 无 pageerror / console.error', popupErrors.join(' | '));
    check(downloaderErrors.length === 0, 'downloader 无 pageerror / console.error', downloaderErrors.join(' | '));
    check(downloader2Errors.length === 0, 'downloader(url) 无 pageerror / console.error', downloader2Errors.join(' | '));

    if (webPage) await webPage.close().catch(() => {});
  } finally {
    if (browser) await browser.close().catch(() => {});
    if (serverInfo) serverInfo.server.close();
  }
}

try {
  await main();
} catch (err) {
  console.error('\n冒烟测试异常：');
  console.error(err && err.stack ? err.stack : err);
  failures.push(`异常：${(err && err.message) || err}`);
}

console.log('\n========== 冒烟结果 ==========');
console.log(`扩展 ID：${globalThis.__SMOKE_EXT_ID || '（未取得）'}`);
console.log(`通过：${passes.length}，失败：${failures.length}`);
if (failures.length) {
  console.log('失败：\n  - ' + failures.join('\n  - '));
  process.exitCode = 1;
} else {
  console.log('结果：冒烟测试全部通过（exit 0）');
  process.exitCode = 0;
}
