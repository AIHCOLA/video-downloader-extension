/**
 * core 自测（真实流 + ffmpeg 校验）。
 * 运行：node _extwork/core-test/run.mjs
 * 可选：node _extwork/core-test/run.mjs --long   （额外跑 300 秒长区间稳定性）
 *
 * 覆盖（CONTRACT §3.3 / task-2）：
 *  1) probePlaylist：segments=1309、duration≈4988.7、encrypted=true 等字段断言
 *  2) 真实流 60–70s → MP4（普通渐进式，moov 末尾，>4MiB）+ ffmpeg 全量校验
 *  3) 同区间 TS 输出 + ffmpeg 校验
 *  4) 取消：下载中 abort → AbortError 且不再调用 output.write
 *  5) fragmented 降级路径（不支持 position 的保存端）：≥8MiB 产物 ffmpeg 可播放
 *  6) B 帧负 cto：单元测试确认不崩溃（clamp 处理）
 */

import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync, readFileSync, existsSync, openSync, closeSync } from 'node:fs';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { probePlaylist, downloadHls } from '../../浏览器扩展/src/core/index.mjs';
import { Mp4Sink } from '../../浏览器扩展/src/core/muxer-sink.mjs';
import { parseMediaPlaylist } from '../../浏览器扩展/src/core/m3u8.mjs';
import { sequenceIv } from '../../浏览器扩展/src/core/crypto-aes.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const WORKSPACE = resolve(HERE, '..', '..');
const OUT_DIR = resolve(HERE, 'out');
const FFMPEG = resolve(WORKSPACE, '_tools', 'imageio_ffmpeg', 'binaries', 'ffmpeg-win-x86_64-v9.0.2.exe');
const PLAYLIST = 'https://vv.jisuzyv.com/play/aQWNV05d/index.m3u8';
const LONG = process.argv.includes('--long');

mkdirSync(OUT_DIR, { recursive: true });

if (!existsSync(FFMPEG)) {
  console.error(`[FATAL] 找不到 ffmpeg：${FFMPEG}`);
  process.exit(2);
}

// ---------------------------------------------------------------- 测试框架
const results = [];
let currentSuite = '';
function suite(name) {
  currentSuite = name;
  console.log(`\n=== ${name} ===`);
}
async function test(name, fn) {
  const started = Date.now();
  try {
    const detail = await fn();
    const ms = Date.now() - started;
    results.push({ suite: currentSuite, name, ok: true, ms });
    console.log(`[PASS] ${name} (${ms}ms)${detail ? ` — ${detail}` : ''}`);
  } catch (err) {
    const ms = Date.now() - started;
    results.push({ suite: currentSuite, name, ok: false, ms, error: err });
    console.error(`[FAIL] ${name} (${ms}ms) — ${err && err.stack ? err.stack : err}`);
  }
}
function assert(condition, message) {
  if (!condition) throw new Error(`断言失败：${message}`);
}
function assertClose(value, expected, tolerance, label) {
  assert(Number.isFinite(value), `${label} 不是数字：${value}`);
  assert(Math.abs(value - expected) <= tolerance, `${label} 期望 ${expected}±${tolerance}，实际 ${value}`);
}

// ---------------------------------------------------------------- ffmpeg 工具
// 注意：DSH 沙箱禁止 Node 用管道捕获子进程输出（EPERM），这里用文件描述符重定向。
const FF_OUT_LOG = resolve(OUT_DIR, '_ffmpeg.stdout.log');
const FF_ERR_LOG = resolve(OUT_DIR, '_ffmpeg.stderr.log');

