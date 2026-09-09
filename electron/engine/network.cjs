'use strict';

const DEFAULT_REQUEST_TIMEOUT_MS = 60000;
const DEFAULT_MAX_BYTES = 4 * 1024 * 1024;

function combinedSignal(parentSignal, timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(new Error(`Request timed out after ${timeoutMs} ms.`)), timeoutMs);
  const abort = () => controller.abort(parentSignal.reason || new Error('Request cancelled.'));
  if (parentSignal) {
    if (parentSignal.aborted) abort();
    else parentSignal.addEventListener('abort', abort, { once: true });
  }
  return {
    signal: controller.signal,
    dispose() {
      clearTimeout(timeout);
      if (parentSignal) parentSignal.removeEventListener('abort', abort);
    },
  };
}

async function fetchWithTimeout(url, options = {}, { timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS, signal } = {}) {
  const deadline = combinedSignal(signal, timeoutMs);
  try {
    const response = await fetch(url, { ...options, signal: deadline.signal });
    Object.defineProperty(response, '__budgetDispose', { value: deadline.dispose, configurable: true });
    return response;
  } catch (error) {
    deadline.dispose();
    if (deadline.signal.aborted) throw new Error(deadline.signal.reason?.message || 'Request cancelled.');
    throw error;
  }
}

async function readResponseBuffer(response, maxBytes = DEFAULT_MAX_BYTES) {
  try {
  const declared = Number(response.headers?.get?.('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) throw new Error(`Response exceeds the ${maxBytes}-byte limit.`);
  if (response.body && typeof response.body.getReader === 'function') {
    const reader = response.body.getReader();
    const chunks = [];
    let total = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => {});
        throw new Error(`Response exceeds the ${maxBytes}-byte limit.`);
      }
      chunks.push(Buffer.from(value));
    }
    return Buffer.concat(chunks, total);
  }
  const raw = typeof response.arrayBuffer === 'function'
    ? await response.arrayBuffer()
    : Buffer.from(await response.text(), 'utf8');
  const buffer = Buffer.from(raw);
  if (buffer.length > maxBytes) throw new Error(`Response exceeds the ${maxBytes}-byte limit.`);
  return buffer;
  } finally {
    response.__budgetDispose?.();
  }
}

async function readResponseText(response, maxBytes = DEFAULT_MAX_BYTES) {
  return (await readResponseBuffer(response, maxBytes)).toString('utf8');
}

async function readResponseJson(response, maxBytes = DEFAULT_MAX_BYTES) {
  if (!response.body && typeof response.arrayBuffer !== 'function' && typeof response.text !== 'function' && typeof response.json === 'function') {
    try {
      const value = await response.json();
      if (Buffer.byteLength(JSON.stringify(value), 'utf8') > maxBytes) throw new Error(`Response exceeds the ${maxBytes}-byte limit.`);
      return value;
    } finally {
      response.__budgetDispose?.();
    }
  }
  return JSON.parse(await readResponseText(response, maxBytes));
}

function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new Error(signal.reason?.message || 'Operation cancelled.'));
    const onAbort = () => {
      clearTimeout(timer);
      reject(new Error(signal.reason?.message || 'Operation cancelled.'));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

module.exports = { fetchWithTimeout, readResponseBuffer, readResponseText, readResponseJson, combinedSignal, sleep, DEFAULT_REQUEST_TIMEOUT_MS, DEFAULT_MAX_BYTES };
