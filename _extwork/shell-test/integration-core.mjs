// shell ↔ core 集成 / 回归检查（真实流，需要网络；不属于一键自检）：
//
// 以“扩展调用方”的身份直接 import `浏览器扩展/src/core/index.mjs`，验证：
//   1. probePlaylist 返回 CONTRACT §3.1 要求的全部字段与目标流信息；
//   2. 【回归】位置感知写入：output.supportsPosition=true + write(chunk, position)，
//      下载 60–70 秒（>4MiB，会触发 mp4-muxer 在 finalize 时回填文件头部 mdat size）
//      的 MP4，用 ffmpeg 校验 Duration/Video/Audio，且 `ffmpeg -v error -f null -` 无 stderr；
//   3. <4MiB 小片段对照（60–62 秒，同样走位置感知写入）；
//   4. TS 输出（60–70 秒）ffmpeg 可解析、解码无错误；
//   5. 取消（AbortController）以 AbortError 结束。
//
// 用法：node _extwork/shell-test/integration-core.mjs
// 退出码 0 = 全部通过。产物在 _extwork/shell-test/out/（供人工复核，不进入交付目录）。
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(HERE, '..', '..');
const CORE_ENTRY = path.join(ROOT, '浏览器扩展', 'src', 'core', 'index.mjs');
const FFMPEG = path.join(ROOT, '_tools', 'imageio_ffmpeg', 'binaries', 'ffmpeg-win-x86_64-v9.0.2.exe');
const OUT_DIR = path.join(HERE, 'out');
const MB = 1024 * 1024;
const TARGET = 'https://vv.jisuzyv.com/play/aQWNV05d/index.m3u8';

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

function range(value, min, max) {
  return Number.isFinite(value) && value >= min && value <= max;
}

// ---- 位置感知文件写入器（模拟扩展 FSA 的 write({type:'write', data, position})） ----

function createPositionalFileWriter(filePath) {
  fs.rmSync(filePath, { force: true });
  const fd = fs.openSync(filePath, 'w+');
  let sequentialOffset = 0;
  let positionedSeen = false;
  let size = 0;
  let writes = 0;
  let positionedWrites = 0;
  return {
    write(chunk, position) {
      const bytes = chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk);
      if (!bytes.byteLength) return;
      writes += 1;
      const hasPosition = Number.isFinite(position);
      let offset;
      if (hasPosition) {
        offset = position;
        positionedSeen = true;
        positionedWrites += 1;
      } else if (positionedSeen) {
        offset = size;
      } else {
        offset = sequentialOffset;
      }
      fs.writeSync(fd, bytes, 0, bytes.byteLength, offset);
      if (!hasPosition) sequentialOffset = offset + bytes.byteLength;
      if (offset + bytes.byteLength > size) size = offset + bytes.byteLength;
    },
    close() {
      if (size > 0) fs.ftruncateSync(fd, size);
      fs.closeSync(fd);
      return { size, writes, positionedWrites };
    },
  };
}

// ---- ffmpeg 调用（stdio 重定向到文件，避免沙箱/管道限制） ----

let ffmpegSeq = 0;
function runFfmpeg(tag, args) {
  ffmpegSeq += 1;
  const outFile = path.join(OUT_DIR, `ffmpeg-${ffmpegSeq}-${tag}.out.txt`);
  const errFile = path.join(OUT_DIR, `ffmpeg-${ffmpegSeq}-${tag}.err.txt`);
  const outFd = fs.openSync(outFile, 'w');
  const errFd = fs.openSync(errFile, 'w');
  let result;
  try {
    result = spawnSync(FFMPEG, args, { stdio: ['ignore', outFd, errFd], timeout: 240000, windowsHide: true });
  } finally {
    fs.closeSync(outFd);
    fs.closeSync(errFd);
  }
  return {
    status: result.status,
    signal: result.signal,
    error: result.error,
    stdout: fs.readFileSync(outFile, 'utf8'),
    stderr: fs.readFileSync(errFile, 'utf8'),
  };
}

function parseDurationSeconds(text) {
  const match = /Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/.exec(text);
  if (!match) return null;
  return Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]);
}

