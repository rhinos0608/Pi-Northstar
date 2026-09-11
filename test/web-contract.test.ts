import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  assertNoWebCursor,
  decodeWebCursor,
  dedupeWebEntities,
  encodeWebCursor,
  orderWebPlans,
  resolveWebAction,
  resolveWebActionForTool,
  validateWebEntity,
  validateWebPage,
  validateWebRequest,
  webCursorFingerprint,
  WEB_CRAWL_MAX_PAGES_MAX,
  WEB_CRAWL_TOP_K_MAX,
  WEB_ENTITY_CONTENT_MAX,
  WEB_PAGE_CONTENT_MAX,
  WEB_READ_MAX_CHARS_MAX,
  WEB_SEARCH_LIMIT_MAX,
  RESEARCH_SEARCH_LIMIT_MAX,
  MAX_WEB_QUERY_LENGTH,
  type WebArticleV1,
  type WebAuthTier,
  type WebBackendPlan,
  type WebPageV1,
} from '../src/web-contract.js';
import { SocialError } from '../src/social-contract.js';

function webError(code: string, run: () => unknown): SocialError {
  try {
    run();
  } catch (error) {
    assert.ok(error instanceof SocialError, `expected SocialError, got ${String(error)}`);
    assert.equal(error.code, code);
    return error;
  }
  throw new Error(`expected SocialError(${code}) but nothing was thrown`);
}

function article(overrides: Partial<WebArticleV1> = {}): WebArticleV1 {
  return {
    version: 1,
    kind: 'article',
    id: 'web:article:1',
    url: 'https://example.com/a',
    source: 'duckduckgo',
    backend: 'duckduckgo',
    title: 'Hello',
    snippet: 'excerpt',
    ...overrides,
  };
}

function page(overrides: Partial<WebPageV1> = {}): WebPageV1 {
  return {
    entities: [article()],
    pagination: { supported: false, limit: 8, returned: 1, hasMore: false },
    partial: false,
    warnings: [],
    ...overrides,
  };
}

function plan(overrides: Partial<WebBackendPlan> & { backend: string }): WebBackendPlan {
  return {
    authTier: 'anonymous' satisfies WebAuthTier as WebAuthTier,
    degraded: false,
    quality: 'full',
    execute: async () => undefined,
    ...overrides,
  };
}

test('canonical actions resolve; unknown rejected with capped echo', () => {
  assert.equal(resolveWebAction('search'), 'search');
  assert.equal(resolveWebAction('read'), 'read');
  assert.equal(resolveWebAction('crawl'), 'crawl');
  const long = `fetch${'x'.repeat(64)}`;
  const err = webError('unsupported_action', () => resolveWebAction(long));
  assert.ok(err.message.includes(long.slice(0, 32)));
  assert.ok(!err.message.includes(long));
});

test('tool routing: web_search=search, fetch query-less=read, fetch query=crawl', () => {
  assert.equal(resolveWebActionForTool('web_search', { query: 'q' }), 'search');
  assert.equal(resolveWebActionForTool('fetch', { url: 'https://example.com' }), 'read');
  assert.equal(resolveWebActionForTool('fetch', { url: 'https://example.com', query: 'q' }), 'crawl');
  assert.equal(resolveWebActionForTool('fetch', { url: 'https://example.com', query: '  ' }), 'read');
  const err = webError('unsupported_action', () => resolveWebActionForTool('github', {}));
  assert.ok(err.message.includes('github'));
});

test('search requires query; query length capped at 300', () => {
  webError('invalid_request', () => validateWebRequest({ action: 'search' }));
  webError('invalid_request', () => validateWebRequest({ action: 'search', query: '   ' }));
  webError('invalid_request', () =>
    validateWebRequest({ action: 'search', query: 'q'.repeat(MAX_WEB_QUERY_LENGTH + 1) }),
  );
  const { request } = validateWebRequest({ action: 'search', query: ' hello ' });
  assert.equal(request.query, 'hello');
});

