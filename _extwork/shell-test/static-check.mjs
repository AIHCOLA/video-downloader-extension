// 静态自检：在无法启动浏览器（DSH 沙箱禁止命名管道，Chromium 无法运行）的环境里，
// 对扩展交付物做尽可能接近“真实浏览器行为”的静态验证：
//
//   1. 所有 JS 通过 `node --check`（ESM 语法）；
//   2. manifest.json 可解析且关键字段/权限/图标/入口正确；
//   3. HTML 引用的本地资源都存在，且没有远程资源 / 内联脚本 / 内联事件处理；
//   4. HTML 无重复 id；JS 中通过 id 访问的元素在 HTML 中都存在；
//   5. 无 eval / new Function / WebAssembly / 远程 import 等 MV3 禁止项；
//   6. downloader 的 E2E 钩子（window.__HLS_STATE / __HLS_RESULT）与关键元素 id 齐全；
//   7. 交付目录只有运行所需文件（无测试产物 / mock / node_modules）。
//
// 用法：node _extwork/shell-test/static-check.mjs
// 退出码 0 = 全部通过；1 = 有失败项。
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(HERE, '..', '..');
export const EXT = path.join(ROOT, '浏览器扩展');
const CHECK_DIR = path.join(HERE, '.check');

const JS_FILES = [
  'background.js',
  'popup/popup.js',
  'downloader/downloader.js',
  'downloader/util.mjs',
  'src/core/direct.mjs',
  'src/core/tab-proxy.mjs',
  'src/core/dash.mjs',
  'src/core/fmp4.mjs',
  'src/core/page-data.mjs',
  'src/sites/index.mjs',
  'src/sites/bilibili.mjs',
  'src/sites/wbi.mjs',
  'src/sites/douyin.mjs',
  'src/page/douyin-capture.js',
];
const HTML_FILES = ['popup/popup.html', 'downloader/downloader.html'];
const CSS_FILES = ['popup/popup.css', 'downloader/downloader.css'];
const ICONS = ['icons/icon16.png', 'icons/icon32.png', 'icons/icon48.png', 'icons/icon128.png'];

const passes = [];
const failures = [];
const warnings = [];

function pass(label, detail) {
  passes.push(label);
  console.log(`PASS  ${label}${detail ? `  (${detail})` : ''}`);
}
function fail(label, detail) {
  failures.push(`${label}${detail ? `：${detail}` : ''}`);
  console.log(`FAIL  ${label}${detail ? `：${detail}` : ''}`);
}
function warn(label, detail) {
  warnings.push(`${label}${detail ? `：${detail}` : ''}`);
  console.log(`WARN  ${label}${detail ? `：${detail}` : ''}`);
}
function check(condition, label, detail) {
  if (condition) pass(label, detail);
  else fail(label, detail);
  return Boolean(condition);
}

function read(rel) {
  return fs.readFileSync(path.join(EXT, rel), 'utf8');
}
function exists(rel) {
  return fs.existsSync(path.join(EXT, rel));
}

// ---- 1. 交付文件齐全 -------------------------------------------------------