function runFfmpeg(args) {
  const outFd = openSync(FF_OUT_LOG, 'w');
  const errFd = openSync(FF_ERR_LOG, 'w');
  let proc;
  try {
    proc = spawnSync(FFMPEG, ['-hide_banner', '-nostdin', ...args], {
      stdio: ['ignore', outFd, errFd],
      windowsHide: true,
    });
  } finally {
    closeSync(outFd);
    closeSync(errFd);
  }
  const stdout = readFileSync(FF_OUT_LOG, 'utf8');
  const stderr = readFileSync(FF_ERR_LOG, 'utf8');
  return { status: proc.status, stdout, stderr, combined: `${stdout}\n${stderr}` };
}
const ffmpeg = runFfmpeg;

function parseDuration(text) {
  const match = /Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/.exec(text);
  if (!match) return null;
  return Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]);
}

function probeFile(file) {
  const { combined } = ffmpeg(['-i', file]);
  return {
    raw: combined,
    duration: parseDuration(combined),
    hasVideoH264: /Video:\s*h264/i.test(combined),
    hasAudioAac: /Audio:\s*aac/i.test(combined),
    has1080p: /1920x1080/.test(combined),
    has48k: /48000\s*Hz/.test(combined),
    hasStereo: /stereo/i.test(combined),
  };
}

function decodeErrorCheck(file) {
  const { status, combined } = ffmpeg(['-v', 'error', '-i', file, '-f', 'null', '-']);
  return { status, output: combined.trim() };
}

function countVideoFrames(file) {
  const { combined } = ffmpeg(['-i', file, '-map', '0:v:0', '-f', 'null', '-']);
  const matches = [...combined.matchAll(/frame=\s*(\d+)/g)];
  return matches.length > 0 ? Number(matches[matches.length - 1][1]) : null;
}

function sampleYAvg(file, seconds) {
  const { combined } = ffmpeg([
    '-ss', String(seconds),
    '-i', file,
    '-frames:v', '1',
    '-vf', 'signalstats,metadata=print:key=lavfi.signalstats.YAVG',
    '-f', 'null', '-',
  ]);
  const matches = [...combined.matchAll(/lavfi\.signalstats\.YAVG=([\d.]+)/g)];
  return matches.length > 0 ? Number(matches[matches.length - 1][1]) : null;
}

function extractJpeg(file, seconds, outFile) {
  if (existsSync(outFile)) {
    try { writeFileSync(outFile, new Uint8Array(0)); } catch { /* ignore */ }
  }
  const outFd = openSync(FF_OUT_LOG, 'w');
  const errFd = openSync(FF_ERR_LOG, 'w');
  let status;
  try {
    status = spawnSync(FFMPEG, [
      '-hide_banner', '-nostdin', '-v', 'error', '-y',
      '-ss', String(seconds), '-i', file, '-frames:v', '1', outFile,
    ], { stdio: ['ignore', outFd, errFd], windowsHide: true }).status;
  } finally {
    closeSync(outFd);
    closeSync(errFd);
  }
  return status === 0 && existsSync(outFile);
}

// ---------------------------------------------------------------- 保存端模拟
function createPositionalSink() {
  let buffer = new Uint8Array(0);
  let chunks = 0;
  const write = (chunk, position) => {
    chunks++;
    const start = position === null || position === undefined ? buffer.length : position;
    const end = start + chunk.length;
    if (end > buffer.length) {
      const next = new Uint8Array(end);
      next.set(buffer);
      buffer = next;
    }
    buffer.set(chunk, start);
  };
  return {
    write,
    supportsPosition: true,
    bytes: () => buffer,
    chunkCount: () => chunks,
  };
}

function createSequentialSink() {
  const parts = [];
  let chunks = 0;
  const write = (chunk) => {
    chunks++;
    parts.push(chunk.slice());
  };
  return {
    write,
    bytes: () => {
      let total = 0;
      for (const part of parts) total += part.length;
      const merged = new Uint8Array(total);
      let offset = 0;
      for (const part of parts) {
        merged.set(part, offset);
        offset += part.length;
      }
      return merged;
    },
    chunkCount: () => chunks,
  };
}

