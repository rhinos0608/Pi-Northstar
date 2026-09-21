import test from 'node:test';
import assert from 'node:assert/strict';
import { BrokerMutationLedger, BrokerReadIdempotencyCache, BrokerReplayError, BrokerSequenceGuard, mutationTransportLoss } from '../../src/runtime/broker-replay.js';

test('sequence guard rejects replay and gaps', () => {
  const guard = new BrokerSequenceGuard(); guard.accept(1); guard.accept(2);
  assert.throws(() => guard.accept(2), (error: unknown) => error instanceof BrokerReplayError && error.code === 'sequence_replay');
  assert.throws(() => guard.accept(4), (error: unknown) => error instanceof BrokerReplayError && error.code === 'sequence_replay');
});

test('read idempotency cache stays bounded and expires', () => {
  let now = 0; const cache = new BrokerReadIdempotencyCache({ maxEntries: 1, maxBytes: 100, ttlMs: 10, now: () => now });
  assert.equal(cache.set('one', { ok: true }), true); assert.deepEqual(cache.get('one'), { ok: true });
  now = 11; assert.equal(cache.get('one'), undefined);
});

test('mutation IDs reject duplicates, never replay', () => {
  const ledger = new BrokerMutationLedger(); ledger.claim('mutation_1');
  assert.throws(() => ledger.claim('mutation_1'), (error: unknown) => error instanceof BrokerReplayError && error.code === 'duplicate_mutation');
});

test('mutation transport loss is outcome unknown and not retryable', () => assert.deepEqual(mutationTransportLoss(), { outcome: 'outcome_unknown', retry: false }));
