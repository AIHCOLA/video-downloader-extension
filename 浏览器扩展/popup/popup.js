// 扩展弹窗：展示当前标签页检测到的 m3u8、手动解析、下载设置，并打开下载页。
import { probePlaylist } from '../src/core/index.mjs';
import { buildDownloaderQuery, clampInt, formatBandwidth, formatDuration } from '../downloader/util.mjs';
import { detectSite } from '../src/sites/index.mjs';

const $ = (id) => document.getElementById(id);

const els = {
  tabInfo: $('tab-info'),
  sourceCard: $('source-card'),
  sourceTitle: $('source-title'),
  candidates: $('candidates'),
  emptyHint: $('empty-hint'),
  candidateCount: $('candidate-count'),
  refresh: $('refresh'),
  clear: $('clear'),
  manualUrl: $('manual-url'),
  probe: $('probe'),
  probeResult: $('probe-result'),
  concurrency: $('concurrency'),
  format: $('format'),
  status: $('status'),
  start: $('start'),
};

const state = {
  tab: null,
  candidates: [],
  probing: false,
  lastProbe: null,
  site: null, // 当前标签页命中的站点（B 站等）
};

// ---- 基础工具 --------------------------------------------------------------

function setStatus(text, kind = 'info') {
  els.status.textContent = text || '';
  els.status.dataset.kind = kind;
}

function sendMessage(message) {
  return new Promise((resolve, reject) => {
    try {
      chrome.runtime.sendMessage(message, (response) => {
        const lastError = chrome.runtime.lastError;
        if (lastError) {
          reject(new Error(lastError.message || '扩展后台无响应'));
          return;
        }
        if (!response) {
          reject(new Error('扩展后台无响应'));
          return;
        }
        if (response.error) {
          reject(new Error(response.error));
          return;
        }
        resolve(response);
      });
    } catch (err) {
      reject(err);
    }
  });
}

function safeHost(url) {
  try {
    const parsed = new URL(url);
    return parsed.host || parsed.protocol;
  } catch {
    return '';
  }
}

function makeElement(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

// ---- 候选列表 --------------------------------------------------------------

/** 卡片标题随来源类型切换：B 站页面 → 「检测到 B站视频」，其它 → 「检测到的 M3U8」 */
function sourceTitleText() {
  return state.site ? `检测到 ${state.site.label}视频` : '检测到的 M3U8';
}

function emptyHintText() {
  if (state.site) return '已清空。点「刷新列表」重新识别本页视频。';
  return '先在本页播放视频，或手动粘贴 m3u8 链接。';
}

function renderCandidates() {
  els.sourceTitle.textContent = sourceTitleText();
  els.emptyHint.textContent = emptyHintText();
  els.candidates.replaceChildren();
  els.candidateCount.textContent = String(state.candidates.length);
  // 站点页的那一条是「当前页面本身」，清了也会被刷新回来，直接禁用更诚实
  els.clear.disabled = state.candidates.length === 0 || Boolean(state.site);

  if (state.candidates.length === 0) {
    els.emptyHint.classList.remove('hidden');
    return;
  }
  els.emptyHint.classList.add('hidden');

  const fragment = document.createDocumentFragment();
  state.candidates.forEach((candidate, index) => {
    const row = makeElement('label', 'candidate');
    row.dataset.url = candidate.url;

    const radio = document.createElement('input');
    radio.type = 'radio';
    radio.name = 'candidate';
    radio.value = candidate.url;
    radio.checked = index === 0;

    const urlText = makeElement('span', 'candidate-url', candidate.url);
    urlText.title = candidate.url;

    const copyBtn = makeElement('button', 'btn ghost tiny', '复制');
    copyBtn.type = 'button';
    copyBtn.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      void copyText(candidate.url, copyBtn);
    });

    row.append(radio, urlText, copyBtn);
    fragment.appendChild(row);
  });
  els.candidates.appendChild(fragment);
  updateSelectedRow();
}

function updateSelectedRow() {
  const checked = els.candidates.querySelector('input[name="candidate"]:checked');
  const selectedUrl = checked ? checked.value : '';
  for (const row of els.candidates.querySelectorAll('.candidate')) {
    row.classList.toggle('selected', row.dataset.url === selectedUrl);
  }
}

function selectedCandidateUrl() {
  const checked = els.candidates.querySelector('input[name="candidate"]:checked');
  return checked && checked.value ? String(checked.value) : '';
}

function resolveTargetUrl() {
  const manual = els.manualUrl.value.trim();
  if (manual) return manual;
  return selectedCandidateUrl();
}