function saveFile(name, bytes) {
  const path = resolve(OUT_DIR, name);
  writeFileSync(path, bytes);
  return path;
}

function inspectMp4Layout(file) {
  const bytes = readFileSync(file);
  const text = bytes.toString('latin1');
  return {
    size: bytes.length,
    mdatIndex: text.indexOf('mdat'),
    moovIndex: text.indexOf('moov'),
  };
}

let probeInfo = null;

// ================================================================ 1. probe
suite('1. probePlaylist（真实流）');
await test('probe 字段与目标流事实一致', async () => {
  const info = await probePlaylist(PLAYLIST);
  probeInfo = info;
  assert(typeof info.url === 'string' && info.url === PLAYLIST, 'url 字段');
  assert(typeof info.finalUrl === 'string', 'finalUrl 字段');
  assert(info.isMaster === false, `isMaster 应为 false，实际 ${info.isMaster}`);
  assert(Array.isArray(info.variants) && info.variants.length === 0, '非 master 时 variants 应为空数组');
  assert(typeof info.selectedUrl === 'string' && info.selectedUrl.length > 0, 'selectedUrl 字段');
  assert(info.segments === 1309, `segments 应为 1309，实际 ${info.segments}`);
  assertClose(info.durationSeconds, 4988.7, 1.0, 'durationSeconds');
  assert(info.targetDuration === 10, `targetDuration 应为 10，实际 ${info.targetDuration}`);
  assert(info.encrypted === true, `encrypted 应为 true，实际 ${info.encrypted}`);
  assert(Array.isArray(info.encryptionMethods) && info.encryptionMethods.includes('AES-128'), 'encryptionMethods 应包含 AES-128');
  assert(info.isLive === false, `isLive 应为 false，实际 ${info.isLive}`);
  return `segments=${info.segments}, duration=${info.durationSeconds}, encrypted=${info.encrypted}, methods=${info.encryptionMethods.join(',')}`;
});

// ================================================================ 2. MP4（渐进式）
suite('2. MP4 输出（60–70s，普通渐进式，moov 末尾）');
let clipPath = null;
await test('downloadHls 返回字段正确', async () => {
  const sink = createPositionalSink();
  const started = Date.now();
  const result = await downloadHls({
    playlistUrl: PLAYLIST,
    start: 60,
    end: 70,
    concurrency: 16,
    output: { type: 'mp4', supportsPosition: true, write: sink.write },
  });
  clipPath = saveFile('clip.mp4', sink.bytes());
  const elapsed = Date.now() - started;

  assert(result.muxed === true, 'muxed 应为 true');
  assert(result.moovFront === false, '渐进式 MP4 的 moovFront 应为 false');
  assert(typeof result.durationSeconds === 'number', 'durationSeconds 字段');
  assertClose(result.durationSeconds, 10, 0.5, 'result.durationSeconds');
  assert(result.width === 1920, `width 应为 1920，实际 ${result.width}`);
  assert(result.height === 1080, `height 应为 1080，实际 ${result.height}`);
  assert(result.sampleRate === 48000, `sampleRate 应为 48000，实际 ${result.sampleRate}`);
  assert(result.channels === 2, `channels 应为 2，实际 ${result.channels}`);
  assert(result.segments === 4, `segments 应为 4（分片 15~18），实际 ${result.segments}`);
  assert(result.videoBytes > 1_000_000, `videoBytes 偏小：${result.videoBytes}`);
  assert(result.audioBytes > 0, `audioBytes 应大于 0：${result.audioBytes}`);
  assert(typeof result.elapsedMs === 'number' && result.elapsedMs > 0, 'elapsedMs 字段');
  assert(sink.chunkCount() > 0, '应至少有 1 次 output.write 调用');
  return `duration=${result.durationSeconds}s, ${result.width}x${result.height}, video=${result.videoBytes}B, audio=${result.audioBytes}B, elapsed=${elapsed}ms`;
});

