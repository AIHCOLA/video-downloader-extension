// 下载页：解析播放列表 → 选择保存位置（File System Access API）→ 流式下载写入 → 结果展示。
//
// E2E 钩子（供 puppeteer 断言，必须保留）：
//   window.__HLS_STATE  { phase, percent, segmentsDone, segmentsTotal, error, done, filename, bytes }
//   window.__HLS_RESULT { done: true, filename, bytes, durationSeconds, muxed, pathHint }（成功后）
//   window.__HLS_START  可编程触发“开始下载”（等价于点击开始按钮）
import { probePlaylist, downloadHls } from '../src/core/index.mjs';
import { downloadDirect, isBlockedError } from '../src/core/direct.mjs';
import { muxDashTracks } from '../src/core/dash.mjs';
import { createTabFetcher, createPageJsonFetcher, createSiteJsonFetcher } from '../src/core/tab-proxy.mjs';
import { createDouyinExtractor } from '../src/core/page-data.mjs';
import { detectSite, resolveSite, buildSiteFilename } from '../src/sites/index.mjs';
import {
  assemblePositionedChunks,
  buildFilename,
  clampInt,
  describeError,
  formatBandwidth,
  formatBytes,
  formatDuration,
  formatEta,
  formatSpeed,
  parseDownloaderParams,
  parseSeconds,
  phaseLabel,
} from './util.mjs';

const $ = (id) => document.getElementById(id);

const pageParams = parseDownloaderParams(location.search);
const rawUrl = pageParams.url;
const pageTitle = pageParams.title;
const autosave = pageParams.autosave;
const initialFormat = pageParams.format;
const initialConcurrency = pageParams.concurrency;
const initialStart = pageParams.start;
const initialEnd = pageParams.end;

// 站点页链接（B 站等）与 m3u8 链接走两条不同的解析/下载链路
const siteMatch = detectSite(rawUrl);

const els = {
  cancel: $('cancel'),
  videoUrl: $('video-url'),
  copyUrl: $('copy-url'),
  pageTitle: $('page-title'),
  infoTitle: $('info-title'),
  infoStatus: $('info-status'),
  infoSegmentsLabel: $('info-segments-label'),
  infoSegments: $('info-segments'),
  infoDuration: $('info-duration'),
  infoEncryption: $('info-encryption'),
  infoType: $('info-type'),
  infoVariants: $('info-variants'),
  infoError: $('info-error'),
  format: $('format'),
  concurrency: $('concurrency'),
  startInput: $('start-sec'),
  endInput: $('end'),
  hlsControls: $('hls-controls'),
  siteControls: $('site-controls'),
  quality: $('quality'),
  siteNote: $('site-note'),
  saveModeNote: $('save-mode-note'),
  statusBanner: $('status-banner'),
  start: $('start'),
  progressCard: $('progress-card'),
  phaseText: $('phase-text'),
  percentText: $('percent-text'),
  barFill: $('bar-fill'),
  segmentsText: $('segments-text'),
  segmentsLabel: $('segments-label'),
  downloadedText: $('downloaded-text'),
  bytesText: $('bytes-text'),
  speedText: $('speed-text'),
  etaText: $('eta-text'),
  resultCard: $('result-card'),
  resultFilename: $('result-filename'),
  resultSize: $('result-size'),
  resultDuration: $('result-duration'),
  resultResolution: $('result-resolution'),
  resultFormat: $('result-format'),
  resultHint: $('result-hint'),
  again: $('again'),
  logToggle: $('log-toggle'),
  logCount: $('log-count'),
  log: $('log'),
  logChev: $('log-chev'),
};

const state = {
  downloading: false,
  aborter: null,
  probeController: null,
  info: null,
  plan: null, // 站点适配器的下载计划（B 站等），与 info 二选一
  site: null, // 命中的站点 id
  qn: null, // 用户选中的清晰度（重试/重新解析时沿用）
  bytes: 0,
  filename: null,
  blobParts: null,
  usingFsa: false,
  lastProgress: null,
  renderTimer: null,
  logCount: 0,
  startTs: 0,
};

// ---- E2E 钩子（必须在页面加载阶段就存在） ----------------------------------

window.__HLS_STATE = {
  phase: 'idle',
  percent: 0,
  segmentsDone: 0,
  segmentsTotal: 0,
  error: null,
  done: false,
  filename: null,
  bytes: 0,
};
window.__HLS_RESULT = null;
window.__HLS_BLOB_URL = null;
window.__HLS_BLOB_SIZE = 0;
window.__HLS_START = () => startDownload();

// ---- 保存方式 --------------------------------------------------------------

function supportsFsa() {
  return typeof window.showSaveFilePicker === 'function' && window.isSecureContext !== false;
}

function savePickerTypes(outFormat) {
  return outFormat === 'ts'
    ? [{ description: 'TS 视频流', accept: { 'video/mp2t': ['.ts'] } }]
    : [{ description: 'MP4 视频', accept: { 'video/mp4': ['.mp4'] } }];
}

function setState(patch) {
  if (!window.__HLS_STATE || typeof window.__HLS_STATE !== 'object') {
    window.__HLS_STATE = {
      phase: 'idle',
      percent: 0,
      segmentsDone: 0,
      segmentsTotal: 0,
      error: null,
      done: false,
      filename: null,
      bytes: 0,
    };
  }
  Object.assign(window.__HLS_STATE, patch);
}

