export interface RetryOptions {
  maxAttempts?: number;
  initialDelayMs?: number;
  maxDelayMs?: number;
  backoffFactor?: number;
  signal?: AbortSignal;
}

export async function retryWithBackoff<T>(fn: () => Promise<T>, opts: RetryOptions = {}): Promise<T> {
  const signal = opts.signal;
  if (signal?.aborted) throw abortError(signal);
  const maxAttempts = Math.max(1, opts.maxAttempts ?? 2);
  const initialDelayMs = opts.initialDelayMs ?? 200;
  const maxDelayMs = opts.maxDelayMs ?? 2_000;
  const backoffFactor = opts.backoffFactor ?? 2;
  let lastError: unknown;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (error) {
      if (signal?.aborted) throw abortError(signal);
      lastError = error;
      if (attempt === maxAttempts || !isRetryable(error)) break;
      const delay = Math.floor(Math.random() * (Math.min(initialDelayMs * Math.pow(backoffFactor, attempt - 1), maxDelayMs) + 1));
      await sleep(delay, signal);
    }
  }

  throw lastError;
}

function isRetryable(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  if (error.name === 'AbortError' || error.name === 'TimeoutError') return true;
  return /timeout|etimedout|econnreset|econnrefused|enotfound|socket hang up|fetch failed|http 5\d\d/i.test(error.message);
}

function abortError(signal?: AbortSignal): unknown {
  if (signal?.reason !== undefined) return signal.reason;
  const error = new Error('Aborted');
  error.name = 'AbortError';
  return error;
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(abortError(signal));
  if (!signal) return new Promise((resolve) => setTimeout(resolve, ms));
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(abortError(signal));
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}
