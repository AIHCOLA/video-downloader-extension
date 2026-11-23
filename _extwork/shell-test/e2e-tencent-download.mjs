// 端到端验证（腾讯视频）：真实解析 → 真实下载整片 → 校验字节数与 MP4 结构。
//
// 和扩展里的路径保持一致：用 src/core/direct.mjs 的 downloadDirect 流式写盘，
// 只是把「写盘」换成写本地文件，验证扩展拿到的计划确实能下出一个完整 MP4。
//
// 用法：node _extwork/shell-test/e2e-tencent-download.mjs [视频URL] [输出文件]
// 退出码 0 = 通过。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(HERE, '..', '..');
const EXT = path.join(ROOT, '浏览器扩展');

const TARGET = process.argv[2] || 'https://v.qq.com/x/page/y41026no22e.html';
const OUTPUT = process.argv[3] || path.join(HERE, 'out', 'tencent-e2e.mp4');
const FFMPEG = path.join(ROOT, '_tools', 'imageio_ffmpeg', 'binaries', 'ffmpeg-win-x86_64-v9.0.2.exe');

const passes = [];
const failures = [];

function ok(condition, label, detail) {
  if (condition) passes.push(label);
  else failures.push(`${label}${detail ? `：${detail}` : ''}`);
  console.log(`${condition ? 'PASS' : 'FAIL'}  ${label}${detail ? `  (${detail})` : ''}`);
}

async function probeWithFfmpeg(file) {
  const { spawnSync } = await import('node:child_process');
  if (!fs.existsSync(FFMPEG)) return { skipped: true };
  const res = spawnSync(FFMPEG, ['-v', 'error', '-i', file, '-f', 'null', '-'], { encoding: 'utf8', timeout: 120000 });
  return { skipped: false, code: res.status, stderr: (res.stderr || '').trim() };
}

async function run() {
  const tencent = await import(pathToFileURL(path.join(EXT, 'src', 'sites', 'tencent.mjs')).href);
  const direct = await import(pathToFileURL(path.join(EXT, 'src', 'core', 'direct.mjs')).href);

  console.log(`目标：${TARGET}\n输出：${OUTPUT}\n`);
  fs.mkdirSync(path.dirname(OUTPUT), { recursive: true });

  // ---- 1) 解析 ----
  const plan = await tencent.resolveTencent(TARGET, { minGapMs: 800 });
  ok(Boolean(plan.url), '解析得到播放地址', plan.url.slice(0, 80));

  // ---- 2) 整片下载（复用扩展的 downloadDirect）----
  const fd = fs.openSync(OUTPUT, 'w');
  let position = 0;
  let progressEvents = 0;
  try {
    const result = await direct.downloadDirect({
      url: plan.url,
      backupUrls: plan.backupUrls,
      sizeBytes: plan.sizeBytes,
      durationSeconds: plan.durationSeconds,
      width: plan.quality.width,
      height: plan.quality.height,
      output: {
        async write(chunk) {
          fs.writeSync(fd, chunk, 0, chunk.byteLength, position);
          position += chunk.byteLength;
        },
      },
      onProgress: () => {
        progressEvents += 1;
      },
      onLog: (level, message) => {
        if (level !== 'info') console.log(`      [${level}] ${message}`);
      },
    });
    ok(result.bytes === plan.sizeBytes, '下载字节数与计划一致', `${result.bytes} vs ${plan.sizeBytes}`);
    ok(progressEvents > 0, '下载过程有进度回调', `${progressEvents} 次`);
  } finally {
    fs.closeSync(fd);
  }

  const stat = fs.statSync(OUTPUT);
  ok(stat.size === plan.sizeBytes, '落盘文件大小正确', `${stat.size} 字节`);

  const head = Buffer.alloc(12);
  const rfd = fs.openSync(OUTPUT, 'r');
  fs.readSync(rfd, head, 0, 12, 0);
  fs.closeSync(rfd);
  ok(head.toString('latin1', 4, 8) === 'ftyp', '文件以 ftyp 开头（标准 MP4）', head.toString('latin1', 4, 12));

  // ---- 3) ffmpeg 解码校验 ----
  const probe = await probeWithFfmpeg(OUTPUT);
  if (probe.skipped) {
    console.log('SKIP  ffmpeg 不存在，跳过解码校验');
  } else {
    ok(probe.code === 0 && !probe.stderr, 'ffmpeg 完整解码无错误', probe.stderr ? probe.stderr.slice(0, 200) : '0 error');
  }

  console.log('\n========== 腾讯视频 E2E 汇总 ==========');
  console.log(`通过：${passes.length}，失败：${failures.length}`);
  if (failures.length) console.log('失败：\n  - ' + failures.join('\n  - '));
  else console.log('结果：全部通过（exit 0）');
  process.exitCode = failures.length === 0 ? 0 : 1;
}

await run();
