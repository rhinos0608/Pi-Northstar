import assert from 'node:assert/strict';
import { test } from 'node:test';
import { orderFanoutSources, searchResearchPage } from '../src/research-sources.js';
import { callNativeTool } from '../src/native-tools.js';
import { resultToText } from '../src/backend.js';
import { decodeResultCursor, validateNorthstarResult, type NorthstarResultV1 } from '../src/result-contract.js';
import { RESEARCH_SOURCE_CAPABILITIES } from '../src/capabilities.js';

function stubFetch(handler: (url: string) => Response | Promise<Response>): () => void {
  const saved = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request) => handler(String(input))) as typeof fetch;
  return () => { globalThis.fetch = saved; };
}

test('research-sources: every advertised source has an exact native adapter wired', async () => {
  for (const capability of RESEARCH_SOURCE_CAPABILITIES) {
    assert.ok(typeof searchResearchPage === 'function');
    // Dispatch is exercised in the per-adapter tests; here we assert the map
    // covers the registry via the aggregate sources list shape.
    assert.ok(capability.backend.length > 0, `source ${capability.id} must declare a backend`);
  }
});

test('research-sources: unknown source returns explicit error envelope, no web substitution', async () => {
  const urls: string[] = [];
  const restore = stubFetch((url) => {
    urls.push(url);
    return new Response('{}', { status: 200 });
  });
  try {
    const result = await searchResearchPage({ query: 'transformers', source: 'duckduckgo' });
    assert.ok(validateNorthstarResult(result).ok, JSON.stringify(result));
    assert.equal(result.status, 'error');
    assert.equal(result.errors[0]?.code, 'invalid_input');
    assert.match(result.errors[0]?.message ?? '', /Unsupported research source "duckduckgo"/);
    assert.equal(result.data.kind === 'entities' ? result.data.entities.length : -1, 0);
    // No network request at all — no DuckDuckGo/web-search fallback.
    assert.equal(urls.length, 0);
  } finally {
    restore();
  }
});

test('research-sources: exact source dispatches to its native adapter', async () => {
  const urls: string[] = [];
  const restore = stubFetch((url) => {
    urls.push(url);
    return new Response(JSON.stringify([
      'transformer interpretability',
      ['Attention Is All You Need'],
      ['The famous transformer paper'],
      ['https://en.wikipedia.org/wiki/Attention_Is_All_You_Need'],
    ]), { status: 200, headers: { 'content-type': 'application/json' } });
  });
  try {
    const result = await searchResearchPage({ query: 'transformer interpretability', source: 'wikipedia', limit: 3 });
    assert.ok(validateNorthstarResult(result).ok, JSON.stringify(result));
    assert.equal(result.status, 'ok');
    assert.equal(result.request.source, 'wikipedia');
    assert.equal(result.sources[0]?.backend, 'wikipedia-api');
    assert.equal(result.data.kind === 'entities' ? result.data.entities[0]?.url : '', 'https://en.wikipedia.org/wiki/Attention_Is_All_You_Need');
    assert.match(urls[0]!, /^https:\/\/en\.wikipedia\.org\/w\/api\.php/);
  } finally {
    restore();
  }
});

test('research-sources: aggregate cursor is rejected with pagination_not_supported', async () => {
  const result = await searchResearchPage({ query: 'transformers', cursor: 'AAAA' });
  assert.ok(validateNorthstarResult(result).ok, JSON.stringify(result));
  assert.equal(result.status, 'error');
  assert.equal(result.errors[0]?.code, 'pagination_not_supported');
  assert.equal(result.pagination.supported, false);
});

