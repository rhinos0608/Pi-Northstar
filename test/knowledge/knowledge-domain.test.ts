import assert from 'node:assert/strict';
import { test } from 'node:test';
import { capableProvidersFor, selectAutoProviders } from '../../src/knowledge/knowledge-domain.js';

// ── Slice 1: internal capability introspection + omitted auto selection ──

test('capable providers list search/enhance/analyze_text capability', () => {
  for (const action of ['search', 'enhance', 'analyze_text'] as const) {
    const capable = capableProvidersFor(action);
    assert.ok(capable.includes('diffbot'), action);
  }
});

test('omitted providers picks highest-priority capable configured provider first', () => {
  const ordered = selectAutoProviders('search', ['diffbot']);
  assert.equal(ordered[0], 'diffbot');
});

// ── Slice 2: explicit allowlist → concurrent runnable + typed partitions ──

test('explicit mismatch yields unsupported_option partition while capable runs', async () => {
  const { planExplicitProviders, runKgFanout } = await import('../../src/knowledge/knowledge-domain.js');
  const plan = planExplicitProviders('search', ['diffbot', 'unknown-provider'], {
    configured: ['diffbot'],
  });
  assert.deepEqual(plan.runnable, ['diffbot']);
  assert.equal(plan.unsupported.length, 1);
  assert.equal(plan.unsupported[0]?.code, 'unsupported_option');
  assert.equal(plan.unsupported[0]?.provider, 'unknown-provider');
  const outcomes = await runKgFanout(async (provider) => ({ provider, entities: [] }), plan.runnable);
  assert.equal(outcomes.length, 1);
  assert.equal(outcomes[0]?.provider, 'diffbot');
});

test('explicit fanout never expands beyond requested providers and respects cap', async () => {
  const { planExplicitProviders } = await import('../../src/knowledge/knowledge-domain.js');
  const plan = planExplicitProviders('search', ['diffbot', 'extra-a', 'extra-b'], {
    configured: ['diffbot'],
    maxProviders: 2,
  });
  assert.deepEqual(plan.runnable, ['diffbot']);
  assert.ok(plan.unsupported.every((error) => error.code === 'unsupported_option'));
  assert.deepEqual(
    plan.unsupported.map((error) => error.provider),
    ['extra-a', 'extra-b'],
  );
  const partitioned = new Set(plan.unsupported.map((error) => error.provider));
  for (const name of plan.runnable) assert.ok(!partitioned.has(name));
  for (const badMax of [0, -1, 9, 2.5, Number.NaN]) {
    assert.throws(
      () => planExplicitProviders('search', ['diffbot'], { configured: ['diffbot'], maxProviders: badMax }),
      (err: unknown) => err instanceof Error && (err as { code?: string }).code === 'unsupported_option',
    );
  }
});

// ── Slice 3: omitted auto sequential retryable-only fallback ──

test('auto fallback advances only on recoverable error codes, stops on success', async () => {
  const { runKgAuto } = await import('../../src/knowledge/knowledge-domain.js');
  const calls: string[] = [];
  const result = await runKgAuto(
    async (provider: string) => {
      calls.push(provider);
      if (provider === 'first') {
        return {
          provider,
          error: { code: 'transport_invalid_response' as const, message: 'down', retryable: true },
        };
      }
      return { provider, entities: [] };
    },
    ['first', 'second'],
  );
  assert.deepEqual(calls, ['first', 'second']);
  assert.equal(result.outcome.provider, 'second');
  assert.deepEqual(result.attempted, ['first', 'second']);
});

test('auto fallback never advances on terminal error codes', async () => {
  const { runKgAuto } = await import('../../src/knowledge/knowledge-domain.js');
  const calls: string[] = [];
  const result = await runKgAuto(
    async (provider: string) => {
      calls.push(provider);
      return {
        provider,
        error: { code: 'unsupported_option' as const, message: 'nope', retryable: false },
      };
    },
    ['first', 'second'],
  );
  assert.deepEqual(calls, ['first']);
  assert.equal(result.outcome.provider, 'first');
});