await test('ffmpeg 元数据：Duration / h264 1920x1080 / aac 48kHz stereo', async () => {
  const info = probeFile(clipPath);
  assert(info.duration !== null, 'ffmpeg 未解析出 Duration');
  assertClose(info.duration, 10, 0.5, 'ffmpeg Duration');
  assert(info.hasVideoH264, '应为 h264 视频流');
  assert(info.has1080p, '分辨率应为 1920x1080');
  assert(info.hasAudioAac, '应为 aac 音频流');
  assert(info.has48k, '音频采样率应为 48000 Hz');
  assert(info.hasStereo, '音频应为 stereo');
  return `Duration=${info.duration}s, h264/1920x1080, aac/48kHz/stereo`;
});

await test('ffmpeg 全量解码无错误（-v error -f null -）', async () => {
  const { status, output } = decodeErrorCheck(clipPath);
  assert(status === 0, `ffmpeg 退出码应为 0，实际 ${status}`);
  assert(output === '', `ffmpeg 解码输出应为空，实际：\n${output}`);
  return '无解码错误';
});

await test('视频帧数 ≈ 240', async () => {
  const frames = countVideoFrames(clipPath);
  assert(Number.isFinite(frames), '无法获取视频帧数');
  assert(Math.abs(frames - 240) <= 12, `视频帧数期望 240±12，实际 ${frames}`);
  return `frames=${frames}`;
});

await test('抽帧非黑（-ss 5 的 YAVG 明显大于 16）', async () => {
  const yavg = sampleYAvg(clipPath, 5);
  assert(Number.isFinite(yavg), '无法读取 YAVG');
  assert(yavg > 30, `YAVG 应在 30 以上（非黑屏），实际 ${yavg}`);
  assert(extractJpeg(clipPath, 5, resolve(OUT_DIR, 'frame.jpg')), '抽帧 jpg 失败');
  return `YAVG=${yavg}, out/frame.jpg 已生成`;
});

await test('MP4 结构：moov 在文件末尾（渐进式）', async () => {
  const layout = inspectMp4Layout(clipPath);
  assert(layout.size > 4 * 1024 * 1024, `产物应大于 4MiB 以覆盖 mdat 回填场景，实际 ${layout.size} 字节`);
  assert(layout.mdatIndex >= 0 && layout.mdatIndex < 64, `mdat 应位于文件开头附近，实际 ${layout.mdatIndex}`);
  assert(layout.moovIndex > layout.size * 0.9, `moov 应在文件末尾（>90%），实际 ${layout.moovIndex}/${layout.size}`);
  return `size=${layout.size}, mdat@${layout.mdatIndex}, moov@${layout.moovIndex}`;
});

// ================================================================ 3. TS
suite('3. MP4 默认起点（0–30s，验证 start=null 时从首个关键帧起）');
let startZeroPath = null;
await test('start=null / end=30 → MP4（渐进式）并通过 ffmpeg', async () => {
  const sink = createPositionalSink();
  const result = await downloadHls({
    playlistUrl: PLAYLIST,
    end: 30,
    concurrency: 16,
    output: { type: 'mp4', supportsPosition: true, write: sink.write },
  });
  startZeroPath = saveFile('clip-start0.mp4', sink.bytes());
  assert(result.muxed === true, 'muxed 应为 true');
  assert(result.moovFront === false, 'moovFront 应为 false');
  assertClose(result.durationSeconds, 30, 0.5, 'result.durationSeconds');
  assert(result.width === 1920 && result.height === 1080, '分辨率应为 1920x1080');
  const info = probeFile(startZeroPath);
  assertClose(info.duration, 30, 0.5, 'ffmpeg Duration');
  assert(info.hasVideoH264 && info.hasAudioAac && info.has48k, '应为 h264 + aac 48kHz');
  const decode = decodeErrorCheck(startZeroPath);
  assert(decode.status === 0 && decode.output === '', `解码不应有错误：${decode.output}`);
  const frames = countVideoFrames(startZeroPath);
  assertClose(frames, 720, 24, '视频帧数');
  return `duration=${result.durationSeconds}s, frames=${frames}, size=${(readFileSync(startZeroPath).length / 1e6).toFixed(2)}MB`;
});