// ---- 日志 / 提示 -----------------------------------------------------------

function appendLog(level, message) {
  if (!message) return;
  const line = document.createElement('div');
  line.className = 'log-line log-' + (level === 'warn' || level === 'error' ? level : 'info');
  let time = '';
  try {
    time = new Date().toLocaleTimeString('zh-CN', { hour12: false });
  } catch {
    time = '';
  }
  line.textContent = `[${time}] ${message}`;
  els.log.appendChild(line);
  state.logCount += 1;
  while (els.log.childElementCount > 400) {
    const first = els.log.firstElementChild;
    if (!first) break;
    first.remove();
  }
  els.logCount.textContent = `（${state.logCount} 条）`;
  els.log.scrollTop = els.log.scrollHeight;
}

function showBanner(text, kind = 'error') {
  els.statusBanner.textContent = text;
  els.statusBanner.className = `banner ${kind}`;
}

function hideBanner() {
  els.statusBanner.textContent = '';
  els.statusBanner.className = 'banner hidden';
}

// ---- 进度渲染 --------------------------------------------------------------

function scheduleRender() {
  if (state.renderTimer != null) return;
  state.renderTimer = setTimeout(() => {
    state.renderTimer = null;
    renderProgress();
  }, 60);
}

function renderProgress() {
  const snapshot = window.__HLS_STATE;
  const progress = state.lastProgress || {};
  const percent = Math.max(0, Math.min(100, Number(snapshot.percent) || 0));
  els.progressCard.classList.remove('hidden');
  els.percentText.textContent = percent >= 100 ? '100%' : `${percent.toFixed(1)}%`;
  els.barFill.style.width = `${percent}%`;
  els.phaseText.textContent = phaseLabel(snapshot.phase);
  els.segmentsText.textContent = `${snapshot.segmentsDone || 0} / ${snapshot.segmentsTotal || 0}`;
  els.downloadedText.textContent = formatBytes(progress.bytesDownloaded || 0);
  els.bytesText.textContent = formatBytes(snapshot.bytes || 0);
  els.speedText.textContent = formatSpeed(progress.speedBps);
  els.etaText.textContent = formatEta(progress.etaSeconds);
}

function handleProgress(progress) {
  if (!progress) return;
  state.lastProgress = progress;
  const percent = Number(progress.percent);
  setState({
    phase: progress.phase || 'download',
    percent: Number.isFinite(percent) ? Math.max(0, Math.min(100, percent)) : 0,
    segmentsDone: Number(progress.segmentsDone) || 0,
    segmentsTotal: Number(progress.segmentsTotal) || 0,
  });
  scheduleRender();
}

// ---- 播放列表信息 ----------------------------------------------------------

function renderInfo(info) {
  els.infoSegments.textContent = String(info.segments ?? '—');
  els.infoDuration.textContent = formatDuration(info.durationSeconds);
  els.infoEncryption.textContent = info.encrypted
    ? (info.encryptionMethods && info.encryptionMethods.length ? info.encryptionMethods.join(' / ') : '已加密')
    : '未加密';
  els.infoType.textContent = info.isMaster ? '多码率 Master' : info.isLive ? '直播（无 ENDLIST）' : '点播 VOD';
  if (info.isMaster && Array.isArray(info.variants) && info.variants.length) {
    const sorted = info.variants.slice().sort((a, b) => (b.bandwidth || 0) - (a.bandwidth || 0));
    const top = sorted
      .slice(0, 5)
      .map((variant) => `${variant.resolution || '未知'} · ${formatBandwidth(variant.bandwidth)}`);
    els.infoVariants.textContent = `清晰度档位（共 ${sorted.length} 档，默认选最高码率）：${top.join(' / ')}${sorted.length > 5 ? ' …' : ''}`;
    els.infoVariants.classList.remove('hidden');
  } else {
    els.infoVariants.classList.add('hidden');
  }
  els.infoError.classList.add('hidden');
}

function renderInfoError(message) {
  els.infoSegments.textContent = '—';
  els.infoDuration.textContent = '—';
  els.infoEncryption.textContent = '—';
  els.infoType.textContent = '—';
  els.infoVariants.classList.add('hidden');
  els.infoError.textContent = message;
  els.infoError.classList.remove('hidden');
}

async function autoProbe() {
  if (siteMatch) return autoProbeSite();
  return autoProbeHls();
}

// ---- 站点（B 站等）信息 -----------------------------------------------------

/**
 * 站点提示文案：基础说明 + 本次清晰度。
 * 清晰度低于 1080P 时说明原因（未登录 / 接口上限），避免用户以为扩展只支持 720P。
 */
