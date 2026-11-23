// 真实网络集成验证（腾讯视频）：不启动浏览器，直接验证解析链路与 CDN 取字节。
//
// 覆盖：
//   1. resolveTencent 真实调用 getinfo，返回可用计划（标题/清晰度/大小/时长）
//   2. 按计划的地址取整片（或指定字节数）→ HTTP 200 / 206，字节以 ftyp 开头
//   3. CDN 不校验 Referer（不带 Referer 也能取到）→ 扩展不需要额外 DNR 规则
//   4. 版权内容（DRM）会给出明确提示而不是下载加密字节
//
// 用法：node _extwork/shell-test/integration-tencent.mjs [视频URL]
// 退出码 0 = 全部通过。
import path from 'node:path';
import http from 'node:http';
import https from 'node:https';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(HERE, '..', '..');
const EXT = path.join(ROOT, '浏览器扩展');

const DEFAULT_TARGET = 'https://v.qq.com/x/page/y41026no22e.html';
const DRM_TARGET = 'https://v.qq.com/x/cover/mzc002001bk7moh/w41029n1rrv.html';

const passes = [];
const failures = [];

function ok(condition, label, detail) {
  if (condition) {
    passes.push(label);
    console.log(`PASS  ${label}${detail ? `  (${detail})` : ''}`);
  } else {
    failures.push(`${label}${detail ? `：${detail}` : ''}`);
    console.log(`FAIL  ${label}${detail ? `：${detail}` : ''}`);
  }
}

/** 用 node:http(s) 取一段字节（可指定 Referer），绕开 fetch 对 Referer 的限制 */
function fetchRange(url, { start = 0, end = 65535, referer } = {}) {
  return new Promise((resolve, reject) => {
    let target;
    try {
      target = new URL(url);
    } catch (err) {
      reject(err);
      return;
    }
    // 腾讯的 302 会跳到 http 的 IPv6 节点，两种协议都要支持
    const isHttps = target.protocol === 'https:';
    const mod = isHttps ? https : http;
    const headers = { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/137.0.0.0 Safari/537.36' };
    if (referer) headers.Referer = referer;
    if (end >= 0) headers.Range = `bytes=${start}-${end}`;
    const req = mod.request(
      {
        protocol: target.protocol,
        hostname: target.hostname,
        port: target.port || (isHttps ? 443 : 80),
        path: `${target.pathname}${target.search}`,
        method: 'GET',
        headers,
        timeout: 30000,
      },
      (res) => {
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => {
          resolve({
            status: res.statusCode,
            headers: res.headers,
            body: Buffer.concat(chunks),
            location: res.headers.location || '',
          });
        });
      }
    );
    req.on('timeout', () => req.destroy(new Error('请求超时')));
    req.on('error', reject);
    req.end();
  });
}

/** 跟随 302，拿到最终地址 */
async function followRedirects(url, opts = {}, max = 5) {
  let current = url;
  for (let i = 0; i < max; i += 1) {
    const res = await fetchRange(current, opts);
    if (res.status >= 300 && res.status < 400 && res.location) {
      current = new URL(res.location, current).href;
      continue;
    }
    return { ...res, finalUrl: current };
  }
  throw new Error('重定向次数过多');
}

function isMp4Head(buf) {
  if (!buf || buf.length < 12) return false;
  const type = buf.toString('latin1', 4, 8);
  return type === 'ftyp';
}

async function run() {
  const target = process.argv[2] || DEFAULT_TARGET;
  const tencent = await import(pathToFileURL(path.join(EXT, 'src', 'sites', 'tencent.mjs')).href);

  console.log(`目标：${target}\n`);

  // ---- 1) 解析 ----
  let plan = null;
  try {
    plan = await tencent.resolveTencent(target, { minGapMs: 800 });
    ok(Boolean(plan && plan.url), '解析成功：拿到播放地址');
    console.log(
      `      标题：${plan.title}\n      清晰度：${plan.quality.label}（${plan.quality.width}×${plan.quality.height}）\n      大小：${plan.sizeBytes} 字节，时长 ${plan.durationSeconds}s\n      地址：${plan.url.slice(0, 110)}…`
    );
  } catch (err) {
    ok(false, '解析成功：拿到播放地址', err.message);
    return;
  }

  ok(plan.site === 'tencent', '计划站点为 tencent');
  ok(plan.mode === 'file' && plan.container === 'mp4', '计划走整段 MP4');
  ok(plan.sizeBytes > 100000, '计划大小合理', `${plan.sizeBytes} 字节`);
  ok(plan.durationSeconds > 1, '计划时长合理', `${plan.durationSeconds}s`);
  ok(plan.qualities.length >= 1, '计划列出清晰度档位', plan.acceptLabels.join(' / '));

  // ---- 2) 带 Referer 取首 64 KiB ----
  await new Promise((r) => setTimeout(r, 800));
  const withRef = await followRedirects(plan.url, { end: 65535, referer: tencent.TENCENT_REFERER });
  ok([200, 206].includes(withRef.status), '带 Referer 取字节成功', `HTTP ${withRef.status}`);
  ok(isMp4Head(withRef.body), '取到的字节以 ftyp 开头（真 MP4）', withRef.body.toString('latin1', 4, 8));
  const totalFromHeader = Number((withRef.headers['content-range'] || '').split('/')[1]) || 0;
  if (totalFromHeader) {
    ok(
      Math.abs(totalFromHeader - plan.sizeBytes) <= 1,
      'Content-Range 总大小与计划一致',
      `${totalFromHeader} vs ${plan.sizeBytes}`
    );
  }

  // ---- 3) 不带 Referer 也能取（说明不需要 DNR 规则）----
  await new Promise((r) => setTimeout(r, 800));
  const noRef = await followRedirects(plan.url, { end: 1023 });
  ok([200, 206].includes(noRef.status), '不带 Referer 也能取字节（CDN 不校验）', `HTTP ${noRef.status}`);

  // ---- 4) 版权内容：明确拒绝 ----
  await new Promise((r) => setTimeout(r, 1200));
  let drmMessage = '';
  try {
    await tencent.resolveTencent(DRM_TARGET, { minGapMs: 800 });
  } catch (err) {
    drmMessage = err.message;
  }
  ok(drmMessage.includes('DRM'), '版权内容（剧集）明确提示 DRM，不返回加密字节', drmMessage.slice(0, 60));

  console.log('\n========== 腾讯视频集成验证汇总 ==========');
  console.log(`通过：${passes.length}，失败：${failures.length}`);
  if (failures.length) console.log('失败：\n  - ' + failures.join('\n  - '));
  else console.log('结果：全部通过（exit 0）');
  process.exitCode = failures.length === 0 ? 0 : 1;
}

await run();
