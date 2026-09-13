import assert from 'node:assert/strict';
import { test } from 'node:test';
import { BOCHA_SEARCH_ENDPOINT, BOCHA_SEARCH_RESULT_MAX, bochaSearchAdapter } from '../../../src/web/providers/web-bocha.js';
import type { WebProviderSearchInput } from '../../../src/web/web-search-types.js';
import { jsonResponse, makeTestInput, mockFetch } from './web-provider-test-utils.js';

const SECRET = 'bocha-secret-key-1';

function input(overrides?: Partial<WebProviderSearchInput>): WebProviderSearchInput {
  return makeTestInput<WebProviderSearchInput>({
    query: 'transformer interpretability',
    limit: 5,
    env: { BOCHA_API_KEY: SECRET },
    nativeAi: { summaries: false, answers: false },
  }, overrides);
}

function okBody(rows: unknown[] = [
  { url: 'https://example.com/a', title: 'T', summary: 'bocha summary', datePublished: '2024-03-01' },
]): unknown {
  return { data: { webPages: { value: rows } } };
}

test('bocha configured: key present, blank and absent rejected', () => {
  assert.equal(bochaSearchAdapter.id, 'bocha');
  assert.equal(BOCHA_SEARCH_RESULT_MAX, 20);
  assert.equal(bochaSearchAdapter.configured({ BOCHA_API_KEY: 'k' }), true);
  assert.equal(bochaSearchAdapter.configured({ BOCHA_API_KEY: '  ' }), false);
  assert.equal(bochaSearchAdapter.configured({}), false);
});

test('bocha unconfigured returns empty output without a call', async () => {
  const { calls, restore } = mockFetch(async () => jsonResponse(okBody()));
  try {
    const out = await bochaSearchAdapter.search(input({ env: {} }));
    assert.deepEqual(out, { backend: 'bocha', hits: [], generatedText: [] });
    assert.equal(calls.length, 0);
  } finally {
    restore();
  }
});

test('bocha exact endpoint, method, headers, default freshness noLimit', async () => {
  const { calls, restore } = mockFetch(async () => jsonResponse(okBody([])));
  try {
    await bochaSearchAdapter.search(input());
    assert.equal(calls.length, 1);
    assert.equal(calls[0]!.url, BOCHA_SEARCH_ENDPOINT);
    assert.equal(calls[0]!.init?.method, 'POST');
    assert.equal(calls[0]!.init?.redirect, 'manual');
    const headers = calls[0]!.init?.headers as Record<string, string>;
    assert.equal(headers.Authorization, `Bearer ${SECRET}`);
    assert.deepEqual(JSON.parse(String(calls[0]!.init?.body)), {
      query: 'transformer interpretability',
      count: 5,
      freshness: 'noLimit',
      summary: false,
    });
  } finally {
    restore();
  }
});

test('bocha recency maps to freshness, summary flag follows nativeAi', async () => {
  const { calls, restore } = mockFetch(async () => jsonResponse(okBody([])));
  try {
    await bochaSearchAdapter.search(input({
      recency: 'month',
      nativeAi: { summaries: true, answers: false },
    }));
    const body = JSON.parse(String(calls[0]!.init?.body));
    assert.equal(body.freshness, 'oneMonth');
    assert.equal(body.summary, true);
  } finally {
    restore();
  }
});

test('bocha count capped at 20', async () => {
  const { calls, restore } = mockFetch(async () => jsonResponse(okBody([])));
  try {
    await bochaSearchAdapter.search(input({ limit: 50 }));
    assert.equal(JSON.parse(String(calls[0]!.init?.body)).count, 20);
  } finally {
    restore();
  }
});

test('bocha maps rows, datePublished to publishedDate, drops bad urls', async () => {
  const { restore } = mockFetch(async () => jsonResponse(okBody([
    { url: 'https://example.com/a', title: 'T', summary: 'bocha summary', datePublished: '2024-03-01' },
    { link: 'https://example.com/b', name: 'N', snippet: 'plain snippet', datePublished: 'not-a-date' },
    { url: '', title: 'NoUrl', summary: 'x' },
  ])));
  try {
    const out = await bochaSearchAdapter.search(input());
    assert.equal(out.backend, 'bocha');
    assert.deepEqual(out.generatedText, []);
    assert.equal(out.hits.length, 2);
    assert.equal(out.hits[0]!.url, 'https://example.com/a');
    assert.equal(out.hits[0]!.snippet, 'bocha summary');
    assert.equal(out.hits[0]!.publishedDate, new Date(Date.parse('2024-03-01')).toISOString());
    assert.equal(out.hits[1]!.title, 'N');
    assert.equal(out.hits[1]!.publishedDate, undefined);
    assert.ok(!JSON.stringify(out).includes(SECRET));
  } finally {
    restore();
  }
});

test('bocha summary becomes generatedText only when summaries enabled', async () => {
  const body = okBody([
    { url: 'https://example.com/a', title: 'T', summary: 'bocha summary' },
  ]);
  const { restore: r1 } = mockFetch(async () => jsonResponse(body));
  try {
    const off = await bochaSearchAdapter.search(input());
    assert.deepEqual(off.generatedText, []);
  } finally {
    r1();
  }
  const { restore: r2 } = mockFetch(async () => jsonResponse(body));
  try {
    const on = await bochaSearchAdapter.search(input({ nativeAi: { summaries: true, answers: false } }));
    assert.equal(on.generatedText.length, 1);
    assert.deepEqual(on.generatedText[0], {
      kind: 'summary',
      backend: 'bocha',
      url: 'https://example.com/a',
      text: 'bocha summary',
      provenance: { kind: 'result_url', urls: ['https://example.com/a'] },
      claimCitations: false,
    });
    // Snippet stays on the hit; summary is separate, never a replacement.
    assert.equal(on.hits[0]!.snippet, 'bocha summary');
  } finally {
    r2();
  }
});

test('bocha missing value array rejects', async () => {
  const { restore } = mockFetch(async () => jsonResponse({ data: { webPages: {} } }));
  try {
    await assert.rejects(() => bochaSearchAdapter.search(input()), /invalid response/);
  } finally {
    restore();
  }
});

test('bocha 3xx rejects', async () => {
  const { calls, restore } = mockFetch(async () => new Response(null, { status: 302 }));
  try {
    await assert.rejects(() => bochaSearchAdapter.search(input()), /Redirect rejected/);
    assert.equal(calls.length, 1);
  } finally {
    restore();
  }
});

for (const status of [401, 429, 500]) {
  test(`bocha HTTP ${status}: one call, safe status-only error`, async () => {
    const { calls, restore } = mockFetch(async () => jsonResponse({ error: 'x' }, status));
    try {
      await assert.rejects(() => bochaSearchAdapter.search(input()), (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.match(error.message, new RegExp(String(status)));
        assert.ok(!error.message.includes(SECRET));
        return true;
      });
      assert.equal(calls.length, 1);
    } finally {
      restore();
    }
  });
}

test('bocha oversized JSON rejects', async () => {
  const { restore } = mockFetch(async () =>
    new Response(JSON.stringify(okBody()), {
      status: 200,
      headers: { 'content-type': 'application/json', 'content-length': String(2_000_000) },
    }));
  try {
    await assert.rejects(() => bochaSearchAdapter.search(input()), /too large|exceeded size/i);
  } finally {
    restore();
  }
});

test('bocha caller abort propagates', async () => {
  const { restore } = mockFetch(async () => jsonResponse(okBody()));
  try {
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(() => bochaSearchAdapter.search(input({ signal: controller.signal })));
  } finally {
    restore();
  }
});