function siteNoteText(plan) {
  const pageHint =
    siteMatch && siteMatch.parsed.kind === 'video' && siteMatch.parsed.page > 1
      ? ` 将下载第 ${siteMatch.parsed.page} P。`
      : '';
  let text =
    plan && plan.mode === 'hls'
      ? `已识别为${siteMatch.label}视频：源站给的是 HLS 播放列表，下载时并发拉取分片、按需 AES-128 解密，最后封装成 MP4。${pageHint}`
      : `已识别为${siteMatch.label}视频：按整段 MP4 下载（源站已含音视频，无需重新封装），不支持时间段裁剪。${pageHint}`;
  if (plan && plan.quality) {
    text += ` 本次清晰度：${plan.quality.label}`;
    if (plan.qualityHint) {
      text += plan.qualityHint;
    } else if (plan.quality.qn < 80) {
      text += plan.loggedIn ? '（接口最高只给到这一档）' : '（未登录上限；登录 B 站后可到 1080P）';
    }
    text += '。';
    if (plan.mode === 'dash') {
      text += ' 这一档只有分离的视频轨和音频轨，下载时会边下边合并成一个完整的 MP4。';
    }
  }
  return text;
}

function renderSiteInfo(plan) {
  const isHls = plan.mode === 'hls';
  els.infoTitle.textContent = '视频信息';
  els.infoSegmentsLabel.textContent = isHls ? '分片' : '文件';
  els.infoSegments.textContent = isHls ? 'HLS（m3u8）' : '整段 MP4';
  els.infoDuration.textContent = formatDuration(plan.durationSeconds);
  els.infoEncryption.textContent = isHls ? '按播放列表' : '未加密';
  els.infoType.textContent = `${plan.siteLabel} · ${plan.quality.label}`;
  const notes = [];
  if (plan.owner) notes.push(`UP 主：${plan.owner}`);
  if (plan.page && plan.page.total > 1) notes.push(`第 ${plan.page.index}/${plan.page.total} P${plan.page.part ? `：${plan.page.part}` : ''}`);
  if (plan.acceptLabels && plan.acceptLabels.length) notes.push(`可用清晰度：${plan.acceptLabels.join(' / ')}`);
  notes.push(`文件大小：${formatBytes(plan.sizeBytes)}`);
  els.infoVariants.textContent = notes.join(' ｜ ');
  els.infoVariants.classList.remove('hidden');
  els.infoError.classList.add('hidden');
  els.siteNote.textContent = siteNoteText(plan);
}

/**
 * 填充清晰度下拉：接口给了哪些档就列哪些；
 * 超过 1080P 的档位（只有 DASH 轨道）列出来但置灰，说明为什么不能选。
 */
function renderQualityOptions(plan, preferredQn) {
  const list = Array.isArray(plan && plan.qualities) ? plan.qualities : [];
  if (!list.length) {
    els.siteControls.classList.add('hidden');
    return;
  }
  const current = Number(preferredQn) || Number(plan.quality && plan.quality.qn) || 0;
  els.quality.replaceChildren();
  for (const item of list) {
    const option = document.createElement('option');
    option.value = String(item.qn);
    // 腾讯等站点的接口只给分辨率高度，宽度未知时就只显示标签
    const dims = item.width && item.height ? `（${item.width}×${item.height}）` : '';
    option.textContent = `${item.label}${dims}`;
    if (item.supported === false) option.disabled = true;
    if (item.qn === current) option.selected = true;
    els.quality.appendChild(option);
  }
  const options = Array.from(els.quality.options);
  if (!options.some((option) => option.selected)) {
    const first = options.find((option) => !option.disabled);
    if (first) first.selected = true;
  }
  els.siteControls.classList.remove('hidden');
}

/** 切换清晰度：重新解析一次（换 qn），并刷新信息区 */
async function applyQuality(qn) {
  if (!siteMatch || state.downloading || !Number.isFinite(qn)) return;
  els.quality.disabled = true;
  els.infoStatus.textContent = '解析中…';
  setState({ phase: 'probe' });
  try {
    const plan = await resolveSite(rawUrl, siteResolveContext({ qn }));
    state.plan = plan;
    state.qn = qn;
    renderSiteInfo(plan);
    renderQualityOptions(plan, qn);
    els.infoStatus.textContent = '';
    setState({ phase: 'ready', segmentsDone: 0, segmentsTotal: 1 });
    appendLog('info', `已切换清晰度：${plan.quality.label}，文件大小 ${formatBytes(plan.sizeBytes)}`);
  } catch (err) {
    const message = describeError(err);
    els.infoStatus.textContent = '切换失败';
    appendLog('error', `切换清晰度失败：${message}`);
    showBanner(`切换清晰度失败：${message}`, 'error');
    setState({ phase: 'ready', error: message });
  } finally {
    els.quality.disabled = false;
  }
}

async function autoProbeSite() {
  els.infoStatus.textContent = '解析中…';
  setState({ phase: 'probe' });
  const controller = new AbortController();
  state.probeController = controller;
  const timer = setTimeout(() => controller.abort(), 60000);
  try {
    const plan = await resolveSite(rawUrl, siteResolveContext({ signal: controller.signal }));
    state.plan = plan;
    state.site = plan.site;
    state.qn = Number(plan.requestedQn) || Number(plan.quality && plan.quality.qn) || null;
    renderSiteInfo(plan);
    renderQualityOptions(plan);
    els.infoStatus.textContent = '';
    setState({ phase: 'ready', segmentsDone: 0, segmentsTotal: 1 });
    appendLog(
      'info',
      `已解析：${plan.title}（${plan.quality.label}，${formatBytes(plan.sizeBytes)}，${formatDuration(plan.durationSeconds)}）`
    );
    if (plan.acceptLabels && plan.acceptLabels.length === 1 && plan.site === 'bilibili') {
      appendLog('info', '当前只有一档清晰度可用；登录 B 站账号后可获得更高清晰度。');
    }
  } catch (err) {
    const message = describeError(err);
    state.plan = null;
    els.infoTitle.textContent = '视频信息';
    els.infoSegmentsLabel.textContent = '文件';
    els.infoSegments.textContent = '—';
    els.infoDuration.textContent = '—';
    els.infoEncryption.textContent = '—';
    els.infoType.textContent = '—';
    els.infoVariants.classList.add('hidden');
    els.infoError.textContent = message;
    els.infoError.classList.remove('hidden');
    els.infoStatus.textContent = '解析失败';
    appendLog('error', `解析视频失败：${message}`);
    setState({ phase: 'ready', error: message });
    showBanner(`解析失败：${message}`, 'error');
  } finally {
    clearTimeout(timer);
    if (state.probeController === controller) state.probeController = null;
  }
}

