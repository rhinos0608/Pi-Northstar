import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

// TDD RED: ingestion modules do not exist yet. Each test imports its owner
// module through the public interface only.

describe('web-access ingestion: content store (TTL/LRU/caps)', () => {
  it('stores and retrieves entries, expires after TTL, evicts LRU, enforces caps', async () => {
    const { createWebAccessContentStore } = await import('../src/web-access-content-store.js');
    const { WEB_ACCESS_STORE_TTL_MS } = await import('../src/web-access-contract.js');
    let now = 1_000_000;
    const store = createWebAccessContentStore({ now: () => now });
    assert.equal(store.size(), 0);
    const { buildWebAccessStoredEntry } = await import('../src/web-access-content-store.js');
    const entry = buildWebAccessStoredEntry({
      queries: ['q1'],
      results: [{ queryIndex: 0, query: 'q1', response: { provider: 'tavily', results: [] } }],
    }, { now: () => now, randomId: () => 'id-1' });
    assert.equal(entry.responseId, 'id-1');
    store.put(entry);
    assert.equal(store.size(), 1);
    assert.deepEqual(store.get('id-1')?.queries, ['q1']);
    // TTL expiry
    now += WEB_ACCESS_STORE_TTL_MS + 1;
    assert.equal(store.get('id-1'), undefined);
    // LRU eviction: fill beyond 128 with tiny entries
    now = 2_000_000;
    const store2 = createWebAccessContentStore({ now: () => now });
    for (let i = 0; i < 129; i++) {
      store2.put(buildWebAccessStoredEntry({
        queries: [`q${i}`],
        results: [{ queryIndex: 0, query: `q${i}`, response: { provider: 'tavily', results: [] } }],
      }, { now: () => now, randomId: () => `id-${i}` }));
    }
    assert.equal(store2.size(), 128);
    assert.equal(store2.get('id-0'), undefined);
    assert.ok(store2.get('id-128'));
    // unknown id + delete
    assert.equal(store2.get('nope'), undefined);
    store2.delete('id-128');
    assert.equal(store2.get('id-128'), undefined);
  });

  it('rejects a single entry larger than the byte cap', async () => {
    const { createWebAccessContentStore, buildWebAccessStoredEntry } = await import('../src/web-access-content-store.js');
    const store = createWebAccessContentStore({ now: () => Date.now() });
    const { WEB_ACCESS_STORE_MAX_BYTES } = await import('../src/web-access-contract.js');
    // put() enforces the cap on entry bytes: a forged oversize entry rejects
    // without allocating a 128MiB payload.
    const small = buildWebAccessStoredEntry({
      queries: ['q'],
      results: [{ queryIndex: 0, query: 'q', response: { provider: 'tavily', results: [] } }],
    }, { now: () => Date.now(), randomId: () => 'small' });
    store.put(small);
    assert.equal(store.size(), 1);
    assert.throws(() => store.put({ ...small, responseId: 'big', bytes: WEB_ACCESS_STORE_MAX_BYTES + 1 }), /byte|large|exceed/i);
    assert.equal(store.get('big'), undefined);
  });
});