function checkFiles() {
  const required = [
    'manifest.json',
    'background.js',
    'README.md',
    ...JS_FILES,
    ...HTML_FILES,
    ...CSS_FILES,
    ...ICONS,
    'lib/mp4-muxer.mjs',
    'lib/LICENSE-mp4-muxer.txt',
  ];
  const missing = required.filter((rel) => !exists(rel));
  check(missing.length === 0, '必需交付文件齐全', missing.length ? `缺少 ${missing.join(', ')}` : `${required.length} 个文件`);

  // 核心模块属于 core-engine 的交付范围；shell 只按契约 import，缺失时记警告不阻塞 shell 自检。
  if (exists('src/core/index.mjs')) {
    pass('核心模块 src/core/index.mjs 存在（与 core-engine 集成点）');
  } else {
    warn('核心模块尚未就绪', 'shell 已按 CONTRACT §3 契约 import src/core/index.mjs；需 core-engine 交付后才能真实下载');
  }

  // 交付目录不得包含测试/临时产物
  const allFiles = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else allFiles.push(path.relative(EXT, full).replaceAll('\\', '/'));
    }
  };
  walk(EXT);
  const allowed = [
    /^manifest\.json$/,
    /^background\.js$/,
    /^README\.md$/,
    /^popup\/(popup\.html|popup\.css|popup\.js)$/,
    /^downloader\/(downloader\.html|downloader\.css|downloader\.js|util\.mjs)$/,
    /^icons\/icon(16|32|48|128)\.png$/,
    /^lib\/(mp4-muxer\.mjs|LICENSE-mp4-muxer\.txt)$/,
    /^src\/core\/.+$/,
    /^src\/sites\/.+$/,
    /^src\/page\/douyin-capture\.js$/,
    /^rules\/.+$/,
    // Lead 集成后加入的界面预览截图（README 引用，随扩展分发）
    /^screenshots\/(popup|downloader-mp4-60-70-done)\.png$/,
  ];
  const unexpected = allFiles.filter((rel) => !allowed.some((re) => re.test(rel)));
  check(unexpected.length === 0, '交付目录无测试/临时文件', unexpected.length ? `多余文件：${unexpected.join(', ')}` : `${allFiles.length} 个文件`);
}

// ---- 2. JS 语法（node --check） -------------------------------------------

function checkJsSyntax() {
  fs.rmSync(CHECK_DIR, { recursive: true, force: true });
  fs.mkdirSync(CHECK_DIR, { recursive: true });
  for (const rel of JS_FILES) {
    const source = read(rel);
    const tmpName = rel.replaceAll('/', '__').replace(/\.(js|mjs)$/, '.mjs');
    const tmpPath = path.join(CHECK_DIR, tmpName);
    fs.writeFileSync(tmpPath, source, 'utf8');
    // stdio 全部 ignore：DSH 沙箱禁止 Node 子进程使用管道 stdio。
    const result = spawnSync(process.execPath, ['--check', tmpPath], { stdio: 'ignore' });
    if (result.error) {
      fail(`node --check ${rel}`, `无法执行 node：${result.error.message}`);
      continue;
    }
    check(result.status === 0, `node --check ${rel}`, result.status === 0 ? '' : `退出码 ${result.status}`);
  }
  fs.rmSync(CHECK_DIR, { recursive: true, force: true });
}

// ---- 3. manifest ----------------------------------------------------------