async function autoProbeHls() {
  els.infoStatus.textContent = '解析中…';
  setState({ phase: 'probe' });
  const controller = new AbortController();
  state.probeController = controller;
  const timer = setTimeout(() => controller.abort(), 60000);
  try {
    const info = await probePlaylist(rawUrl, {
      signal: controller.signal,
      onLog: (level, message) => {
        if (level === 'error') appendLog('error', message);
        else if (level === 'warn') appendLog('warn', message);
      },
    });
    state.info = info;
    renderInfo(info);
    els.infoStatus.textContent = '';
    if (!state.downloading) {
      setState({ phase: 'ready', segmentsDone: 0, segmentsTotal: info.segments });
    }
    appendLog(
      'info',
      `播放列表解析完成：${info.segments} 个片段，时长 ${formatDuration(info.durationSeconds)}` +
        (info.encrypted ? `，加密：${(info.encryptionMethods || []).join(' / ') || '已加密'}` : '，未加密')
    );
    if (info.isLive) appendLog('warn', '该播放列表没有 ENDLIST，可能是直播流，录制可能不完整。');
  } catch (err) {
    if (controller.signal.aborted) {
      if (state.downloading) {
        els.infoStatus.textContent = '解析被中断';
        appendLog('warn', '播放列表解析被下载流程中断。');
      } else {
        els.infoStatus.textContent = '解析超时';
        appendLog('error', '播放列表解析超时。');
        showBanner('播放列表解析超时，仍可点击“开始下载”重试（下载时会重新解析）。', 'warn');
        setState({ phase: 'ready', error: '解析超时' });
      }
      return;
    }
    const message = describeError(err);
    state.info = null;
    renderInfoError(message);
    els.infoStatus.textContent = '解析失败';
    appendLog('error', `解析播放列表失败：${message}`);
    setState({ phase: 'ready', error: message });
    showBanner(`播放列表解析失败：${message}。仍可点击“开始下载”重试。`, 'warn');
  } finally {
    clearTimeout(timer);
    if (state.probeController === controller) state.probeController = null;
  }
}

// ---- 下载流程 --------------------------------------------------------------

function setControlsDisabled(disabled) {
  els.format.disabled = disabled;
  els.concurrency.disabled = disabled;
  els.startInput.disabled = disabled;
  els.endInput.disabled = disabled;
  els.quality.disabled = disabled;
}

function resetProgressUI() {
  els.resultCard.classList.add('hidden');
  els.progressCard.classList.remove('hidden');
  els.barFill.className = 'bar-fill';
  els.barFill.style.width = '0%';
  els.percentText.textContent = '0%';
  els.phaseText.textContent = '准备中…';
  els.segmentsText.textContent = '0 / 0';
  els.downloadedText.textContent = '0 B';
  els.bytesText.textContent = '0 B';
  els.speedText.textContent = '—';
  els.etaText.textContent = '—';
}

function resetForRetry() {
  els.resultCard.classList.add('hidden');
  els.progressCard.classList.add('hidden');
  els.barFill.className = 'bar-fill';
  els.barFill.style.width = '0%';
  els.percentText.textContent = '0%';
  els.phaseText.textContent = '等待开始';
  els.segmentsText.textContent = '0 / 0';
  els.downloadedText.textContent = '0 B';
  els.bytesText.textContent = '0 B';
  els.speedText.textContent = '—';
  els.etaText.textContent = '—';
  els.start.textContent = '选择保存位置并开始下载';
  els.start.disabled = false;
  els.cancel.disabled = true;
  hideBanner();
  state.bytes = 0;
  state.filename = null;
  state.lastProgress = null;
  // 站点直链带时效签名，重试前重新解析，避免拿着过期地址反复 403
  if (siteMatch) state.plan = null;
  window.__HLS_RESULT = null;
  window.__HLS_BLOB_URL = null;
  window.__HLS_BLOB_SIZE = 0;
  setState({
    phase: 'idle',
    percent: 0,
    segmentsDone: 0,
    segmentsTotal: state.info ? state.info.segments : 0,
    error: null,
    done: false,
    filename: null,
    bytes: 0,
  });
}

/**
 * Blob 降级 / autosave 模式的文件组装。
 *
 * 由于 MP4（fastStart:false）在 finalize 时会按绝对偏移回填文件头部 mdat 的 size，
 * 不能简单把 chunk 依次 push 成一个数组；这里按 { position, data } 收集，
 * 结束后分配最终大小（各段 position + length 的最大值）再按偏移复制。
 */
