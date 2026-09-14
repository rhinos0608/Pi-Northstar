import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  WebSearchLedger,
  FAILURE_BLOCK_MS,
  MAX_LEDGER_ACTIVE_SEARCHES,
  SUCCESS_SUPPRESS_MS,
  type LedgerFailureCode,
} from '../../src/web/web-search-ledger.js';

function ledgerAt(start: number) {
  let now = start;
  const ledger = new WebSearchLedger({ now: () => now });
  return { ledger, advance: (ms: number) => { now += ms; } };
}

describe('web-search-ledger: run and success suppression', () => {
  it('first begin runs, success suppresses exact repeat within TTL', () => {
    const { ledger } = ledgerAt(1_000_000);
    const first = ledger.begin(['hello world'], { limit: 8 });
    assert.equal(first.status, 'run');
    if (first.status !== 'run') throw new Error('expected run');
    ledger.completeSuccess(first.key);
    const second = ledger.begin(['hello world'], { limit: 8 });
    assert.equal(second.status, 'suppressed');
  });

  it('success suppression expires after 30 minutes', () => {
    const { ledger, advance } = ledgerAt(1_000_000);
    const first = ledger.begin(['hello world'], { limit: 8 });
    assert.equal(first.status, 'run');
    if (first.status !== 'run') throw new Error('expected run');
    ledger.completeSuccess(first.key);
    advance(SUCCESS_SUPPRESS_MS + 1);
    assert.equal(ledger.begin(['hello world'], { limit: 8 }).status, 'run');
  });

  it('different non-query options are not suppressed', () => {
    const { ledger } = ledgerAt(1_000_000);
    const first = ledger.begin(['hello world'], { limit: 8 });
    if (first.status !== 'run') throw new Error('expected run');
    ledger.completeSuccess(first.key);
    assert.equal(ledger.begin(['hello world'], { limit: 5 }).status, 'run');
  });
});