describe('web-access ingestion: content find (selectors/slices/find)', () => {
  it('slices stored content by offset/limit and discards them when findText present', async () => {
    const { createWebAccessContentStore, buildWebAccessStoredEntry } = await import('../src/web-access-content-store.js');
    const { getWebAccessContent } = await import('../src/web-access-content-find.js');
    const store = createWebAccessContentStore({ now: () => Date.now() });
    const entry = buildWebAccessStoredEntry({
      queries: ['alpha query'],
      results: [{
        queryIndex: 0, query: 'alpha query',
        response: { provider: 'tavily', results: [{ title: 'T', url: 'https://example.com/a', snippet: 'hello world snippet here' }] },
      }],
    }, { now: () => Date.now(), randomId: () => 'r1' });
    store.put(entry);
    const full = getWebAccessContent(store, { responseId: 'r1' });
    assert.ok(full.totalChars > 0);
    assert.ok(full.text.includes('hello world'));
    const sliced = getWebAccessContent(store, { responseId: 'r1', offset: 1, limit: 5 });
    assert.equal(sliced.text, full.text.slice(1, 6));
    assert.equal(sliced.offset, 1);
    // findText discards offset/limit (upstream semantic): no throw, offset ignored
    const found = getWebAccessContent(store, { responseId: 'r1', findText: 'hello', offset: 999, limit: 1 });
    assert.ok(found.text.toLowerCase().includes('hello'));
    assert.throws(() => getWebAccessContent(store, { responseId: 'missing' }), /no stored|not found|unknown/i);
    assert.throws(() => getWebAccessContent(store, { responseId: 'r1', offset: -1 }), /offset/i);
  });

  it('supports exact/case-insensitive/fuzzy find modes and queryIndex selectors', async () => {
    const { createWebAccessContentStore, buildWebAccessStoredEntry } = await import('../src/web-access-content-store.js');
    const { getWebAccessContent } = await import('../src/web-access-content-find.js');
    const store = createWebAccessContentStore({ now: () => Date.now() });
    store.put(buildWebAccessStoredEntry({
      queries: ['first', 'second'],
      results: [
        { queryIndex: 0, query: 'first', response: { provider: 'tavily', results: [{ title: 'A', url: 'https://example.com/a', snippet: 'Alpha Bravo content' }] } },
        { queryIndex: 1, query: 'second', response: { provider: 'exa', results: [{ title: 'B', url: 'https://example.com/b', snippet: 'Second query unique zebra words' }] } },
      ],
    }, { now: () => Date.now(), randomId: () => 'r2' }));
    // selector narrows to queryIndex 1
    const sel = getWebAccessContent(store, { responseId: 'r2', queryIndex: 1 });
    assert.ok(sel.text.includes('zebra'));
    assert.ok(!sel.text.includes('Alpha Bravo'));
    // case-insensitive default finds mixed case
    const ci = getWebAccessContent(store, { responseId: 'r2', findText: 'aLpHa bRaVo' });
    assert.ok(ci.matches && ci.matches.length > 0);
    // exact mode does not match different case
    const exact = getWebAccessContent(store, { responseId: 'r2', findText: 'alpha bravo', findMode: 'exact' });
    assert.equal(exact.matches?.length ?? 0, 0);
    // fuzzy matches token subsequence across whitespace/case
    const fuzzy = getWebAccessContent(store, { responseId: 'r2', findText: '  ALPHA   bravo ', findMode: 'fuzzy' });
    assert.ok((fuzzy.matches?.length ?? 0) > 0);
    // findMode without findText rejects
    assert.throws(() => getWebAccessContent(store, { responseId: 'r2', findMode: 'exact' }), /findText/i);
  });
});

