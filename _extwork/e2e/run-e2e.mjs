// 真实浏览器 E2E v2：Chrome for Testing + puppeteer-core 加载 `浏览器扩展/`。
// 关键设计：
//  - 用真实鼠标事件点击（CDP Input），保证浏览器把点击视为用户激活（下载/文件 API 需要）；
//  - 下载产物不依赖 Chrome 下载目录：页面内 fetch(window.__HLS_BLOB_URL) → POST 到本脚本的
//    本地 HTTP 服务 → 写入 _extwork/e2e/uploaded/ → ffmpeg 校验（更可靠，也顺带验证字节流）；
//  - 轮询 window.__HLS_STATE 并打印时间线，便于定位问题。
// 运行：node _extwork/e2e/run-e2e.mjs
import path from 'node:path';
import fs from 'node:fs';
import http from 'node:http';
import { spawnSync } from 'node:child_process';
import puppeteer from 'puppeteer-core';

const ROOT = 'C:/Users/20823/Documents/deepseek-harness/default-workspace';
const CHROME = path.join(ROOT, '_extwork/browsers/chrome-win64/chrome.exe');
const EXT = path.join(ROOT, '浏览器扩展');
const PROFILE = path.join(ROOT, '_extwork/e2e/profile-ext');
const DL_DIR = path.join(ROOT, '_extwork/e2e/downloads');
const UPLOAD_DIR = path.join(ROOT, '_extwork/e2e/uploaded');
const SHOT_DIR = path.join(ROOT, '_extwork/e2e/screenshots');
const FFMPEG = path.join(ROOT, '_tools/imageio_ffmpeg/binaries/ffmpeg-win-x86_64-v9.0.2.exe');
const PLAYLIST = 'https://vv.jisuzyv.com/play/aQWNV05d/index.m3u8';
const REPORT_PATH = path.join(ROOT, '_extwork/e2e/report.json');
const UPLOAD_PORT = 8799;

const report = { startedAt: new Date().toISOString(), chrome: CHROME, steps: [], consoleErrors: [], files: [], timeline: [] };
let failures = 0;

function step(name, ok, detail = '') {
  report.steps.push({ name, ok, detail: String(detail || '') });
  if (!ok) failures += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  |  ' + detail : ''}`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function ffInfo(file) {
  const r = spawnSync(FFMPEG, ['-hide_banner', '-i', file], { encoding: 'utf8' });
  return (r.stderr || '') + (r.stdout || '');
}
function ffDecode(file) {
  const r = spawnSync(FFMPEG, ['-v', 'error', '-i', file, '-f', 'null', '-'], { encoding: 'utf8' });
  return { ok: r.status === 0 && !(r.stderr || '').trim(), stderr: (r.stderr || '').slice(0, 1500) };
}
function countFrames(file) {
  const r = spawnSync(FFMPEG, ['-hide_banner', '-i', file, '-map', '0:v:0', '-c', 'copy', '-f', 'null', '-'], { encoding: 'utf8' });
  const m = (r.stderr || '').match(/frame=\s*(\d+)/g);
  return m ? Number(m[m.length - 1].replace(/[^\d]/g, '')) : -1;
}

// 本地服务：接收页面 POST 上来的字节
const server = http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', '*');
  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }
  const url = new URL(req.url, 'http://127.0.0.1');
  if (req.method === 'POST' && url.pathname === '/upload') {
    const name = path.basename(url.searchParams.get('name') || 'upload.bin');
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const buf = Buffer.concat(chunks);
      const out = path.join(UPLOAD_DIR, name);
      fs.writeFileSync(out, buf);
      report.files.push(out);
      console.log(`       [upload] ${name} ${buf.length} bytes -> ${out}`);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, size: buf.length, path: out }));
    });
    return;
  }
  if (url.pathname === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
    return;
  }
  res.writeHead(404);
  res.end('not found');
});

async function clickReal(page, selector) {
  await page.waitForSelector(selector, { visible: true, timeout: 30000 });
  const el = await page.$(selector);
  const box = await el.boundingBox();
  if (!box) return false;
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  return true;
}

async function readState(page) {
  return page.evaluate(() => ({
    state: window.__HLS_STATE ? { ...window.__HLS_STATE } : null,
    result: window.__HLS_RESULT || null,
    blobSize: window.__HLS_BLOB_SIZE || 0,
    blobUrl: window.__HLS_BLOB_URL || null,
    startText: (document.getElementById('start') || {}).textContent || '',
    startDisabled: !!(document.getElementById('start') || {}).disabled,
    pageText: (document.body.innerText || '').slice(0, 400),
  })).catch(() => null);
}

