import assert from 'node:assert/strict';
import { test } from 'node:test';
import { XAI_SEARCH_ENDPOINT, XAI_SEARCH_MODEL, XAI_SEARCH_RESULT_MAX, xaiSearchAdapter } from '../src/web-xai.js';
import type { WebProviderSearchInput } from '../src/web-search-types.js';
import { jsonResponse, mockFetch } from './web-provider-test-utils.js';

const SECRET = 'xai-secret-key-1';

function input(overrides?: Partial<WebProviderSearchInput>): WebProviderSearchInput {
  return {
    query: 'transformer interpretability',
    limit: 5,
    env: { XAI_API_KEY: SECRET },
    nativeAi: { summaries: false, answers: true },
    ...overrides,
  };
}

function messageOutput(text: string, annotations: unknown[] = []): unknown {
  return {
    type: 'message',
    content: [{ type: 'output_text', text, ...(annotations.length > 0 ? { annotations } : {}) }],
  };
}

test('xai configured: key present, blank and absent rejected', () => {
  assert.equal(xaiSearchAdapter.id, 'xai');
  assert.equal(XAI_SEARCH_MODEL, 'grok-4.6');
  assert.equal(XAI_SEARCH_RESULT_MAX, 20);
  assert.equal(xaiSearchAdapter.configured({ XAI_API_KEY: 'k' }), true);
  assert.equal(xaiSearchAdapter.configured({ XAI_API_KEY: '  ' }), false);
  assert.equal(xaiSearchAdapter.configured({}), false);
});

test('xai unconfigured returns empty output without a call', async () => {
  const { calls, restore } = mockFetch(async () => jsonResponse({ output: [] }));
  try {
    const out = await xaiSearchAdapter.search(input({ env: {} }));
    assert.deepEqual(out, { backend: 'xai', hits: [], generatedText: [] });
    assert.equal(calls.length, 0);
  } finally {
    restore();
  }
});

test('xai exact endpoint, method, headers, minimal body; no filter fields', async () => {
  const { calls, restore } = mockFetch(async () => jsonResponse({ output: [messageOutput('hi')], citations: ['https://example.com/a'] }));
  try {
    await xaiSearchAdapter.search(
      input({ recency: 'week', domains: ['example.com'], includeContent: true, yearFrom: 2020 }),
    );
    assert.equal(calls.length, 1);
    assert.equal(calls[0]!.url, XAI_SEARCH_ENDPOINT);
    assert.equal(calls[0]!.init?.method, 'POST');
    assert.equal(calls[0]!.init?.redirect, 'manual');
    const headers = calls[0]!.init?.headers as Record<string, string>;
    assert.equal(headers.Authorization, `Bearer ${SECRET}`);
    assert.equal(headers.Accept, 'application/json');
    const body = JSON.parse(String(calls[0]!.init?.body));
    assert.deepEqual(body, { model: 'grok-4.6', input: 'transformer interpretability', tools: [{ type: 'web_search' }] });
    assert.ok(!('allowed_domains' in body), 'allowed_domains must never be sent');
  } finally {
    restore();
  }
});

test('xai citation precedence: url_citation, then web_search_call.sources, then citations', async () => {
  const { restore } = mockFetch(async () =>
    jsonResponse({
      output: [
        messageOutput('answer text', [{ type: 'url_citation', url: 'https://example.com/annotated', title: 'Annotated' }]),
        { type: 'web_search_call', sources: [{ url: 'https://example.com/called', title: 'Called' }] },
      ],
      citations: ['https://example.com/top', { url: 'https://example.com/obj', title: 'Obj' }],
    }),
  );
  try {
    const out = await xaiSearchAdapter.search(input({ limit: 10 }));
    assert.deepEqual(
      out.hits.map((h) => h.url),
      ['https://example.com/annotated', 'https://example.com/called', 'https://example.com/top', 'https://example.com/obj'],
    );
    assert.ok(out.hits.every((h) => h.backend === 'xai'));
    assert.equal(out.generatedText.length, 1);
    assert.equal(out.generatedText[0]?.kind, 'answer');
    assert.equal((out.generatedText[0] as { text: string }).text, 'answer text');
  } finally {
    restore();
  }
});

test('xai web_search_call string sources and duplicate urls deduped', async () => {
  const { restore } = mockFetch(async () =>
    jsonResponse({
      output: [{ type: 'item.web_search_call', sources: ['https://example.com/a', 'https://example.com/a'] }],
      citations: ['https://example.com/a'],
    }),
  );
  try {
    const out = await xaiSearchAdapter.search(input({ nativeAi: { summaries: false, answers: false } }));
    assert.equal(out.hits.length, 1);
    assert.deepEqual(out.hits[0], { title: 'Untitled', url: 'https://example.com/a', snippet: '', backend: 'xai' });
    assert.deepEqual(out.generatedText, []);
  } finally {
    restore();
  }
});

test('xai caps hits at 20 and truncates long answers', async () => {
  const sources = Array.from({ length: 25 }, (_, i) => `https://example.com/${i}`);
  const longAnswer = `A${'x'.repeat(9000)}`;
  const { restore } = mockFetch(async () =>
    jsonResponse({ output: [messageOutput(longAnswer), { type: 'web_search_call', sources }], citations: [] }),
  );
  try {
    const out = await xaiSearchAdapter.search(input({ limit: 50 }));
    assert.equal(out.hits.length, 20);
    assert.equal(out.generatedText.length, 1);
    assert.equal((out.generatedText[0] as { text: string }).text.length, 8000);
  } finally {
    restore();
  }
});