describe('web-access ingestion: fetch (readable/raw arrays, github/media routing, gates)', () => {
  it('fetches url arrays in readable/raw modes and routes github/media readers first', async () => {
    const { fetchWebAccessContent } = await import('../src/web-access-fetch.js');
    const calls: string[] = [];
    const pageReader = {
      read: async (url: string, mode: 'readable' | 'raw') => {
        calls.push(`page:${mode}:${url}`);
        return { title: `page ${mode}`, content: `body of ${url} mode=${mode}` };
      },
    };
    const githubMediaReader = {
      read: async (url: string) => {
        if (url.includes('github.com')) {
          calls.push(`gh:${url}`);
          return { title: 'gh title', content: 'gh body' };
        }
        return undefined;
      },
    };
    const out = await fetchWebAccessContent({ urls: ['https://example.com/a', 'https://github.com/o/r'] }, {
      mode: 'readable', pageReader, githubMediaReader, allowExternal: true,
    });
    assert.equal(out.length, 2);
    assert.equal(out[0]?.source, 'page');
    assert.equal(out[0]?.mode, 'readable');
    assert.equal(out[1]?.source, 'github-media');
    assert.equal(out[1]?.title, 'gh title');
    const raw = await fetchWebAccessContent({ url: 'https://example.com/a' }, {
      mode: 'raw', pageReader, allowExternal: true,
    });
    assert.equal(raw[0]?.mode, 'raw');
    assert.ok(calls.some((c) => c.startsWith('page:raw:')));
  });

  it('calls zero readers when external fetch is disabled and truncates at 50k chars', async () => {
    const { fetchWebAccessContent } = await import('../src/web-access-fetch.js');
    let pageCalls = 0;
    let ghCalls = 0;
    const pageReader = { read: async () => { pageCalls++; return { title: 't', content: 'c' }; } };
    const githubMediaReader = { read: async () => { ghCalls++; return undefined; } };
    const blocked = await fetchWebAccessContent({ url: 'https://example.com/a' }, {
      mode: 'readable', pageReader, githubMediaReader, allowExternal: false,
    });
    assert.equal(pageCalls, 0);
    assert.equal(ghCalls, 0);
    assert.ok((blocked[0]?.error ?? '').length > 0);
    const bigReader = { read: async () => ({ title: 't', content: 'y'.repeat(60_000) }) };
    const big = await fetchWebAccessContent({ url: 'https://example.com/big' }, {
      mode: 'readable', pageReader: bigReader, allowExternal: true,
    });
    assert.equal(big[0]?.content.length, 50_000);
    assert.equal(big[0]?.truncated, true);
    await assert.rejects(() => fetchWebAccessContent({} as never, { pageReader: bigReader }), /url/i);
  });
});

describe('web-access ingestion: source check (artifacts/hashes/heuristic)', () => {
  it('builds sources, passages with ids+hashes, and heuristic assessments with 0.85 cap', async () => {
    const { buildWebAccessSourceCheck } = await import('../src/web-access-source-check.js');
    const artifact = buildWebAccessSourceCheck({
      query: 'Does example feature exist?',
      results: [
        { title: 'Docs', url: 'https://docs.example.com/guide', snippet: 'The feature is confirmed and verified by the docs.' },
        { title: 'Thread', url: 'https://github.com/o/r/issues/1', snippet: 'This is not true, the claim was debunked.' },
      ],
      fetched: [
        { url: 'https://docs.example.com/guide', title: 'Docs', content: 'According to the docs, the example feature is confirmed and shows that it works. Verified behavior.' },
      ],
      claims: ['example feature exists'],
    }, { now: () => 7, randomId: () => 'art-1' });
    assert.equal(artifact.id, 'art-1');
    assert.ok(artifact.sources.length >= 2);
    assert.ok(artifact.passages.length >= 2);
    for (const p of artifact.passages) {
      assert.match(p.passage_id, /^p-\d+-\d+$/);
      assert.match(p.content_hash ?? '', /^sha256:[0-9a-f]{64}$/);
    }
    assert.ok(artifact.claims && artifact.claims.length === 1);
    const claim = artifact.claims[0]!;
    assert.ok(['supported', 'contradicted', 'unclear', 'missing-evidence'].includes(claim.status));
    assert.ok(claim.confidence <= 0.85);
    assert.ok(claim.rationale.length > 0);
    assert.equal(artifact.heuristic, true);
    // support-only claim stays supported; contradiction-only stays contradicted
    const supportOnly = buildWebAccessSourceCheck({
      query: 'q', results: [{ title: 't', url: 'https://docs.example.com/x', snippet: 'confirmed and verified shows that it works' }],
      claims: ['confirmed verified works claim'],
    }, { now: () => 7, randomId: () => 'a2' });
    assert.equal(supportOnly.claims?.[0]?.status, 'supported');
    const mixed = buildWebAccessSourceCheck({
      query: 'q',
      results: [
        { title: 'a', url: 'https://docs.example.com/a', snippet: 'confirmed verified shows that example works' },
        { title: 'b', url: 'https://example.com/b', snippet: 'this example is not true, debunked and false claim here' },
      ],
      claims: ['example works debunked claim'],
    }, { now: () => 7, randomId: () => 'a3' });
    assert.equal(mixed.claims?.[0]?.status, 'unclear');
  });
});