describe('web-search-ledger: in-flight coalescing', () => {
  it('concurrent exact duplicate coalesces onto one shared promise', async () => {
    const { ledger } = ledgerAt(2_000_000);
    const first = ledger.begin(['coalesce me'], { limit: 8 });
    assert.equal(first.status, 'run');
    const second = ledger.begin(['coalesce me'], { limit: 8 });
    assert.equal(second.status, 'coalesced');
    if (second.status !== 'coalesced') throw new Error('expected coalesced');
    if (first.status !== 'run') throw new Error('expected run');
    ledger.completeSuccess(first.key);
    await second.promise;
    // After success, later callers suppress rather than run.
    assert.equal(ledger.begin(['coalesce me'], { limit: 8 }).status, 'suppressed');
  });

  it('unicode-normalized duplicates coalesce in flight', async () => {
    const { ledger } = ledgerAt(2_000_000);
    const first = ledger.begin(['Caf\u00e9 search'], { limit: 8 });
    assert.equal(first.status, 'run');
    // NFC vs NFD forms of é must canonicalize identically.
    const second = ledger.begin(['Cafe\u0301 search'], { limit: 8 });
    assert.equal(second.status, 'coalesced');
    if (first.status === 'run') ledger.completeSuccess(first.key);
    if (second.status === 'coalesced') await second.promise;
  });

  it('coalesced follower receives the leader transient result', async () => {
    const { ledger } = ledgerAt(2_000_000);
    const first = ledger.begin(['shared result'], { limit: 8 });
    if (first.status !== 'run') throw new Error('expected run');
    const second = ledger.begin(['shared result'], { limit: 8 });
    if (second.status !== 'coalesced') throw new Error('expected coalesced');
    ledger.completeSuccess(first.key, 'LEADER_RESULT');
    assert.equal(await second.promise, 'LEADER_RESULT');
  });

  it('source distinguishes otherwise identical searches', () => {
    const { ledger } = ledgerAt(2_100_000);
    const first = ledger.begin(['sourced query'], { limit: 8 });
    if (first.status !== 'run') throw new Error('expected run');
    ledger.completeSuccess(first.key);
    const other = ledger.begin(['sourced query'], { limit: 8, source: 'arxiv' });
    assert.equal(other.status, 'run');
  });

  it('active cap bypasses tracking for new searches without evicting live entries', () => {
    const { ledger } = ledgerAt(2_200_000);
    const keys: string[] = [];
    for (let index = 0; index < MAX_LEDGER_ACTIVE_SEARCHES; index += 1) {
      const begun = ledger.begin([`live active search number ${index} zebra`], { limit: 8 });
      if (begun.status !== 'run') throw new Error(`expected run at ${index}`);
      keys.push(begun.key);
    }
    const extra = ledger.begin(['one more unique active search quokka'], { limit: 8 });
    assert.equal(extra.status, 'run');
    if (extra.status !== 'run') throw new Error('expected bypass run');
    // Live entries keep coalescing; none were evicted to make room.
    const follower = ledger.begin(['live active search number 0 zebra'], { limit: 8 });
    assert.equal(follower.status, 'coalesced');
    ledger.completeSuccess(keys[0]!);
    ledger.completeSuccess(extra.key);
  });

  it('untracked bypass completion records nothing (no empty fuzzy entry)', () => {
    const { ledger } = ledgerAt(2_300_000);
    const keys: string[] = [];
    for (let index = 0; index < MAX_LEDGER_ACTIVE_SEARCHES; index += 1) {
      const begun = ledger.begin([`untracked cap query number ${index} zebra`], { limit: 8 });
      if (begun.status !== 'run') throw new Error(`expected run at ${index}`);
      keys.push(begun.key);
    }
    const extra = ledger.begin(['untracked bypass query quokka'], { limit: 8 });
    assert.equal(extra.status, 'run');
    if (extra.status !== 'run') throw new Error('expected bypass run');
    // Untracked completion must not store a single:true entry with empty
    // tokens/options: the bypass query re-runs instead of suppressing.
    // (Free one tracked slot first: the cap check runs before the
    // exact/suppression lookup, so re-begin needs active < max.)
    ledger.completeSuccess(extra.key);
    ledger.completeSuccess(keys[0]!);
    // Tracked entries still record and suppress normally after the bypass.
    assert.equal(ledger.begin(['untracked cap query number 0 zebra'], { limit: 8 }).status, 'suppressed');
    const rebypass = ledger.begin(['untracked bypass query quokka'], { limit: 8 });
    assert.equal(rebypass.status, 'run');
    if (rebypass.status === 'run') ledger.cancel(rebypass.key);
    // Untracked failure likewise records nothing: no block is stored.
    // (Refill to cap so the failure probe bypasses tracking, then free a
    // slot so the re-begin reaches the exact/block lookup.)
    const filler = ledger.begin(['filler query wombat'], { limit: 8 });
    assert.equal(filler.status, 'run');
    const extraFail = ledger.begin(['untracked bypass failure quokka'], { limit: 8 });
    assert.equal(extraFail.status, 'run');
    if (extraFail.status !== 'run') throw new Error('expected bypass run');
    ledger.completeFailure(extraFail.key, { retryable: false, code: 'upstream_error' });
    if (filler.status === 'run') ledger.cancel(filler.key);
    assert.equal(ledger.begin(['untracked bypass failure quokka'], { limit: 8 }).status, 'run');
  });
});

describe('web-search-ledger: near-duplicate suppression', () => {
  it('token Jaccard >= 0.85 with same options suppresses', () => {
    const { ledger } = ledgerAt(3_000_000);
    // 6-token base plus one extra token: 6/7 ~= 0.857 >= 0.85.
    const first = ledger.begin(['alpha beta gamma delta epsilon zeta'], { limit: 8 });
    if (first.status !== 'run') throw new Error('expected run');
    ledger.completeSuccess(first.key);
    const dup = ledger.begin(['alpha beta gamma delta epsilon zeta extra'], { limit: 8 });
    assert.equal(dup.status, 'suppressed');
  });

  it('dissimilar queries do not suppress', () => {
    const { ledger } = ledgerAt(3_000_000);
    const first = ledger.begin(['alpha beta gamma delta epsilon zeta'], { limit: 8 });
    if (first.status !== 'run') throw new Error('expected run');
    ledger.completeSuccess(first.key);
    assert.equal(ledger.begin(['totally unrelated query about plumbing'], { limit: 8 }).status, 'run');
  });
});

