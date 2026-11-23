/**
 * 统一错误 / 取消处理。
 * 仅使用标准 Web API（DOMException 在浏览器与 Node 20 均为全局对象）。
 */

/** 创建一个名为 AbortError 的取消异常（与 fetch 取消的形态一致）。 */
export function abortError(message = '已取消') {
  if (typeof DOMException === 'function') {
    return new DOMException(message, 'AbortError');
  }
  const err = new Error(message);
  err.name = 'AbortError';
  return err;
}

/** 是否为取消异常。 */
export function isAbortError(err) {
  return !!err && typeof err === 'object' && err.name === 'AbortError';
}

/** signal 已取消时立即抛出 AbortError。 */
export function throwIfAborted(signal) {
  if (signal && signal.aborted) throw abortError();
}

/** 带中文 message 的核心错误。 */
export function hlsError(message, cause) {
  const err = new Error(message);
  if (cause !== undefined) err.cause = cause;
  return err;
}