function checkManifest() {
  let manifest;
  try {
    manifest = JSON.parse(read('manifest.json'));
  } catch (err) {
    fail('manifest.json 可解析', err.message);
    return;
  }
  pass('manifest.json 可解析');
  check(manifest.manifest_version === 3, 'manifest_version = 3');
  check(manifest.name === '视频下载器（HLS / B站 / 抖音 / 腾讯视频 / 优酷）', 'name 正确', manifest.name);
  check(/^\d+\.\d+\.\d+$/.test(String(manifest.version || '')), 'version 为 x.y.z', manifest.version);

  const permissions = Array.isArray(manifest.permissions) ? manifest.permissions : [];
  for (const need of ['webRequest', 'storage', 'tabs', 'activeTab', 'scripting', 'declarativeNetRequest']) {
    check(permissions.includes(need), `permissions 含 ${need}`);
  }
  // 抖音：document_start 注入的捕获脚本必须在包里，否则扩展加载即报错
  const contentScripts = Array.isArray(manifest.content_scripts) ? manifest.content_scripts : [];
  check(contentScripts.length > 0, '声明 content_scripts（抖音页面捕获）');
  for (const entry of contentScripts) {
    for (const file of entry.js || []) {
      check(exists(file), `content_scripts 文件存在 ${file}`, file);
    }
    check(entry.run_at === 'document_start', `content_scripts run_at = document_start`, entry.run_at);
  }

  // v1.1：B 站 CDN 需要 Referer，规则必须是「只改请求头」的静态规则集
  const dnr = manifest.declarative_net_request;
  check(Boolean(dnr && Array.isArray(dnr.rule_resources) && dnr.rule_resources.length), '声明 declarative_net_request 规则集');
  if (dnr && Array.isArray(dnr.rule_resources)) {
    for (const rule of dnr.rule_resources) {
      const rel = String(rule.path || '');
      check(exists(rel), `DNR 规则文件存在 ${rel}`, rel);
      try {
        const rules = JSON.parse(read(rel));
        const hasReferer = JSON.stringify(rules).includes('Referer');
        check(Array.isArray(rules) && rules.length > 0 && hasReferer, `DNR 规则 ${rel} 设置 Referer`);
        const onlyHeaderMod = rules.every((r) => r.action && r.action.type === 'modifyHeaders');
        check(onlyHeaderMod, `DNR 规则 ${rel} 仅做请求头改写`);
      } catch (err) {
        fail(`DNR 规则可解析 ${rel}`, err.message);
      }
    }
  }
  check(!permissions.includes('downloads'), '未申请 downloads 权限');
  check(
    Array.isArray(manifest.host_permissions) && manifest.host_permissions.includes('<all_urls>'),
    'host_permissions 含 <all_urls>',
    JSON.stringify(manifest.host_permissions)
  );

  const bg = manifest.background || {};
  check(bg.service_worker === 'background.js' && bg.type === 'module', 'background: SW background.js + type=module');
  check(manifest.action && manifest.action.default_popup === 'popup/popup.html', 'action.default_popup = popup/popup.html');
  check(Boolean(manifest.action && manifest.action.default_icon), 'action.default_icon 已配置');

  for (const size of [16, 32, 48, 128]) {
    const rel = manifest.icons && manifest.icons[String(size)];
    check(Boolean(rel) && exists(rel), `icons.${size} 文件存在`, rel);
  }
  // v1.2.1 起抖音需要 document_start 注入的捕获脚本，但作用面必须严格限定
  const scopedScripts = manifest.content_scripts || [];
  const matchesAll = scopedScripts.some((entry) =>
    (entry.matches || []).some((pattern) => !/douyin\.com/.test(pattern))
  );
  check(!matchesAll, 'content_scripts 仅作用于抖音域名（不注入其它站点）');
  check(
    scopedScripts.every((entry) => entry.all_frames !== true),
    'content_scripts 不注入所有 frame'
  );
  check(!manifest.content_security_policy, '使用默认 MV3 CSP（无 eval/wasm 放宽）');
}

// ---- 4. HTML / CSS --------------------------------------------------------