async function waitDone(page, timeoutMs, label) {
  const t0 = Date.now();
  let last = '';
  while (Date.now() - t0 < timeoutMs) {
    const snap = await readState(page);
    if (snap && snap.state) {
      const line = `phase=${snap.state.phase} pct=${snap.state.percent} seg=${snap.state.segmentsDone}/${snap.state.segmentsTotal} bytes=${snap.state.bytes} err=${snap.state.error} result=${snap.result ? 'yes' : 'no'} blob=${snap.blobSize}`;
      if (line !== last) {
        last = line;
        report.timeline.push({ t: Date.now() - t0, label, line });
        console.log(`       [${label} +${((Date.now() - t0) / 1000).toFixed(1)}s] ${line}`);
      }
      if (snap.state.error) return { snap, error: snap.state.error };
      // 注意：core 的 onProgress 阶段里也会出现 phase='done'（此时 finalizeBlob/结果落盘还未完成），
      // 必须等页面真正写完 __HLS_RESULT / done:true。
      if (snap.result || snap.state.done === true) return { snap, error: null };
    }
    await sleep(350);
  }
  return { snap: last ? null : await readState(page), error: `超时（${label}）` };
}

async function fetchBlobAndUpload(page, name) {
  return page.evaluate(
    async ({ port, name }) => {
      if (!window.__HLS_BLOB_URL) return { ok: false, error: 'no __HLS_BLOB_URL' };
      const resp = await fetch(window.__HLS_BLOB_URL);
      const blob = await resp.blob();
      const up = await fetch(`http://127.0.0.1:${port}/upload?name=${encodeURIComponent(name)}`, { method: 'POST', body: blob });
      return { ok: up.ok, size: blob.size, result: await up.json().catch(() => null) };
    },
    { port: UPLOAD_PORT, name }
  ).catch((e) => ({ ok: false, error: String(e && e.message) }));
}

async function testFormat(browser, extId, { format, start, end, timeout = 180000, shotName }) {
  const label = format.toUpperCase();
  const page = await browser.newPage();
  const errs = [];
  page.on('pageerror', (e) => errs.push('pageerror: ' + e.message));
  page.on('console', (m) => {
    if (m.type() === 'error') errs.push('console: ' + m.text());
  });
  const url =
    `chrome-extension://${extId}/downloader/downloader.html?url=${encodeURIComponent(PLAYLIST)}` +
    `&format=${format}&concurrency=16&start=${start}&end=${end}&autosave=1`;
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  // 等自动 probe 完成
  const t0 = Date.now();
  let infoTxt = '';
  while (Date.now() - t0 < 45000) {
    infoTxt = await page.evaluate(() => (document.getElementById('info-segments') || {}).textContent || '').catch(() => '');
    if (/\d/.test(infoTxt)) break;
    await sleep(300);
  }
  step(`${label}：下载页解析播放列表`, /\d/.test(infoTxt), `segments=${infoTxt}`);
  if (errs.length) step(`${label}：解析阶段无 JS 错误`, false, errs.join(' | '));
  const clicked = await clickReal(page, '#start').catch((e) => {
    console.log('click start failed:', e.message);
    return false;
  });
  step(`${label}：点击开始下载`, clicked);
  let { snap, error } = await waitDone(page, timeout, label);
  if (error || !snap || !snap.state) {
    step(`${label}：下载完成`, false, String(error));
    const txt = await page.evaluate(() => document.body.innerText).catch(() => '');
    console.log('       PAGE TEXT:', txt.slice(0, 1500));
    await page.screenshot({ path: path.join(SHOT_DIR, shotName + '-error.png'), fullPage: true }).catch(() => {});
    report.consoleErrors.push(...errs);
    await page.close();
    return;
  }
  const finalSnap = await readState(page);
  snap = finalSnap || snap;
  step(`${label}：下载完成（done=true）`, !!(snap.state && snap.state.done === true), JSON.stringify(snap.state || null).slice(0, 200));
  step(`${label}：__HLS_RESULT 已写入`, !!snap.result, JSON.stringify(snap.result || null).slice(0, 300));
  step(`${label}：__HLS_BLOB_SIZE > 0`, snap.blobSize > 0, String(snap.blobSize));
  await page.screenshot({ path: path.join(SHOT_DIR, shotName + '.png'), fullPage: true }).catch(() => {});

  const up = await fetchBlobAndUpload(page, `e2e-${label.toLowerCase()}-${Date.now()}.${format === 'ts' ? 'ts' : 'mp4'}`);
  step(`${label}：产物字节上传成功（fetch Blob）`, !!(up && up.ok), JSON.stringify(up).slice(0, 250));
  if (up && up.ok) {
    const file = report.files[report.files.length - 1];
    if (file && fs.existsSync(file)) {
      const info = ffInfo(file);
      const dec = ffDecode(file);
      const durMatch = info.match(/Duration: (\d+):(\d+):(\d+\.\d+)/);
      const dur = durMatch ? Number(durMatch[1]) * 3600 + Number(durMatch[2]) * 60 + Number(durMatch[3]) : -1;
      const expect = end - start;
      if (format === 'mp4') {
        step(`${label}：ffmpeg 时长 ${expect}s±0.6`, Math.abs(dur - expect) < 0.6, `duration=${dur}`);
      } else {
        // 设计约定：TS 按分片边界输出，不做时间裁剪；允许比请求区间多 1~2 个分片
        step(`${label}：ffmpeg 时长在 ${expect}~${expect + 12}s 内（TS 不裁剪）`, dur >= expect - 0.5 && dur <= expect + 12, `duration=${dur}`);
      }
      step(`${label}：含 H.264 视频流`, /Video:\s*h264/i.test(info), (info.match(/Video:[^\n]*/) || [''])[0].trim().slice(0, 120));
      step(`${label}：含 AAC 音频流`, /Audio:\s*aac/i.test(info), (info.match(/Audio:[^\n]*/) || [''])[0].trim().slice(0, 120));
      step(`${label}：全片解码无错误`, dec.ok, dec.stderr);
      if (format === 'mp4') {
        step('MP4：__HLS_RESULT.moovFront === false（渐进式）', snap.result && snap.result.moovFront === false, String(snap.result && snap.result.moovFront));
        const raw = fs.readFileSync(file);
        const mdatPos = raw.indexOf('mdat');
        const moovPos = raw.indexOf('moov');
        step('MP4：文件结构 moov 在 mdat 之后（moov 末尾）', mdatPos > 0 && moovPos > mdatPos, `mdat@${mdatPos} moov@${moovPos}`);
      }
    }
  }
  if (errs.length) step(`${label}：下载阶段无 JS 错误`, false, errs.join(' | '));
  else step(`${label}：下载阶段无 JS 错误`, true, '');
  report.consoleErrors.push(...errs);
  await page.close();
}

