import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildWebAccessStoredEntry, createWebAccessContentStore } from '../../../src/web/access/web-access-content-store.js';
import { WEB_ACCESS_STORE_TTL_MS } from '../../../src/web/access/web-access-contract.js';

function seed(overrides: { owner?: string; now?: () => number } = {}) {
  const store = createWebAccessContentStore(overrides.now ? { now: overrides.now } : {});
  const entryDeps: { owner?: string; now?: () => number } = {};
  if (overrides.owner !== undefined) entryDeps.owner = overrides.owner;
  // Thread the same clock into the entry so TTL tests control createdAt.
  if (overrides.now !== undefined) entryDeps.now = overrides.now;
  const entry = buildWebAccessStoredEntry(
    { queries: ['q'], results: [{ queryIndex: 0, query: 'q', response: { provider: 'tavily', results: [] } }] },
    entryDeps,
  );
  store.put(entry);
  return { store, entry };
}

test('foreign-owner get rejects (resolves as miss)', () => {
  const { store, entry } = seed();
  store.put(entry, 'session-a');
  assert.equal(store.get(entry.responseId, 'session-b'), undefined);
  assert.equal(store.get(entry.responseId), undefined);
});

test('matching owner resolves; cross-session isolation holds', () => {
  const { store, entry } = seed();
  store.put(entry, 'session-a');
  const got = store.get(entry.responseId, 'session-a');
  assert.ok(got);
  assert.equal(got.responseId, entry.responseId);
  // Second entry under a different owner is independent.
  const other = buildWebAccessStoredEntry(
    { queries: ['q2'], results: [{ queryIndex: 0, query: 'q2', response: { provider: 'exa', results: [] } }] },
  );
  store.put(other, 'session-b');
  assert.equal(store.get(other.responseId, 'session-a'), undefined);
  assert.ok(store.get(other.responseId, 'session-b'));
});

test('explicit put owner wins over entry owner field', () => {
  const { store, entry } = seed({ owner: 'stale' });
  store.put(entry, 'fresh');
  assert.equal(store.get(entry.responseId, 'stale'), undefined);
  assert.ok(store.get(entry.responseId, 'fresh'));
});

test('expired entries (>1h) rejected even with matching owner', () => {
  let now = 1_000_000;
  const { store, entry } = seed({ now: () => now });
  store.put(entry, 'session-a');
  now += WEB_ACCESS_STORE_TTL_MS + 1;
  assert.equal(store.get(entry.responseId, 'session-a'), undefined);
  assert.equal(store.size(), 0);
});

test('legacy unowned entries resolve for any caller (backward compat)', () => {
  const { store, entry } = seed();
  assert.ok(store.get(entry.responseId));
  assert.ok(store.get(entry.responseId, 'anyone'));
});

test('foreign-owner delete is a no-op; owner delete removes', () => {
  const { store, entry } = seed();
  store.put(entry, 'session-a');
  store.delete(entry.responseId, 'session-b');
  assert.ok(store.get(entry.responseId, 'session-a'));
  store.delete(entry.responseId, 'session-a');
  assert.equal(store.get(entry.responseId, 'session-a'), undefined);
});