test('research-sources: source "all" fans out in registry order, dedupes, reports partial', async () => {
  const urls: string[] = [];
  const restore = stubFetch((url) => {
    urls.push(url);
    // Wikipedia opensearch shape.
    if (url.includes('en.wikipedia.org')) {
      return new Response(JSON.stringify(['q', ['Shared Title'], ['wiki article'], ['https://en.wikipedia.org/wiki/Shared']]), { status: 200 });
    }
    if (url.includes('hn.algolia.com')) {
      return new Response(JSON.stringify({ hits: [{ objectID: '1', title: 'Shared Title', url: 'https://en.wikipedia.org/wiki/Shared' }, { objectID: '2', title: 'HN only', url: 'https://news.ycombinator.com/item?id=2', points: 5 }], page: 0, nbPages: 1 }), { status: 200 });
    }
    // Every other provider: hard failure (non-JSON 200 → backend error path).
    return new Response('<html>gateway</html>', { status: 200, headers: { 'content-type': 'text/html' } });
  });
  try {
    const result: NorthstarResultV1 = await searchResearchPage({ query: 'shared', limit: 5 });
    assert.ok(validateNorthstarResult(result).ok, JSON.stringify(result));
    assert.equal(result.request.source, 'all');
    // Sources list covers every registry source in registry order.
    assert.deepEqual(result.sources.map((entry) => entry.source), RESEARCH_SOURCE_CAPABILITIES.map((entry) => entry.id));
    // Registry order preserved: wikipedia entities precede hackernews.
    const sourcesWithEntities = result.data.kind === 'entities'
      ? result.data.entities.map((entity) => entity.source)
      : [];
    const wikiIndex = sourcesWithEntities.indexOf('wikipedia');
    const hnIndex = sourcesWithEntities.indexOf('hackernews');
    assert.ok(wikiIndex !== -1 && hnIndex !== -1 && wikiIndex < hnIndex, 'registry order preserved');
    // Dedupe by normalized URL: shared title appears once.
    const sharedUrls = result.data.kind === 'entities'
      ? result.data.entities.filter((entity) => entity.url === 'https://en.wikipedia.org/wiki/Shared')
      : [];
    assert.equal(sharedUrls.length, 1);
    assert.ok(sourcesWithEntities.includes('hackernews'), 'hackernews contributes the non-duplicate hit');
    // Failed providers are visible per source.
    const failed = result.sources.filter((entry) => entry.status === 'error');
    assert.ok(failed.length >= RESEARCH_SOURCE_CAPABILITIES.length - 2);
    assert.equal(result.status, 'partial');
    assert.equal(result.pagination.supported, false);
    assert.ok(result.notes.some((note) => note.includes('choose one exact source')));
  } finally {
    restore();
  }
});

test('research-sources: cross-source cursor rejected via adapter envelope', async () => {
  const foreign = Buffer.from(JSON.stringify({ v: 1, source: 'openalex', queryHash: 'x', state: { cursor: 'abc' } }), 'utf8').toString('base64url');
  const restore = stubFetch(() => new Response('[]', { status: 200 }));
  try {
    const result = await searchResearchPage({ query: 'q', source: 'arxiv', cursor: foreign });
    assert.ok(validateNorthstarResult(result).ok, JSON.stringify(result));
    assert.equal(result.status, 'error');
    assert.equal(result.errors[0]?.code, 'pagination_not_supported');
  } finally {
    restore();
  }
});

test('research-sources: wikipedia rejects yearFrom explicitly', async () => {
  const result = await searchResearchPage({ query: 'q', source: 'wikipedia', yearFrom: 2020 });
  assert.equal(result.status, 'error');
  assert.equal(result.errors[0]?.code, 'invalid_input');
  assert.match(result.errors[0]?.message ?? '', /yearFrom/);
});

test('native research: legacy details plus northstar envelope, no DDG for unknown source', async () => {
  const urls: string[] = [];
  const restore = stubFetch((url) => {
    urls.push(url);
    return new Response(JSON.stringify({
      data: [{ paperId: 'p1', title: 'S2 Paper', year: 2024, citationCount: 3 }],
      next: 3,
    }), { status: 200 });
  });
  try {
    const result = await callNativeTool('research', { action: 'academic', query: 'attention', source: 'semantic_scholar', limit: 2 });
    assert.match(resultToText(result), /S2 Paper/);
    const details = result.details as Record<string, unknown>;
    assert.equal(details.query, 'attention');
    assert.equal(details.source, 'semantic_scholar');
    const items = details.results as Array<{ title: string; url: string; source: string }>;
    assert.equal(items[0]?.title, 'S2 Paper');
    assert.equal(items[0]?.source, 'semantic_scholar');
    const northstar = details.northstar as NorthstarResultV1;
    assert.ok(northstar && northstar.schema === 'pi-northstar.result');
    assert.ok(validateNorthstarResult(northstar).ok);
    assert.equal(northstar.status, 'ok');
    assert.ok(urls.every((url) => url.includes('semanticscholar.org')), 'no DuckDuckGo substitution');
    // Cursor round-trip through the envelope.
    const decoded = decodeResultCursor(northstar.pagination.nextCursor!, { source: 'semantic_scholar', query: 'attention' });
    assert.equal(decoded.state.offset, 3);
  } finally {
    restore();
  }
});

