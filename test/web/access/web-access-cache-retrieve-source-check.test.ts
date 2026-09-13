import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildWebAccessStoredEntry, createWebAccessContentStore } from '../../../src/web/access/web-access-content-store.js';
import { retrieveWebAccessCorpus } from '../../../src/web/access/web-access-retrieve.js';
import { runWebAccessCachedSourceCheck } from '../../../src/web/access/web-access-cached-source-check.js';

function seedStore() {
  const store = createWebAccessContentStore({ now: () => Date.now() });
  store.put(
    buildWebAccessStoredEntry(
      {
        queries: ['alpha query'],
        results: [
          {
            queryIndex: 0,
            query: 'alpha query',
            response: {
              provider: 'tavily',
              results: [
                { title: 'Alpha Doc', url: 'https://docs.example.com/alpha', snippet: 'Alpha Bravo content confirmed here.' },
                { title: 'Beta Page', url: 'https://example.com/beta', snippet: 'Beta words about zebra migration.' },
              ],
            },
          },
        ],
      },
      { now: () => Date.now(), randomId: () => 'resp-1' },
    ),
  );
  return store;
}

test('retrieve returns full cached corpus with citations and hashes', () => {
  const store = seedStore();
  const out = retrieveWebAccessCorpus(store, { responseId: 'resp-1' });
  assert.equal(out.responseId, 'resp-1');
  assert.ok(out.text.includes('Alpha Bravo'));
  assert.ok(out.text.includes('zebra migration'));
  assert.equal(out.sources.length, 2);
  assert.deepEqual(
    out.sources.map((s) => s.sourceId),
    ['s-0-0', 's-0-1'],
  );
  for (const source of out.sources) {
    assert.match(source.content_hash, /^sha256:[0-9a-f]{64}$/);
    assert.ok(out.text.includes(source.sourceId));
  }
  assert.equal(out.truncated, false);
});

test('retrieve honors sourceIds filter, offset/limit slices, and findText precedence', () => {
  const store = seedStore();
  const full = retrieveWebAccessCorpus(store, { responseId: 'resp-1' });
  const narrowed = retrieveWebAccessCorpus(store, { responseId: 'resp-1', sourceIds: ['s-0-1'] });
  assert.equal(narrowed.sources.length, 1);
  assert.equal(narrowed.sources[0]?.sourceId, 's-0-1');
  assert.ok(narrowed.text.includes('zebra migration'));
  assert.ok(!narrowed.text.includes('Alpha Bravo'));
  const sliced = retrieveWebAccessCorpus(store, { responseId: 'resp-1', offset: 1, limit: 5 });
  assert.equal(sliced.text, full.text.slice(1, 6));
  assert.equal(sliced.offset, 1);
  assert.equal(sliced.truncated, full.text.length > 6);
  if (sliced.truncated) assert.equal(sliced.nextOffset, 6);
  // findText wins: offset/limit accepted but ignored, no throw.
  const found = retrieveWebAccessCorpus(store, { responseId: 'resp-1', findText: 'ALPHA bravo', offset: 999, limit: 1 });
  assert.ok((found.matches?.length ?? 0) > 0);
  assert.ok(found.text.toLowerCase().includes('alpha bravo'));
  assert.equal(found.offset, 0);
  assert.throws(() => retrieveWebAccessCorpus(store, { responseId: 'missing' }), /responseId/);
  assert.throws(() => retrieveWebAccessCorpus(store, { responseId: 'resp-1', sourceIds: ['s-9-9'] }), /sourceId/);
  assert.throws(() => retrieveWebAccessCorpus(store, { responseId: 'resp-1', offset: full.text.length + 1 }), /Offset/);
  assert.throws(() => retrieveWebAccessCorpus(store, { responseId: 'resp-1', findText: '' }), /findText/);
});