// ================================================================ 4. TS
suite('4. TS 输出（60–70s）');
let tsPath = null;
await test('downloadHls（type=ts）返回字段正确且 ffmpeg 可解析 h264+aac', async () => {
  const sink = createSequentialSink();
  const result = await downloadHls({
    playlistUrl: PLAYLIST,
    start: 60,
    end: 70,
    concurrency: 16,
    output: { type: 'ts', write: sink.write },
  });
  tsPath = saveFile('clip.ts', sink.bytes());
  const size = readFileSync(tsPath).length;
  assert(result.muxed === false, 'muxed 应为 false');
  assert(result.moovFront === false, 'TS 的 moovFront 应为 false');
  assert(result.segments === 4, `segments 应为 4，实际 ${result.segments}`);
  assert(result.videoBytes === 0 && result.audioBytes === 0, 'TS 模式 videoBytes/audioBytes 应为 0');
  assert(result.durationSeconds > 10 && result.durationSeconds < 14, `TS 模式时长应按分片累加（约 12s），实际 ${result.durationSeconds}`);
  assert(size > 0 && size % 188 === 0, `TS 产物大小应为 188 的倍数，实际 ${size}`);
  const info = probeFile(tsPath);
  assert(info.hasVideoH264, 'TS 应可解析出 h264');
  assert(info.hasAudioAac, 'TS 应可解析出 aac');
  assert(info.has1080p, 'TS 分辨率应为 1920x1080');
  const decode = decodeErrorCheck(tsPath);
  assert(decode.status === 0, `TS 解码退出码应为 0，实际 ${decode.status}`);
  assert(decode.output === '', `TS 解码不应有错误输出：\n${decode.output}`);
  return `size=${(size / 1e6).toFixed(2)}MB, h264+aac 可解析, 解码无错`;
});

// ================================================================ 5. 取消
suite('5. 取消（AbortSignal）');
await test('下载中 abort → AbortError 且不再写 output', async () => {
  const controller = new AbortController();
  let writes = 0;
  let writesAtAbort = -1;
  let aborted = false;
  const write = () => {
    if (!aborted) {
      aborted = true;
      writesAtAbort = writes;
      controller.abort();
    }
    writes++;
    // 模拟略慢的写盘
    return new Promise((resolve) => setTimeout(resolve, 5));
  };
  let caught = null;
  try {
    await downloadHls({
      playlistUrl: PLAYLIST,
      // 全片下载，保证写盘先于下载结束发生
      concurrency: 16,
      output: { type: 'mp4', supportsPosition: true, write },
      signal: controller.signal,
    });
    throw new Error('预期抛出 AbortError，但 downloadHls 正常返回了');
  } catch (err) {
    caught = err;
  }
  assert(caught !== null, '应捕获异常');
  assert(caught.name === 'AbortError', `异常名应为 AbortError，实际 ${caught && caught.name}`);
  assert(aborted, 'abort 未被触发（可能整片下载尚未产生第一次写盘）');
  const countAtCatch = writes;
  await new Promise((resolve) => setTimeout(resolve, 400));
  assert(writes === countAtCatch, `取消后仍有 ${writes - countAtCatch} 次 output.write 调用`);
  assert(writesAtAbort >= 0, '缺少 abort 时的写盘计数');
  return `AbortError=${caught.name}, 取消时已写 ${writesAtAbort} 块, 之后新增写 ${writes - countAtCatch} 次`;
});

