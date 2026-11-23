/**
 * 带超时 / 重试 / 取消的 fetch 封装。
 * 只依赖标准 Web API（fetch / AbortController / TextDecoder），浏览器与 Node 20 均可用。
 */

import { abortError, throwIfAborted, hlsError } from './errors.mjs';

function linkAbort(outerSignal, controller) {
  if (!outerSignal) return () => {};
  if (outerSignal.aborted) {
    try { controller.abort(); } catch { /* ignore */ }
    return () => {};
  }
  const onAbort = () => {
    try { controller.abort(); } catch { /* ignore */ }
  };
  outerSignal.addEventListener('abort', onAbort, { once: true });
  return () => outerSignal.removeEventListener('abort', onAbort);
}

function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal && signal.aborted) {
      reject(abortError());
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(abortError());
    };
    const timer = setTimeout(() => {
      if (signal) signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    if (signal) signal.addEventListener('abort', onAbort, { once: true });
  });
}

/** 判断是否为可重试的 HTTP 状态码。 */
function isRetryableStatus(status) {
  return status >= 500 || status === 408 || status === 425 || status === 429;
}

/**
 * 下载一个 URL 的全部字节。
 * @param {string} url
 * @param {{signal?: AbortSignal, timeoutMs?: number, retries?: number,
 *          onLog?: Function, label?: string}} options
 * @returns {Promise<Uint8Array>}
 */
export async function fetchBytes(url, options = {}) {
  const {
    signal,
    timeoutMs = 30000,
    retries = 4,
    onLog,
    label = '资源',
  } = options;
  const attempts = Math.max(0, Number(retries) || 0) + 1;
  let lastError = null;

  for (let attempt = 0; attempt < attempts; attempt++) {
    throwIfAborted(signal);
    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      try { controller.abort(); } catch { /* ignore */ }
    }, timeoutMs);
    const unlink = linkAbort(signal, controller);
    try {
      let response;
      try {
        response = await fetch(url, {
          signal: controller.signal,
          cache: 'no-store',
          redirect: 'follow',
          credentials: 'omit',
        });
      } catch (err) {
        if (signal && signal.aborted) throw abortError();
        if (timedOut) throw hlsError(`${label}请求超时（${timeoutMs}ms）：${url}`);
        throw hlsError(`${label}网络请求失败：${err && err.message ? err.message : err}（${url}）`, err);
      }
      if (!response.ok) {
        const err = hlsError(`${label}请求失败：HTTP ${response.status}（${url}）`);
        err.httpStatus = response.status;
        err.retryable = isRetryableStatus(response.status);
        throw err;
      }
      let bytes;
      try {
        bytes = new Uint8Array(await response.arrayBuffer());
      } catch (err) {
        if (signal && signal.aborted) throw abortError();
        if (timedOut) throw hlsError(`${label}读取超时（${timeoutMs}ms）：${url}`);
        throw hlsError(`${label}数据读取失败：${err && err.message ? err.message : err}`, err);
      }
      if (bytes.length === 0) throw hlsError(`${label}内容为空（${url}）`);
      return bytes;
    } catch (err) {
      if (signal && signal.aborted) throw abortError();
      lastError = err;
      if (err && err.retryable === false) break;
      if (err && err.httpStatus && !isRetryableStatus(err.httpStatus)) break;
      if (attempt >= attempts - 1) break;
      const delay = Math.min(8000, 250 * 2 ** Math.min(attempt, 5)) + Math.round(Math.random() * 200);
      if (onLog) {
        onLog('warn', `${label}获取失败（第 ${attempt + 1}/${attempts} 次）：${err && err.message ? err.message : err}；${delay}ms 后重试`);
      }
      await sleep(delay, signal);
    } finally {
      clearTimeout(timer);
      unlink();
    }
  }
  if (lastError instanceof Error) throw lastError;
  throw hlsError(`${label}获取失败：${url}`);
}

/** 下载 URL 并解码为 UTF-8 文本。 */
export async function fetchText(url, options = {}) {
  const bytes = await fetchBytes(url, options);
  try {
    return new TextDecoder('utf-8').decode(bytes);
  } catch {
    return new TextDecoder('utf-8', { fatal: false }).decode(bytes);
  }
}
