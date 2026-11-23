// 一键自检入口（本机 / 无浏览器环境可运行）：
//   1. 静态检查（manifest / HTML / 资源 / 安全项 / id / E2E 钩子）
//   2. util.mjs 纯逻辑单测
//   3. background.js 单测（chrome.* mock）
//
// 用法：node _extwork/shell-test/run-checks.mjs
// 退出码 0 = 全部通过。
//
// 注意：puppeteer 冒烟测试 smoke.mjs 需要能正常启动 Chrome 的环境（本 DSH 沙箱禁止命名管道，
// Chromium 无法启动），不在本一键自检范围内，请用 `node _extwork/shell-test/smoke.mjs` 单独运行。
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));

const STEPS = [
  ['./static-check.mjs', '静态检查（manifest / HTML / 资源 / 安全 / 钩子）'],
  ['./unit-util.mjs', 'util.mjs 纯逻辑单测'],
  ['./unit-background.mjs', 'background.js 逻辑单测（chrome.* mock）'],
  ['./unit-sites.mjs', 'B 站解析 + 直链下载单测'],
];

let failedSteps = 0;
for (const [modulePath, label] of STEPS) {
  console.log(`\n${'#'.repeat(8)} ${label} ${'#'.repeat(8)}`);
  try {
    const mod = await import(modulePath);
    const code = await mod.runCheck();
    if (code !== 0) failedSteps += 1;
  } catch (err) {
    failedSteps += 1;
    console.error(`步骤异常退出：${label}`);
    console.error(err && err.stack ? err.stack : err);
  }
}

console.log('\n==================================================');
if (failedSteps === 0) {
  console.log('全部自检通过（exit 0）：静态检查 + 纯逻辑单测 + 后台逻辑单测');
} else {
  console.log(`自检失败：${failedSteps} 个步骤未通过`);
}
process.exitCode = failedSteps === 0 ? 0 : 1;