test('xai title capped at 500 chars, snippet at 8000', async () => {
  const { restore } = mockFetch(async () =>
    jsonResponse({
      output: [messageOutput('a')],
      citations: [{ url: 'https://example.com/a', title: `T${'x'.repeat(600)}`, snippet: `S${'y'.repeat(9000)}` }],
    }),
  );
  try {
    const out = await xaiSearchAdapter.search(input());
    assert.equal(out.hits[0]!.title.length, 500);
    assert.equal(out.hits[0]!.snippet.length, 8000);
  } finally {
    restore();
  }
});

test('xai malformed rows dropped; non-http urls skipped', async () => {
  const { restore } = mockFetch(async () =>
    jsonResponse({
      output: [
        messageOutput('answer'),
        { type: 'web_search_call', sources: [42, null, { url: 'ftp://example.com/x' }, { url: 'https://example.com/ok', title: 'Ok' }] },
        'stray',
        null,
      ],
      citations: [false, { title: 'no-url' }],
    }),
  );
  try {
    const out = await xaiSearchAdapter.search(input());
    assert.equal(out.hits.length, 1);
    assert.equal(out.hits[0]!.url, 'https://example.com/ok');
  } finally {
    restore();
  }
});

test('xai empty answer and no sources rejects as invalid', async () => {
  const { calls, restore } = mockFetch(async () => jsonResponse({ output: [], citations: [] }));
  try {
    await assert.rejects(() => xaiSearchAdapter.search(input()), /invalid response/);
    assert.equal(calls.length, 1);
  } finally {
    restore();
  }
});

test('xai non-object envelope rejects as invalid', async () => {
  const { restore } = mockFetch(async () => jsonResponse([1, 2]));
  try {
    await assert.rejects(() => xaiSearchAdapter.search(input()), /invalid response/);
  } finally {
    restore();
  }
});

test('xai 3xx rejected without retry', async () => {
  const { calls, restore } = mockFetch(async () => new Response(null, { status: 302, headers: { location: 'https://example.com' } }));
  try {
    await assert.rejects(() => xaiSearchAdapter.search(input()), /Redirect rejected/);
    assert.equal(calls.length, 1);
  } finally {
    restore();
  }
});

test('xai 401, 429, 500 fail once with safe status-only errors', async () => {
  for (const status of [401, 429, 500]) {
    const { calls, restore } = mockFetch(async () => jsonResponse({ error: 'spending-limit detail' }, status));
    try {
      const error = await xaiSearchAdapter.search(input()).then(
        () => null,
        (e: unknown) => e as Error,
      );
      assert.ok(error instanceof Error, `status ${status} must throw`);
      assert.match(error.message, new RegExp(`HTTP ${status}`));
      assert.ok(!error.message.includes(SECRET), 'key must not leak');
      assert.ok(!error.message.includes('spending-limit'), 'upstream body must not leak');
      assert.equal(calls.length, 1, `status ${status} must not retry`);
    } finally {
      restore();
    }
  }
});

test('xai 403 spending-limit body never leaks', async () => {
  const { restore } = mockFetch(async () =>
    jsonResponse({ error: { message: 'exceeded your spending limit', key: SECRET } }, 403),
  );
  try {
    const error = await xaiSearchAdapter.search(input()).then(
      () => null,
      (e: unknown) => e as Error,
    );
    assert.ok(error instanceof Error);
    assert.match(error.message, /HTTP 403/);
    const serialized = JSON.stringify(error.message);
    assert.ok(!serialized.includes(SECRET), 'key must not leak');
    assert.ok(!serialized.includes('spending'), 'upstream body must not leak');
  } finally {
    restore();
  }
});

test('xai oversized JSON rejected', async () => {
  const { calls, restore } = mockFetch(
    async () => new Response('x', { status: 200, headers: { 'content-length': '2000000' } }),
  );
  try {
    await assert.rejects(() => xaiSearchAdapter.search(input()), /too large|exceeded size limit/);
    assert.equal(calls.length, 1);
  } finally {
    restore();
  }
});

test('xai caller abort propagates', async () => {
  const controller = new AbortController();
  controller.abort();
  const { calls, restore } = mockFetch(async (_url, init) => {
    init?.signal?.throwIfAborted();
    return jsonResponse({ output: [] });
  });
  try {
    await assert.rejects(() => xaiSearchAdapter.search(input({ signal: controller.signal })));
    assert.equal(calls.length, 0);
  } finally {
    restore();
  }
});

test('xai answer discarded when native answers disabled or no supporting urls', async () => {
  const body = { output: [messageOutput('  answer text  ')], citations: ['https://example.com/a'] };
  const { restore } = mockFetch(async () => jsonResponse(body));
  try {
    const off = await xaiSearchAdapter.search(input({ nativeAi: { summaries: false, answers: false } }));
    assert.equal(off.hits.length, 1);
    assert.deepEqual(off.generatedText, []);
    const on = await xaiSearchAdapter.search(input());
    assert.equal(on.generatedText.length, 1);
    const answer = on.generatedText[0] as { kind: string; backend: string; text: string; provenance: { kind: string; urls: string[] }; claimCitations: false };
    assert.deepEqual(answer, {
      kind: 'answer',
      backend: 'xai',
      text: 'answer text',
      provenance: { kind: 'supporting_result_set', urls: ['https://example.com/a'] },
      claimCitations: false,
    });
  } finally {
    restore();
  }
  // Answer with no supporting URLs yields empty generatedText (hits empty, nothing to cite).
  const noUrl = mockFetch(async () => jsonResponse({ output: [messageOutput('orphan answer')], citations: [] }));
  try {
    const out = await xaiSearchAdapter.search(input());
    assert.equal(out.hits.length, 0);
    assert.deepEqual(out.generatedText, []);
  } finally {
    noUrl.restore();
  }
});
