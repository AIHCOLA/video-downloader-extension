// 纯逻辑单测：直接 import 交付目录里的 `浏览器扩展/downloader/util.mjs`，
// 验证 URL 参数解析、文件名规则、格式化、设置取值范围等可单测逻辑。
//
// 用法：node _extwork/shell-test/unit-util.mjs
// 退出码 0 = 全部通过。
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(HERE, '..', '..');
const EXT = path.join(ROOT, '浏览器扩展');

const passes = [];
const failures = [];

function eq(actual, expected, label) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) {
    passes.push(label);
    console.log(`PASS  ${label}`);
  } else {
    failures.push(`${label}：期望 ${e}，实际 ${a}`);
    console.log(`FAIL  ${label}：期望 ${e}，实际 ${a}`);
  }
}

function ok(condition, label, detail) {
  if (condition) {
    passes.push(label);
    console.log(`PASS  ${label}`);
  } else {
    failures.push(`${label}${detail ? `：${detail}` : ''}`);
    console.log(`FAIL  ${label}${detail ? `：${detail}` : ''}`);
  }
}

export async function runCheck() {
  console.log('=== util.mjs 纯逻辑单测 ===');
  const util = await import(pathToFileURL(path.join(EXT, 'downloader', 'util.mjs')).href);
  const {
    clampInt,
    parseSeconds,
    formatBytes,
    formatDuration,
    formatSpeed,
    formatEta,
    formatBandwidth,
    describeError,
    buildFilename,
    parseDownloaderParams,
    buildDownloaderQuery,
    assemblePositionedChunks,
    phaseLabel,
    PHASE_LABELS,
  } = util;

  // clampInt
  eq(clampInt('16', 16, 1, 64), 16, 'clampInt 正常值');
  eq(clampInt('999', 16, 1, 64), 64, 'clampInt 上限截断 64');
  eq(clampInt('0', 16, 1, 64), 1, 'clampInt 下限截断 1');
  eq(clampInt('abc', 16, 1, 64), 16, 'clampInt 非法值回退');
  eq(clampInt(undefined, 16, 1, 64), 16, 'clampInt undefined 回退');
  eq(clampInt(15.9, 16, 1, 64), 15, 'clampInt 取整');

  // parseSeconds
  eq(parseSeconds(''), null, 'parseSeconds 空字符串 → null');
  eq(parseSeconds('0'), 0, 'parseSeconds 0');
  eq(parseSeconds('60'), 60, 'parseSeconds 60');
  eq(parseSeconds('1.5'), 1.5, 'parseSeconds 小数');
  eq(parseSeconds('abc'), null, 'parseSeconds 非法 → null');
  eq(parseSeconds('-5'), null, 'parseSeconds 负数 → null');
  eq(parseSeconds(null), null, 'parseSeconds null');

  // formatBytes
  eq(formatBytes(0), '0 B', 'formatBytes 0');
  eq(formatBytes(-1), '0 B', 'formatBytes 负数');
  eq(formatBytes(512), '512 B', 'formatBytes 512');
  eq(formatBytes(1024), '1.00 KB', 'formatBytes 1 KB');
  eq(formatBytes(1536), '1.50 KB', 'formatBytes 1.5 KB');
  eq(formatBytes(1048576), '1.00 MB', 'formatBytes 1 MB');
  eq(formatBytes(1431632355), '1.33 GB', 'formatBytes 参考产物大小 1.33 GB');
  eq(formatBytes(null), '0 B', 'formatBytes null');

  // formatDuration
  eq(formatDuration(0), '0:00', 'formatDuration 0');
  eq(formatDuration(70), '1:10', 'formatDuration 70s');
  eq(formatDuration(4988.7), '1:23:09', 'formatDuration 目标流 4988.7s');
  eq(formatDuration(null), '—', 'formatDuration null');
  eq(formatDuration(-3), '—', 'formatDuration 负数');

  // formatSpeed / formatEta / formatBandwidth
  eq(formatSpeed(1048576), '1.00 MB/s', 'formatSpeed 1 MB/s');
  eq(formatSpeed(0), '—', 'formatSpeed 0');
  eq(formatEta(30), '30 秒', 'formatEta 30s');
  eq(formatEta(90), '1 分 30 秒', 'formatEta 90s');
  eq(formatEta(3700), '1:01:40', 'formatEta 3700s');
  eq(formatEta(-1), '—', 'formatEta 负数');
  eq(formatBandwidth(5000000), '5.00 Mbps', 'formatBandwidth 5 Mbps');
  eq(formatBandwidth(128000), '128 kbps', 'formatBandwidth 128 kbps');
  eq(formatBandwidth(0), '—', 'formatBandwidth 0');

  // describeError
  eq(describeError(new Error('网络错误')), '网络错误', 'describeError Error');
  eq(describeError('字符串错误'), '字符串错误', 'describeError 字符串');
  eq(describeError(null), '未知错误', 'describeError null');

  // buildFilename：E2E 依赖的固定规则
  eq(
    buildFilename('https://vv.jisuzyv.com/play/aQWNV05d/index.m3u8', 'mp4'),
    'video_aQWNV05d.mp4',
    'buildFilename 目标流 → video_aQWNV05d.mp4'
  );
  eq(
    buildFilename('https://vv.jisuzyv.com/play/aQWNV05d/index.m3u8', 'ts'),
    'video_aQWNV05d.ts',
    'buildFilename TS 扩展名'
  );
  eq(
    buildFilename('https://cdn.example.com/index.m3u8', 'mp4'),
    'video_cdn_example_com.mp4',
    'buildFilename 无上级目录时使用域名'
  );
  eq(buildFilename('not-a-url', 'mp4'), 'video_video.mp4', 'buildFilename 非法 URL 兜底');
  eq(
    buildFilename('https://cdn.example.com/a b/index.m3u8', 'mp4'),
    'video_a_b.mp4',
    'buildFilename 非法字符替换为下划线'
  );

  // parseDownloaderParams：E2E 打开下载页的参数
  const targetUrl = 'https://vv.jisuzyv.com/play/aQWNV05d/index.m3u8';
  const query = 'url=' + encodeURIComponent(targetUrl) + '&format=ts&concurrency=999&start=60&end=70&autosave=1&title=' + encodeURIComponent('第 1 集');
  eq(
    parseDownloaderParams(query),
    { url: targetUrl, title: '第 1 集', format: 'ts', concurrency: 64, start: 60, end: 70, autosave: true },
    'parseDownloaderParams 完整参数'
  );
  eq(
    parseDownloaderParams(''),
    { url: '', title: '', format: 'mp4', concurrency: 16, start: null, end: null, autosave: false },
    'parseDownloaderParams 空参数默认值'
  );
  eq(parseDownloaderParams('?format=mp4&concurrency=8').concurrency, 8, 'parseDownloaderParams 并发 8');
  eq(parseDownloaderParams('?format=avi&concurrency=0').format, 'mp4', 'parseDownloaderParams 非法格式回退 mp4');
  eq(parseDownloaderParams('?autosave=0').autosave, false, 'parseDownloaderParams autosave=0');
  eq(parseDownloaderParams('?start=&end=').start, null, 'parseDownloaderParams 空 start → null');

  // buildDownloaderQuery ↔ parseDownloaderParams 互逆
  const roundTrip = parseDownloaderParams(
    '?' + buildDownloaderQuery({ url: targetUrl, format: 'mp4', concurrency: 16, title: '测试标题' })
  );
  eq(
    roundTrip,
    { url: targetUrl, title: '测试标题', format: 'mp4', concurrency: 16, start: null, end: null, autosave: false },
    'buildDownloaderQuery 与 parseDownloaderParams 互逆'
  );
  eq(
    buildDownloaderQuery({ url: 'https://x.test/a.m3u8', format: 'ts', concurrency: 999 }),
    'url=' + encodeURIComponent('https://x.test/a.m3u8') + '&format=ts&concurrency=64',
    'buildDownloaderQuery 并发数截断且无 title 参数'
  );

  // assemblePositionedChunks：Blob 降级模式的按偏移组装（MP4 mdat size 回填）
  eq(Array.from(assemblePositionedChunks([])), [], 'assemblePositionedChunks 空数组');
  eq(
    Array.from(
      assemblePositionedChunks([
        { position: 0, data: Uint8Array.from([1, 2, 3]) },
        { position: 4, data: Uint8Array.from([9]) },
      ])
    ),
    [1, 2, 3, 0, 9],
    'assemblePositionedChunks 顺序分片 + 结尾偏移（空洞补 0）'
  );
  eq(
    Array.from(
      assemblePositionedChunks([
        { position: 0, data: Uint8Array.from([1, 2, 3]) },
        { position: 4, data: Uint8Array.from([9]) },
        { position: 1, data: Uint8Array.from([7, 7]) },
      ])
    ),
    [1, 7, 7, 0, 9],
    'assemblePositionedChunks 乱序/回填覆盖（模拟 mdat size 回填）'
  );
  {
    // 模拟真实场景：先写 4MiB 顺序块，finalize 时回填 position=28 的 mdat size。
    const big = new Uint8Array(4 * 1024 * 1024).fill(0xab);
    const backfill = Uint8Array.from([0xde, 0xad, 0xbe, 0xef]);
    const assembled = assemblePositionedChunks([
      { position: 0, data: big },
      { position: 28, data: backfill },
    ]);
    eq(assembled.length, big.length, 'assemblePositionedChunks 回填不改变文件大小（>4MiB）');
    eq(Array.from(assembled.subarray(28, 32)), [0xde, 0xad, 0xbe, 0xef], 'assemblePositionedChunks 回填写入正确偏移');
    eq(assembled[27], 0xab, 'assemblePositionedChunks 回填不影响相邻字节');
  }

  // 阶段文案
  eq(phaseLabel('download'), '下载分片', 'phaseLabel download');
  eq(phaseLabel('cancelled'), '已取消', 'phaseLabel cancelled');
  eq(phaseLabel('unknown-phase'), '处理中', 'phaseLabel 未知阶段');
  ok(PHASE_LABELS && PHASE_LABELS.done === '下载完成', 'PHASE_LABELS.done 文案');

  console.log('\n========== util 单测汇总 ==========');
  console.log(`通过：${passes.length}，失败：${failures.length}`);
  if (failures.length) console.log('失败：\n  - ' + failures.join('\n  - '));
  else console.log('结果：全部通过（exit 0）');
  return failures.length === 0 ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  process.exitCode = await runCheck();
}
