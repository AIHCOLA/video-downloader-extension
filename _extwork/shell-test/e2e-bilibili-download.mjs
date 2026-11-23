// 端到端下载验证：用扩展里真实的 downloadDirect + 真实 CDN（带 Referer），
// 把整部视频下到本地，再用 ffmpeg 校验可播性。
//
// 用法：node _extwork/shell-test/e2e-bilibili-download.mjs [BV号或URL] [输出目录]
import path from 'node:path';
import fs from 'node:fs';
import https from 'node:https';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');
const EXT = path.join(ROOT, '浏览器扩展');
const FFMPEG = path.join(ROOT, '_tools', 'imageio_ffmpeg', 'binaries', 'ffmpeg-win-x86_64-v9.0.2.exe');

const target = process.argv[2] || 'https://www.bilibili.com/video/BV1GbWq6HEct';
const outDir = process.argv[3] || path.join(HERE, 'out');
fs.mkdirSync(outDir, { recursive: true });

/** 带 Referer 的 Range 请求（模拟扩展里「经 B 站标签页代理」的取字节行为） */
function fetchChunkWithReferer(url, { start, end }, { signal } = {}) {
  return new Promise((resolve, reject) => {
    if (signal && signal.aborted) {
      const err = new Error('已取消');
      err.name = 'AbortError';
      reject(err);
      return;
    }
    const u = new URL(url);
    const req = https.request(
      {
        hostname: u.hostname,
        port: u.port || 443,
        path: `${u.pathname}${u.search}`,
        method: 'GET',
        timeout: 60000,
        headers: {
          Range: `bytes=${start}-${end}`,
          Referer: 'https://www.bilibili.com',
          'User-Agent':
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36',
        },
      },
      (res) => {
        if (res.statusCode !== 206 && res.statusCode !== 200) {
          res.resume();
          reject(new Error(`HTTP ${res.statusCode}`));
          return;
        }
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => resolve(new Uint8Array(Buffer.concat(chunks))));
      }
    );
    req.on('timeout', () => req.destroy(new Error('超时')));
    req.on('error', reject);
    if (signal) {
      signal.addEventListener('abort', () => req.destroy(Object.assign(new Error('已取消'), { name: 'AbortError' })), {
        once: true,
      });
    }
    req.end();
  });
}

const { resolveBilibili, buildBilibiliFilename } = await import(
  pathToFileURL(path.join(EXT, 'src', 'sites', 'bilibili.mjs')).href
);
const { downloadDirect } = await import(pathToFileURL(path.join(EXT, 'src', 'core', 'direct.mjs')).href);

const plan = await resolveBilibili(target, { onLog: (l, m) => console.log(`[${l}] ${m}`) });
const filename = buildBilibiliFilename({
  title: plan.title,
  bvid: plan.bvid,
  pageIndex: plan.page.index,
  qualityLabel: plan.quality.label,
});
const outPath = path.join(outDir, filename);
console.log(`\n目标：${plan.title}  ${plan.quality.label}  ${(plan.sizeBytes / 1048576).toFixed(1)} MB`);
console.log(`输出：${outPath}`);

const fd = fs.openSync(outPath, 'w');
let lastPct = -1;
const started = Date.now();
try {
  const result = await downloadDirect({
    url: plan.url,
    backupUrls: plan.backupUrls,
    sizeBytes: plan.sizeBytes,
    durationSeconds: plan.durationSeconds,
    width: plan.quality.width,
    height: plan.quality.height,
    mode: 'range',
    fetchChunk: fetchChunkWithReferer,
    retries: 3,
    output: {
      write: async (chunk) => {
        fs.writeSync(fd, Buffer.from(chunk));
      },
    },
    onProgress: (p) => {
      const pct = Math.floor(p.percent / 10) * 10;
      if (pct !== lastPct) {
        lastPct = pct;
        console.log(`  ${String(pct).padStart(3)}%  ${(p.bytesDownloaded / 1048576).toFixed(1)} MB  ${(p.speedBps / 1048576).toFixed(2)} MB/s`);
      }
    },
    onLog: (l, m) => console.log(`  [${l}] ${m}`),
  });
  console.log(`\n完成：${result.bytes} 字节，耗时 ${((Date.now() - started) / 1000).toFixed(1)}s`);
} finally {
  fs.closeSync(fd);
}

const stat = fs.statSync(outPath);
console.log(`磁盘大小：${stat.size} 字节（计划 ${plan.sizeBytes}）`);

// ffmpeg 校验
const { spawnSync } = await import('node:child_process');
const probe = spawnSync(FFMPEG, ['-hide_banner', '-i', outPath], { encoding: 'utf8' });
const info = probe.stderr || '';
console.log('\n--- ffmpeg 探测 ---');
console.log(
  info
    .split('\n')
    .filter((line) => /Duration|Stream #|Input #/.test(line))
    .join('\n')
);
const decode = spawnSync(FFMPEG, ['-v', 'error', '-i', outPath, '-f', 'null', '-'], { encoding: 'utf8' });
console.log(`解码错误输出：${decode.stderr ? decode.stderr.slice(0, 500) : '（无）'}`);
console.log(`结论：${stat.size === plan.sizeBytes && !decode.stderr ? 'PASS 字节完整且可解码' : 'CHECK 见上方输出'}`);
