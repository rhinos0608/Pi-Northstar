import assert from 'node:assert/strict';
import { test } from 'node:test';
import { retryWithBackoff } from '../src/retry.js';

const retryableError = (message = 'fetch failed: boom'): Error => new Error(message);

test('abort during sleep rejects promptly with no leaked timer', async () => {
  let created = 0;
  let cleared = 0;
  const origSetTimeout = globalThis.setTimeout;
  const origClearTimeout = globalThis.clearTimeout;
  globalThis.setTimeout = ((...args: Parameters<typeof setTimeout>) => {
    created++;
    return (origSetTimeout as (...a: unknown[]) => unknown)(...args) as ReturnType<typeof setTimeout>;
  }) as typeof setTimeout;
  globalThis.clearTimeout = ((...args: Parameters<typeof clearTimeout>) => {
    cleared++;
    return (origClearTimeout as (...a: unknown[]) => unknown)(...args) as ReturnType<typeof clearTimeout>;
  }) as typeof clearTimeout;
  try {
    let calls = 0;
    const controller = new AbortController();
    const pending = retryWithBackoff(
      async () => {
        calls++;
        throw retryableError();
      },
      { maxAttempts: 3, initialDelayMs: 5_000, maxDelayMs: 5_000, signal: controller.signal },
    );
    const settled = await Promise.allSettled([
      pending,
      (async () => {
        await new Promise((resolve) => origSetTimeout(resolve, 10));
        controller.abort();
      })(),
    ]);
    // Re-measure with a fresh controller to assert prompt rejection directly.
    const c2 = new AbortController();
    const t0 = Date.now();
    const p2 = retryWithBackoff(
      async () => {
        throw retryableError();
      },
      { maxAttempts: 3, initialDelayMs: 5_000, maxDelayMs: 5_000, signal: c2.signal },
    );
    origSetTimeout(() => c2.abort(), 10);
    await assert.rejects(() => p2);
    const elapsed = Date.now() - t0;
    assert.ok(elapsed < 50, `abort rejection took ${elapsed}ms, expected <50ms`);
    assert.equal(calls, 1, 'fn runs once; abort interrupts sleep before retry');
    assert.equal(created, cleared, `leaked timer: created=${created} cleared=${cleared}`);
    assert.equal(settled[0]?.status, 'rejected', 'first pending rejects on abort');
  } finally {
    globalThis.setTimeout = origSetTimeout;
    globalThis.clearTimeout = origClearTimeout;
  }
});

test('abort-before-start rejects immediately without calling fn', async () => {
  const controller = new AbortController();
  controller.abort();
  let calls = 0;
  const t0 = Date.now();
  await assert.rejects(() =>
    retryWithBackoff(
      async () => {
        calls++;
        return 'ok';
      },
      { signal: controller.signal },
    ),
  );
  assert.ok(Date.now() - t0 < 50, 'aborted-before-start must reject immediately');
  assert.equal(calls, 0, 'fn must not run when already aborted');
});

test('no-signal behavior unchanged: retryable error retries then succeeds', async () => {
  let calls = 0;
  const result = await retryWithBackoff(
    async () => {
      calls++;
      if (calls === 1) throw retryableError('socket hang up');
      return 'ok';
    },
    { maxAttempts: 3, initialDelayMs: 1, maxDelayMs: 5 },
  );
  assert.equal(result, 'ok');
  assert.equal(calls, 2);
});

test('retryable classification unchanged: non-retryable fails fast, retryable exhausts', async () => {
  let fastCalls = 0;
  await assert.rejects(() =>
    retryWithBackoff(
      async () => {
        fastCalls++;
        throw new Error('permanent validation failure');
      },
      { maxAttempts: 3, initialDelayMs: 1, maxDelayMs: 5 },
    ),
  );
  assert.equal(fastCalls, 1, 'non-retryable error must not retry');

  let retryCalls = 0;
  await assert.rejects(() =>
    retryWithBackoff(
      async () => {
        retryCalls++;
        throw new Error('HTTP 503 unavailable');
      },
      { maxAttempts: 3, initialDelayMs: 1, maxDelayMs: 5 },
    ),
  );
  assert.equal(retryCalls, 3, 'retryable HTTP 5xx must exhaust maxAttempts');
});