test('search limit hard cap 20 rejects; research category cap 30 rejects', () => {
  assert.equal(WEB_SEARCH_LIMIT_MAX, 20);
  assert.equal(RESEARCH_SEARCH_LIMIT_MAX, 30);
  webError('invalid_request', () => validateWebRequest({ action: 'search', query: 'q', limit: 21 }));
  webError('invalid_request', () => validateWebRequest({ action: 'search', query: 'q', limit: 0 }));
  webError('invalid_request', () => validateWebRequest({ action: 'search', query: 'q', limit: 2.5 }));
  const ok = validateWebRequest({ action: 'search', query: 'q', limit: 20 });
  assert.equal(ok.request.limit, 20);
  // Research-category search honors the wider cap.
  webError('invalid_request', () =>
    validateWebRequest({ action: 'search', query: 'q', limit: 31, category: 'research' }),
  );
  const rok = validateWebRequest({ action: 'search', query: 'q', limit: 30, category: 'research' });
  assert.equal(rok.request.limit, 30);
  assert.equal(rok.request.researchCategory, true);
  // Non-research category keeps the 20 cap.
  webError('invalid_request', () =>
    validateWebRequest({ action: 'search', query: 'q', limit: 21, category: 'news' }),
  );
});

test('read requires url; maxChars 1-50000 honored and rejected out of range', () => {
  assert.equal(WEB_READ_MAX_CHARS_MAX, 50000);
  webError('invalid_request', () => validateWebRequest({ action: 'read' }));
  webError('invalid_request', () => validateWebRequest({ action: 'read', url: '   ' }));
  webError('invalid_request', () => validateWebRequest({ action: 'read', url: 'https://example.com', maxChars: 0 }));
  webError('invalid_request', () =>
    validateWebRequest({ action: 'read', url: 'https://example.com', maxChars: 50001 }),
  );
  const { request } = validateWebRequest({ action: 'read', url: 'https://example.com', maxChars: 50000 });
  assert.equal(request.maxChars, 50000);
  // Shape only: no reachability check at contract layer.
  const shape = validateWebRequest({ action: 'read', url: 'https://example.com/x' });
  assert.equal(shape.request.url, 'https://example.com/x');
});

test('crawl requires url+query; topK cap 20 and maxPages cap 25 reject', () => {
  assert.equal(WEB_CRAWL_TOP_K_MAX, 20);
  assert.equal(WEB_CRAWL_MAX_PAGES_MAX, 25);
  webError('invalid_request', () => validateWebRequest({ action: 'crawl', query: 'q' }));
  webError('invalid_request', () => validateWebRequest({ action: 'crawl', url: 'https://example.com' }));
  webError('invalid_request', () =>
    validateWebRequest({ action: 'crawl', url: 'https://example.com', query: 'q', topK: 21 }),
  );
  webError('invalid_request', () =>
    validateWebRequest({ action: 'crawl', url: 'https://example.com', query: 'q', maxPages: 26 }),
  );
  // maxChars honored on crawl path too.
  webError('invalid_request', () =>
    validateWebRequest({ action: 'crawl', url: 'https://example.com', query: 'q', maxChars: 50001 }),
  );
  const { request } = validateWebRequest({
    action: 'crawl',
    url: 'https://example.com',
    query: 'q',
    topK: 20,
    maxPages: 25,
  });
  assert.equal(request.topK, 20);
  assert.equal(request.maxPages, 25);
});

test('entity validator accepts sparse article, rejects work and backend_text', () => {
  assert.equal(validateWebEntity(article()).ok, true);
  assert.equal(validateWebEntity({ ...article(), id: undefined }).ok, false);
  assert.equal(validateWebEntity(article({ url: 'notaurl' })).ok, false);
  const work = validateWebEntity({ ...article(), kind: 'work' });
  assert.equal(work.ok, false);
  assert.ok(work.issues.some((issue) => issue.includes('work')));
  const backendText = validateWebEntity({ ...article(), backend_text: 'raw' });
  assert.equal(backendText.ok, false);
  assert.ok(backendText.issues.some((issue) => issue.includes('backend_text')));
  const camel = validateWebEntity({ ...article(), backendText: 'raw' });
  assert.equal(camel.ok, false);
  const unknown = validateWebEntity({ ...article(), extra: 1 });
  assert.equal(unknown.ok, false);
  const big = validateWebEntity(article({ content: 'x'.repeat(WEB_ENTITY_CONTENT_MAX + 1) }));
  assert.equal(big.ok, false);
});