/** 校验 MP4：ftyp / ffmpeg 容器可解析 / Duration / h264 (High) / aac 48000 Hz stereo / 解码无错误 */
function verifyMp4(tag, file, { expectLarge, durationMin, durationMax }) {
  const stat = fs.statSync(file);
  ok(stat.size > 0, `${tag}：文件非空`, `${stat.size} bytes`);
  if (expectLarge) {
    ok(stat.size > 4 * MB, `${tag}：文件 > 4MiB（必然触发 mdat size 回填路径）`, `${(stat.size / MB).toFixed(2)} MiB`);
  } else {
    ok(stat.size > 0 && stat.size < 4 * MB, `${tag}：文件 < 4MiB（小片段对照）`, `${(stat.size / MB).toFixed(2)} MiB`);
  }
  const head = fs.readFileSync(file).subarray(0, 16).toString('latin1');
  ok(head.includes('ftyp'), `${tag}：以 MP4 ftyp box 开头`, JSON.stringify(head));

  const info = runFfmpeg('info', ['-hide_banner', '-i', file]);
  ok(info.stderr.includes('Duration:'), `${tag}：ffmpeg 可解析容器（有 Duration）`, `status=${info.status}`);
  const duration = parseDurationSeconds(info.stderr);
  ok(range(duration, durationMin, durationMax), `${tag}：Duration ${durationMin}–${durationMax}s`, `${duration}s`);
  ok(/Video:\s*h264\s*\(High\)/i.test(info.stderr), `${tag}：Video: h264 (High)`);
  ok(/Audio:\s*aac\b[^\n]*48000 Hz, stereo/i.test(info.stderr), `${tag}：Audio: aac 48000 Hz, stereo`);

  const decode = runFfmpeg('decode', ['-v', 'error', '-i', file, '-f', 'null', '-']);
  ok(
    decode.status === 0 && decode.stderr.trim() === '',
    `${tag}：ffmpeg -v error 解码无任何 stderr 输出`,
    `status=${decode.status} stderr=${JSON.stringify(decode.stderr.trim().slice(0, 300))}`
  );
  return { size: stat.size, duration };
}

