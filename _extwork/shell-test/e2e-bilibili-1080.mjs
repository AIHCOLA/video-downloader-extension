// 端到端：真实解析出 1080P 的 DASH 轨道 → 下载并合并 → ffmpeg 校验。
//
// 说明：B 站未登录时 DASH 只给到 480P，1080P 需要登录态。本脚本用网页播放器同款的
// try_look 参数拿到 1080P 轨道，仅用于**测试合并链路**；扩展产品里不发这个参数。
//
// 用法：node _extwork/shell-test/e2e-bilibili-1080.mjs [视频URL]
import path from 'node:path';
import fs from 'node:fs';
import https from 'node:https';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');
const EXT = path.join(ROOT, '浏览器扩展');
const FFMPEG = path.join(ROOT, '_tools', 'imageio_ffmpeg', 'binaries', 'ffmpeg-win-x86_64-v9.0.2.exe');
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36';

const target = process.argv[2] || 'https://www.bilibili.com/video/BV1GbWq6HEct';
const outDir = path.join(HERE, 'out');
fs.mkdirSync(outDir, { recursive: true });

function httpsGet(url) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = https.request(
      {
        hostname: u.hostname,
        port: u.port || 443,
        path: u.pathname + u.search,
        headers: { 'User-Agent': UA, Referer: 'https://www.bilibili.com' },
        timeout: 60000,
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks) }));
      }
    );
    req.on('timeout', () => req.destroy(new Error('超时')));
    req.on('error', reject);
    req.end();
  });
}

const jsonFetch = async (url) => {
  const res = await httpsGet(url);
  return { ok: res.status === 200, status: res.status, json: async () => JSON.parse(res.body.toString('utf8')) };
};

function fetchRange(url, { start, end }, { signal } = {}) {
  return new Promise((resolve, reject) => {
    if (signal && signal.aborted) {
      reject(Object.assign(new Error('已取消'), { name: 'AbortError' }));
      return;
    }
    const u = new URL(url);
    const req = https.request(
      {
        hostname: u.hostname,
        port: u.port || 443,
        path: u.pathname + u.search,
        headers: { Range: `bytes=${start}-${end}`, Referer: 'https://www.bilibili.com', 'User-Agent': UA },
        timeout: 60000,
      },
      (res) => {
        if (res.statusCode !== 200 && res.statusCode !== 206) {
          res.resume();
          reject(Object.assign(new Error(`HTTP ${res.statusCode}`), { status: res.statusCode }));
          return;
        }
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => resolve(new Uint8Array(Buffer.concat(chunks))));
      }
    );
    req.on('timeout', () => req.destroy(new Error('超时')));
    req.on('error', reject);
    req.end();
  });
}

const { resolveBilibili } = await import(pathToFileURL(path.join(EXT, 'src', 'sites', 'bilibili.mjs')).href);
const { muxDashTracks } = await import(pathToFileURL(path.join(EXT, 'src', 'core', 'dash.mjs')).href);

console.log(`目标：${target}`);

// 页面上下文 fetcher：把 playurl 改写成「普通接口 + try_look」再请求（仅测试用）
const fetchJsonInPage = async (url) => {
  if (!url.includes('/playurl')) {
    return (await jsonFetch(url)).json();
  }
  const u = new URL(url);
  const plain = new URL('https://api.bilibili.com/x/player/playurl');
  plain.searchParams.set('bvid', u.searchParams.get('bvid'));
  plain.searchParams.set('cid', u.searchParams.get('cid'));
  plain.searchParams.set('qn', u.searchParams.get('qn'));
  plain.searchParams.set('fnval', u.searchParams.get('fnval'));
  plain.searchParams.set('fourk', '1');
  plain.searchParams.set('try_look', '1');
  const res = await httpsGet(plain.href);
  return JSON.parse(res.body.toString('utf8'));
};

const plan = await resolveBilibili(target, {
  fetchImpl: jsonFetch,
  fetchJsonInPage,
  onLog: (l, m) => console.log(`  [${l}] ${m}`),
});

console.log(`\n清晰度：${plan.quality.label}（qn=${plan.selectedQn}），模式：${plan.mode}`);
console.log(`可选档位：${plan.qualities.map((q) => q.label).join(' / ')}`);

if (plan.mode !== 'dash') {
  console.log('未拿到 DASH 1080P 轨道（该视频可能没有 1080P），跳过合并测试');
  process.exit(0);
}
if (!plan.video || !plan.audio) {
  console.log('缺少 DASH 轨道地址，合并测试失败');
  process.exit(1);
}

const outPath = path.join(outDir, 'bilibili-1080p.mp4');
const fd = fs.openSync(outPath, 'w');
let fileSize = 0;
let lastPct = -1;
try {
  const result = await muxDashTracks({
    video: plan.video,
    audio: plan.audio,
    fetchRange,
    output: {
      write: async (data, position) => {
        const buf = Buffer.from(data);
        const pos = Number.isFinite(position) ? position : fileSize;
        fs.writeSync(fd, buf, 0, buf.length, pos);
        fileSize = Math.max(fileSize, pos + buf.length);
      },
    },
    totalBytes: plan.sizeBytes,
    onProgress: (p) => {
      const pct = Math.floor(p.percent / 25) * 25;
      if (pct !== lastPct) {
        lastPct = pct;
        console.log(`  ${String(Math.min(100, pct)).padStart(3)}%`);
      }
    },
    onLog: (l, m) => console.log(`  [${l}] ${m}`),
  });
  console.log(`\n合并结果：${JSON.stringify({ ...result, elapsedMs: undefined })}`);
} finally {
  fs.closeSync(fd);
}

const { spawnSync } = await import('node:child_process');
const probe = spawnSync(FFMPEG, ['-hide_banner', '-i', outPath], { encoding: 'utf8' });
const info = probe.stderr || '';
console.log('\n--- ffmpeg ---');
console.log(info.split('\n').filter((l) => /Duration|Stream #/.test(l)).join('\n'));
const decode = spawnSync(FFMPEG, ['-v', 'error', '-i', outPath, '-f', 'null', '-'], { encoding: 'utf8' });
console.log(`解码错误：${decode.stderr ? decode.stderr.slice(0, 500) : '（无）'}`);
console.log(`\n结论：${/Video: h264/.test(info) && /Audio: aac/.test(info) && !decode.stderr ? 'PASS 1080P 合并产物可正常解码' : 'CHECK'}`);