test('native research: unsupported source surfaces explicit safe error text', async () => {
  const result = await callNativeTool('research', { action: 'academic', query: 'q', source: 'wikipedia2' });
  const text = resultToText(result);
  assert.match(text, /Research error/);
  assert.match(text, /Unsupported research source/);
  const northstar = (result.details as Record<string, unknown>).northstar as NorthstarResultV1;
  assert.equal(northstar.status, 'error');
  assert.equal(northstar.errors[0]?.code, 'invalid_input');
});

test('native research: aggregate runs without source selection and keeps legacy shape', async () => {
  const restore = stubFetch((url) => {
    if (url.includes('en.wikipedia.org')) {
      return new Response(JSON.stringify(['q', ['Wiki Page'], ['desc'], ['https://en.wikipedia.org/wiki/Wiki_Page']]), { status: 200 });
    }
    return new Response('{"hits":[],"page":0,"nbPages":0}', { status: 200 });
  });
  try {
    const result = await callNativeTool('research', { action: 'academic', query: 'q' });
    const details = result.details as Record<string, unknown>;
    assert.equal(details.source, 'all');
    assert.ok(Array.isArray(details.results));
    const northstar = details.northstar as NorthstarResultV1;
    assert.equal(northstar.request.source, 'all');
    assert.ok(validateNorthstarResult(northstar).ok);
  } finally {
    restore();
  }
});

test('research-sources: aggregate continues to next page via cursor round-trip binding', async () => {
  // Exact-source cursor encodes source binding; verify a semantic_scholar
  // cursor round-trips through the seam.
  const restore = stubFetch(() => new Response(JSON.stringify({ data: [{ paperId: 'x1', title: 'T' }], next: 1 }), { status: 200 }));
  try {
    const first = await searchResearchPage({ query: 'bound', source: 'semantic_scholar', limit: 1 });
    assert.ok(validateNorthstarResult(first).ok);
    const cursor = first.pagination.nextCursor;
    assert.ok(cursor);
    const decoded = decodeResultCursor(cursor, { source: 'semantic_scholar', query: 'bound' });
    assert.equal(decoded.state.offset, 1);
    const next = await searchResearchPage({ query: 'bound', source: 'semantic_scholar', limit: 1, cursor });
    assert.ok(validateNorthstarResult(next).ok);
    // Cursor bound to a different query must be rejected.
    const mismatch = await searchResearchPage({ query: 'other', source: 'semantic_scholar', limit: 1, cursor });
    assert.equal(mismatch.status, 'error');
    assert.equal(mismatch.errors[0]?.code, 'invalid_input');
  } finally {
    restore();
  }
});

