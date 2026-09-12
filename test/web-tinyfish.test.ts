import assert from 'node:assert/strict';
import { test } from 'node:test';
import { TINYFISH_RECENCY_MINUTES, tinyfishSearchAdapter } from '../src/web-tinyfish.js';
import type { WebProviderSearchInput } from '../src/web-search-types.js';

const SECRET = 'tinyfish-secret-key-1';

function input(overrides?: Partial<WebProviderSearchInput>): WebProviderSearchInput {
  return {
    query: 'transformer interpretability',
    limit: 8,
    env: { TINYFISH_API_KEY: SECRET },
    nativeAi: { summaries: false, answers: false },
    ...overrides,
  };
}

function mockFetch(handler: (url: string, init?: RequestInit) => Response | Promise<Response>): {
  calls: Array<{ url: string; init: RequestInit | undefined }>;
  restore: () => void;
} {
  const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
  const saved = globalThis.fetch;
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    return handler(String(url), init);
  }) as typeof fetch;
  return { calls, restore: () => { globalThis.fetch = saved; } };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

test('tinyfish configured: key present, blank and absent rejected', () => {
  assert.equal(tinyfishSearchAdapter.id, 'tinyfish');
  assert.deepEqual(TINYFISH_RECENCY_MINUTES, { day: 1440, week: 10080, month: 43200, year: 525600 });
  assert.equal(tinyfishSearchAdapter.configured({ TINYFISH_API_KEY: 'k' }), true);
  assert.equal(tinyfishSearchAdapter.configured({ TINYFISH_API_KEY: '  ' }), false);
  assert.equal(tinyfishSearchAdapter.configured({}), false);
});

test('tinyfish unconfigured returns empty output without a call', async () => {
  const { calls, restore } = mockFetch(async () => jsonResponse({ results: [] }));
  try {
    const out = await tinyfishSearchAdapter.search(input({ env: {} }));
    assert.deepEqual(out, { backend: 'tinyfish', hits: [], generatedText: [] });
    assert.equal(calls.length, 0);
  } finally {
    restore();
  }
});

test('tinyfish exact endpoint, method, headers, minimal query; no invented params', async () => {
  const { calls, restore } = mockFetch(async () => jsonResponse({ results: [] }));
  try {
    await tinyfishSearchAdapter.search(input());
    assert.equal(calls.length, 1);
    const url = new URL(calls[0]!.url);
    assert.equal(url.origin, 'https://api.search.tinyfish.ai');
    assert.equal(url.searchParams.get('query'), 'transformer interpretability');
    assert.equal(url.searchParams.has('page'), false, 'page param must not be sent');
    assert.equal(url.searchParams.has('count'), false, 'count param must not be sent');
    assert.equal(url.searchParams.has('num'), false, 'num param must not be sent');
    assert.equal(calls[0]!.init?.method, 'GET');
    const headers = calls[0]!.init?.headers as Record<string, string>;
    assert.equal(headers['X-API-Key'], SECRET);
  } finally {
    restore();
  }
});

test('tinyfish recency and domain filters map to official params', async () => {
  const { calls, restore } = mockFetch(async () => jsonResponse({ results: [] }));
  try {
    await tinyfishSearchAdapter.search(
      input({ recency: 'week', domains: ['example.com', '-blocked.example'] }),
    );
    const url = new URL(calls[0]!.url);
    assert.equal(url.searchParams.get('recency_minutes'), '10080');
    assert.equal(url.searchParams.get('include_domains'), 'example.com');
    assert.equal(url.searchParams.get('exclude_domains'), 'blocked.example');
  } finally {
    restore();
  }
  const cases = [
    ['day', '1440'],
    ['month', '43200'],
    ['year', '525600'],
  ] as const;
  for (const [recency, minutes] of cases) {
    const m = mockFetch(async () => jsonResponse({ results: [] }));
    try {
      await tinyfishSearchAdapter.search(input({ recency }));
      assert.equal(new URL(m.calls[0]!.url).searchParams.get('recency_minutes'), minutes);
    } finally {
      m.restore();
    }
  }
});

test('tinyfish minimal success mapping with date; generatedText always empty', async () => {
  const { restore } = mockFetch(async () =>
    jsonResponse({
      results: [
        { title: 'T', url: 'https://example.com/a', snippet: 'body text', date: '2026-09-01' },
      ],
    }),
  );
  try {
    const out = await tinyfishSearchAdapter.search(input());
    assert.equal(out.backend, 'tinyfish');
    assert.equal(out.hits.length, 1);
    assert.equal(out.hits[0]!.title, 'T');
    assert.equal(out.hits[0]!.snippet, 'body text');
    assert.equal(out.hits[0]!.publishedDate, '2026-09-01');
    assert.deepEqual(out.generatedText, []);
  } finally {
    restore();
  }
});