// ================================================================ 6. fragmented 降级
suite('6. fragmented 降级路径（保存端不支持 position，≥8MiB）');
let fragPath = null;
await test('自动降级 fragmented 且 ffmpeg 可正常播放（40s，>8MiB）', async () => {
  const sink = createSequentialSink();
  const result = await downloadHls({
    playlistUrl: PLAYLIST,
    start: 60,
    end: 100,
    concurrency: 16,
    output: { type: 'mp4', write: sink.write }, // 无 supportsPosition 标记 → 自动降级
  });
  fragPath = saveFile('clip-fragmented.mp4', sink.bytes());
  const size = readFileSync(fragPath).length;
  assert(result.muxed === true, 'muxed 应为 true');
  assert(result.moovFront === true, '降级模式 moovFront 应为 true');
  assertClose(result.durationSeconds, 40, 1.0, 'result.durationSeconds');
  assert(size > 8 * 1024 * 1024, `降级产物应 ≥8MiB，实际 ${(size / 1e6).toFixed(2)}MB`);
  const info = probeFile(fragPath);
  assert(info.duration !== null, 'ffmpeg 未解析出 Duration');
  assertClose(info.duration, 40, 1.0, 'ffmpeg Duration');
  assert(info.hasVideoH264 && info.has1080p, '应为 h264 1920x1080');
  assert(info.hasAudioAac && info.has48k && info.hasStereo, '应为 aac 48000Hz stereo');
  const decode = decodeErrorCheck(fragPath);
  assert(decode.status === 0, `解码退出码应为 0，实际 ${decode.status}`);
  assert(decode.output === '', `解码不应有错误输出：\n${decode.output}`);
  const frames = countVideoFrames(fragPath);
  assert(Number.isFinite(frames), '无法获取帧数');
  assertClose(frames, 960, 24, '视频帧数');
  const layout = inspectMp4Layout(fragPath);
  assert(layout.moovIndex < 1024 * 1024, `fragmented 的 moov 应在文件开头，实际 ${layout.moovIndex}`);
  return `size=${(size / 1e6).toFixed(2)}MB, Duration=${info.duration}s, frames=${frames}, moov@${layout.moovIndex}`;
});

// ================================================================ 7. 负 cto 单元测试
suite('7. B 帧负 cto 处理（单元测试）');
await test('pts < dts 时不崩溃（clamp 到 0）', async () => {
  const avcC = new Uint8Array([1, 0x64, 0x00, 0x28, 0xff, 0xe1, 0x00, 0x04, 0x67, 0x64, 0x00, 0x28, 0x01, 0x00, 0x02, 0x68, 0xee]);
  const sink = createPositionalSink();
  const mp4sink = new Mp4Sink({
    width: 320,
    height: 180,
    avcC,
    asc: new Uint8Array([0x11, 0x90]),
    sampleRate: 48000,
    channels: 2,
    write: sink.write,
    writeSupportsPosition: true,
  });
  const fakeVideo = new Uint8Array([0, 0, 0, 2, 0x65, 0x88]);
  // 第 1 帧正常；第 2 帧 pts < dts（模拟异常 B 帧）；第 3 帧恢复
  mp4sink.addVideo({ data: fakeVideo, isKey: true, ptsUs: 1_000_000, dtsUs: 1_000_000, durationUs: 41666.67 });
  mp4sink.addVideo({ data: fakeVideo, isKey: false, ptsUs: 950_000, dtsUs: 1_041_666, durationUs: 41666.67 });
  mp4sink.addVideo({ data: fakeVideo, isKey: false, ptsUs: 1_083_333, dtsUs: 1_125_000, durationUs: 41666.67 });
  await mp4sink.finalize();
  const bytes = sink.bytes();
  assert(bytes.length > 0, '应写出 MP4 数据');
  return `fake MP4 ${bytes.length} 字节，负 cto 未抛异常`;
});

