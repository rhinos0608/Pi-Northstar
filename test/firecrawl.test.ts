import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  FIRECRAWL_SCRAPE_ENDPOINT,
  FIRECRAWL_SEARCH_ENDPOINT,
  FIRECRAWL_SEARCH_RESULT_MAX,
  FIRECRAWL_SEARCH_SUMMARY_RESULT_MAX,
  firecrawlFetchAdapter,
  firecrawlSearchAdapter,
} from '../src/firecrawl.js';

const SENTINEL = 'SENTINEL_FIRECRAWL_KEY_abc123xyz';

function mockFetch(handler: (url: string, init?: RequestInit) => Response | Promise<Response>): () => void {
  const prev = globalThis.fetch;
  globalThis.fetch = (async (url: unknown, init?: RequestInit) => handler(String(url), init)) as typeof fetch;
  return () => {
    globalThis.fetch = prev;
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function searchBody(rows: unknown[]) {
  return { success: true, data: { web: rows } };
}

function searchRow(overrides: Record<string, unknown> = {}) {
  return {
    url: 'https://example.com/a',
    title: 'Alpha',
    description: 'snippet a',
    ...overrides,
  };
}

function okSummaries() {
  return { summaries: true, answers: true };
}

// ── exports ──

test('exports fixed endpoints and caps', () => {
  assert.equal(FIRECRAWL_SEARCH_ENDPOINT, 'https://api.firecrawl.dev/v2/search');
  assert.equal(FIRECRAWL_SCRAPE_ENDPOINT, 'https://api.firecrawl.dev/v2/scrape');
  assert.equal(FIRECRAWL_SEARCH_RESULT_MAX, 10);
  assert.equal(FIRECRAWL_SEARCH_SUMMARY_RESULT_MAX, 3);
  assert.equal(firecrawlSearchAdapter.id, 'firecrawl');
  assert.equal(firecrawlFetchAdapter.id, 'firecrawl');
});

test('configured() requires nonblank key', () => {
  assert.equal(firecrawlSearchAdapter.configured({}), false);
  assert.equal(firecrawlSearchAdapter.configured({ FIRECRAWL_API_KEY: '  ' }), false);
  assert.equal(firecrawlSearchAdapter.configured({ FIRECRAWL_API_KEY: SENTINEL }), true);
  assert.equal(firecrawlFetchAdapter.configured({}), false);
  assert.equal(firecrawlFetchAdapter.configured({ FIRECRAWL_API_KEY: SENTINEL }), true);
});

// ── search: summary-on ──

test('search summary-on posts summarized payload, caps 3 rows, one request', async () => {
  let calls = 0;
  let seenBody: Record<string, unknown> | undefined;
  let seenAuth: string | null = null;
  let seenUrl = '';
  let seenMethod = '';
  const restore = mockFetch((url, init) => {
    calls += 1;
    seenUrl = url;
    seenMethod = String(init?.method ?? '');
    seenAuth = new Headers(init?.headers).get('authorization');
    seenBody = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
    const rows = [1, 2, 3, 4, 5].map((n) => searchRow({ url: `https://example.com/${n}`, summary: `summary ${n}` }));
    return jsonResponse(searchBody(rows));
  });
  try {
    const out = await firecrawlSearchAdapter.search({
      query: 'q',
      limit: 8,
      env: { FIRECRAWL_API_KEY: SENTINEL },
      nativeAi: okSummaries(),
    });
    assert.equal(calls, 1);
    assert.equal(seenUrl, FIRECRAWL_SEARCH_ENDPOINT);
    assert.equal(seenMethod, 'POST');
    assert.equal(seenAuth, `Bearer ${SENTINEL}`);
    assert.equal(seenBody?.query, 'q');
    assert.equal(seenBody?.limit, 3);
    assert.deepEqual(seenBody?.sources, ['web']);
    assert.equal(seenBody?.highlights, true);
    assert.deepEqual(seenBody?.scrapeOptions, { formats: [{ type: 'summary' }], onlyMainContent: true });
    assert.equal(out.backend, 'firecrawl');
    assert.equal(out.hits.length, 3);
    assert.equal(out.generatedText.length, 3);
    assert.ok(out.hits.every((h) => h.backend === 'firecrawl'));
    assert.ok(out.generatedText.every((g) => g.kind === 'summary' && g.claimCitations === false));
  } finally {
    restore();
  }
});

test('search summary-off posts unsummarized payload, caps 10 rows, no generated text', async () => {
  let calls = 0;
  let seenBody: Record<string, unknown> | undefined;
  const restore = mockFetch((_url, init) => {
    calls += 1;
    seenBody = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
    const rows = Array.from({ length: 12 }, (_, i) => searchRow({ url: `https://example.com/${i}` }));
    return jsonResponse(searchBody(rows));
  });
  try {
    const out = await firecrawlSearchAdapter.search({
      query: 'q',
      limit: 20,
      env: { FIRECRAWL_API_KEY: SENTINEL },
      nativeAi: { summaries: false, answers: false },
    });
    assert.equal(calls, 1);
    assert.equal(seenBody?.limit, 10);
    assert.equal('scrapeOptions' in (seenBody ?? {}), false);
    assert.equal(out.hits.length, 10);
    assert.deepEqual(out.generatedText, []);
  } finally {
    restore();
  }
});

test('search summary never becomes snippet; highlights preferred over description', async () => {
  const restore = mockFetch(() =>
    jsonResponse(
      searchBody([
        searchRow({ description: 'desc', highlights: ['hl-one', 'hl-two'], summary: 'gen summary' }),
      ]),
    ),
  );
  try {
    const out = await firecrawlSearchAdapter.search({
      query: 'q',
      limit: 5,
      env: { FIRECRAWL_API_KEY: SENTINEL },
      nativeAi: okSummaries(),
    });
    assert.equal(out.hits[0]?.snippet, 'hl-one hl-two');
    assert.ok(!out.hits[0]?.snippet.includes('gen summary'));
    assert.equal(out.generatedText[0]?.kind, 'summary');
    if (out.generatedText[0]?.kind === 'summary') {
      assert.equal(out.generatedText[0].text, 'gen summary');
      assert.deepEqual(out.generatedText[0].provenance, {
        kind: 'result_url',
        urls: ['https://example.com/a'],
      });
    }
  } finally {
    restore();
  }
});

test('search drops malformed sibling rows, rejects invalid container', async () => {
  const restore = mockFetch(() =>
    jsonResponse(
      searchBody([
        searchRow({}),
        { url: 'ftp://example.com/x', title: 'Bad scheme' },
        { title: 'No url' },
        searchRow({ url: 'https://example.com/good' }),
      ]),
    ),
  );
  try {
    const out = await firecrawlSearchAdapter.search({
      query: 'q',
      limit: 5,
      env: { FIRECRAWL_API_KEY: SENTINEL },
      nativeAi: { summaries: false, answers: false },
    });
    assert.equal(out.hits.length, 2);
    assert.equal(out.hits[1]?.url, 'https://example.com/good');
  } finally {
    restore();
  }
  const restore2 = mockFetch(() => jsonResponse({ success: true, data: {} }));
  try {
    await assert.rejects(
      firecrawlSearchAdapter.search({
        query: 'q',
        limit: 5,
        env: { FIRECRAWL_API_KEY: SENTINEL },
        nativeAi: { summaries: false, answers: false },
      }),
    );
  } finally {
    restore2();
  }
  const restore3 = mockFetch(() => jsonResponse({ success: false, data: { web: [] } }));
  try {
    await assert.rejects(
      firecrawlSearchAdapter.search({
        query: 'q',
        limit: 5,
        env: { FIRECRAWL_API_KEY: SENTINEL },
        nativeAi: { summaries: false, answers: false },
      }),
    );
  } finally {
    restore3();
  }
});

test('search rejects redirect, never retries 429/5xx, no token in error', async () => {
  let calls = 0;
  const restore = mockFetch(() => {
    calls += 1;
    return new Response('moved', { status: 301, headers: { location: 'https://example.com/x' } });
  });
  try {
    await assert.rejects(
      firecrawlSearchAdapter.search({
        query: 'q',
        limit: 5,
        env: { FIRECRAWL_API_KEY: SENTINEL },
        nativeAi: { summaries: false, answers: false },
      }),
      /Redirect rejected/,
    );
    assert.equal(calls, 1);
  } finally {
    restore();
  }
  for (const status of [402, 429, 500]) {
    let n = 0;
    const r = mockFetch(() => {
      n += 1;
      return jsonResponse({ error: 'up' }, status);
    });
    try {
      await assert.rejects(
        firecrawlSearchAdapter.search({
          query: 'q',
          limit: 5,
          env: { FIRECRAWL_API_KEY: SENTINEL },
          nativeAi: { summaries: false, answers: false },
        }),
        (error: unknown) => {
          assert.ok(!String((error as Error)?.message ?? error).includes(SENTINEL), 'token leaked in error');
          return true;
        },
      );
      assert.equal(n, 1, `status ${status} retried`);
    } finally {
      r();
    }
  }
});

test('search rejects oversize response and propagates abort, one request', async () => {
  let calls = 0;
  const restore = mockFetch(() => {
    calls += 1;
    return new Response('x'.repeat(100), {
      status: 200,
      headers: { 'content-type': 'application/json', 'content-length': String(2_000_000) },
    });
  });
  try {
    await assert.rejects(
      firecrawlSearchAdapter.search({
        query: 'q',
        limit: 5,
        env: { FIRECRAWL_API_KEY: SENTINEL },
        nativeAi: { summaries: false, answers: false },
      }),
    );
    assert.equal(calls, 1);
  } finally {
    restore();
  }
  const controller = new AbortController();
  controller.abort();
  let seenSignalAborted: boolean | undefined;
  const r2 = mockFetch((_url, init) => {
    seenSignalAborted = init?.signal?.aborted;
    if (init?.signal?.aborted) {
      throw new DOMException('This operation was aborted', 'AbortError');
    }
    return jsonResponse(searchBody([searchRow({})]));
  });
  try {
    await assert.rejects(
      firecrawlSearchAdapter.search({
        query: 'q',
        limit: 5,
        env: { FIRECRAWL_API_KEY: SENTINEL },
        nativeAi: { summaries: false, answers: false },
        signal: controller.signal,
      }),
    );
    assert.equal(seenSignalAborted, true);
  } finally {
    r2();
  }
});

test('search requires configured key and nonblank query', async () => {
  await assert.rejects(
    firecrawlSearchAdapter.search({ query: 'q', limit: 5, env: {}, nativeAi: okSummaries() }),
  );
  const restore = mockFetch(() => jsonResponse(searchBody([])));
  try {
    await assert.rejects(
      firecrawlSearchAdapter.search({
        query: '   ',
        limit: 5,
        env: { FIRECRAWL_API_KEY: SENTINEL },
        nativeAi: okSummaries(),
      }),
    );
  } finally {
    restore();
  }
});

// ── fetch ──

function scrapeBody(overrides: Record<string, unknown> = {}) {
  return {
    success: true,
    data: {
      markdown: '# Hello\nworld',
      summary: 'page summary',
      metadata: { title: 'Page Title', sourceURL: 'https://example.com/final' },
      ...overrides,
    },
  };
}

function publicLookup() {
  return async () => [{ address: '93.184.216.34', family: 4, port: 0 }];
}

test('fetch posts markdown+summary when summaries enabled, maps content/title/url', async () => {
  let seenBody: Record<string, unknown> | undefined;
  let seenAuth: string | null = null;
  let calls = 0;
  const restore = mockFetch((url, init) => {
    calls += 1;
    assert.equal(url, FIRECRAWL_SCRAPE_ENDPOINT);
    assert.equal(String(init?.method ?? ''), 'POST');
    seenAuth = new Headers(init?.headers).get('authorization');
    seenBody = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
    return jsonResponse(scrapeBody());
  });
  try {
    const page = await firecrawlFetchAdapter.fetch({
      url: 'https://example.com/article',
      env: { FIRECRAWL_API_KEY: SENTINEL },
      lookup: publicLookup(),
      timeoutMs: 15_000,
    });
    assert.equal(calls, 1);
    assert.equal(seenAuth, `Bearer ${SENTINEL}`);
    assert.equal(seenBody?.url, 'https://example.com/article');
    assert.deepEqual(seenBody?.formats, ['markdown', { type: 'summary' }]);
    assert.equal(seenBody?.onlyMainContent, true);
    assert.equal(seenBody?.timeout, 15_000);
    assert.ok(!('question' in (seenBody ?? {})), 'question format must never be requested');
    assert.ok(!('actions' in (seenBody ?? {})), 'actions must never be requested');
    assert.equal(page.backend, 'firecrawl');
    assert.equal(page.externalProcessing, true);
    assert.equal(page.url, 'https://example.com/final');
    assert.equal(page.title, 'Page Title');
    assert.ok(page.content.includes('# Hello'));
    assert.equal(page.generatedText.length, 1);
    assert.equal(page.generatedText[0]?.kind, 'summary');
  } finally {
    restore();
  }
});

test('fetch honors PI_SEARCH_NATIVE_SUMMARIES=0: markdown-only, no summary item', async () => {
  let seenBody: Record<string, unknown> | undefined;
  const restore = mockFetch((_url, init) => {
    seenBody = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
    return jsonResponse(scrapeBody());
  });
  try {
    const page = await firecrawlFetchAdapter.fetch({
      url: 'https://example.com/article',
      env: { FIRECRAWL_API_KEY: SENTINEL, PI_SEARCH_NATIVE_SUMMARIES: '0' },
      lookup: publicLookup(),
      timeoutMs: 15_000,
    });
    assert.deepEqual(seenBody?.formats, ['markdown']);
    assert.deepEqual(page.generatedText, []);
    assert.ok(page.content.length > 0);
  } finally {
    restore();
  }
});

test('fetch rejects private/reserved/credentialed URL before any vendor call', async () => {
  for (const target of [
    'http://localhost/article',
    'http://127.0.0.1/article',
    'http://10.0.0.5/article',
    'https://user:pass@example.com/article',
    'ftp://example.com/article',
  ]) {
    let calls = 0;
    const restore = mockFetch(() => {
      calls += 1;
      return jsonResponse(scrapeBody());
    });
    try {
      await assert.rejects(
        firecrawlFetchAdapter.fetch({
          url: target,
          env: { FIRECRAWL_API_KEY: SENTINEL },
          lookup: publicLookup(),
          timeoutMs: 15_000,
        }),
      );
      assert.equal(calls, 0, `vendor called for ${target}`);
    } finally {
      restore();
    }
  }
});

test('fetch rejects DNS private answer before vendor call', async () => {
  let calls = 0;
  const restore = mockFetch(() => {
    calls += 1;
    return jsonResponse(scrapeBody());
  });
  try {
    await assert.rejects(
      firecrawlFetchAdapter.fetch({
        url: 'https://example.com/article',
        env: { FIRECRAWL_API_KEY: SENTINEL },
        lookup: async () => [{ address: '10.1.2.3', family: 4, port: 0 }],
        timeoutMs: 15_000,
      }),
    );
    assert.equal(calls, 0);
  } finally {
    restore();
  }
});

test('fetch sends no cookies/caller headers, rejects redirect, no retry, no token leak', async () => {
  let seenCookie: string | null = 'unset';
  let calls = 0;
  const restore = mockFetch((_url, init) => {
    calls += 1;
    const headers = new Headers(init?.headers);
    seenCookie = headers.get('cookie');
    return new Response('moved', { status: 302, headers: { location: 'https://example.com/x' } });
  });
  try {
    await assert.rejects(
      firecrawlFetchAdapter.fetch({
        url: 'https://example.com/article',
        env: { FIRECRAWL_API_KEY: SENTINEL },
        lookup: publicLookup(),
        timeoutMs: 15_000,
      }),
      /Redirect rejected/,
    );
    assert.equal(calls, 1);
    assert.equal(seenCookie, null);
  } finally {
    restore();
  }
  let n = 0;
  const r2 = mockFetch(() => {
    n += 1;
    return jsonResponse({ error: 'busy' }, 429);
  });
  try {
    await assert.rejects(
      firecrawlFetchAdapter.fetch({
        url: 'https://example.com/article',
        env: { FIRECRAWL_API_KEY: SENTINEL },
        lookup: publicLookup(),
        timeoutMs: 15_000,
      }),
      (error: unknown) => {
        assert.ok(!String((error as Error)?.message ?? error).includes(SENTINEL), 'token leaked in error');
        return true;
      },
    );
    assert.equal(n, 1);
  } finally {
    r2();
  }
});

test('fetch rejects oversize/malformed/empty responses, ignores unexpected answer', async () => {
  const big = mockFetch(() =>
    new Response('x'.repeat(64), {
      status: 200,
      headers: { 'content-type': 'application/json', 'content-length': String(2_000_000) },
    }),
  );
  try {
    await assert.rejects(
      firecrawlFetchAdapter.fetch({
        url: 'https://example.com/a',
        env: { FIRECRAWL_API_KEY: SENTINEL },
        lookup: publicLookup(),
        timeoutMs: 15_000,
      }),
    );
  } finally {
    big();
  }
  const malformed = mockFetch(() => jsonResponse({ success: true, data: { noMarkdown: 1 } }));
  try {
    await assert.rejects(
      firecrawlFetchAdapter.fetch({
        url: 'https://example.com/a',
        env: { FIRECRAWL_API_KEY: SENTINEL },
        lookup: publicLookup(),
        timeoutMs: 15_000,
      }),
    );
  } finally {
    malformed();
  }
  const withAnswer = mockFetch(() =>
    jsonResponse(scrapeBody({ answer: 'should be ignored', markdown: 'content here' })),
  );
  try {
    const page = await firecrawlFetchAdapter.fetch({
      url: 'https://example.com/a',
      env: { FIRECRAWL_API_KEY: SENTINEL, PI_SEARCH_NATIVE_SUMMARIES: '0' },
      lookup: publicLookup(),
      timeoutMs: 15_000,
    });
    assert.equal(page.content, 'content here');
    assert.deepEqual(page.generatedText, []);
  } finally {
    withAnswer();
  }
});

test('fetch retains submitted URL when vendor resolved URL invalid', async () => {
  const restore = mockFetch(() =>
    jsonResponse(scrapeBody({ metadata: { title: 'T', sourceURL: 'ftp://example.com/x' } })),
  );
  try {
    const page = await firecrawlFetchAdapter.fetch({
      url: 'https://example.com/submitted',
      env: { FIRECRAWL_API_KEY: SENTINEL, PI_SEARCH_NATIVE_SUMMARIES: '0' },
      lookup: publicLookup(),
      timeoutMs: 15_000,
    });
    assert.equal(page.url, 'https://example.com/submitted');
  } finally {
    restore();
  }
});

test('search passes composed policy signal through with no extra timer (25s policy not capped at 12s)', async () => {
  const origTimeout = AbortSignal.timeout;
  const delays: number[] = [];
  AbortSignal.timeout = ((ms: number) => {
    delays.push(ms);
    return origTimeout.call(AbortSignal, ms);
  }) as typeof AbortSignal.timeout;
  let seenSignal: AbortSignal | undefined;
  const restore = mockFetch((_url, init) => {
    seenSignal = init?.signal as AbortSignal | undefined;
    return jsonResponse(searchBody([searchRow({})]));
  });
  try {
    const controller = new AbortController();
    const out = await firecrawlSearchAdapter.search({
      query: 'q',
      limit: 5,
      env: { FIRECRAWL_API_KEY: SENTINEL },
      nativeAi: { summaries: false, answers: false },
      signal: controller.signal,
    });
    assert.equal(out.hits.length, 1);
    assert.equal(seenSignal, controller.signal);
    assert.deepEqual(delays, []);
  } finally {
    restore();
    AbortSignal.timeout = origTimeout;
  }
});

test('search without signal still applies bounded 12s standalone default', async () => {
  const origTimeout = AbortSignal.timeout;
  const delays: number[] = [];
  AbortSignal.timeout = ((ms: number) => {
    delays.push(ms);
    return origTimeout.call(AbortSignal, ms);
  }) as typeof AbortSignal.timeout;
  const restore = mockFetch(() => jsonResponse(searchBody([searchRow({})])));
  try {
    const out = await firecrawlSearchAdapter.search({
      query: 'q',
      limit: 5,
      env: { FIRECRAWL_API_KEY: SENTINEL },
      nativeAi: { summaries: false, answers: false },
    });
    assert.equal(out.hits.length, 1);
    // DEFAULT_WEB_SEARCH_PROVIDER_TIMEOUT_MS
    assert.deepEqual(delays, [12_000]);
  } finally {
    restore();
    AbortSignal.timeout = origTimeout;
  }
});

test('fetch keeps timeoutMs input effective (25s policy reaches vendor body and timer)', async () => {
  const origTimeout = AbortSignal.timeout;
  const delays: number[] = [];
  AbortSignal.timeout = ((ms: number) => {
    delays.push(ms);
    return origTimeout.call(AbortSignal, ms);
  }) as typeof AbortSignal.timeout;
  let seenBody: Record<string, unknown> | undefined;
  const restore = mockFetch((_url, init) => {
    seenBody = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
    return jsonResponse(scrapeBody());
  });
  try {
    const controller = new AbortController();
    const page = await firecrawlFetchAdapter.fetch({
      url: 'https://example.com/article',
      env: { FIRECRAWL_API_KEY: SENTINEL },
      lookup: publicLookup(),
      timeoutMs: 25_000,
      signal: controller.signal,
    });
    assert.equal(seenBody?.timeout, 25_000);
    assert.ok(delays.includes(25_000));
    assert.ok(page.content.length > 0);
  } finally {
    restore();
    AbortSignal.timeout = origTimeout;
  }
});