function checkHtml() {
  for (const rel of HTML_FILES) {
    const html = read(rel);
    const dir = path.dirname(path.join(EXT, rel));

    // 4.1 本地资源引用都存在
    const refs = [...html.matchAll(/\s(?:src|href)="([^"]+)"/g)].map((m) => m[1]);
    const missing = [];
    for (const ref of refs) {
      if (/^(https?:)?\/\//i.test(ref) || ref.startsWith('#') || ref.startsWith('data:')) continue;
      const target = path.resolve(dir, ref.split('?')[0].split('#')[0]);
      if (!fs.existsSync(target)) missing.push(ref);
    }
    check(missing.length === 0, `${rel} 引用的本地资源都存在`, missing.join(', '));

    // 4.2 无远程资源
    const remote = refs.filter((ref) => /^(https?:)?\/\//i.test(ref));
    check(remote.length === 0, `${rel} 无远程资源引用`, remote.join(', '));

    // 4.3 无内联脚本 / 内联事件处理（MV3 CSP 不允许）
    const inlineScripts = [...html.matchAll(/<script\b([^>]*)>/gi)].filter((m) => !/\bsrc=/i.test(m[1]));
    check(inlineScripts.length === 0, `${rel} 无内联 <script>`, `${inlineScripts.length} 处`);
    const inlineHandlers = [...html.matchAll(/\son[a-z]+\s*=\s*"/gi)].map((m) => m[0].trim());
    check(inlineHandlers.length === 0, `${rel} 无内联事件处理属性`, inlineHandlers.join(', '));

    // 4.4 id 唯一
    const ids = [...html.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]);
    const duplicates = [...new Set(ids.filter((id, index) => ids.indexOf(id) !== index))];
    check(duplicates.length === 0, `${rel} id 唯一（无重复）`, duplicates.join(', '));

    // 4.5 关键元素
    if (rel.includes('downloader')) {
      for (const id of ['start', 'cancel', 'start-sec', 'end', 'format', 'concurrency', 'progress-card', 'result-card']) {
        check(ids.includes(id), `${rel} 含关键元素 #${id}`);
      }
      check(html.includes('运行日志'), `${rel} 含日志区`);
    } else {
      for (const id of ['candidates', 'manual-url', 'probe', 'concurrency', 'format', 'start']) {
        check(ids.includes(id), `${rel} 含关键元素 #${id}`);
      }
    }

    // 4.6 编码：UTF-8（无 BOM）
    const raw = fs.readFileSync(path.join(EXT, rel));
    check(!(raw[0] === 0xef && raw[1] === 0xbb && raw[2] === 0xbf), `${rel} 无 UTF-8 BOM`);
  }

  for (const rel of CSS_FILES) {
    const css = read(rel);
    check(!/@import\s+url\(\s*['"]?https?:/i.test(css), `${rel} 无远程 @import`);
    check(!/url\(\s*['"]?https?:/i.test(css), `${rel} 无远程 url()`);
    check(!/url\(\s*['"]?\/\//i.test(css), `${rel} 无协议相对 url()`);
  }
}

// ---- 5. JS 安全性 / 远程代码 ----------------------------------------------

function checkJsSafety() {
  for (const rel of JS_FILES) {
    const js = read(rel);
    check(!/\beval\s*\(/.test(js), `${rel} 无 eval()`);
    check(!/\bnew\s+Function\s*\(/.test(js), `${rel} 无 new Function()`);
    check(!/WebAssembly/.test(js), `${rel} 无 WebAssembly`);
    check(!/\bimport\s*\(\s*['"]https?:/.test(js), `${rel} 无远程动态 import`);
    check(!/from\s+['"]https?:/.test(js), `${rel} 无远程模块 import`);
    check(!/document\.write\s*\(/.test(js), `${rel} 无 document.write`);
  }
}

// ---- 6. JS 中按 id 取用的元素都在 HTML 里 ----------------------------------

function checkElementIds() {
  const pairs = [
    ['popup/popup.js', 'popup/popup.html'],
    ['downloader/downloader.js', 'downloader/downloader.html'],
  ];
  for (const [jsRel, htmlRel] of pairs) {
    const js = read(jsRel);
    const html = read(htmlRel);
    const htmlIds = new Set([...html.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]));
    const used = new Set();
    for (const match of js.matchAll(/(?:\$|getElementById)\(\s*'([A-Za-z0-9_-]+)'\s*\)/g)) used.add(match[1]);
    const missing = [...used].filter((id) => !htmlIds.has(id));
    check(missing.length === 0, `${jsRel} 用到的元素 id 都存在于 ${htmlRel}`, missing.join(', '));
  }
}

// ---- 7. E2E 钩子 / 集成点 --------------------------------------------------

function checkE2eHooks() {
  const js = read('downloader/downloader.js');
  check(js.includes('window.__HLS_STATE'), 'downloader 设置 window.__HLS_STATE');
  check(js.includes('window.__HLS_RESULT'), 'downloader 设置 window.__HLS_RESULT');
  check(js.includes('window.__HLS_BLOB_URL'), 'downloader 暴露 E2E 用的 window.__HLS_BLOB_URL');
  for (const key of ['phase', 'percent', 'segmentsDone', 'segmentsTotal', 'error', 'done', 'filename', 'bytes']) {
    check(new RegExp(`\\b${key}\\b`).test(js), `__HLS_STATE 钩子字段含 ${key}`);
  }
  for (const key of ['durationSeconds', 'muxed', 'pathHint']) {
    check(new RegExp(`\\b${key}\\b`).test(js), `__HLS_RESULT 钩子字段含 ${key}`);
  }
  check(js.includes('showSaveFilePicker'), 'downloader 使用 File System Access API（showSaveFilePicker）');
  check(/<a\b|createElement\('a'\)/.test(js), 'downloader 有 Blob + <a download> 兜底');
  check(js.includes('AbortController'), 'downloader 支持取消（AbortController）');
  check(js.includes("'AbortError'") && js.includes('已取消'), 'downloader 区分 AbortError 并提示已取消');

  // 位置感知写入（MP4 fastStart:false 的 mdat size 回填，>4MiB 文件必需）
  check(js.includes('supportsPosition: true'), 'downloader 向 downloadHls 声明 output.supportsPosition=true');
  check(/async \(chunk, position\)/.test(js), 'downloader 的 output.write 接收 (chunk, position)');
  check(js.includes("type: 'write', data: bytes, position: offset"), 'downloader FSA 模式按 position 覆盖写');
  check(js.includes('assemblePositionedChunks'), 'downloader Blob 模式按偏移组装文件');
  check(js.includes('moovFront'), 'downloader 暴露 __HLS_RESULT.moovFront（E2E 校验渐进式 MP4）');

  const bg = read('background.js');
  check(bg.includes("'GET_CANDIDATES'"), 'background 提供 GET_CANDIDATES');
  check(bg.includes("'CLEAR_CANDIDATES'"), 'background 提供 CLEAR_CANDIDATES');
  check(bg.includes("'GET_SETTINGS'"), 'background 提供 GET_SETTINGS');
  check(bg.includes("'SET_SETTINGS'"), 'background 提供 SET_SETTINGS');
  check(bg.includes('storage.session'), 'background 使用 storage.session 持久化候选');
  check(bg.includes('tabs.onRemoved'), 'background 在 tabs.onRemoved 清理');
  check(bg.includes('#6D3BFF'), 'background 角标紫色 #6D3BFF');

  const popup = read('popup/popup.js');
  check(popup.includes("from '../src/core/index.mjs'"), 'popup 按契约 import src/core/index.mjs');
  check(popup.includes('probePlaylist'), 'popup 调用 probePlaylist');
  check(popup.includes("from '../downloader/util.mjs'"), 'popup import 共享 util.mjs');
  const dl = js;
  check(dl.includes("from '../src/core/index.mjs'"), 'downloader 按契约 import src/core/index.mjs');
  check(dl.includes('probePlaylist') && dl.includes('downloadHls'), 'downloader 调用 probePlaylist + downloadHls');
  check(dl.includes("from './util.mjs'"), 'downloader import 共享 util.mjs');
}

// ---- 8. README ------------------------------------------------------------

function checkReadme() {
  const md = read('README.md');
  for (const keyword of ['加载已解压的扩展程序', 'chrome://extensions', '开发者模式', '保存位置', '常见问题', '已知限制', '已验证']) {
    check(md.includes(keyword), `README 含「${keyword}」章节/说明`);
  }
  check(!/https?:\/\/[^\s)]*\.(js|css)/.test(md), 'README 不引用远程脚本/样式');
}

// ---- 入口 -----------------------------------------------------------------

export async function runCheck() {
  console.log('=== 扩展外壳静态自检 ===');
  console.log(`工作区：${ROOT}`);
  console.log(`扩展目录：${EXT}\n`);
  checkFiles();
  checkJsSyntax();
  checkManifest();
  checkHtml();
  checkJsSafety();
  checkElementIds();
  checkE2eHooks();
  checkReadme();

  console.log('\n========== 静态自检汇总 ==========');
  console.log(`通过：${passes.length}，失败：${failures.length}，警告：${warnings.length}`);
  if (warnings.length) console.log('警告：\n  - ' + warnings.join('\n  - '));
  if (failures.length) {
    console.log('失败：\n  - ' + failures.join('\n  - '));
  } else {
    console.log('结果：静态自检全部通过（exit 0）');
  }
  return failures.length === 0 ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  process.exitCode = await runCheck();
}