// ================================================================ 8. 离线 m3u8 解析（本地模拟）
suite('8. m3u8 解析（本地模拟：master 选最高带宽 / 密钥轮换 / 默认 IV）');
await test('probe master 播放列表 + 媒体播放列表解析', async () => {
  const routes = new Map();
  const mediaHigh = [
    '#EXTM3U',
    '#EXT-X-VERSION:3',
    '#EXT-X-TARGETDURATION:6',
    '#EXT-X-MEDIA-SEQUENCE:7',
    '#EXT-X-KEY:METHOD=AES-128,URI="key.bin",IV=0x000102030405060708090a0b0c0d0e0f',
    '#EXTINF:5.5,',
    'seg0.ts',
    '#EXTINF:5.5,',
    'seg1.ts',
    '#EXT-X-KEY:METHOD=AES-128,URI="/other/key2.bin"',
    '#EXTINF:5.5,',
    'seg2.ts',
    '#EXT-X-ENDLIST',
    '',
  ].join('\n');
  const mediaLow = ['#EXTM3U', '#EXT-X-TARGETDURATION:6', '#EXTINF:5.5,', 'a.ts', '#EXTINF:5.5,', 'b.ts', '#EXT-X-ENDLIST', ''].join('\n');
  const master = [
    '#EXTM3U',
    '#EXT-X-STREAM-INF:BANDWIDTH=800000,RESOLUTION=640x360',
    'low/index.m3u8',
    '#EXT-X-STREAM-INF:BANDWIDTH=2400000,RESOLUTION=1920x1080',
    'high/index.m3u8',
    '#EXT-X-STREAM-INF:BANDWIDTH=1400000,RESOLUTION=1280x720',
    'mid/index.m3u8',
    '',
  ].join('\n');
  routes.set('/bin/master.m3u8', master);
  routes.set('/bin/high/index.m3u8', mediaHigh);
  routes.set('/bin/low/index.m3u8', mediaLow);
  routes.set('/bin/mid/index.m3u8', mediaLow);
  const server = createServer((req, res) => {
    const body = routes.get(req.url);
    if (body === undefined) {
      res.writeHead(404);
      res.end('not found');
      return;
    }
    res.writeHead(200, { 'content-type': 'application/vnd.apple.mpegurl' });
    res.end(body);
  });
  await new Promise((resolveListen) => server.listen(0, '127.0.0.1', resolveListen));
  try {
    const base = `http://127.0.0.1:${server.address().port}`;
    const info = await probePlaylist(`${base}/bin/master.m3u8`);
    assert(info.isMaster === true, 'master 播放列表 isMaster 应为 true');
    assert(info.variants.length === 3, `variants 应为 3，实际 ${info.variants.length}`);
    assert(info.selectedUrl.endsWith('/bin/high/index.m3u8'), `应选择最高带宽（2.4Mbps），实际 ${info.selectedUrl}`);
    assert(info.segments === 3, `segments 应为 3，实际 ${info.segments}`);
    assertClose(info.durationSeconds, 16.5, 0.01, 'durationSeconds');
    assert(info.targetDuration === 6, `targetDuration 应为 6，实际 ${info.targetDuration}`);
    assert(info.encrypted === true, 'encrypted 应为 true');
    assert(info.isLive === false, 'isLive 应为 false');

    // 直接解析媒体列表：密钥轮换 / 显式 IV / 默认 IV / 相对地址 / 媒体序号
    const text = routes.get('/bin/high/index.m3u8');
    const parsed = parseMediaPlaylist(text, `${base}/bin/high/index.m3u8`);
    assert(parsed.segments.length === 3, '媒体列表应解析出 3 个分片');
    const seg0 = parsed.segments[0];
    const seg1 = parsed.segments[1];
    const seg2 = parsed.segments[2];
    assert(seg0.seq === 7 && seg1.seq === 8 && seg2.seq === 9, `媒体序号应为 7/8/9，实际 ${seg0.seq}/${seg1.seq}/${seg2.seq}`);
    assert(seg0.key && seg0.key.method === 'AES-128', 'seg0 应为 AES-128');
    assert(seg0.key.uri === `${base}/bin/high/key.bin`, `key URI 解析错误：${seg0.key && seg0.key.uri}`);
    assert(seg0.key.iv instanceof Uint8Array && seg0.key.iv.length === 16, 'seg0 IV 应为 16 字节');
    assert(seg0.key.iv[0] === 0x00 && seg0.key.iv[15] === 0x0f, `seg0 IV 解析错误：${Array.from(seg0.key.iv).map((b) => b.toString(16).padStart(2, '0')).join('')}`);
    assert(seg1.key === seg0.key, 'seg1 应沿用 seg0 的密钥');
    assert(seg2.key.uri === `${base}/other/key2.bin`, `seg2 密钥轮换 URI 解析错误：${seg2.key && seg2.key.uri}`);
    assert(seg2.key.iv === null, 'seg2 未显式给出 IV，应为 null（解密时用媒体序号）');
    assert(seg0.url === `${base}/bin/high/seg0.ts`, `相对分片地址解析错误：${seg0.url}`);
    const defaultIv = sequenceIv(9);
    assert(defaultIv[15] === 9 && defaultIv[0] === 0 && defaultIv.length === 16, '默认 IV（媒体序号大端）生成错误');
    return `master 3 变体→${info.selectedUrl.split('/').slice(-2).join('/')}, 密钥轮换/默认IV 解析正确`;
  } finally {
    await new Promise((resolveClose) => server.close(resolveClose));
  }
});