test('tinyfish unparseable date omitted, never copied verbatim', async () => {
  const { restore } = mockFetch(async () =>
    jsonResponse({
      results: [{ title: 'T', url: 'https://example.com/a', snippet: 's', date: 'not-a-date' }],
    }),
  );
  try {
    const out = await tinyfishSearchAdapter.search(input());
    assert.equal(out.hits.length, 1);
    assert.ok(!('publishedDate' in out.hits[0]!), 'invalid date must be omitted');
  } finally {
    restore();
  }
});

test('tinyfish drops malformed rows, keeps valid siblings; invalid container rejects', async () => {
  const good = { title: 'G', url: 'https://example.com/g', snippet: 'ok' };
  const badRows = [
    { title: 'NoUrl', snippet: 'x' },
    { title: 'BadScheme', url: 'ftp://example.com/f', snippet: 'x' },
    'not-an-object',
    42,
  ];
  const { restore } = mockFetch(async () => jsonResponse({ results: [good, ...badRows] }));
  try {
    const out = await tinyfishSearchAdapter.search(input());
    assert.equal(out.hits.length, 1);
    assert.equal(out.hits[0]!.url, 'https://example.com/g');
  } finally {
    restore();
  }
  const m2 = mockFetch(async () => jsonResponse({ results: 'not-an-array' }));
  try {
    await assert.rejects(tinyfishSearchAdapter.search(input()), /invalid response/);
  } finally {
    m2.restore();
  }
});

test('tinyfish no retry, redacted error, redirect rejected, oversize rejected', async () => {
  const key = 'tinyfish-redact-check-123';
  const m1 = mockFetch(async () => new Response('boom', { status: 500 }));
  try {
    await assert.rejects(
      tinyfishSearchAdapter.search(input({ env: { TINYFISH_API_KEY: key } })),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.ok(!error.message.includes(key), 'key leaked into error');
        return true;
      },
    );
    assert.equal(m1.calls.length, 1);
  } finally {
    m1.restore();
  }
  const m2 = mockFetch(async () => new Response('', { status: 302, headers: { location: 'https://evil.example/' } }));
  try {
    await assert.rejects(tinyfishSearchAdapter.search(input()), /Redirect rejected/);
  } finally {
    m2.restore();
  }
  const m3 = mockFetch(async () => new Response('denied', { status: 401 }));
  try {
    await assert.rejects(tinyfishSearchAdapter.search(input()), /HTTP 401/);
    assert.equal(m3.calls.length, 1);
  } finally {
    m3.restore();
  }
  const big = 'x'.repeat(1_000_005);
  const m4 = mockFetch(async () => new Response(JSON.stringify({ results: [], pad: big }), { status: 200 }));
  try {
    await assert.rejects(tinyfishSearchAdapter.search(input()), /size limit|too large/i);
  } finally {
    m4.restore();
  }
});

test('tinyfish passes composed policy signal through', async () => {
  let seenSignal: AbortSignal | undefined;
  const { calls, restore } = mockFetch((_url, init) => {
    seenSignal = init?.signal as AbortSignal | undefined;
    return jsonResponse({ results: [] });
  });
  try {
    const controller = new AbortController();
    const out = await tinyfishSearchAdapter.search(input({ signal: controller.signal }));
    assert.equal(calls.length, 1);
    assert.equal(out.backend, 'tinyfish');
    assert.equal(seenSignal, controller.signal);
  } finally {
    restore();
  }
});

test('tinyfish abort propagates only when the forwarded signal aborted', async () => {
  const { restore } = mockFetch(async (_url, init) => {
    // Mirror real fetch: AbortError surfaces only if the forwarded signal aborted.
    if ((init?.signal as AbortSignal | undefined)?.aborted) {
      throw new DOMException('This operation was aborted', 'AbortError');
    }
    return jsonResponse({ results: [] });
  });
  try {
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(
      tinyfishSearchAdapter.search(input({ signal: controller.signal })),
      (error: unknown) => {
        assert.equal((error as DOMException).name, 'AbortError');
        assert.equal(controller.signal.aborted, true);
        return true;
      },
    );
    // Non-aborted signal succeeds instead of surfacing a spurious AbortError.
    const live = new AbortController();
    const out = await tinyfishSearchAdapter.search(input({ signal: live.signal }));
    assert.deepEqual(out, { backend: 'tinyfish', hits: [], generatedText: [] });
  } finally {
    restore();
  }
});