// ── Slice 4: single-provider cursor pin/version/fingerprint, no fanout cursor ──

test('single-provider cursor issues, pins provider/version/fingerprint', async () => {
  const { fingerprintKgRequest, issueKgCursor, decodePinnedKgCursor } = await import(
    '../../src/knowledge/knowledge-domain.js'
  );
  const fingerprint = fingerprintKgRequest({ action: 'search', query: 'type:Person', limit: 10 });
  assert.equal(fingerprint, fingerprintKgRequest({ limit: 10, query: 'type:Person', action: 'search' }));
  const cursor = issueKgCursor({
    provider: 'diffbot',
    fingerprint,
    adapterCursorV: 1,
    state: { from: 10 },
    fanout: false,
  });
  assert.ok(typeof cursor === 'string');
  const decoded = decodePinnedKgCursor(cursor, {
    provider: 'diffbot',
    fingerprint,
    adapterCursorV: 1,
  });
  assert.equal(decoded.provider, 'diffbot');
  assert.throws(
    () => decodePinnedKgCursor(cursor, { provider: 'other', fingerprint, adapterCursorV: 1 }),
    /cursor/i,
  );
  assert.throws(
    () => decodePinnedKgCursor(cursor, { provider: 'diffbot', fingerprint: 'tampered', adapterCursorV: 1 }),
    /cursor/i,
  );
  assert.throws(
    () => decodePinnedKgCursor(cursor, { provider: 'diffbot', fingerprint, adapterCursorV: 99 }),
    /cursor/i,
  );
});

test('explicit fanout never issues cursor; cursor with explicit providers rejected', async () => {
  const { issueKgCursor, rejectCursorForExplicitFanout } = await import('../../src/knowledge/knowledge-domain.js');
  assert.equal(
    issueKgCursor({
      provider: 'diffbot',
      fingerprint: 'fp',
      adapterCursorV: 1,
      state: {},
      fanout: true,
    }),
    undefined,
  );
  try {
    rejectCursorForExplicitFanout('cursor-token', ['diffbot', 'other']);
    assert.fail('expected pagination_not_supported');
  } catch (error) {
    assert.equal((error as { code?: string }).code, 'pagination_not_supported');
  }
  rejectCursorForExplicitFanout(undefined, ['diffbot']);
});

test('isRecoverableKgOutcome treats contract/semantic failures as failoverable without paid retry', async () => {
  const { isRecoverableKgOutcome } = await import('../../src/knowledge/knowledge-domain.js');
  for (const code of ['transport_invalid_response', 'contract_invalid_response', 'semantic_invalid_response'] as const) {
    const outcome = { provider: 'diffbot', entities: [], invalid: 0, error: { code, message: 'bad', retryable: false } };
    assert.equal(isRecoverableKgOutcome(outcome), true, code);
  }
});

test('isRecoverableKgOutcome keeps terminal errors non-recoverable and all-invalid rows failoverable', async () => {
  const { isRecoverableKgOutcome } = await import('../../src/knowledge/knowledge-domain.js');
  for (const code of ['upstream_error', 'response_too_large', 'invalid_input', 'unsupported_option'] as const) {
    const outcome = { provider: 'diffbot', entities: [], invalid: 0, error: { code, message: 'no', retryable: false } };
    assert.equal(isRecoverableKgOutcome(outcome), false, code);
  }
  assert.equal(isRecoverableKgOutcome({ provider: 'diffbot', entities: [], invalid: 2 }), true);
  assert.equal(isRecoverableKgOutcome({ provider: 'diffbot', entities: [], invalid: 0 }), false);
});
test('cursor with empty explicit allowlist is rejected, omitted providers allow cursor', async () => {
  const { rejectCursorForExplicitFanout } = await import('../../src/knowledge/knowledge-domain.js');
  try {
    rejectCursorForExplicitFanout('cursor-token', []);
    assert.fail('expected pagination_not_supported');
  } catch (error) {
    assert.equal((error as { code?: string }).code, 'pagination_not_supported');
  }
  rejectCursorForExplicitFanout('cursor-token', undefined);
  rejectCursorForExplicitFanout(undefined, []);
});
