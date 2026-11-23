// 真实网络集成验证（优酷）：直连 ups 接口，能通就验证整条链路，被风控就如实标记 SKIP。
//
// 为什么会有 SKIP：
//   优酷对匿名 / 陌生网络的风控很严（实测本机 IP 恒定返回 -6004「该账号检测到有可疑违规…已限制播放」，
//   换 utid、换 ccode、换视频都一样）。扩展里真正跑的是「在用户自己的 youku.com 页面里请求」，
//   Cookie 与网络出口都和真实播放一致。所以这里只能验证到「参数与错误翻译是否正确」，
//   能拿到 stream 时再进一步验证 m3u8 可取。
//
// 用法：node _extwork/shell-test/integration-youku.mjs [视频URL]
// 退出码 0 = 通过（含 SKIP）；1 = 真失败。
import path from 'node:path';
import http from 'node:http';
import https from 'node:https';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(HERE, '..', '..');
const EXT = path.join(ROOT, '浏览器扩展');

const TARGET = process.argv[2] || 'https://v.youku.com/v_show/id_XNjQ0Mzc5ODQ4NA==.html';

const passes = [];
const failures = [];
const skips = [];

function ok(condition, label, detail) {
  if (condition) {
    passes.push(label);
    console.log(`PASS  ${label}${detail ? `  (${detail})` : ''}`);
  } else {
    failures.push(`${label}${detail ? `：${detail}` : ''}`);
    console.log(`FAIL  ${label}${detail ? `：${detail}` : ''}`);
  }
}

function skip(label, detail) {
  skips.push(label);
  console.log(`SKIP  ${label}${detail ? `  (${detail})` : ''}`);
}

/** 取一段字节（跟随 302），用于验证 m3u8 是否可取 */
function fetchText(url, { referer, max = 5 } = {}) {
  return new Promise((resolve, reject) => {
    let current = url;
    let hops = 0;
    const go = () => {
      let target;
      try {
        target = new URL(current);
      } catch (err) {
        reject(err);
        return;
      }
      const isHttps = target.protocol === 'https:';
      const mod = isHttps ? https : http;
      const headers = {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/137.0.0.0 Safari/537.36',
      };
      if (referer) headers.Referer = referer;
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
          if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && hops < max) {
            hops += 1;
            current = new URL(res.headers.location, current).href;
            res.resume();
            go();
            return;
          }
          const chunks = [];
          res.on('data', (c) => chunks.push(c));
          res.on('end', () =>
            resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8'), finalUrl: current })
          );
        }
      );
      req.on('timeout', () => req.destroy(new Error('请求超时')));
      req.on('error', reject);
      req.end();
    };
    go();
  });
}

async function run() {
  const youku = await import(pathToFileURL(path.join(EXT, 'src', 'sites', 'youku.mjs')).href);
  console.log(`目标：${TARGET}\n`);

  // ---- 1) URL 解析 ----
  const parsed = youku.parseYoukuUrl(TARGET);
  ok(Boolean(parsed && parsed.vid), 'URL 解析得到 vid', parsed && parsed.vid);

  // ---- 2) cna（mmstat ETag）----
  const cna = await new Promise((resolve) => {
    https
      .get(
        'https://log.mmstat.com/eg.js',
        { headers: { Referer: 'https://www.youku.com/', 'User-Agent': 'Mozilla/5.0 Chrome/137.0.0.0' } },
        (res) => {
          resolve(String(res.headers.etag || '').replace(/^"+|"+$/g, ''));
          res.resume();
        }
      )
      .on('error', () => resolve(''));
  });
  ok(Boolean(cna), 'mmstat 能取到 cna（ups 的 utid）', cna);

  // ---- 3) 直连 ups ----
  let plan = null;
  let errorMessage = '';
  try {
    plan = await youku.resolveYouku(TARGET, {});
  } catch (err) {
    errorMessage = err.message;
  }

  if (plan) {
    ok(plan.mode === 'hls', '计划走 HLS 链路');
    ok(Boolean(plan.playlistUrl), '计划带 m3u8 地址', plan.playlistUrl.slice(0, 90));
    ok(plan.qualities.length >= 1, '计划列出档位', plan.acceptLabels.join(' / '));
    console.log(`      标题：${plan.title}\n      时长：${plan.durationSeconds}s\n      大小：${plan.sizeBytes} 字节`);

    const playlist = await fetchText(plan.playlistUrl, { referer: youku.YOUKU_REFERER });
    ok([200, 206].includes(playlist.status), 'm3u8 可取', `HTTP ${playlist.status}`);
    ok(playlist.body.includes('#EXTM3U'), '取到的是合法 m3u8', playlist.body.slice(0, 40).replace(/\n/g, ' '));
    const isEncrypted = playlist.body.includes('#EXT-X-KEY');
    console.log(`      加密：${isEncrypted ? '有 EXT-X-KEY（AES-128 由核心处理）' : '未加密'}`);
    const segments = (playlist.body.match(/\.(ts|m4s|mp4)/g) || []).length;
    ok(segments > 0, '播放列表里有分片', `${segments} 条`);
  } else {
    // 本机 IP 被优酷风控时，这里只能验证「错误是否被人话化」
    ok(
      /风控|登录|会员|地区|不存在|接口/.test(errorMessage),
      '取不到播放信息时给出可读的错误提示',
      errorMessage.slice(0, 80)
    );
    skip('完整下载链路（需要你的网络 / 登录态）', '本机触发优酷风控，扩展里走页面上下文取数');
  }

  console.log('\n========== 优酷集成验证汇总 ==========');
  console.log(`通过：${passes.length}，跳过：${skips.length}，失败：${failures.length}`);
  if (failures.length) console.log('失败：\n  - ' + failures.join('\n  - '));
  else console.log('结果：通过（exit 0，跳过项见上）');
  process.exitCode = failures.length === 0 ? 0 : 1;
}

await run();