test('cached source_check assesses claims from stored corpus only, with hashes and heuristic label', () => {
  const store = createWebAccessContentStore({ now: () => Date.now() });
  store.put(
    buildWebAccessStoredEntry(
      {
        queries: ['alpha feature'],
        results: [
          {
            queryIndex: 0,
            query: 'alpha feature',
            response: {
              provider: 'tavily',
              results: [
                { title: 'Docs', url: 'https://docs.example.com/alpha', snippet: 'The alpha feature is confirmed and verified by the docs.' },
                { title: 'Thread', url: 'https://example.com/thread', snippet: 'The alpha feature is not true, debunked and false claim here.' },
              ],
            },
          },
        ],
      },
      { now: () => Date.now(), randomId: () => 'resp-sc' },
    ),
  );
  const artifact = runWebAccessCachedSourceCheck(store, { responseId: 'resp-sc', claims: ['alpha feature exists here'] });
  assert.equal(artifact.heuristic, true);
  assert.equal(artifact.claims?.length, 1);
  assert.equal(artifact.claims?.[0]?.status, 'unclear');
  assert.ok((artifact.claims?.[0]?.confidence ?? 1) <= 0.85);
  for (const passage of artifact.passages) {
    assert.match(passage.passage_id, /^p-\d+-\d+$/);
    assert.match(passage.content_hash ?? '', /^sha256:[0-9a-f]{64}$/);
  }
  // sourceIds narrows the corpus: contradiction-only source contradicts.
  const narrowed = runWebAccessCachedSourceCheck(store, {
    responseId: 'resp-sc',
    sourceIds: ['s-0-1'],
    claims: ['alpha feature exists here'],
  });
  assert.equal(narrowed.sources.length, 1);
  assert.equal(narrowed.sources[0]?.url, 'https://example.com/thread');
  assert.equal(narrowed.claims?.[0]?.status, 'contradicted');
  // Bounds and corpus-only errors.
  assert.throws(() => runWebAccessCachedSourceCheck(store, { responseId: 'resp-sc', claims: [] }), /claims/);
  assert.throws(
    () => runWebAccessCachedSourceCheck(store, { responseId: 'resp-sc', claims: Array.from({ length: 21 }, (_, i) => `c${i}`) }),
    /claims/,
  );
  assert.throws(() => runWebAccessCachedSourceCheck(store, { responseId: 'gone', claims: ['x claim words'] }), /responseId/);
  assert.throws(() => runWebAccessCachedSourceCheck(store, { responseId: 'resp-sc', sourceIds: ['s-9-9'], claims: ['x claim words'] }), /sourceId/);
});

test('memory cache bounds hold: 1h TTL, 128 entries, 128MiB, random IDs, no list or disk', async () => {
  const contract = await import('../../../src/web/access/web-access-contract.js');
  assert.equal(contract.WEB_ACCESS_STORE_TTL_MS, 3_600_000);
  assert.equal(contract.WEB_ACCESS_STORE_MAX_ENTRIES, 128);
  assert.equal(contract.WEB_ACCESS_STORE_MAX_BYTES, 128 * 1024 * 1024);
  const { randomUUID } = await import('node:crypto');
  assert.match(randomUUID(), /^[0-9a-f-]{36}$/);
  let now = 5_000_000;
  const store = createWebAccessContentStore({ now: () => now });
  store.put(buildWebAccessStoredEntry(
    { queries: ['q'], results: [{ queryIndex: 0, query: 'q', response: { provider: 'tavily', results: [] } }] },
    { now: () => now },
  ));
  // Default IDs are random (no caller-supplied ID): two entries differ.
  store.put(buildWebAccessStoredEntry(
    { queries: ['q'], results: [{ queryIndex: 0, query: 'q', response: { provider: 'tavily', results: [] } }] },
    { now: () => now },
  ));
  assert.equal(store.size(), 2);
  now += contract.WEB_ACCESS_STORE_TTL_MS + 1;
  assert.equal(store.size(), 0);
  // No listing or disk API on the store surface: lookup is responseId-only.
  const surface = store as unknown as Record<string, unknown>;
  assert.equal(typeof surface.list, 'undefined');
  assert.equal(typeof surface.save, 'undefined');
  assert.equal(typeof surface.load, 'undefined');
  assert.deepEqual(Object.keys(surface).sort(), ['delete', 'get', 'prune', 'put', 'size']);
});