// ================================================================ 可选：长区间
if (LONG) {
  suite('9. 长区间稳定性（300 秒：300–600s）');
  await test('300 秒长区间 MP4（渐进式）+ ffmpeg 校验', async () => {
    const sink = createPositionalSink();
    const started = Date.now();
    const result = await downloadHls({
      playlistUrl: PLAYLIST,
      start: 300,
      end: 600,
      concurrency: 16,
      output: { type: 'mp4', supportsPosition: true, write: sink.write },
    });
    const longPath = saveFile('long-300s.mp4', sink.bytes());
    const elapsed = Date.now() - started;
    assertClose(result.durationSeconds, 300, 1.5, 'result.durationSeconds');
    const info = probeFile(longPath);
    assertClose(info.duration, 300, 1.5, 'ffmpeg Duration');
    assert(info.hasVideoH264 && info.has1080p, '应为 h264 1920x1080');
    assert(info.hasAudioAac && info.has48k && info.hasStereo, '应为 aac 48000Hz stereo');
    const decode = decodeErrorCheck(longPath);
    assert(decode.status === 0 && decode.output === '', `长区间解码错误：${decode.output}`);
    const frames = countVideoFrames(longPath);
    assertClose(frames, 7200, 72, '视频帧数');
    return `duration=${result.durationSeconds}s, frames=${frames}, 耗时 ${(elapsed / 1000).toFixed(1)}s, size=${(readFileSync(longPath).length / 1e6).toFixed(1)}MB`;
  });
}

// ---------------------------------------------------------------- 汇总
const passed = results.filter((item) => item.ok).length;
const failed = results.filter((item) => !item.ok);
console.log(`\n==================== 结果：${passed}/${results.length} 通过 ====================`);
if (failed.length > 0) {
  for (const item of failed) {
    console.error(`FAIL [${item.suite}] ${item.name}: ${item.error && item.error.message ? item.error.message : item.error}`);
  }
  process.exit(1);
}
console.log(`产物目录：${OUT_DIR}`);
for (const name of ['clip.mp4', 'clip-start0.mp4', 'clip.ts', 'clip-fragmented.mp4', 'frame.jpg']) {
  const path = resolve(OUT_DIR, name);
  if (existsSync(path)) {
    console.log(` - ${name}: ${readFileSync(path).length} 字节`);
  }
}
console.log('ALL TESTS PASSED');