async function finalizeBlob(chunks, filename, outFormat) {
  const type = outFormat === 'ts' ? 'video/mp2t' : 'video/mp4';
  // 按 position 组装（兼容 MP4 finalize 时对文件头部 mdat size 的回填）。
  const buffer = assemblePositionedChunks(chunks);
  // 释放分段引用，降低峰值内存占用。
  chunks.length = 0;
  const blob = new Blob([buffer], { type });
  const objectUrl = URL.createObjectURL(blob);
  // E2E 辅助钩子：可在页面内 fetch(window.__HLS_BLOB_URL) 直接校验字节内容，
  // 不依赖浏览器的下载目录/下载行为设置。
  window.__HLS_BLOB_URL = objectUrl;
  window.__HLS_BLOB_SIZE = blob.size;
  try {
    const link = document.createElement('a');
    link.href = objectUrl;
    link.download = filename;
    link.rel = 'noopener';
    link.style.display = 'none';
    document.body.appendChild(link);
    link.click();
    link.remove();
  } finally {
    setTimeout(() => URL.revokeObjectURL(objectUrl), 10 * 60 * 1000);
  }
  appendLog('info', `已按偏移组装文件（${formatBytes(blob.size)}），正在交给浏览器保存。`);
  // 给浏览器一点时间真正开始下载，便于调用方/E2E 观察。
  await new Promise((resolve) => setTimeout(resolve, 400));
  return blob.size;
}

function showResult(result, meta) {
  els.resultFilename.textContent = meta.filename;
  els.resultSize.textContent = formatBytes(meta.bytes);
  els.resultDuration.textContent = formatDuration(
    Number(result.durationSeconds) || (state.info && state.info.durationSeconds) || 0
  );
  const width = Number(result.width) || 0;
  const height = Number(result.height) || 0;
  els.resultResolution.textContent = width > 0 && height > 0 ? `${width} × ${height}` : '—';
  els.resultFormat.textContent = meta.siteLabel
    ? `MP4（${meta.siteLabel}${meta.merged ? '，音视频已合并' : ' 源文件'}）`
    : meta.outFormat === 'ts'
      ? 'TS 原始流'
      : 'MP4（H.264 + AAC）';
  els.resultHint.textContent = `${meta.pathHint} 下载耗时 ${formatDuration(meta.elapsedMs / 1000)}。`;
  els.resultCard.classList.remove('hidden');
}

function updateSaveModeNote() {
  let text;
  if (autosave) {
    text = '自动保存模式（autosave=1）：点击开始后直接下载，完成后自动保存到浏览器下载目录。';
  } else if (supportsFsa()) {
    text = '点击开始后会弹出系统“保存文件”对话框；选择位置后边下载边写入磁盘，不占用大量内存。';
  } else {
    text = '当前环境不支持 File System Access API，会把文件缓存在内存中，完成后通过浏览器下载。大文件可能占用较多内存。';
  }
  els.saveModeNote.textContent = text;
}

function cancelDownload() {
  if (!state.aborter) return;
  els.cancel.disabled = true;
  els.phaseText.textContent = '正在取消…';
  appendLog('warn', '用户请求取消下载…');
  try {
    state.aborter.abort();
  } catch (err) {
    console.warn('[HLS] abort 失败：', err);
  }
}

/**
 * 站点解析的能力注入：
 *   B 站 → 在页面上下文里请求 playurl（带登录态 + WBI 签名）
 *   抖音 → 读页面自己的数据（_ROUTER_DATA / <video>）
 * 各站点只取自己用得到的那一个。
 */
let siteTools = null;
function siteResolveContext(extra = {}) {
  const onLog = (level, message) => appendLog(level, message);
  // 这两个工具内部各自缓存标签页 id：必须整页共用一份，否则每次解析都会新开一个标签页
  if (!siteTools) {
    const youkuJson = createSiteJsonFetcher({
      origin: 'https://v.youku.com/',
      match: ['*://*.youku.com/*'],
      label: '优酷',
      onLog,
    });
    const bilibiliJson = createPageJsonFetcher({ onLog });
    siteTools = {
      // 按接口域名路由到对应站点的页面上下文：
      // B 站要在 bilibili.com 页面里请求 playurl（带登录态），优酷要在 youku.com 页面里请求 ups
      fetchJsonInPage: (url, ctx) => (/youku\.com/i.test(url) ? youkuJson(url, ctx) : bilibiliJson(url, ctx)),
      extractPageData: createDouyinExtractor({ onLog }),
    };
  }
  return { onLog, ...siteTools, ...extra };
}

/**
 * 给 DASH 合并用的 Range 取字节函数：
 * 先直连（DNR 规则会补 Referer），被 403/401 或网络错误挡下时改用 B 站标签页代理。
 */