describe('web-search-ledger: batch exact canonical match', () => {
  it('identical batch suppresses after success', () => {
    const { ledger } = ledgerAt(4_000_000);
    const first = ledger.begin(['alpha one', 'beta two'], { limit: 8 });
    if (first.status !== 'run') throw new Error('expected run');
    ledger.completeSuccess(first.key);
    assert.equal(ledger.begin(['alpha one', 'beta two'], { limit: 8 }).status, 'suppressed');
  });

  it('near-duplicate batch without exact match runs', () => {
    const { ledger } = ledgerAt(4_000_000);
    const first = ledger.begin(['alpha one two three four five six', 'beta seven eight nine ten eleven twelve'], { limit: 8 });
    if (first.status !== 'run') throw new Error('expected run');
    ledger.completeSuccess(first.key);
    // Fuzzy overlap must not suppress batches: only exact canonical match counts.
    const near = ledger.begin(['alpha one two three four five six', 'beta seven eight nine ten eleven thirteen'], { limit: 8 });
    assert.equal(near.status, 'run');
    if (near.status === 'run') ledger.cancel(near.key);
  });
});

describe('web-search-ledger: failure blocking', () => {
  it('non-retryable failure blocks for 10 minutes then allows', () => {
    const { ledger, advance } = ledgerAt(5_000_000);
    const first = ledger.begin(['fail once'], { limit: 8 });
    if (first.status !== 'run') throw new Error('expected run');
    const code: LedgerFailureCode = 'upstream_error';
    ledger.completeFailure(first.key, { retryable: false, code });
    assert.equal(ledger.begin(['fail once'], { limit: 8 }).status, 'blocked');
    advance(FAILURE_BLOCK_MS + 1);
    assert.equal(ledger.begin(['fail once'], { limit: 8 }).status, 'run');
  });

  it('retryable failure allows one retry then blocks the third', () => {
    const { ledger, advance } = ledgerAt(6_000_000);
    const code: LedgerFailureCode = 'timeout';
    const first = ledger.begin(['flaky query'], { limit: 8 });
    if (first.status !== 'run') throw new Error('expected run');
    ledger.completeFailure(first.key, { retryable: true, code });
    // One retry is allowed.
    const second = ledger.begin(['flaky query'], { limit: 8 });
    assert.equal(second.status, 'run');
    if (second.status !== 'run') throw new Error('expected retry run');
    ledger.completeFailure(second.key, { retryable: true, code });
    // Third attempt is blocked.
    assert.equal(ledger.begin(['flaky query'], { limit: 8 }).status, 'blocked');
    advance(FAILURE_BLOCK_MS + 1);
    assert.equal(ledger.begin(['flaky query'], { limit: 8 }).status, 'run');
  });

  it('success resets retryable failure count', () => {
    const { ledger, advance } = ledgerAt(6_500_000);
    const code: LedgerFailureCode = 'timeout';
    const first = ledger.begin(['recover query'], { limit: 8 });
    if (first.status !== 'run') throw new Error('expected run');
    ledger.completeFailure(first.key, { retryable: true, code });
    const second = ledger.begin(['recover query'], { limit: 8 });
    if (second.status !== 'run') throw new Error('expected retry run');
    ledger.completeSuccess(second.key);
    // Success resets the failure count: the next failure on the original
    // entry is a first-failure (run), not a block.
    const debug = ledger.debugEntries();
    const entry = debug.find((candidate) => candidate.failures === 0);
    assert.ok(entry, 'completed success entry must reset failures to zero');
    const third = ledger.begin(['recover query'], { limit: 8 });
    assert.equal(third.status, 'suppressed');
    if (third.status === 'suppressed') {
      advance(SUCCESS_SUPPRESS_MS + 1);
      const fourth = ledger.begin(['recover query'], { limit: 8 });
      assert.equal(fourth.status, 'run');
      if (fourth.status !== 'run') throw new Error('expected run after success TTL expiry');
      ledger.completeFailure(fourth.key, { retryable: true, code });
      const fifth = ledger.begin(['recover query'], { limit: 8 });
      assert.equal(fifth.status, 'run');
    }
  });

  it('success clears failure metadata so retry is not blocked', () => {
    const { ledger } = ledgerAt(9_500_000);
    const code: LedgerFailureCode = 'upstream_error';
    const first = ledger.begin(['stale failure query'], { limit: 8 });
    if (first.status !== 'run') throw new Error('expected run');
    ledger.completeFailure(first.key, { retryable: true, code });
    // A success on the same entry must clear lastFailureAt/lastRetryable:
    // retained metadata would keep isBlocked() true and forbid the retry
    // the reset failureCount just allowed.
    const second = ledger.begin(['stale failure query'], { limit: 8 });
    if (second.status !== 'run') throw new Error('expected retry run');
    ledger.completeSuccess(second.key);
    // A success on the same entry must clear the failure block: the next
    // identical search is a near-duplicate suppress (recency), never a
    // failure block, and debug state reads success.
    const third = ledger.begin(['stale failure query'], { limit: 8 });
    assert.notEqual(third.status, 'blocked', 'success must clear the failure block');
    const debug = ledger.debugEntries();
    assert.ok(debug.some((candidate) => candidate.state === 'success'), 'success entry must be recorded');
    assert.ok(!debug.some((candidate) => candidate.state === 'blocked'), 'no entry may stay blocked after success');
  });
});