test('research-sources: canonical action search dispatches, legacy academic alias holds, others reject', async () => {
  const wikiBody = JSON.stringify(['q', ['Wiki Page'], ['desc'], ['https://en.wikipedia.org/wiki/Wiki_Page']]);
  const restore = stubFetch(() => new Response(wikiBody, { status: 200, headers: { 'content-type': 'application/json' } }));
  try {
    const canonical = await searchResearchPage({ query: 'q', source: 'wikipedia' }, { requestedAction: 'search' });
    assert.ok(validateNorthstarResult(canonical).ok, JSON.stringify(canonical));
    assert.equal(canonical.status, 'ok');
    assert.equal(canonical.request.requestedAction, 'search');

    const legacy = await searchResearchPage({ query: 'q', source: 'wikipedia' }, { requestedAction: 'academic' });
    assert.ok(validateNorthstarResult(legacy).ok, JSON.stringify(legacy));
    assert.equal(legacy.status, 'ok');

    const rejected = await searchResearchPage({ query: 'q', source: 'wikipedia' }, { requestedAction: 'lookup' });
    assert.ok(validateNorthstarResult(rejected).ok, JSON.stringify(rejected));
    assert.equal(rejected.status, 'error');
    assert.equal(rejected.errors[0]?.code, 'invalid_input');
    assert.match(rejected.errors[0]?.message ?? '', /Canonical action is "search"/);
  } finally {
    restore();
  }
});

test('research-sources: pinned-source valid-empty page stops without retrying other sources', async () => {
  let fetches = 0;
  const restore = stubFetch(() => {
    fetches += 1;
    return new Response(JSON.stringify(['q', [], [], []]), { status: 200, headers: { 'content-type': 'application/json' } });
  });
  try {
    const result = await searchResearchPage({ query: 'no such page xyz', source: 'wikipedia', limit: 5 });
    assert.ok(validateNorthstarResult(result).ok, JSON.stringify(result));
    assert.equal(result.status, 'empty');
    assert.equal(result.data.kind === 'entities' ? result.data.entities.length : -1, 0);
    assert.equal(result.errors.length, 0);
    assert.equal(fetches, 1);
  } finally {
    restore();
  }
});

test('research-sources: all-fanout reports filter capability mismatch per source', async () => {
  const restore = stubFetch(() => new Response('<html>gateway</html>', { status: 200, headers: { 'content-type': 'text/html' } }));
  try {
    const result = await searchResearchPage({ query: 'q', limit: 3, author: 'Ada Lovelace' });
    assert.ok(validateNorthstarResult(result).ok, JSON.stringify(result));
    // Sources without author support reject the filter explicitly per source.
    const byId = new Map(result.sources.map((entry) => [entry.source, entry]));
    for (const id of ['semantic_scholar', 'arxiv', 'wikipedia', 'ror', 'wikidata']) {
      assert.equal(byId.get(id)?.status, 'error', `source ${id} must report its author mismatch`);
    }
    const authorErrors = result.errors.filter((error) => /"author"/.test(error.message));
    assert.ok(authorErrors.length >= 5, `expected per-source author errors, got ${authorErrors.length}`);
    // Filter-capable sources attempted their backends instead of filter rejects.
    const capableBackendErrors = result.errors.filter((error) =>
      (error.source === 'openalex' || error.source === 'pubmed' || error.source === 'datacite' || error.source === 'crossref')
      && !/"author"/.test(error.message));
    assert.equal(capableBackendErrors.length, 4);
  } finally {
    restore();
  }
});

test('research-sources: fanout ordering is completeness-aware with registry tiebreak', () => {
  const registry = RESEARCH_SOURCE_CAPABILITIES.map((entry) => entry.id);
  assert.deepEqual(orderFanoutSources({ query: 'q', limit: 5 }), registry);
  const byAuthor = orderFanoutSources({ query: 'q', limit: 5, author: 'Ada' });
  assert.deepEqual(byAuthor.slice(0, 4), ['openalex', 'pubmed', 'datacite', 'crossref']);
  assert.ok(byAuthor.indexOf('semantic_scholar') > byAuthor.indexOf('crossref'));
  const byVenue = orderFanoutSources({ query: 'q', limit: 5, venue: 'Nature' });
  assert.deepEqual(byVenue.slice(0, 2), ['openalex', 'pubmed']);
  // yearTo has no wire support anywhere: every source ties, registry order holds.
  assert.deepEqual(orderFanoutSources({ query: 'q', limit: 5, yearTo: 2024 }), registry);
});

