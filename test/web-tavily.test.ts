import assert from 'node:assert/strict';
import { test } from 'node:test';
import { TAVILY_SEARCH_ENDPOINT, tavilySearchAdapter } from '../src/web-tavily.js';
import type { WebProviderSearchInput } from '../src/web-search-types.js';

const SECRET = 'tavily-secret-key-1';

function input(overrides?: Partial<WebProviderSearchInput>): WebProviderSearchInput {
  return {
    query: 'transformer interpretability',
    limit: 8,
    env: { TAVILY_API_KEY: SECRET },
    nativeAi: { summaries: true, answers: true },
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

test('tavily configured: key present, blank and absent rejected', () => {
  assert.equal(tavilySearchAdapter.id, 'tavily');
  assert.equal(tavilySearchAdapter.configured({ TAVILY_API_KEY: 'k' }), true);
  assert.equal(tavilySearchAdapter.configured({ TAVILY_API_KEY: '  ' }), false);
  assert.equal(tavilySearchAdapter.configured({}), false);
});

test('tavily unconfigured returns empty output without a call', async () => {
  const { calls, restore } = mockFetch(async () => jsonResponse({ results: [] }));
  try {
    const out = await tavilySearchAdapter.search(input({ env: {} }));
    assert.deepEqual(out, { backend: 'tavily', hits: [], generatedText: [] });
    assert.equal(calls.length, 0);
  } finally {
    restore();
  }
});

test('tavily exact endpoint, method, headers, payload; max_results capped at 20', async () => {
  const { calls, restore } = mockFetch(async () => jsonResponse({ results: [] }));
  try {
    await tavilySearchAdapter.search(input({ limit: 50 }));
    assert.equal(calls.length, 1);
    assert.equal(calls[0]!.url, TAVILY_SEARCH_ENDPOINT);
    assert.equal(new URL(calls[0]!.url).origin, 'https://api.tavily.com');
    assert.equal(calls[0]!.init?.method, 'POST');
    const headers = calls[0]!.init?.headers as Record<string, string>;
    assert.equal(headers.Authorization, `Bearer ${SECRET}`);
    const body = JSON.parse(String(calls[0]!.init?.body)) as Record<string, unknown>;
    assert.equal(body.query, 'transformer interpretability');
    assert.equal(body.max_results, 20);
    assert.equal(body.search_depth, 'basic');
    assert.equal(body.include_answer, 'basic');
    assert.equal(body.include_raw_content, false);
    assert.equal(body.include_images, false);
  } finally {
    restore();
  }
});

test('tavily answers opt-out sends include_answer false and emits no answer item', async () => {
  const { calls, restore } = mockFetch(async () =>
    jsonResponse({
      answer: 'generated answer',
      results: [{ title: 'T', url: 'https://example.com/a', content: 'original excerpt' }],
    }),
  );
  try {
    const out = await tavilySearchAdapter.search(input({ nativeAi: { summaries: true, answers: false } }));
    const body = JSON.parse(String(calls[0]!.init?.body)) as Record<string, unknown>;
    assert.equal(body.include_answer, false);
    assert.equal(out.hits[0]!.snippet, 'original excerpt');
    assert.deepEqual(out.generatedText, []);
  } finally {
    restore();
  }
});

test('tavily content stays snippet; answer separate with supporting-result-set provenance', async () => {
  const { restore } = mockFetch(async () =>
    jsonResponse({
      answer: 'generated answer',
      results: [
        { title: 'A', url: 'https://example.com/a', content: 'excerpt a' },
        { title: 'B', url: 'https://example.com/b', content: 'excerpt b' },
      ],
    }),
  );
  try {
    const out = await tavilySearchAdapter.search(input());
    assert.equal(out.hits.length, 2);
    assert.equal(out.hits[0]!.snippet, 'excerpt a');
    assert.ok(!out.hits[0]!.snippet.includes('generated answer'));
    assert.equal(out.generatedText.length, 1);
    const item = out.generatedText[0]!;
    assert.equal(item.kind, 'answer');
    assert.equal(item.backend, 'tavily');
    if (item.kind !== 'answer') return;
    assert.equal(item.text, 'generated answer');
    assert.deepEqual(item.provenance, {
      kind: 'supporting_result_set',
      urls: ['https://example.com/a', 'https://example.com/b'],
    });
    assert.equal(item.claimCitations, false);
  } finally {
    restore();
  }
});

test('tavily empty answer or answer without supporting urls omitted', async () => {
  const m1 = mockFetch(async () =>
    jsonResponse({ answer: '  ', results: [{ title: 'A', url: 'https://example.com/a', content: 'x' }] }),
  );
  try {
    assert.deepEqual((await tavilySearchAdapter.search(input())).generatedText, []);
  } finally {
    m1.restore();
  }
  const m2 = mockFetch(async () => jsonResponse({ answer: 'orphan', results: [] }));
  try {
    assert.deepEqual((await tavilySearchAdapter.search(input())).generatedText, []);
  } finally {
    m2.restore();
  }
});

test('tavily drops malformed rows, keeps valid siblings; invalid container rejects', async () => {
  const { restore } = mockFetch(async () =>
    jsonResponse({
      answer: 'ans',
      results: [{ title: 'G', url: 'https://example.com/g', content: 'ok' }, { title: 'Bad' }, 7],
    }),
  );
  try {
    const out = await tavilySearchAdapter.search(input());
    assert.equal(out.hits.length, 1);
    assert.equal(out.hits[0]!.url, 'https://example.com/g');
  } finally {
    restore();
  }
  const m2 = mockFetch(async () => jsonResponse({ results: 'not-an-array' }));
  try {
    await assert.rejects(tavilySearchAdapter.search(input()), /invalid response/);
  } finally {
    m2.restore();
  }
});

test('tavily no retry, redacted error, redirect rejected, oversize rejected', async () => {
  const key = 'tavily-redact-check-123';
  const m1 = mockFetch(async () => new Response('boom', { status: 429 }));
  try {
    await assert.rejects(tavilySearchAdapter.search(input({ env: { TAVILY_API_KEY: key } })), (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.ok(!error.message.includes(key), 'key leaked into error');
      return true;
    });
    assert.equal(m1.calls.length, 1);
  } finally {
    m1.restore();
  }
  const m2 = mockFetch(async () => new Response('', { status: 307, headers: { location: 'https://evil.example/' } }));
  try {
    await assert.rejects(tavilySearchAdapter.search(input()), /Redirect rejected/);
  } finally {
    m2.restore();
  }
  const big = 'x'.repeat(1_000_005);
  const m3 = mockFetch(async () => new Response(JSON.stringify({ results: [], pad: big }), { status: 200 }));
  try {
    await assert.rejects(tavilySearchAdapter.search(input()), /size limit|too large/i);
  } finally {
    m3.restore();
  }
});

test('tavily passes composed policy signal through with no governing 15s cap', async () => {
  const origTimeout = AbortSignal.timeout;
  const delays: number[] = [];
  AbortSignal.timeout = ((ms: number) => {
    delays.push(ms);
    return origTimeout.call(AbortSignal, ms);
  }) as typeof AbortSignal.timeout;
  let seenSignal: AbortSignal | undefined;
  const { calls, restore } = mockFetch((_url, init) => {
    seenSignal = init?.signal as AbortSignal | undefined;
    return jsonResponse({ results: [] });
  });
  try {
    const controller = new AbortController();
    const out = await tavilySearchAdapter.search(input({ signal: controller.signal }));
    assert.equal(calls.length, 1);
    assert.equal(out.backend, 'tavily');
    assert.equal(seenSignal, controller.signal);
    // fetchInit(headers, undefined) mints one discarded 15s validation signal;
    // its timer is unrefd and listener-free, so the request follows only the
    // composed policy signal. Identity above is the no-premature-cap proof.
    assert.deepEqual(delays, [15_000]);
  } finally {
    restore();
    AbortSignal.timeout = origTimeout;
  }
});

test('tavily without signal still applies bounded 15s standalone default', async () => {
  const origTimeout = AbortSignal.timeout;
  const delays: number[] = [];
  AbortSignal.timeout = ((ms: number) => {
    delays.push(ms);
    return origTimeout.call(AbortSignal, ms);
  }) as typeof AbortSignal.timeout;
  const { restore } = mockFetch(async () => jsonResponse({ results: [] }));
  try {
    const out = await tavilySearchAdapter.search(input({}));
    assert.equal(out.backend, 'tavily');
    // fetchInit standalone default
    assert.deepEqual(delays, [15_000]);
  } finally {
    restore();
    AbortSignal.timeout = origTimeout;
  }
});

test('tavily abort propagates', async () => {
  const { restore } = mockFetch(async () => {
    throw new DOMException('This operation was aborted', 'AbortError');
  });
  try {
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(tavilySearchAdapter.search(input({ signal: controller.signal })));
  } finally {
    restore();
  }
});