describe('web-search-ledger: abort safety', () => {
  it('aborted follower rejects without poisoning the run', async () => {
    const { ledger } = ledgerAt(7_000_000);
    const first = ledger.begin(['abortable'], { limit: 8 });
    if (first.status !== 'run') throw new Error('expected run');
    const controller = new AbortController();
    const second = ledger.begin(['abortable'], { limit: 8 }, controller.signal);
    assert.equal(second.status, 'coalesced');
    if (second.status !== 'coalesced') throw new Error('expected coalesced');
    controller.abort();
    await assert.rejects(second.promise, (error: unknown) => (error as Error).name === 'AbortError');
    // Underlying run still completes successfully and suppresses later callers.
    ledger.completeSuccess(first.key);
    assert.equal(ledger.begin(['abortable'], { limit: 8 }).status, 'suppressed');
  });

  it('cancel removes in-flight without recording a failure block', () => {
    const { ledger } = ledgerAt(7_000_000);
    const first = ledger.begin(['cancelled run'], { limit: 8 });
    if (first.status !== 'run') throw new Error('expected run');
    ledger.cancel(first.key);
    assert.equal(ledger.begin(['cancelled run'], { limit: 8 }).status, 'run');
  });
});

describe('web-search-ledger: bounds and safe storage', () => {
  it('evicts oldest entries beyond 128 (LRU)', () => {
    const { ledger } = ledgerAt(8_000_000);
    for (let index = 0; index < 128; index += 1) {
      const begun = ledger.begin([`unique ledger query number ${index} zebra`], { limit: 8 });
      if (begun.status !== 'run') throw new Error(`expected run at ${index}`);
      ledger.completeSuccess(begun.key);
    }
    assert.equal(ledger.size, 128);
    const extra = ledger.begin(['one more brand new ledger entry quokka'], { limit: 8 });
    if (extra.status !== 'run') throw new Error('expected run for new entry');
    ledger.completeSuccess(extra.key);
    assert.equal(ledger.size, 128);
    // Oldest entry was evicted, so its exact query runs again.
    assert.equal(ledger.begin(['unique ledger query number 0 zebra'], { limit: 8 }).status, 'run');
  });

  it('stored entries hold hash/state/counts/safe codes only', () => {
    const { ledger } = ledgerAt(9_000_000);
    const secret = 's3cr3t-token-body-value';
    const first = ledger.begin([`query carrying ${secret}`], { limit: 8 });
    if (first.status !== 'run') throw new Error('expected run');
    ledger.completeFailure(first.key, { retryable: false, code: 'upstream_error' });
    const snapshot = JSON.stringify(ledger.debugEntries());
    assert.ok(!snapshot.includes(secret), 'raw query text must not be stored');
    assert.ok(!snapshot.includes('s3cr3t'), 'secret fragments must not be stored');
    for (const entry of ledger.debugEntries()) {
      assert.match(entry.hash, /^[0-9a-f]{64}$/);
      assert.ok(['success', 'failed', 'blocked'].includes(entry.state));
    }
  });

  it('uses injectable clock for TTL behavior', () => {
    let now = 10_000_000;
    const ledger = new WebSearchLedger({ now: () => now });
    const first = ledger.begin(['clock query'], { limit: 8 });
    if (first.status !== 'run') throw new Error('expected run');
    ledger.completeSuccess(first.key);
    now += SUCCESS_SUPPRESS_MS - 1;
    assert.equal(ledger.begin(['clock query'], { limit: 8 }).status, 'suppressed');
    now += 2;
    assert.equal(ledger.begin(['clock query'], { limit: 8 }).status, 'run');
  });
});