// ---------------------------------------------------------------------------
fs.rmSync(PROFILE, { recursive: true, force: true });
for (const d of [DL_DIR, UPLOAD_DIR, SHOT_DIR]) {
  fs.rmSync(d, { recursive: true, force: true });
  fs.mkdirSync(d, { recursive: true });
}

await new Promise((resolve) => server.listen(UPLOAD_PORT, '127.0.0.1', resolve));
console.log('upload server on', UPLOAD_PORT);

if (!fs.existsSync(CHROME)) {
  step('Chrome for Testing 存在', false, CHROME);
  fs.writeFileSync(REPORT_PATH, JSON.stringify(report, null, 2));
  process.exit(1);
}
if (!fs.existsSync(path.join(EXT, 'manifest.json'))) {
  step('扩展目录存在', false, EXT);
  fs.writeFileSync(REPORT_PATH, JSON.stringify(report, null, 2));
  process.exit(1);
}

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: true,
  userDataDir: PROFILE,
  args: [
    `--disable-extensions-except=${EXT}`,
    `--load-extension=${EXT}`,
    '--no-sandbox',
    '--disable-setuid-sandbox',
    '--disable-gpu',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-background-networking',
    '--disable-sync',
    '--disable-component-update',
    '--allow-insecure-localhost',
  ],
});