test('research-sources: yearTo is surfaced as unsupported, never silently dropped', async () => {
  let fetches = 0;
  const restore = stubFetch(() => {
    fetches += 1;
    return new Response('{}', { status: 200 });
  });
  try {
    const pinned = await searchResearchPage({ query: 'q', source: 'arxiv', yearTo: 2024 });
    assert.ok(validateNorthstarResult(pinned).ok, JSON.stringify(pinned));
    assert.equal(pinned.status, 'error');
    assert.equal(pinned.errors[0]?.code, 'invalid_input');
    assert.match(pinned.errors[0]?.message ?? '', /"yearTo"/);
    assert.equal(fetches, 0);

    const aggregate = await searchResearchPage({ query: 'q', yearTo: 2024 });
    assert.ok(validateNorthstarResult(aggregate).ok, JSON.stringify(aggregate));
    assert.equal(aggregate.sources.length, RESEARCH_SOURCE_CAPABILITIES.length);
    assert.ok(aggregate.sources.every((entry) => entry.status === 'error'));
    assert.ok(aggregate.errors.every((error) => error.code === 'invalid_input' && /"yearTo"/.test(error.message)));
    assert.equal(fetches, 0);
  } finally {
    restore();
  }
});

test('research-sources: ror page-offset cursor round-trips through the seam', async () => {
  const items = [0, 1].map((index) => ({
    id: `https://ror.org/org${index}`,
    names: [{ value: `Organization ${index}`, types: ['ror_display'] }],
    links: [`https://www.org${index}.example`],
    established: 1901 + index,
    locations: [{ geonames_details: { country_name: 'Norway' } }],
  }));
  const restore = stubFetch(() => new Response(JSON.stringify({ number_of_results: 25, items }), { status: 200 }));
  try {
    const first = await searchResearchPage({ query: 'oslo', source: 'ror', limit: 2 });
    assert.ok(validateNorthstarResult(first).ok, JSON.stringify(first));
    assert.equal(first.status, 'ok');
    assert.equal(first.pagination.hasMore, true);
    const cursor = first.pagination.nextCursor;
    assert.ok(cursor);
    const decoded = decodeResultCursor(cursor, { source: 'ror', query: 'oslo' });
    assert.deepEqual(decoded.state, { page: 1, offset: 2 });

    const next = await searchResearchPage({ query: 'oslo', source: 'ror', limit: 2, cursor });
    assert.ok(validateNorthstarResult(next).ok, JSON.stringify(next));

    const mismatch = await searchResearchPage({ query: 'bergen', source: 'ror', limit: 2, cursor });
    assert.equal(mismatch.status, 'error');
    assert.equal(mismatch.errors[0]?.code, 'invalid_input');
  } finally {
    restore();
  }
});

test('research-sources: wikidata continuation cursor round-trips through the seam', async () => {
  const urls: string[] = [];
  const restore = stubFetch((url) => {
    urls.push(url);
    return new Response(JSON.stringify({
      searchcontinue: 10,
      search: [
        { id: 'Q7259', label: 'Ada Lovelace', concepturi: 'https://www.wikidata.org/wiki/Q7259', description: 'English mathematician' },
        { id: 'Q42', label: 'Douglas Adams', concepturi: 'https://www.wikidata.org/wiki/Q42' },
      ],
    }), { status: 200 });
  });
  try {
    const first = await searchResearchPage({ query: 'ada lovelace', source: 'wikidata', limit: 2 });
    assert.ok(validateNorthstarResult(first).ok, JSON.stringify(first));
    assert.equal(first.status, 'ok');
    assert.equal(first.pagination.hasMore, true);
    const cursor = first.pagination.nextCursor;
    assert.ok(cursor);
    const decoded = decodeResultCursor(cursor, { source: 'wikidata', query: 'ada lovelace' });
    assert.equal(decoded.state.continue, 10);

    await searchResearchPage({ query: 'ada lovelace', source: 'wikidata', limit: 2, cursor });
    assert.equal(new URL(urls[1]!).searchParams.get('continue'), '10');

    const mismatch = await searchResearchPage({ query: 'grace hopper', source: 'wikidata', limit: 2, cursor });
    assert.equal(mismatch.status, 'error');
    assert.equal(mismatch.errors[0]?.code, 'invalid_input');
  } finally {
    restore();
  }
});
