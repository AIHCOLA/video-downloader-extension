// 下载页 / 弹窗共用的纯逻辑工具。
//
// 本模块不依赖 DOM、不依赖 chrome.* API，因此既能在扩展页面里被 import，
// 也能被 Node（`_extwork/shell-test/` 下的单测）直接 import 做单元测试。
// 所有函数必须是纯函数或只依赖传入参数。

/** 把任意值解析为 [min, max] 范围内的整数；无法解析时返回 fallback */
export function clampInt(value, fallback, min, max) {
  const n = Number.parseInt(String(value ?? ''), 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

/** 解析“秒”参数；空值 / 非法值返回 null */
export function parseSeconds(value) {
  if (value == null || String(value).trim() === '') return null;
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

/** 字节数 → 人类可读（0 显示 0 B） */
export function formatBytes(bytes) {
  const n = Number(bytes);
  if (!Number.isFinite(n) || n <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = n;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  const digits = unit === 0 ? 0 : value >= 100 ? 1 : 2;
  return `${value.toFixed(digits)} ${units[unit]}`;
}

/** 秒 → h:mm:ss / m:ss；空值 / 非法返回 — */
export function formatDuration(seconds) {
  if (seconds == null || String(seconds).trim() === '') return '—';
  const total = Number(seconds);
  if (!Number.isFinite(total) || total < 0) return '—';
  const s = Math.round(total);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
  return `${m}:${String(sec).padStart(2, '0')}`;
}

/** 字节/秒 → 速度文本 */
export function formatSpeed(bytesPerSecond) {
  const n = Number(bytesPerSecond);
  if (!Number.isFinite(n) || n <= 0) return '—';
  return `${formatBytes(n)}/s`;
}

/** 剩余秒数 → 中文 ETA 文本 */
export function formatEta(seconds) {
  const n = Number(seconds);
  if (!Number.isFinite(n) || n < 0) return '—';
  if (n < 60) return `${Math.max(1, Math.round(n))} 秒`;
  if (n < 3600) return `${Math.floor(n / 60)} 分 ${Math.round(n % 60)} 秒`;
  return formatDuration(n);
}

/** 码率（bit/s） → Mbps / kbps 文本 */
export function formatBandwidth(bitsPerSecond) {
  const n = Number(bitsPerSecond);
  if (!Number.isFinite(n) || n <= 0) return '—';
  if (n >= 1e6) return `${(n / 1e6).toFixed(2)} Mbps`;
  return `${Math.round(n / 1e3)} kbps`;
}

/** 统一错误文案 */
export function describeError(err) {
  if (!err) return '未知错误';
  if (typeof err === 'string') return err;
  return err.message || String(err);
}

/** 根据 m3u8 地址推导保存文件名：video_<id>.<mp4|ts>，规则固定可预期（E2E 依赖） */
export function buildFilename(url, outFormat) {
  const ext = outFormat === 'ts' ? 'ts' : 'mp4';
  let id = '';
  try {
    const parsed = new URL(url);
    const parts = parsed.pathname.split('/').filter(Boolean);
    for (let i = parts.length - 2; i >= 0; i -= 1) {
      if (!/^index(\.[a-z0-9]+)?$/i.test(parts[i])) {
        id = parts[i];
        break;
      }
    }
    if (id) {
      try {
        id = decodeURIComponent(id);
      } catch {
        /* 保持原值 */
      }
    }
    if (!id) id = parsed.hostname || 'video';
  } catch {
    id = 'video';
  }
  const safe = id.replace(/[^A-Za-z0-9_-]+/g, '_').slice(0, 60) || 'video';
  return `video_${safe}.${ext}`;
}

/** 解析 downloader 页 URL 参数（URLSearchParams 的 query string） */
export function parseDownloaderParams(search) {
  let params;
  try {
    params = new URLSearchParams(search || '');
  } catch {
    params = new URLSearchParams();
  }
  return {
    url: (params.get('url') || '').trim(),
    title: (params.get('title') || '').trim(),
    format: params.get('format') === 'ts' ? 'ts' : 'mp4',
    concurrency: clampInt(params.get('concurrency'), 16, 1, 64),
    start: parseSeconds(params.get('start')),
    end: parseSeconds(params.get('end')),
    autosave: params.get('autosave') === '1',
  };
}

/** 构造打开 downloader 页所需的 query string（弹窗使用，与 parseDownloaderParams 互逆） */
export function buildDownloaderQuery({ url, format, concurrency, title }) {
  const params = new URLSearchParams();
  if (url) params.set('url', url);
  params.set('format', format === 'ts' ? 'ts' : 'mp4');
  params.set('concurrency', String(clampInt(concurrency, 16, 1, 64)));
  if (title) params.set('title', title);
  return params.toString();
}

/**
 * 按 { position, data } 分片组装最终文件（Blob 降级 / autosave 模式使用）。
 *
 * MP4（fastStart:false）在 finalize 时会按绝对偏移回填文件头部 mdat 的 size，
 * 因此不能简单顺序拼接；先按 position 的最大“position + length”分配最终大小，
 * 再逐段按偏移写入即可。乱序的 position 也能正确处理。
 */
export function assemblePositionedChunks(chunks) {
  let size = 0;
  for (const chunk of chunks) {
    const end = chunk.position + chunk.data.byteLength;
    if (end > size) size = end;
  }
  const buffer = new Uint8Array(size);
  for (const chunk of chunks) buffer.set(chunk.data, chunk.position);
  return buffer;
}

export const PHASE_LABELS = {
  idle: '等待开始',
  probe: '解析播放列表',
  playlist: '解析播放列表',
  ready: '准备就绪',
  download: '下载分片',
  decrypt: '解密分片',
  mux: '封装 MP4',
  done: '下载完成',
  error: '下载失败',
  cancelled: '已取消',
  cancelling: '正在取消',
};

export function phaseLabel(phase) {
  return PHASE_LABELS[phase] || '处理中';
}
