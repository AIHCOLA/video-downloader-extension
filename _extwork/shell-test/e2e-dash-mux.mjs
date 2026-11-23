// DASH 合并端到端验证：真实 1080P 视频轨 + 音频轨 → 合并成一个 MP4 → ffmpeg 校验。
//
// 用法：node _extwork/shell-test/e2e-dash-mux.mjs <tracks.json> [输出目录]
// tracks.json 形如 { video: "https://...m4s", audio: "https://...m4s" }
import path from 'node:path';
import fs from 'node:fs';
import https from 'node:https';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');
const EXT = path.join(ROOT, '浏览器扩展');
const FFMPEG = path.join(ROOT, '_tools', 'imageio_ffmpeg', 'binaries', 'ffmpeg-win-x86_64-v9.0.2.exe');

const tracksFile = process.argv[2];
if (!tracksFile) {
  console.error('用法: node e2e-dash-mux.mjs <tracks.json>');
  process.exit(1);
}
const tracks = JSON.parse(fs.readFileSync(tracksFile, 'utf8'));
const outDir = process.argv[3] || path.join(HERE, 'out');
fs.mkdirSync(outDir, { recursive: true });
const outPath = path.join(outDir, 'dash-1080p.mp4');

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36';

/** 带 Referer 的 Range 请求（模拟扩展里的直连/代理取字节） */
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
        path: `${u.pathname}${u.search}`,
        method: 'GET',
        timeout: 60000,
        headers: {
          Range: `bytes=${start}-${end}`,
          Referer: 'https://www.bilibili.com',
          'User-Agent': UA,
        },
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

const { muxDashTracks } = await import(pathToFileURL(path.join(EXT, 'src', 'core', 'dash.mjs')).href);

const fd = fs.openSync(outPath, 'w');
let fileSize = 0;
let lastPct = -1;
const started = Date.now();

try {
  const result = await muxDashTracks({
    video: { url: tracks.video },
    audio: { url: tracks.audio },
    fetchRange,
    output: {
      write: async (data, position) => {
        const buf = Buffer.from(data);
        const pos = Number.isFinite(position) ? position : fileSize;
        fs.writeSync(fd, buf, 0, buf.length, pos);
        fileSize = Math.max(fileSize, pos + buf.length);
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
  console.log(`\n合并完成：${JSON.stringify({ ...result, elapsedMs: undefined })}`);
  console.log(`耗时 ${((Date.now() - started) / 1000).toFixed(1)}s`);
} finally {
  fs.closeSync(fd);
}

const stat = fs.statSync(outPath);
console.log(`磁盘大小：${stat.size} 字节`);

const { spawnSync } = await import('node:child_process');
const probe = spawnSync(FFMPEG, ['-hide_banner', '-i', outPath], { encoding: 'utf8' });
const info = probe.stderr || '';
console.log('\n--- ffmpeg 探测 ---');
console.log(info.split('\n').filter((line) => /Duration|Stream #|Input #/.test(line)).join('\n'));
const decode = spawnSync(FFMPEG, ['-v', 'error', '-i', outPath, '-f', 'null', '-'], { encoding: 'utf8' });
console.log(`解码错误输出：${decode.stderr ? decode.stderr.slice(0, 800) : '（无）'}`);
const hasVideo = /Video: h264/.test(info);
const hasAudio = /Audio: aac/.test(info);
console.log(`\n结论：${hasVideo && hasAudio && !decode.stderr ? 'PASS 音视频合并成功且可解码' : 'CHECK 见上方输出'}`);
