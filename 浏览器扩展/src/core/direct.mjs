/**
 * 直链下载核心（站点适配器用）。
 *
 * 与 HLS 核心的区别：源站已经给了一个完整的 MP4，**不需要**解复用与重新封装，
 * 因此这里只做「取字节 → 顺序写盘 → 进度 / 取消 / 重试」。
 *
 * 两种取字节方式：
 *   stream —— 扩展页直接 fetch，边下边写（快，但必须能通过源站的 Referer/UA 校验）；
 *   range  —— 由调用方注入 fetchChunk（例如经 B 站标签页代理），按固定大小分块取，
 *             每块单独重试，适合无法直连的场景。
 */

const DEFAULT_TIMEOUT_MS = 60000;
const DEFAULT_RETRIES = 3;
const DEFAULT_CHUNK_SIZE = 4 * 1024 * 1024;
const MAX_CHUNKS = 200000;

/** 源站因为 Referer / Cookie / 签名校验拒绝了请求（可降级到代理模式） */
export class DirectFetchError extends Error {
  constructor(message, status) {
    super(message);
    this.name = 'DirectFetchError';
    this.status = status;
  }
}

export function isBlockedError(err) {
  return err instanceof DirectFetchError && (err.status === 401 || err.status === 403);
}

function abortError() {
  const err = new Error('已取消');
  err.name = 'AbortError';
  return err;
}

function throwIfAborted(signal) {
  if (signal && signal.aborted) throw abortError();
}

function round(value, digits = 2) {
  if (!Number.isFinite(value)) return 0;
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

/** 单次请求（可取消 + 超时） */
async function requestOnce(url, { signal, timeoutMs, headers }) {
  throwIfAborted(signal);
  const controller = new AbortController();
  const onAbort = () => controller.abort();
  if (signal) signal.addEventListener('abort', onAbort, { once: true });
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { signal: controller.signal, headers, credentials: 'omit' });
  } catch (err) {
    if (signal && signal.aborted) throw abortError();
    if (err && err.name === 'AbortError') throw new DirectFetchError(`请求超时（${Math.round(timeoutMs / 1000)}s）`, 0);
    throw new DirectFetchError(`网络请求失败：${err && err.message ? err.message : String(err)}`, 0);
  } finally {
    clearTimeout(timer);
    if (signal) signal.removeEventListener('abort', onAbort);
  }
}

function makeResult(bytes, options, startedAt) {
  return {
    bytes,
    durationSeconds: Number(options.durationSeconds) || 0,
    width: Number(options.width) || 0,
    height: Number(options.height) || 0,
    sampleRate: 0,
    channels: 0,
    // 源文件自带音视频轨，不走封装流程
    muxed: false,
    alreadyMuxed: true,
    moovFront: false,
    segments: 1,
    videoBytes: bytes,
    audioBytes: 0,
    elapsedMs: Date.now() - startedAt,
  };
}

/**
 * 下载直链。
 * @param {object} options
 * @param {string} options.url 主地址
 * @param {string[]} [options.backupUrls] 备用镜像
 * @param {number} [options.sizeBytes] 期望大小（Range 模式必填；Stream 模式用于进度）
 * @param {number} [options.durationSeconds]
 * @param {number} [options.width]
 * @param {number} [options.height]
 * @param {{write:(chunk:Uint8Array, position?:number)=>Promise<void>}} options.output
 * @param {AbortSignal} [options.signal]
 * @param {'auto'|'stream'|'range'} [options.mode]
 * @param {(url:string, range:{start:number,end:number}, ctx:{signal:AbortSignal})=>Promise<Uint8Array>} [options.fetchChunk]
 * @param {number} [options.chunkSize]
 * @param {number} [options.retries]
 * @param {number} [options.timeoutMs]
 * @param {(level:string,message:string)=>void} [options.onLog]
 * @param {(progress:object)=>void} [options.onProgress]
 */
