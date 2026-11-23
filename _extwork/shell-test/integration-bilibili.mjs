// 真实网络集成验证（B 站）：不启动浏览器，直接验证解析链路与 CDN 取字节。
//
// 覆盖：
//   1. resolveBilibili 真实调用 view + playurl，返回可用计划（标题/清晰度/大小/时长/整段 MP4）
//   2. 带 Referer 取首 64 KiB → HTTP 206，字节里有 ftyp/moov 结构，Content-Range 总大小与计划一致
//   3. 不带 Referer 取 → 403（这正是扩展需要 DNR 改写 / 标签页代理的原因）
//
// 用法：node _extwork/shell-test/integration-bilibili.mjs [BV号或视频URL]
// 退出码 0 = 全部通过。
import path from 'node:path';
import https from 'node:https';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(HERE, '..', '..');
const EXT = path.join(ROOT, '浏览器扩展');

const DEFAULT_TARGET = 'https://www.bilibili.com/video/BV1GbWq6HEct';

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

/** 用 node:https 取一段字节（可指定 Referer），绕开 fetch 对 Referer 的限制 */
function fetchRange(url, { start = 0, end = 65535, referer } = {}) {
  return new Promise((resolve, reject) => {
    let target;
    try {
      target = new URL(url);
    } catch (err) {
      reject(err);
      return;
    }
    const headers = {
      Range: `bytes=${start}-${end}`,
      'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36',
    };
    if (referer) headers.Referer = referer;
    const req = https.request(
      {
        hostname: target.hostname,
        port: target.port || 443,
        path: `${target.pathname}${target.search}`,
        method: 'GET',
        headers,
        timeout: 30000,
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () =>
          resolve({
            status: res.statusCode,
            bytes: Buffer.concat(chunks),
            contentRange: res.headers['content-range'] || '',
            contentType: res.headers['content-type'] || '',
          })
        );
      }
    );
    req.on('timeout', () => req.destroy(new Error('请求超时')));
    req.on('error', reject);
    req.end();
  });
}

export async function runCheck() {
  const target = process.argv[2] || DEFAULT_TARGET;
  console.log(`=== B 站真实网络集成验证 ===\n目标：${target}\n`);

  const bili = await import(pathToFileURL(path.join(EXT, 'src', 'sites', 'bilibili.mjs')).href);

  let plan = null;
  let wbiFallback = false;
  try {
    plan = await bili.resolveBilibili(target, {
      onLog: (l, m) => {
        console.log(`      [${l}] ${m}`);
        if (m.includes('WBI 签名请求失败')) wbiFallback = true;
      },
    });
  } catch (err) {
    ok(false, '解析视频', err.message);
  }

  ok(!wbiFallback, 'WBI 签名被接口接受（没有回退普通接口）');

  if (plan) {
    ok(plan.site === 'bilibili', '识别为 B 站', plan.site);
    ok(Boolean(plan.title), '拿到标题', plan.title);
    ok(/^BV[0-9A-Za-z]{10}$/.test(plan.bvid), '拿到 BV 号', plan.bvid);
    ok(plan.quality && plan.quality.qn > 0, '拿到清晰度', `${plan.quality.label} (qn=${plan.quality.qn})`);
    ok(plan.sizeBytes > 0, '拿到文件大小', `${(plan.sizeBytes / 1048576).toFixed(1)} MB`);
    ok(plan.durationSeconds > 0, '拿到时长', `${plan.durationSeconds.toFixed(1)}s`);
    ok(plan.requiresReferer === true && plan.referer.includes('bilibili.com'), '计划声明需要 Referer', plan.referer);
    ok(/\.(bilivideo\.(com|cn)|mountaintoys\.cn|szbdyd\.com)/.test(new URL(plan.url).hostname), '下载地址为 B 站 CDN', new URL(plan.url).hostname);

    // 带 Referer：应当 206，且字节是 MP4
    const withRef = await fetchRange(plan.url, { start: 0, end: 65535, referer: 'https://www.bilibili.com' });
    ok(withRef.status === 206 || withRef.status === 200, '带 Referer 请求成功', `HTTP ${withRef.status}`);
    ok(withRef.bytes.length > 1000, '带 Referer 返回有效字节', `${withRef.bytes.length} 字节`);
    ok(withRef.bytes.includes(Buffer.from('ftyp')), '返回内容是 MP4（含 ftyp）', withRef.contentType);
    const total = Number((withRef.contentRange.match(/\/(\d+)/) || [])[1] || 0);
    ok(total > 0 && Math.abs(total - plan.sizeBytes) < 1024, 'Content-Range 总大小与计划一致', `${total} vs ${plan.sizeBytes}`);

    // 不带 Referer：应当被拒绝
    const noRef = await fetchRange(plan.url, { start: 0, end: 1023 });
    ok(noRef.status === 403 || noRef.status === 401, '不带 Referer 被拒绝（说明需要 DNR/代理）', `HTTP ${noRef.status}`);
  }

  console.log('\n========== B 站集成验证汇总 ==========');
  console.log(`通过：${passes.length}，失败：${failures.length}`);
  if (failures.length) console.log('失败：\n  - ' + failures.join('\n  - '));
  else console.log('结果：全部通过（exit 0）');
  return failures.length === 0 ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  process.exitCode = await runCheck();
}
