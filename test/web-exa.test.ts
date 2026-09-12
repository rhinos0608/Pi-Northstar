import assert from 'node:assert/strict';
import { test } from 'node:test';
import { EXA_SEARCH_ENDPOINT, exaSearchAdapter } from '../src/web-exa.js';
import type { WebProviderSearchInput } from '../src/web-search-types.js';

const SECRET = 'exa-secret-key-1';

function input(overrides?: Partial<WebProviderSearchInput>): WebProviderSearchInput {
  return {
    query: 'transformer interpretability',
    limit: 8,
    env: { EXA_API_KEY: SECRET },
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

function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

test('exa configured: key present, blank and absent rejected', () => {
  assert.equal(exaSearchAdapter.id, 'exa');
  assert.equal(exaSearchAdapter.configured({ EXA_API_KEY: 'k' }), true);
  assert.equal(exaSearchAdapter.configured({ EXA_API_KEY: '  ' }), false);
  assert.equal(exaSearchAdapter.configured({}), false);
});

test('exa unconfigured returns empty output without a call', async () => {
  const { calls, restore } = mockFetch(async () => jsonResponse({ results: [] }));
  try {
    const out = await exaSearchAdapter.search(input({ env: {} }));
    assert.deepEqual(out, { backend: 'exa', hits: [], generatedText: [] });
    assert.equal(calls.length, 0);
  } finally {
    restore();
  }
});

test('exa exact endpoint, method, headers, payload; numResults capped at 10', async () => {
  const { calls, restore } = mockFetch(async () => jsonResponse({ results: [] }));
  try {
    await exaSearchAdapter.search(input({ limit: 20 }));
    assert.equal(calls.length, 1);
    assert.equal(calls[0]!.url, EXA_SEARCH_ENDPOINT);
    assert.equal(new URL(calls[0]!.url).origin, 'https://api.exa.ai');
    assert.equal(calls[0]!.init?.method, 'POST');
    const headers = calls[0]!.init?.headers as Record<string, string>;
    assert.equal(headers['x-api-key'], SECRET);
    assert.equal(headers['Content-Type'], 'application/json');
    const body = JSON.parse(String(calls[0]!.init?.body)) as Record<string, unknown>;
    assert.equal(body.query, 'transformer interpretability');
    assert.equal(body.numResults, 10);
    assert.equal(body.type, 'auto');
    assert.equal('useAutoprompt' in body, false, 'deprecated useAutoprompt must not be sent');
    assert.deepEqual(body.contents, { text: true, highlights: true, summary: true });
  } finally {
    restore();
  }
});

test('exa summaries opt-out omits summary from payload and emits no generated item', async () => {
  const { calls, restore } = mockFetch(async () =>
    jsonResponse({
      results: [{ title: 'T', url: 'https://example.com/a', text: 'body', summary: 'gen-summary' }],
    }),
  );
  try {
    const out = await exaSearchAdapter.search(input({ nativeAi: { summaries: false, answers: true } }));
    const body = JSON.parse(String(calls[0]!.init?.body)) as Record<string, unknown>;
    assert.deepEqual(body.contents, { text: true, highlights: true });
    assert.equal(out.hits.length, 1);
    assert.equal(out.hits[0]!.snippet, 'body');
    assert.deepEqual(out.generatedText, []);
  } finally {
    restore();
  }
});

test('exa snippet from highlights/text, never summary; summary separate with result_url provenance', async () => {
  const { restore } = mockFetch(async () =>
    jsonResponse({
      results: [
        {
          title: 'T',
          url: 'https://example.com/a',
          text: 'original excerpt',
          highlights: ['h1', 'h2'],
          summary: 'generated summary',
        },
      ],
    }),
  );
  try {
    const out = await exaSearchAdapter.search(input());
    assert.equal(out.hits[0]!.snippet, 'h1 h2');
    assert.ok(!out.hits[0]!.snippet.includes('generated summary'));
    assert.equal(out.generatedText.length, 1);
    const item = out.generatedText[0]!;
    assert.equal(item.kind, 'summary');
    assert.equal(item.backend, 'exa');
    if (item.kind !== 'summary') return;
    assert.equal(item.url, 'https://example.com/a');
    assert.equal(item.text, 'generated summary');
    assert.deepEqual(item.provenance, { kind: 'result_url', urls: ['https://example.com/a'] });
    assert.equal(item.claimCitations, false);
  } finally {
    restore();
  }
});

test('exa drops malformed rows, keeps valid siblings; invalid container rejects', async () => {
  const good = { title: 'G', url: 'https://example.com/g', text: 'ok' };
  const badRows = [
    { title: 'NoUrl', text: 'x' },
    { title: 'BadScheme', url: 'ftp://example.com/f', text: 'x' },
    'not-an-object',
    42,
  ];
  const { restore } = mockFetch(async () => jsonResponse({ results: [good, ...badRows] }));
  try {
    const out = await exaSearchAdapter.search(input());
    assert.equal(out.hits.length, 1);
    assert.equal(out.hits[0]!.url, 'https://example.com/g');
  } finally {
    restore();
  }
  const m2 = mockFetch(async () => jsonResponse({ nope: [] }));
  try {
    await assert.rejects(exaSearchAdapter.search(input()), /invalid response/);
  } finally {
    m2.restore();
  }
});

test('exa no retry, redacted error, redirect rejected, oversize rejected', async () => {
  const key = 'exa-redact-check-123';
  const m1 = mockFetch(async () => new Response('boom', { status: 500 }));
  try {
    await assert.rejects(exaSearchAdapter.search(input({ env: { EXA_API_KEY: key } })), (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.ok(!error.message.includes(key), 'key leaked into error');
      return true;
    });
    assert.equal(m1.calls.length, 1);
  } finally {
    m1.restore();
  }
  const m2 = mockFetch(async () => new Response('', { status: 302, headers: { location: 'https://evil.example/' } }));
  try {
    await assert.rejects(exaSearchAdapter.search(input()), /Redirect rejected/);
  } finally {
    m2.restore();
  }
  const big = 'x'.repeat(1_000_005);
  const m3 = mockFetch(async () => new Response(JSON.stringify({ results: [], pad: big }), { status: 200 }));
  try {
    await assert.rejects(exaSearchAdapter.search(input()), /size limit|too large/i);
  } finally {
    m3.restore();
  }
});

test('exa passes composed policy signal through with no extra 15s cap', async () => {
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
    const out = await exaSearchAdapter.search(input({ signal: controller.signal }));
    assert.equal(calls.length, 1);
    assert.equal(out.backend, 'exa');
    assert.equal(seenSignal, controller.signal);
    // fetchInit(headers, undefined) mints one discarded 15s validation signal;
    // its timer is unref'd and listener-free, so the request follows only the
    // composed policy signal. Identity above is the no-premature-cap proof.
    assert.deepEqual(delays, [15_000]);
  } finally {
    restore();
    AbortSignal.timeout = origTimeout;
  }
});

test('exa without signal still applies bounded 15s standalone default', async () => {
  const origTimeout = AbortSignal.timeout;
  const delays: number[] = [];
  AbortSignal.timeout = ((ms: number) => {
    delays.push(ms);
    return origTimeout.call(AbortSignal, ms);
  }) as typeof AbortSignal.timeout;
  const { restore } = mockFetch(async () => jsonResponse({ results: [] }));
  try {
    const out = await exaSearchAdapter.search(input({}));
    assert.equal(out.backend, 'exa');
    // fetchInit standalone default
    assert.deepEqual(delays, [15_000]);
  } finally {
    restore();
    AbortSignal.timeout = origTimeout;
  }
});

test('exa pushes domains + freshnessLowerBoundMs to startPublishedDate/includeDomains/excludeDomains', async () => {
  const { calls, restore } = mockFetch(async () => jsonResponse({ results: [] }));
  try {
    await exaSearchAdapter.search(
      input({ domains: ['example.com', '-blocked.example'], freshnessLowerBoundMs: Date.UTC(2024, 5, 15) }),
    );
    assert.equal(calls.length, 1);
    const body = JSON.parse(String(calls[0]!.init?.body)) as Record<string, unknown>;
    assert.deepEqual(body.includeDomains, ['example.com']);
    assert.deepEqual(body.excludeDomains, ['blocked.example']);
    assert.equal(body.startPublishedDate, '2024-06-15T00:00:00.000Z');
  } finally {
    restore();
  }
});

test('exa derives startPublishedDate from yearFrom/recency when no explicit bound', async () => {
  const m1 = mockFetch(async () => jsonResponse({ results: [] }));
  try {
    await exaSearchAdapter.search(input({ yearFrom: 2021 }));
    const body = JSON.parse(String(m1.calls[0]!.init?.body)) as Record<string, unknown>;
    assert.equal(body.startPublishedDate, '2021-01-01T00:00:00.000Z');
  } finally {
    m1.restore();
  }
  const m2 = mockFetch(async () => jsonResponse({ results: [] }));
  try {
    await exaSearchAdapter.search(input({ recency: 'day' }));
    const body = JSON.parse(String(m2.calls[0]!.init?.body)) as Record<string, unknown>;
    assert.match(String(body.startPublishedDate), /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  } finally {
    m2.restore();
  }
});

test('exa preserves publishedDate from provider date fields, omits when absent', async () => {
  const { restore } = mockFetch(async () =>
    jsonResponse({
      results: [
        { title: 'A', url: 'https://example.com/a', text: 'x', published_date: '2024-03-01T00:00:00Z' },
        { title: 'B', url: 'https://example.com/b', text: 'y' },
      ],
    }),
  );
  try {
    const out = await exaSearchAdapter.search(input());
    assert.equal(out.hits.length, 2);
    assert.equal(out.hits[0]!.publishedDate, '2024-03-01T00:00:00Z');
    assert.equal(out.hits[1]!.publishedDate, undefined);
  } finally {
    restore();
  }
});

test('exa abort propagates', async () => {
  const { restore } = mockFetch(async () => {
    throw new DOMException('This operation was aborted', 'AbortError');
  });
  try {
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(exaSearchAdapter.search(input({ signal: controller.signal })));
  } finally {
    restore();
  }
});