function createRangeFetcher(proxyFetch) {
  return async function fetchRange(url, range, ctx = {}) {
    if (ctx.signal && ctx.signal.aborted) {
      const err = new Error('已取消');
      err.name = 'AbortError';
      throw err;
    }
    try {
      const res = await fetch(url, {
        signal: ctx.signal,
        credentials: 'omit',
        headers: { Range: `bytes=${range.start}-${range.end}` },
      });
      if (res.status === 416) {
        const err = new Error('HTTP 416');
        err.status = 416;
        throw err;
      }
      if (!res.ok) {
        const err = new Error(`HTTP ${res.status}`);
        err.status = res.status;
        throw err;
      }
      return new Uint8Array(await res.arrayBuffer());
    } catch (err) {
      if (err && err.name === 'AbortError') throw err;
      if (err && err.status === 416) throw err;
      appendLog('warn', `直连取字节失败（${describeError(err)}），改用 B 站标签页代理`);
      return proxyFetch(url, range, ctx);
    }
  };
}

async function startDownload() {
  if (state.downloading) return;
  if (!rawUrl) {
    showBanner('缺少视频地址（url 参数），无法开始下载。', 'error');
    return;
  }
  if (!/^https?:\/\//i.test(rawUrl)) {
    showBanner('视频地址格式不正确，需要以 http:// 或 https:// 开头。', 'error');
    return;
  }

  const isSite = Boolean(siteMatch);
  const outFormat = isSite ? 'mp4' : els.format.value === 'ts' ? 'ts' : 'mp4';
  const concurrency = clampInt(els.concurrency.value, 16, 1, 64);
  const startSec = isSite ? null : parseSeconds(els.startInput.value);
  const endSec = isSite ? null : parseSeconds(els.endInput.value);
  if (startSec != null && endSec != null && endSec <= startSec) {
    showBanner('“结束时间”必须大于“开始时间”。', 'error');
    return;
  }

  // 中断尚未完成的自动解析，避免重复请求网络。
  if (state.probeController) {
    try {
      state.probeController.abort();
    } catch {
      /* 忽略 */
    }
    state.probeController = null;
  }

  // 站点链接：进入下载前必须拿到解析计划（可能用户是直接打开本页的）
  let plan = state.plan;
  if (isSite && !plan) {
    showBanner('正在解析视频信息…', 'warn');
    try {
      plan = await resolveSite(rawUrl, siteResolveContext({ qn: state.qn || undefined }));
      state.plan = plan;
      state.site = plan.site;
      state.qn = Number(plan.requestedQn) || Number(plan.quality && plan.quality.qn) || state.qn;
      renderSiteInfo(plan);
      renderQualityOptions(plan, state.qn);
      hideBanner();
    } catch (err) {
      showBanner(`解析失败：${describeError(err)}`, 'error');
      return;
    }
  }

  hideBanner();
  resetProgressUI();
  state.downloading = true;
  state.bytes = 0;
  state.filename = null;
  state.blobParts = null;
  state.usingFsa = false;
  state.lastProgress = null;
  state.startTs = Date.now();
  window.__HLS_RESULT = null;
  window.__HLS_BLOB_URL = null;
  window.__HLS_BLOB_SIZE = 0;
  setState({
    phase: 'download',
    percent: 0,
    segmentsDone: 0,
    segmentsTotal: state.info ? state.info.segments : 0,
    error: null,
    done: false,
    filename: null,
    bytes: 0,
  });
  renderProgress();
  setControlsDisabled(true);
  els.cancel.disabled = false;
  els.start.disabled = true;
  els.start.textContent = '下载中…';

  const controller = new AbortController();
  state.aborter = controller;
  let filename = plan ? buildSiteFilename(plan) : buildFilename(rawUrl, outFormat);
  let writer = null;
  let blobParts = null;

  try {
    // 1) 选择保存位置（File System Access API），拿到可写流。
    if (!autosave && supportsFsa()) {
      let handle = null;
      try {
        handle = await window.showSaveFilePicker({ suggestedName: filename, types: savePickerTypes(outFormat) });
      } catch (pickerErr) {
        if (pickerErr && pickerErr.name === 'AbortError') {
          appendLog('warn', '已取消选择保存位置。');
          setState({ phase: 'cancelled', done: false, error: '已取消' });
          els.barFill.classList.add('cancelled');
          els.phaseText.textContent = '已取消';
          showBanner('已取消：未选择保存位置。', 'warn');
          return;
        }
        appendLog('warn', `无法打开保存对话框（${describeError(pickerErr)}），改用浏览器下载方式。`);
        handle = null;
      }
      if (handle) {
        writer = await handle.createWritable();
        state.usingFsa = true;
        filename = handle.name || filename;
        appendLog('info', `保存位置已选择：${filename}`);
      }
    }

    if (!writer) {
      blobParts = [];
      state.blobParts = blobParts;
      appendLog(
        'info',
        autosave
          ? '自动保存模式（autosave=1）：完成后自动下载文件。'
          : '当前环境不支持文件选择器，将在下载完成后通过浏览器下载文件。'
      );
    }

    state.filename = filename;
    setState({ filename });

    // 2) 位置感知流式写入。
    //    MP4（fastStart:false，moov 在文件末尾）在 finalize 时会按绝对偏移回填文件头部
    //    mdat 的 size（position≈28），因此 downloadHls 以 (chunk, position) 调用 write：
    //      - position 为数字：写到该绝对偏移（覆盖写，用于回填）；
    //      - position 缺省：顺序追加。
    //    FSA：FileSystemWritableFileStream 原生支持 { type:'write', data, position }；
    //    Blob：先按 {position,data} 收集，完成后按偏移组装（见 finalizeBlob）。
    let sequentialOffset = 0; // 顺序追加的累计偏移
    let positionedSeen = false; // 是否出现过位置写入（出现过则后续“追加”按文件末尾处理）
    let fileSize = 0; // 文件最大范围 = 最终文件大小（含回填，不重复计数）
    const write = async (chunk, position) => {
      if (!chunk) return;
      const bytes = chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk);
      if (!bytes.byteLength) return;
      const hasPosition = Number.isFinite(position);
      let offset;
      if (hasPosition) {
        offset = position;
        positionedSeen = true;
      } else if (positionedSeen) {
        offset = fileSize;
      } else {
        offset = sequentialOffset;
      }
      if (writer) {
        if (hasPosition || positionedSeen) {
          await writer.write({ type: 'write', data: bytes, position: offset });
        } else {
          await writer.write(bytes);
        }
      } else {
        // Blob 模式复制一份，避免上游复用缓冲区。
        blobParts.push({ position: offset, data: bytes.slice() });
      }
      if (!hasPosition) sequentialOffset = offset + bytes.byteLength;
      if (offset + bytes.byteLength > fileSize) fileSize = offset + bytes.byteLength;
      state.bytes = fileSize;
      setState({ bytes: fileSize });
      scheduleRender();
    };

    let result;
    if (plan && plan.mode === 'dash') {
      // 1080P 及以上：视频轨 + 音频轨分别取回，边下边合并成一个 MP4
      const proxyFetch = createTabFetcher({ onLog: (level, message) => appendLog(level, message) });
      const fetchRange = createRangeFetcher(proxyFetch);
      result = await muxDashTracks({
        video: plan.video,
        audio: plan.audio,
        fetchRange,
        output: { write },
        signal: controller.signal,
        totalBytes: plan.sizeBytes,
        onProgress: handleProgress,
        onLog: (level, message) => appendLog(level, message),
      });
    } else if (plan && plan.mode === 'hls') {
      // 站点给的是 HLS（优酷）：分片下载 + AES-128 解密 + 封装 MP4
      result = await downloadHls({
        playlistUrl: plan.playlistUrl,
        concurrency,
        signal: controller.signal,
        output: {
          type: 'mp4',
          supportsPosition: true,
          write,
        },
        onProgress: handleProgress,
        onLog: (level, message) => appendLog(level, message),
      });
    } else if (plan) {
      // 站点直链：源文件已是完整 MP4，只做「取字节 → 写盘」；
      // 直连若被 Referer 校验拦下（403），downloadDirect 会自动改用标签页代理分块下载。
      // 标签页代理复用的是 B 站页面上下文，只对它有意义；抖音走 DNR + 直连
      const fetchChunk = plan.site === 'bilibili' ? createTabFetcher({ onLog: (level, message) => appendLog(level, message) }) : undefined;
      result = await downloadDirect({
        url: plan.url,
        backupUrls: plan.backupUrls,
        sizeBytes: plan.sizeBytes,
        durationSeconds: plan.durationSeconds,
        width: plan.quality && plan.quality.width,
        height: plan.quality && plan.quality.height,
        signal: controller.signal,
        output: { supportsPosition: true, write },
        fetchChunk,
        onProgress: handleProgress,
        onLog: (level, message) => appendLog(level, message),
      });
    } else {
      result = await downloadHls({
        playlistUrl: rawUrl,
        concurrency,
        start: startSec,
        end: endSec,
        signal: controller.signal,
        output: {
          type: outFormat,
          // 声明支持按文件偏移写入，核心才会使用 fastStart:false（普通渐进式 MP4，moov 在末尾），
          // 并在 finalize 时把 mdat size 回填到文件头部（>4MiB 时必需）。
          supportsPosition: true,
          write,
        },
        onProgress: handleProgress,
        onLog: (level, message) => appendLog(level, message),
      });
    }

    if (writer) {
      await writer.close();
      writer = null;
    }
    if (blobParts) {
      const assembledSize = await finalizeBlob(blobParts, filename, outFormat);
      if (Number.isFinite(assembledSize) && assembledSize > 0) {
        state.bytes = assembledSize;
        setState({ bytes: assembledSize });
      }
      blobParts = null;
      state.blobParts = null;
    }

    const payload = result || {};
    const elapsedMs = Date.now() - state.startTs;
    const segmentsDone = window.__HLS_STATE.segmentsDone || Number(payload.segments) || 0;
    const segmentsTotal = window.__HLS_STATE.segmentsTotal || (state.info ? state.info.segments : segmentsDone);
    const pathHint = state.usingFsa
      ? `已保存到你选择的文件：${filename}`
      : '已通过浏览器下载，请到浏览器下载目录查看（Ctrl+J / chrome://downloads）。';

    setState({
      phase: 'done',
      percent: 100,
      segmentsDone,
      segmentsTotal,
      error: null,
      done: true,
      filename,
      bytes: state.bytes,
    });
    window.__HLS_RESULT = {
      done: true,
      filename,
      bytes: state.bytes,
      durationSeconds: Number(payload.durationSeconds) || 0,
      muxed: Boolean(payload.muxed),
      // moovFront=false 表示普通渐进式 MP4（moov 在文件末尾）；用于 E2E 确认位置感知写入生效。
      moovFront: payload.moovFront === true,
      pathHint,
    };
    els.barFill.classList.add('complete');
    renderProgress();
    showResult(payload, {
      filename,
      bytes: state.bytes,
      pathHint,
      elapsedMs,
      outFormat,
      siteLabel: plan ? plan.siteLabel : '',
      merged: Boolean(plan && plan.mode === 'dash'),
    });
    appendLog('info', `下载完成：${filename}，${formatBytes(state.bytes)}，耗时 ${formatDuration(elapsedMs / 1000)}`);
  } catch (err) {
    if (writer) {
      try {
        await writer.abort();
      } catch {
        /* 忽略 */
      }
      writer = null;
    }
    state.blobParts = null;
    blobParts = null;
    const aborted = controller.signal.aborted || (err && err.name === 'AbortError');
    if (aborted) {
      appendLog('warn', '已取消下载，未完成的数据已清理。');
      setState({ phase: 'cancelled', done: false, error: '已取消' });
      els.barFill.classList.add('cancelled');
      els.phaseText.textContent = '已取消';
      showBanner('已取消下载，未完成的数据已清理。', 'warn');
    } else {
      let message = describeError(err);
      // 抖音的播放地址带签名时效，过期就是 403，直连和代理都救不回来
      if (plan && plan.site === 'douyin' && isBlockedError(err)) {
        message = '抖音播放地址已过期（HTTP 403）。请回到作品页刷新一次，再点「重新下载」重新解析。';
      } else if (plan && plan.site === 'tencent' && isBlockedError(err)) {
        message = '腾讯视频播放地址已过期（HTTP 403）。点「重新下载」会重新解析并拿到新地址。';
      } else if (plan && plan.site === 'youku' && isBlockedError(err)) {
        message = '优酷 CDN 拒绝了请求（HTTP 403）：播放地址可能已过期，或需要先在优酷页面里播放一次。点「重新下载」重新解析。';
      }
      appendLog('error', `下载失败：${message}`);
      setState({ phase: 'error', done: false, error: message });
      els.barFill.classList.add('error');
      els.phaseText.textContent = '下载失败';
      showBanner(`下载失败：${message}`, 'error');
    }
  } finally {
    state.downloading = false;
    state.aborter = null;
    setControlsDisabled(false);
    els.cancel.disabled = true;
    els.start.disabled = false;
    els.start.textContent = '重新下载';
    scheduleRender();
  }
}