try {
  step('浏览器启动', true, await browser.version());
  const cdp = await browser.target().createCDPSession();
  await cdp.send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: DL_DIR, eventsEnabled: true }).catch(() => {});

  let swTarget = null;
  try {
    swTarget = await browser.waitForTarget((t) => t.type() === 'service_worker' && t.url().startsWith('chrome-extension://'), { timeout: 30000 });
  } catch (e) {
    step('service worker 启动', false, String(e && e.message));
  }
  if (!swTarget) throw new Error('扩展未加载（找不到 service worker）');
  const extId = new URL(swTarget.url()).host;
  step('扩展加载 + service worker', true, `id=${extId}`);

  // popup
  const popupPage = await browser.newPage();
  const popupErrs = [];
  popupPage.on('pageerror', (e) => popupErrs.push('pageerror: ' + e.message));
  popupPage.on('console', (m) => {
    if (m.type() === 'error') popupErrs.push('console: ' + m.text());
  });
  await popupPage.goto(`chrome-extension://${extId}/popup/popup.html`, { waitUntil: 'domcontentloaded' });
  await sleep(800);
  const popupText = await popupPage.evaluate(() => document.body.innerText);
  await popupPage.screenshot({ path: path.join(SHOT_DIR, 'popup.png') });
  step('popup 页面加载', /HLS|m3u8|下载/i.test(popupText), `errors=${popupErrs.length}`);
  report.consoleErrors.push(...popupErrs);
  await popupPage.close();

  // 检测
  const page = await browser.newPage();
  await page.goto('https://vv.jisuzyv.com/play/aQWNV05d/', { waitUntil: 'domcontentloaded', timeout: 45000 }).catch(() => {});
  await sleep(4000);
  const cand = await swTarget.worker().then((w) => w.evaluate(async () => (await chrome.storage.session.get(null)).m3u8Candidates || null)).catch(() => null);
  const list = cand ? Object.values(cand).flat() : [];
  step('m3u8 自动检测（webRequest → 候选）', list.length > 0, `候选数=${list.length} ${JSON.stringify(list.slice(0, 2))}`);
  if (list.length === 0) {
    const p2 = await browser.newPage();
    await p2.goto(PLAYLIST, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
    await sleep(2500);
    const cand2 = await swTarget.worker().then((w) => w.evaluate(async () => (await chrome.storage.session.get(null)).m3u8Candidates || null)).catch(() => null);
    const list2 = cand2 ? Object.values(cand2).flat() : [];
    step('m3u8 自动检测（兜底）', list2.length > 0, `候选数=${list2.length}`);
    await p2.close();
  }
  await page.close();

  // MP4 / TS
  await testFormat(browser, extId, { format: 'mp4', start: 0, end: 10, timeout: 180000, shotName: 'downloader-mp4-done' });
  // 关键回归：>4MiB 产物在浏览器 Blob 模式下的位置回填（mdat size）与 moov 末尾结构
  await testFormat(browser, extId, { format: 'mp4', start: 60, end: 70, timeout: 240000, shotName: 'downloader-mp4-60-70-done' });
  await testFormat(browser, extId, { format: 'ts', start: 0, end: 6, timeout: 120000, shotName: 'downloader-ts-done' });

  // 取消
  {
    const page = await browser.newPage();
    const errs = [];
    page.on('pageerror', (e) => errs.push('pageerror: ' + e.message));
    page.on('console', (m) => {
      if (m.type() === 'error') errs.push('console: ' + m.text());
    });
    const url = `chrome-extension://${extId}/downloader/downloader.html?url=${encodeURIComponent(PLAYLIST)}&format=mp4&concurrency=8&autosave=1`;
    await page.goto(url, { waitUntil: 'domcontentloaded' });
    const t0 = Date.now();
    while (Date.now() - t0 < 45000) {
      const t = await page.evaluate(() => (document.getElementById('info-segments') || {}).textContent || '').catch(() => '');
      if (/\d/.test(t)) break;
      await sleep(300);
    }
    await clickReal(page, '#start');
    let cancelledState = null;
    const t1 = Date.now();
    while (Date.now() - t1 < 60000) {
      const snap = await readState(page);
      if (snap && snap.state) {
        if ((snap.state.segmentsDone || 0) >= 2) break;
        if (snap.state.error) break;
      }
      await sleep(250);
    }
    const clickCancel = await clickReal(page, '#cancel').catch(() => false);
    step('取消：点击取消按钮', clickCancel);
    const t2 = Date.now();
    while (Date.now() - t2 < 30000) {
      const snap = await readState(page);
      if (snap && snap.state && (snap.state.phase === 'cancelled' || snap.state.error)) {
        cancelledState = snap;
        break;
      }
      await sleep(250);
    }
    const pageText = await page.evaluate(() => document.body.innerText).catch(() => '');
    step('取消：状态变为已取消', !!(cancelledState && /已取消/.test(String(cancelledState.state.error || ''))), JSON.stringify(cancelledState && cancelledState.state));
    step('取消：页面显示已取消', /已取消/.test(pageText), '');
    const res = cancelledState && cancelledState.result;
    step('取消：无成功结果', !res, JSON.stringify(res));
    await page.screenshot({ path: path.join(SHOT_DIR, 'downloader-cancelled.png'), fullPage: true }).catch(() => {});
    if (errs.length) step('取消：无 JS 错误', false, errs.join(' | '));
    report.consoleErrors.push(...errs);
    await page.close();
  }
} catch (e) {
  step('E2E 未捕获异常', false, String((e && e.stack) || e));
} finally {
  report.finishedAt = new Date().toISOString();
  report.downloadFiles = (() => {
    try {
      return fs.readdirSync(DL_DIR);
    } catch {
      return [];
    }
  })();
  report.ok = failures === 0;
  fs.writeFileSync(REPORT_PATH, JSON.stringify(report, null, 2));
  await browser.close().catch(() => {});
  server.close();
  console.log(`\n==== E2E ${failures === 0 ? 'PASS' : 'FAIL'} (${failures} failures) ====`);
  console.log('report:', REPORT_PATH);
  process.exit(failures === 0 ? 0 : 1);
}