async function copyText(text, button) {
  const original = button.textContent;
  try {
    if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
      await navigator.clipboard.writeText(text);
    } else {
      throw new Error('clipboard unavailable');
    }
    button.textContent = '已复制';
  } catch {
    try {
      const textarea = document.createElement('textarea');
      textarea.value = text;
      textarea.style.position = 'fixed';
      textarea.style.top = '-1000px';
      textarea.style.opacity = '0';
      document.body.appendChild(textarea);
      textarea.select();
      const ok = document.execCommand('copy');
      textarea.remove();
      if (!ok) throw new Error('copy command failed');
      button.textContent = '已复制';
    } catch {
      setStatus('复制失败，请手动选中链接复制。', 'error');
      return;
    }
  }
  setTimeout(() => {
    button.textContent = original;
  }, 1200);
}

// ---- 标签页 / 设置 ----------------------------------------------------------

async function loadActiveTab() {
  const query = async (extra) => {
    try {
      const tabs = await chrome.tabs.query({ active: true, ...extra });
      return (tabs && tabs[0]) || null;
    } catch {
      return null;
    }
  };
  // 弹窗里 currentWindow 的语义在不同版本上略有差异，优先 lastFocusedWindow，再兜底 currentWindow。
  state.tab = (await query({ lastFocusedWindow: true })) || (await query({ currentWindow: true }));
  if (state.tab) {
    const url = state.tab.url || '';
    const host = safeHost(url);
    els.tabInfo.textContent = host ? `当前标签页：${host}` : '当前标签页：地址不可用';
    els.tabInfo.title = url;
    state.site = detectSite(url);
  } else {
    els.tabInfo.textContent = '当前标签页：不可用';
    state.site = null;
  }
}

// ---- 站点视频（B 站等） ------------------------------------------------------

function siteSummary(site) {
  const parsed = (site && site.parsed) || {};
  const bits = [];
  if (parsed.awemeId) {
    bits.push(`作品号 ${parsed.awemeId}`);
  } else if (parsed.kind === 'feed') {
    bits.push('当前信息流（取页面正在播放的那条）');
  } else if (parsed.kind === 'page') {
    bits.push('当前页面（取正在播放的视频）');
  } else if (parsed.kind === 'short') {
    bits.push('短链接（下载时自动展开）');
  } else if (parsed.vid) {
    bits.push(`视频号 ${parsed.vid}`);
    if (parsed.cid) bits.push(`专辑 ${parsed.cid}`);
  } else if (parsed.kind === 'cover') {
    bits.push('专辑 / 剧集页：请点开具体某一集再下载');
  } else if (parsed.bvid || parsed.aid) {
    bits.push(parsed.bvid ? `视频号 ${parsed.bvid}` : `av${parsed.aid}`);
    if (parsed.page > 1) bits.push(`第 ${parsed.page} P`);
  } else if (parsed.kind === 'bangumi') {
    bits.push('番剧页，暂不支持');
  }
  bits.push(site && site.id === 'youku' ? 'HLS 分片' : '完整 MP4');
  return bits.join(' · ');
}

/**
 * 本页是站点视频时，用一条「合成候选」代表它：
 * 这样来源卡的标题/列表/复制/开始下载全部复用同一套逻辑，
 * 不需要为站点单独做一块 UI。
 */
function siteCandidate(tab) {
  if (!tab || !tab.url) return null;
  const site = detectSite(tab.url);
  if (!site) return null;
  return { url: tab.url, site: site.id, siteLabel: site.label, parsed: site.parsed };
}

async function openSiteDownloader(url, title) {
  const params = new URLSearchParams();
  params.set('url', url);
  if (title) params.set('title', title);
  const target = chrome.runtime.getURL('downloader/downloader.html') + '?' + params.toString();
  await chrome.tabs.create({ url: target });
}

async function loadCandidates() {
  if (!state.tab || !Number.isInteger(state.tab.id)) {
    state.candidates = [];
    renderCandidates();
    return;
  }
  // 站点页：本页只有一条「视频链接」，不需要向后台要 m3u8 候选
  if (state.site) {
    const candidate = siteCandidate(state.tab);
    state.candidates = candidate ? [candidate] : [];
    renderCandidates();
    return;
  }
  try {
    const response = await sendMessage({ type: 'GET_CANDIDATES', tabId: state.tab.id });
    state.candidates = Array.isArray(response.candidates) ? response.candidates : [];
  } catch (err) {
    state.candidates = [];
    setStatus(`读取候选链接失败：${err.message || err}`, 'error');
  }
  renderCandidates();
}

async function loadSettings() {
  try {
    const response = await sendMessage({ type: 'GET_SETTINGS' });
    applySettings(response.settings);
  } catch {
    applySettings({ concurrency: 16, format: 'mp4' });
  }
}