/** 校验 TS：mpegts 容器 / h264 / aac / 解码无错误 */
function verifyTs(tag, file) {
  const stat = fs.statSync(file);
  ok(stat.size > 0, `${tag}：文件非空`, `${stat.size} bytes`);
  const info = runFfmpeg('info', ['-hide_banner', '-i', file]);
  ok(/Input #0,\s*mpegts/i.test(info.stderr), `${tag}：ffmpeg 识别为 mpegts 容器`);
  ok(/Video:\s*h264/i.test(info.stderr), `${tag}：含 h264 视频`);
  ok(/Audio:\s*aac\b[^\n]*48000 Hz, stereo/i.test(info.stderr), `${tag}：含 aac 48000 Hz stereo 音频`);
  const decode = runFfmpeg('decode', ['-v', 'error', '-i', file, '-f', 'null', '-']);
  ok(
    decode.status === 0 && decode.stderr.trim() === '',
    `${tag}：ffmpeg -v error 解码无任何 stderr 输出`,
    `status=${decode.status} stderr=${JSON.stringify(decode.stderr.trim().slice(0, 300))}`
  );
  return { size: stat.size };
}

// ---- 主流程 ----------------------------------------------------------------

export async function runCheck() {
  console.log('=== shell ↔ core 集成 / 位置感知写入回归检查（真实流） ===');
  console.log(`core：${CORE_ENTRY}`);
  console.log(`目标流：${TARGET}`);
  console.log(`ffmpeg：${FFMPEG}\n`);

  fs.rmSync(OUT_DIR, { recursive: true, force: true });
  fs.mkdirSync(OUT_DIR, { recursive: true });

  const core = await import(pathToFileURL(CORE_ENTRY).href);
  ok(typeof core.probePlaylist === 'function', 'core 导出 probePlaylist');
  ok(typeof core.downloadHls === 'function', 'core 导出 downloadHls');
  const hasFfmpeg = fs.existsSync(FFMPEG);
  ok(hasFfmpeg, 'ffmpeg 可执行文件存在', FFMPEG);

  const logs = [];
  const onLog = (level, message) => logs.push(`[${level}] ${message}`);

  // ---- 1. probePlaylist ----
  const probeController = new AbortController();
  const probeTimer = setTimeout(() => probeController.abort(), 90000);
  let info = null;
  try {
    info = await core.probePlaylist(TARGET, { signal: probeController.signal, onLog });
    ok(true, 'probePlaylist 调用成功');
  } catch (err) {
    ok(false, 'probePlaylist 调用成功', `${err && err.name}: ${err && err.message}`);
  } finally {
    clearTimeout(probeTimer);
  }
  if (info) {
    for (const key of [
      'url', 'finalUrl', 'isMaster', 'variants', 'selectedUrl', 'segments',
      'durationSeconds', 'targetDuration', 'encrypted', 'encryptionMethods', 'isLive',
    ]) {
      ok(Object.prototype.hasOwnProperty.call(info, key), `probePlaylist 返回字段 ${key}`);
    }
    ok(info.segments === 1309, 'segments = 1309', String(info.segments));
    ok(range(info.durationSeconds, 4980, 5000), 'durationSeconds ≈ 4988.7', String(info.durationSeconds));
    ok(info.encrypted === true && info.encryptionMethods.includes('AES-128'), '加密 AES-128', JSON.stringify(info.encryptionMethods));
    ok(info.isLive === false, 'isLive = false（VOD）');
    ok(Array.isArray(info.variants), 'variants 为数组');
    ok(typeof info.selectedUrl === 'string' && info.selectedUrl.length > 0, 'selectedUrl 非空');
  }

  // ---- 2. 【回归】60–70 秒 MP4（>4MiB，位置感知写入 + mdat size 回填）----
  const largeMp4Path = path.join(OUT_DIR, 'clip_60_70.mp4');
  const largeWriter = createPositionalFileWriter(largeMp4Path);
  const largePhases = new Set();
  const largeController = new AbortController();
  const largeTimer = setTimeout(() => largeController.abort(), 240000);
  let largeResult = null;
  try {
    largeResult = await core.downloadHls({
      playlistUrl: TARGET,
      concurrency: 16,
      start: 60,
      end: 70,
      signal: largeController.signal,
      output: { type: 'mp4', supportsPosition: true, write: (chunk, position) => largeWriter.write(chunk, position) },
      onProgress(progress) {
        if (progress && progress.phase) largePhases.add(progress.phase);
      },
      onLog,
    });
    ok(true, 'downloadHls(MP4 60–70s, supportsPosition) 调用成功');
  } catch (err) {
    ok(false, 'downloadHls(MP4 60–70s, supportsPosition) 调用成功', `${err && err.name}: ${err && err.message}`);
  } finally {
    clearTimeout(largeTimer);
  }
  const largeWriterInfo = largeWriter.close();
  if (largeResult) {
    ok(largeResult.muxed === true, '大片段：muxed = true');
    ok(largeResult.moovFront === false, '大片段：moovFront = false（普通渐进式 MP4，moov 在末尾）');
    ok(range(largeResult.durationSeconds, 9, 11.5), '大片段：result.durationSeconds ≈ 10s', String(largeResult.durationSeconds));
    ok(largeResult.width === 1920 && largeResult.height === 1080, '大片段：分辨率 1920x1080', `${largeResult.width}x${largeResult.height}`);
    ok(largeResult.sampleRate === 48000, '大片段：音频采样率 48000', String(largeResult.sampleRate));
  }
  ok(largeWriterInfo.positionedWrites > 0, '大片段：确实发生了按 position 的写入（位置感知路径生效）', `${largeWriterInfo.positionedWrites}/${largeWriterInfo.writes}`);
  ok(largeWriterInfo.size > 0, '大片段：写盘字节数 > 0', `${largeWriterInfo.size} bytes`);
  ok(largePhases.has('download'), '大片段：进度含 download 阶段', [...largePhases].join(','));
  ok(largePhases.has('done'), '大片段：进度含 done 阶段', [...largePhases].join(','));
  if (hasFfmpeg && largeWriterInfo.size > 0) {
    const verified = verifyMp4('大片段 60–70s', largeMp4Path, { expectLarge: true, durationMin: 9, durationMax: 11.5 });
    console.log(`      大片段文件：${(verified.size / MB).toFixed(2)} MiB，ffmpeg Duration=${verified.duration}s`);
  }

  // ---- 3. <4MiB 小片段对照（60–62 秒）----
  const smallMp4Path = path.join(OUT_DIR, 'clip_60_62.mp4');
  const smallWriter = createPositionalFileWriter(smallMp4Path);
  const smallController = new AbortController();
  const smallTimer = setTimeout(() => smallController.abort(), 240000);
  let smallResult = null;
  try {
    smallResult = await core.downloadHls({
      playlistUrl: TARGET,
      concurrency: 8,
      start: 60,
      end: 62,
      signal: smallController.signal,
      output: { type: 'mp4', supportsPosition: true, write: (chunk, position) => smallWriter.write(chunk, position) },
      onLog,
    });
    ok(true, 'downloadHls(MP4 60–62s, 小片段对照) 调用成功');
  } catch (err) {
    ok(false, 'downloadHls(MP4 60–62s, 小片段对照) 调用成功', `${err && err.name}: ${err && err.message}`);
  } finally {
    clearTimeout(smallTimer);
  }
  const smallWriterInfo = smallWriter.close();
  if (smallResult) {
    ok(smallResult.muxed === true, '小片段：muxed = true');
    ok(smallResult.moovFront === false, '小片段：moovFront = false');
  }
  if (hasFfmpeg && smallWriterInfo.size > 0) {
    const verified = verifyMp4('小片段 60–62s', smallMp4Path, { expectLarge: false, durationMin: 1, durationMax: 3.5 });
    console.log(`      小片段文件：${(verified.size / MB).toFixed(2)} MiB，ffmpeg Duration=${verified.duration}s`);
  }

  // ---- 4. TS 输出（60–70 秒，顺便回归）----
  const tsPath = path.join(OUT_DIR, 'clip_60_70.ts');
  const tsWriter = createPositionalFileWriter(tsPath);
  const tsController = new AbortController();
  const tsTimer = setTimeout(() => tsController.abort(), 240000);
  let tsResult = null;
  try {
    tsResult = await core.downloadHls({
      playlistUrl: TARGET,
      concurrency: 8,
      start: 60,
      end: 70,
      signal: tsController.signal,
      output: { type: 'ts', supportsPosition: true, write: (chunk, position) => tsWriter.write(chunk, position) },
      onLog,
    });
    ok(true, 'downloadHls(TS 60–70s) 调用成功');
  } catch (err) {
    ok(false, 'downloadHls(TS 60–70s) 调用成功', `${err && err.name}: ${err && err.message}`);
  } finally {
    clearTimeout(tsTimer);
  }
  const tsWriterInfo = tsWriter.close();
  if (tsResult) {
    ok(tsResult.muxed === false, 'TS：muxed = false');
    ok(range(tsResult.durationSeconds, 9, 13), 'TS：durationSeconds ≈ 10–11s', String(tsResult.durationSeconds));
  }
  ok(tsWriterInfo.positionedWrites === 0, 'TS：全部为顺序追加（无 position 写入）', `${tsWriterInfo.positionedWrites}/${tsWriterInfo.writes}`);
  if (hasFfmpeg && tsWriterInfo.size > 0) {
    const verified = verifyTs('TS 60–70s', tsPath);
    console.log(`      TS 文件：${(verified.size / MB).toFixed(2)} MiB`);
  }

  // ---- 5. 取消（AbortError）----
  const cancelController = new AbortController();
  let cancelWrites = 0;
  let wroteAfterAbort = false;
  let abortedAt = 0;
  const cancelTimer = setTimeout(() => cancelController.abort(), 120000);
  try {
    await core.downloadHls({
      playlistUrl: TARGET,
      concurrency: 8,
      signal: cancelController.signal,
      output: {
        type: 'mp4',
        supportsPosition: true,
        write(chunk, position) {
          if (cancelController.signal.aborted) wroteAfterAbort = true;
          cancelWrites += 1;
        },
      },
      onProgress(progress) {
        if (!abortedAt && progress && progress.phase === 'download' && progress.segmentsDone >= 3) {
          abortedAt = Date.now();
          cancelController.abort();
        }
      },
      onLog() {},
    });
    ok(false, '取消时 downloadHls 抛出 AbortError', '未抛出异常');
  } catch (err) {
    ok(err && err.name === 'AbortError', '取消时 downloadHls 抛出 AbortError', String(err && err.name));
  } finally {
    clearTimeout(cancelTimer);
  }
  if (abortedAt) {
    ok(Date.now() - abortedAt < 30000, '取消后 30 秒内结束');
    console.log(`      取消测试：abort 后写入次数=${cancelWrites}，取消后仍写入=${wroteAfterAbort}`);
  }

  console.log('\n========== 集成检查汇总 ==========');
  console.log(`通过：${passes.length}，失败：${failures.length}`);
  if (logs.length) {
    console.log(`core 日志（前 10 条）：\n  ${logs.slice(0, 10).join('\n  ')}`);
  }
  if (failures.length) console.log('失败：\n  - ' + failures.join('\n  - '));
  else console.log('结果：shell ↔ core 集成 / 位置感知写入回归检查全部通过（exit 0）');
  return failures.length === 0 ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  process.exitCode = await runCheck();
}