test('page validation mirrors media: dedupe first-wins, bounded sizes', () => {
  assert.equal(validateWebPage(page()).ok, true);
  const dupes = validateWebPage(
    page({
      entities: [article(), article({ id: 'web:article:2', title: 'Second' })],
      pagination: { supported: false, limit: 8, returned: 2, hasMore: false },
    }),
  );
  assert.equal(dupes.ok, false);
  assert.ok(dupes.issues.some((issue) => issue.includes('duplicate')));
  const deduped = dedupeWebEntities([article(), article({ id: 'web:article:2' })]);
  assert.equal(deduped.length, 1);
  assert.equal(deduped[0]!.id, 'web:article:1');
  const over = validateWebPage(
    page({
      entities: [article({ content: 'x'.repeat(WEB_PAGE_CONTENT_MAX + 1) })],
    }),
  );
  assert.equal(over.ok, false);
  const paged = validateWebPage(
    page({ pagination: { supported: true, limit: 8, returned: 1, hasMore: true, nextCursor: 'abc' } }),
  );
  assert.equal(paged.ok, false);
});

test('web pagination unsupported: cursors rejected with cursor_invalid', () => {
  assert.throws(() => assertNoWebCursor('any-token'), (error: unknown) => {
    assert.ok(error instanceof SocialError);
    assert.equal((error as SocialError).code, 'cursor_invalid');
    return true;
  });
  assert.doesNotThrow(() => assertNoWebCursor(undefined));
  assert.doesNotThrow(() => assertNoWebCursor(''));
  webError('cursor_invalid', () =>
    validateWebRequest({ action: 'search', query: 'q', cursor: 'tok' }),
  );
  // Decode path stays fail-closed: always cursor_invalid, never mismatch.
  webError('cursor_invalid', () =>
    decodeWebCursor(encodeWebCursor({ action: 'search', backend: 'b', fingerprint: 'f', state: {} }), {
      action: 'search',
      backend: 'b',
      fingerprint: 'f',
    }),
  );
  // Fingerprint util is deterministic over canonical selectors.
  assert.equal(
    webCursorFingerprint({ action: 'search', query: 'q', limit: 8 }),
    webCursorFingerprint({ action: 'search', query: 'q', limit: 8 }),
  );
  assert.notEqual(
    webCursorFingerprint({ action: 'search', query: 'q', limit: 8 }),
    webCursorFingerprint({ action: 'search', query: 'other', limit: 8 }),
  );
});

test('search preference order places diffbot after keyed providers, before keyless', async () => {
  const { WEB_BACKEND_PREFERENCE } = await import('../src/web-contract.js');
  assert.deepEqual([...WEB_BACKEND_PREFERENCE.search], [
    'codex',
    'tavily',
    'exa',
    'brave',
    'searxng',
    'diffbot',
    'ollama-search',
    'duckduckgo',
  ]);
});

test('plan ordering: complete before degraded, tier then preference', () => {
  const degraded = plan({ backend: 'codex', degraded: true });
  const full = plan({ backend: 'duckduckgo' });
  assert.deepEqual(
    orderWebPlans('search', [degraded, full]).map((p) => p.backend),
    ['duckduckgo', 'codex'],
  );
  const keyed = plan({ backend: 'tavily', authTier: 'api_key' });
  const anon = plan({ backend: 'duckduckgo', authTier: 'anonymous' });
  assert.deepEqual(
    orderWebPlans('search', [keyed, anon]).map((p) => p.backend),
    ['duckduckgo', 'tavily'],
  );
  const late = plan({ backend: 'duckduckgo' });
  const early = plan({ backend: 'codex' });
  assert.deepEqual(
    orderWebPlans('search', [late, early]).map((p) => p.backend),
    ['codex', 'duckduckgo'],
  );
});