// ---- 复制 / 事件 / 初始化 --------------------------------------------------

async function copyUrl() {
  const original = els.copyUrl.textContent;
  try {
    if (!navigator.clipboard || typeof navigator.clipboard.writeText !== 'function') {
      throw new Error('clipboard unavailable');
    }
    await navigator.clipboard.writeText(rawUrl);
    els.copyUrl.textContent = '已复制';
    setTimeout(() => {
      els.copyUrl.textContent = original;
    }, 1200);
  } catch {
    showBanner('复制失败，请手动选中地址复制。', 'error');
  }
}

function bindEvents() {
  els.start.addEventListener('click', () => {
    void startDownload();
  });
  els.cancel.addEventListener('click', () => {
    cancelDownload();
  });
  els.quality.addEventListener('change', () => {
    void applyQuality(Number(els.quality.value));
  });
  els.again.addEventListener('click', () => {
    resetForRetry();
    void startDownload();
  });
  els.copyUrl.addEventListener('click', () => {
    void copyUrl();
  });
  els.logToggle.addEventListener('click', () => {
    const collapsed = els.log.classList.toggle('collapsed');
    els.logToggle.classList.toggle('collapsed', collapsed);
  });
}

function init() {
  els.videoUrl.textContent = rawUrl || '（未提供视频地址）';
  els.videoUrl.title = rawUrl;
  if (pageTitle) {
    els.pageTitle.textContent = pageTitle;
  } else {
    els.pageTitle.classList.add('hidden');
  }
  els.format.value = initialFormat;
  els.concurrency.value = String(initialConcurrency);
  if (initialStart != null) els.startInput.value = String(initialStart);
  if (initialEnd != null) els.endInput.value = String(initialEnd);
  updateSaveModeNote();
  if (siteMatch) {
    els.hlsControls.classList.add('hidden');
    els.siteNote.textContent = siteNoteText(null);
    els.siteNote.classList.remove('hidden');
    els.infoTitle.textContent = '视频信息';
    els.segmentsLabel.textContent = '文件';
  }
  bindEvents();

  if (!rawUrl) {
    els.infoStatus.textContent = '缺少视频地址';
    els.start.disabled = true;
    els.progressCard.classList.add('hidden');
    showBanner('缺少 url 参数。请从扩展弹窗重新打开本页面，或在页面地址后追加 ?url=<m3u8 地址>。', 'error');
    setState({ phase: 'error', error: '缺少 url 参数' });
    return;
  }
  if (!/^https?:\/\//i.test(rawUrl)) {
    els.infoStatus.textContent = '地址格式不正确';
    els.start.disabled = true;
    els.progressCard.classList.add('hidden');
    showBanner('视频地址格式不正确，需要以 http:// 或 https:// 开头。', 'error');
    setState({ phase: 'error', error: '视频地址格式不正确' });
    return;
  }
  void autoProbe();
}

void init();