export async function downloadDirect(options = {}) {
  const startedAt = Date.now();
  const url = options.url;
  if (!url) throw new Error('缺少下载地址');
  const output = options.output;
  if (!output || typeof output.write !== 'function') throw new Error('缺少 output.write');
  const signal = options.signal;
  const onLog = typeof options.onLog === 'function' ? options.onLog : () => {};
  const onProgress = typeof options.onProgress === 'function' ? options.onProgress : () => {};
  const mode = options.mode || 'auto';
  const retries = Number.isFinite(options.retries) ? options.retries : DEFAULT_RETRIES;
  const timeoutMs = Number.isFinite(options.timeoutMs) ? options.timeoutMs : DEFAULT_TIMEOUT_MS;
  const chunkSize = Math.max(256 * 1024, options.chunkSize || DEFAULT_CHUNK_SIZE);
  const candidates = [url, ...(Array.isArray(options.backupUrls) ? options.backupUrls : [])].filter(Boolean);

  let written = 0;
  let total = Number(options.sizeBytes) > 0 ? Number(options.sizeBytes) : 0;
  let lastEmitAt = 0;

  const report = (patch = {}, force = false) => {
    const now = Date.now();
    if (!force && now - lastEmitAt < 200) return;
    lastEmitAt = now;
    const elapsed = Math.max(0.001, (now - startedAt) / 1000);
    const speed = written / elapsed;
    const pct = total > 0 ? Math.min(99.9, (written / total) * 100) : 0;
    const eta = total > 0 && speed > 0 ? Math.max(0, (total - written) / speed) : null;
    try {
      onProgress({
        phase: 'download',
        percent: round(pct, 2),
        segmentsDone: total > 0 && written >= total ? 1 : 0,
        segmentsTotal: 1,
        bytesDownloaded: written,
        speedBps: Math.round(speed),
        etaSeconds: eta == null ? null : round(eta, 1),
        message: '正在下载',
        ...patch,
      });
    } catch {
      /* 忽略回调异常 */
    }
  };

  const write = async (chunk) => {
    if (!chunk || !chunk.byteLength) return;
    await output.write(chunk);
    written += chunk.byteLength;
    report();
  };

  const finish = () => {
    report({ phase: 'done', percent: 100, segmentsDone: 1 }, true);
    return makeResult(written, options, startedAt);
  };

  throwIfAborted(signal);

  // ---------- 1) 直连流式 ----------
  if (mode === 'stream' || mode === 'auto') {
    let lastError = null;
    let blocked = false;
    for (const candidate of candidates) {
      try {
        onLog('info', '正在连接源站…');
        const res = await requestOnce(candidate, { signal, timeoutMs, headers: {} });
        if (res.status === 401 || res.status === 403) {
          throw new DirectFetchError(`源站拒绝访问（HTTP ${res.status}），需要带 Referer 的请求`, res.status);
        }
        if (!res.ok) throw new DirectFetchError(`源站返回 HTTP ${res.status}`, res.status);
        const len = Number(res.headers.get('content-length'));
        if (!total && Number.isFinite(len) && len > 0) total = len;
        report({}, true);
        if (res.body && typeof res.body.getReader === 'function') {
          const reader = res.body.getReader();
          const onAbort = () => {
            try {
              reader.cancel().catch(() => {});
            } catch {
              /* 忽略 */
            }
          };
          if (signal) signal.addEventListener('abort', onAbort, { once: true });
          try {
            for (;;) {
              throwIfAborted(signal);
              const { done, value } = await reader.read();
              if (done) break;
              await write(value);
            }
          } finally {
            if (signal) signal.removeEventListener('abort', onAbort);
          }
        } else {
          await write(new Uint8Array(await res.arrayBuffer()));
        }
        if (total > 0 && written !== total) {
          onLog('warn', `实际写入 ${written} 字节，与源站声明的大小 ${total} 不一致`);
        }
        return finish();
      } catch (err) {
        lastError = err;
        if (err && err.name === 'AbortError') throw err;
        if (isBlockedError(err)) {
          blocked = true;
          break;
        }
        onLog('warn', `直连失败：${err.message}`);
      }
    }
    if (blocked) {
      if (mode === 'stream' || typeof options.fetchChunk !== 'function') throw lastError;
      onLog('warn', '直连被源站拒绝（Referer 校验），改用标签页代理下载');
    } else if (mode === 'stream') {
      throw lastError || new Error('直连下载失败');
    }
  }

  // ---------- 2) 分块（经代理 / 直连 Range） ----------
  const fetchChunk = options.fetchChunk;
  if (typeof fetchChunk !== 'function') {
    throw new Error('无法直连源站，且未提供代理取字节的实现');
  }
  if (!total) throw new Error('缺少文件大小，无法分块下载');
  onLog('info', `开始分块下载：共 ${Math.ceil(total / chunkSize)} 块，每块 ${(chunkSize / 1048576).toFixed(1)} MB`);
  report({}, true);

  let offset = 0;
  let chunks = 0;
  while (offset < total) {
    throwIfAborted(signal);
    chunks += 1;
    if (chunks > MAX_CHUNKS) throw new Error('分块次数异常，已中止');
    const end = Math.min(offset + chunkSize, total) - 1;
    let bytes = null;
    let lastErr = null;
    for (let attempt = 0; attempt <= retries; attempt += 1) {
      try {
        bytes = await fetchChunk(url, { start: offset, end }, { signal });
        break;
      } catch (err) {
        lastErr = err;
        if (err && err.name === 'AbortError') throw err;
        if (attempt < retries) {
          const wait = 500 * 2 ** attempt;
          onLog('warn', `第 ${offset} 字节起的区块失败（${err.message}），${wait}ms 后重试`);
          await new Promise((r) => setTimeout(r, wait));
        }
      }
    }
    if (!bytes) throw lastErr || new Error('分块下载失败');
    if (!bytes.byteLength) break;
    await write(bytes);
    offset += bytes.byteLength;
  }

  if (offset !== total) onLog('warn', `下载字节数 ${offset} 与预期 ${total} 不一致`);
  return finish();
}