function applySettings(settings) {
  const concurrency = clampInt(settings && settings.concurrency, 16, 1, 64);
  const format = settings && settings.format === 'ts' ? 'ts' : 'mp4';
  els.concurrency.value = String(concurrency);
  els.format.value = format;
}

async function saveSettings() {
  const settings = {
    concurrency: clampInt(els.concurrency.value, 16, 1, 64),
    format: els.format.value === 'ts' ? 'ts' : 'mp4',
  };
  els.concurrency.value = String(settings.concurrency);
  try {
    await sendMessage({ type: 'SET_SETTINGS', settings });
  } catch (err) {
    console.warn('[HLS] 保存设置失败：', err);
  }
  return settings;
}

// ---- 手动解析 --------------------------------------------------------------

function renderProbeSite(url, site) {
  els.probeResult.classList.remove('hidden');
  const title = makeElement('div', 'probe-title', `${site.label}视频页`);
  const note = makeElement('div', 'probe-note', siteSummary(site));
  const urlNode = makeElement('div', 'probe-note', url);
  els.probeResult.replaceChildren(title, note, urlNode);
}

function renderProbeLoading(url) {
  els.probeResult.classList.remove('hidden');
  els.probeResult.replaceChildren(
    makeElement('div', 'probe-title', '正在解析播放列表…'),
    makeElement('div', 'probe-error', url)
  );
}

function renderProbeError(url, message) {  els.probeResult.classList.remove('hidden');
  const title = makeElement('div', 'probe-title error', '解析失败');
  const error = makeElement('div', 'probe-error', message);
  const urlNode = makeElement('div', 'probe-note', url);
  els.probeResult.replaceChildren(title, error, urlNode);
}

function addProbeItem(grid, label, value) {
  const item = makeElement('div', 'probe-item');
  item.append(makeElement('span', null, label), makeElement('b', null, value));
  grid.appendChild(item);
}

function describeVariants(variants) {
  if (!Array.isArray(variants) || variants.length === 0) return '—';
  const sorted = variants.slice().sort((a, b) => (b.bandwidth || 0) - (a.bandwidth || 0));
  const top = sorted.slice(0, 3).map((variant) => {
    const resolution = variant.resolution || '未知';
    return `${resolution}@${formatBandwidth(variant.bandwidth)}`;
  });
  const more = sorted.length > 3 ? ` 等 ${sorted.length} 档` : '';
  return top.join(' / ') + more;
}

function renderProbeInfo(url, info) {
  els.probeResult.classList.remove('hidden');
  const title = makeElement('div', 'probe-title', '播放列表信息');
  const grid = makeElement('div', 'probe-grid');
  addProbeItem(grid, '片段数', String(info.segments ?? '—'));
  addProbeItem(grid, '总时长', formatDuration(info.durationSeconds));
  addProbeItem(grid, '加密', info.encrypted ? (info.encryptionMethods && info.encryptionMethods.length ? info.encryptionMethods.join(' / ') : '已加密') : '未加密');
  addProbeItem(grid, '类型', info.isMaster ? '多码率 Master' : info.isLive ? '直播（无 ENDLIST）' : '点播 VOD');
  if (info.isMaster && info.variants && info.variants.length) {
    const variantItem = makeElement('div', 'probe-item');
    variantItem.style.gridColumn = '1 / -1';
    variantItem.append(makeElement('span', null, '清晰度档位'), makeElement('b', null, describeVariants(info.variants)));
    grid.appendChild(variantItem);
  }
  els.probeResult.replaceChildren(title, grid);

  if (info.isLive) {
    els.probeResult.appendChild(makeElement('div', 'probe-note', '该播放列表没有 ENDLIST，可能是直播流；直播录制可能不完整。'));
  }
  if (info.finalUrl && info.finalUrl !== url) {
    els.probeResult.appendChild(makeElement('div', 'probe-note', `实际解析地址：${info.finalUrl}`));
  }
}

async function handleProbe() {
  if (state.probing) return;
  const url = resolveTargetUrl();
  if (!url) {
    setStatus('请先选择检测到的链接，或粘贴 m3u8 链接。', 'warn');
    return;
  }
  if (!/^https?:\/\//i.test(url)) {
    setStatus('链接格式不正确，需要以 http:// 或 https:// 开头。', 'error');
    return;
  }
  const site = detectSite(url);
  if (site) {
    renderProbeSite(url, site);
    setStatus(`这是${site.label}视频页，点击“开始下载”可直接保存整段 MP4。`, 'ok');
    return;
  }
  state.probing = true;
  els.probe.disabled = true;
  els.probe.textContent = '解析中…';
  setStatus('正在解析播放列表…', 'info');
  renderProbeLoading(url);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 45000);
  try {
    const info = await probePlaylist(url, {
      signal: controller.signal,
      onLog: (level, message) => {
        if (level === 'error') console.warn('[HLS probe]', message);
      },
    });
    state.lastProbe = { url, info };
    renderProbeInfo(url, info);
    setStatus('解析完成。点击“开始下载”继续。', 'ok');
  } catch (err) {
    state.lastProbe = null;
    const message = err && err.name === 'AbortError' ? '解析超时或已取消' : (err && err.message) || String(err);
    renderProbeError(url, message);
    setStatus(`解析失败：${message}`, 'error');
  } finally {
    clearTimeout(timer);
    state.probing = false;
    els.probe.disabled = false;
    els.probe.textContent = '解析';
  }
}

// ---- 开始下载 --------------------------------------------------------------

async function handleStart() {
  let url = resolveTargetUrl();
  // 站点页上没有手输/候选时，底部按钮直接理解为「下载本页视频」
  if (!url && state.site && state.tab && state.tab.url) {
    url = state.tab.url;
  }
  if (!url) {
    setStatus('请先选择或粘贴 m3u8 链接。', 'warn');
    return;
  }
  if (!/^https?:\/\//i.test(url)) {
    setStatus('链接格式不正确，需要以 http:// 或 https:// 开头。', 'error');
    return;
  }
  const site = detectSite(url);
  if (site) {
    if (site.parsed.kind === 'bangumi') {
      setStatus('番剧、影视等 PGC 内容暂不支持下载。', 'warn');
      return;
    }
    if (site.parsed.kind === 'cover') {
      setStatus('这是专辑 / 剧集页，请先点开具体某一集（让地址里带上视频号）再下载。', 'warn');
      return;
    }
    try {
      await openSiteDownloader(url, state.tab && state.tab.title);
      setStatus('已打开下载页面。', 'ok');
    } catch (err) {
      setStatus(`打开下载页面失败：${(err && err.message) || err}`, 'error');
    }
    return;
  }
  const settings = await saveSettings();
  const query = buildDownloaderQuery({
    url,
    format: settings.format,
    concurrency: settings.concurrency,
    title: state.tab && state.tab.title,
  });
  const target = chrome.runtime.getURL('downloader/downloader.html') + '?' + query;
  try {
    await chrome.tabs.create({ url: target });
    setStatus('已打开下载页面。', 'ok');
  } catch (err) {
    setStatus(`打开下载页面失败：${(err && err.message) || err}`, 'error');
  }
}

// ---- 初始化 ----------------------------------------------------------------

function bindEvents() {
  els.refresh.addEventListener('click', () => {
    void (async () => {
      els.refresh.disabled = true;
      try {
        // 站点页连标签页一起重读：链接可能已经换了一个视频
        await loadActiveTab();
        await loadCandidates();
        setStatus(state.site ? `已识别为${state.site.label}视频。` : '已刷新。', 'info');
      } finally {
        els.refresh.disabled = false;
      }
    })();
  });

  els.clear.addEventListener('click', async () => {
    state.candidates = [];
    if (!state.site) {
      if (!state.tab || !Number.isInteger(state.tab.id)) {
        renderCandidates();
        return;
      }
      try {
        await sendMessage({ type: 'CLEAR_CANDIDATES', tabId: state.tab.id });
      } catch (err) {
        setStatus(`清空失败：${(err && err.message) || err}`, 'error');
      }
    }
    renderCandidates();
    setStatus('已清空。', 'ok');
  });

  els.candidates.addEventListener('change', (event) => {
    const target = event.target;
    if (target && target.name === 'candidate') {
      // 选择候选链接时清空手动输入，保持单一来源。
      els.manualUrl.value = '';
      updateSelectedRow();
      setStatus('', 'info');
    }
  });

  els.manualUrl.addEventListener('input', () => {
    if (els.manualUrl.value.trim()) {
      const radios = els.candidates.querySelectorAll('input[name="candidate"]');
      for (const radio of radios) radio.checked = false;
      updateSelectedRow();
    }
  });

  els.probe.addEventListener('click', () => {
    void handleProbe();
  });

  els.manualUrl.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      void handleProbe();
    }
  });

  els.start.addEventListener('click', () => {
    void handleStart();
  });

  // 设置变化立即持久化，避免用户直接关弹窗丢失。
  els.concurrency.addEventListener('change', () => {
    void saveSettings();
  });
  els.format.addEventListener('change', () => {
    void saveSettings();
  });
}

async function init() {
  bindEvents();
  await loadSettings();
  await loadActiveTab();
  await loadCandidates();
  if (state.site) {
    setStatus(`已识别为${state.site.label}视频：点击「开始下载」保存整段 MP4。`, 'info');
  }
}

void init();
