import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  MISTRAL_CONVERSATIONS_ENDPOINT,
  MISTRAL_SEARCH_MODEL,
  MISTRAL_SEARCH_RESULT_MAX,
  mistralSearchAdapter,
} from '../src/web-mistral.js';
import type { WebProviderSearchInput } from '../src/web-search-types.js';

const SECRET = 'mistral-secret-key-1';

function input(overrides?: Partial<WebProviderSearchInput>): WebProviderSearchInput {
  return {
    query: 'transformer interpretability',
    limit: 5,
    env: { MISTRAL_API_KEY: SECRET },
    nativeAi: { summaries: false, answers: true },
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

function messageOutput(content: unknown): unknown {
  return { type: 'message.output', content };
}

test('mistral configured: key present, blank and absent rejected', () => {
  assert.equal(mistralSearchAdapter.id, 'mistral');
  assert.equal(MISTRAL_SEARCH_MODEL, 'mistral-small-latest');
  assert.equal(MISTRAL_SEARCH_RESULT_MAX, 20);
  assert.equal(mistralSearchAdapter.configured({ MISTRAL_API_KEY: 'k' }), true);
  assert.equal(mistralSearchAdapter.configured({ MISTRAL_API_KEY: '  ' }), false);
  assert.equal(mistralSearchAdapter.configured({}), false);
});

test('mistral unconfigured returns empty output without a call', async () => {
  const { calls, restore } = mockFetch(async () => jsonResponse({ outputs: [] }));
  try {
    const out = await mistralSearchAdapter.search(input({ env: {} }));
    assert.deepEqual(out, { backend: 'mistral', hits: [], generatedText: [] });
    assert.equal(calls.length, 0);
  } finally {
    restore();
  }
});

test('mistral exact endpoint, method, headers, body; no filter fields', async () => {
  const { calls, restore } = mockFetch(async () =>
    jsonResponse({ outputs: [messageOutput([{ type: 'tool_reference', url: 'https://example.com/a', title: 'A' }])] }),
  );
  try {
    await mistralSearchAdapter.search(
      input({ recency: 'month', domains: ['example.com'], includeContent: true, yearFrom: 2021 }),
    );
    assert.equal(calls.length, 1);
    assert.equal(calls[0]!.url, MISTRAL_CONVERSATIONS_ENDPOINT);
    assert.equal(calls[0]!.init?.method, 'POST');
    assert.equal(calls[0]!.init?.redirect, 'manual');
    const headers = calls[0]!.init?.headers as Record<string, string>;
    assert.equal(headers.Authorization, `Bearer ${SECRET}`);
    const body = JSON.parse(String(calls[0]!.init?.body));
    assert.deepEqual(body, {
      inputs: [{ role: 'user', content: 'transformer interpretability' }],
      stream: false,
      model: 'mistral-small-latest',
      tools: [{ type: 'web_search' }],
    });
  } finally {
    restore();
  }
});

test('mistral preserves tool_reference order and maps description to snippet', async () => {
  const { restore } = mockFetch(async () =>
    jsonResponse({
      outputs: [
        messageOutput([
          { type: 'tool_reference', url: 'https://example.com/first', title: 'First', description: 'first excerpt' },
          { type: 'text', text: 'native answer' },
          { type: 'tool_reference', url: 'https://example.com/second', title: 'Second', description: 'second excerpt' },
        ]),
      ],
    }),
  );
  try {
    const out = await mistralSearchAdapter.search(input());
    assert.deepEqual(
      out.hits,
      [
        { title: 'First', url: 'https://example.com/first', snippet: 'first excerpt', backend: 'mistral' },
        { title: 'Second', url: 'https://example.com/second', snippet: 'second excerpt', backend: 'mistral' },
      ],
    );
    assert.equal(out.generatedText.length, 1);
    assert.equal((out.generatedText[0] as { text: string }).text, 'native answer');
  } finally {
    restore();
  }
});

test('mistral string content answer plus duplicate urls deduped', async () => {
  const { restore } = mockFetch(async () =>
    jsonResponse({
      outputs: [
        messageOutput('  string answer  '),
        messageOutput([{ type: 'tool_reference', url: 'https://example.com/a', title: 'A' }]),
        messageOutput([{ type: 'tool_reference', url: 'https://example.com/a', title: 'A2' }]),
      ],
    }),
  );
  try {
    const out = await mistralSearchAdapter.search(input());
    assert.equal(out.hits.length, 1);
    assert.equal(out.hits[0]!.title, 'A');
    const answer = out.generatedText[0] as { kind: string; backend: string; text: string; provenance: { kind: string; urls: string[] }; claimCitations: false };
    assert.deepEqual(answer, {
      kind: 'answer',
      backend: 'mistral',
      text: 'string answer',
      provenance: { kind: 'supporting_result_set', urls: ['https://example.com/a'] },
      claimCitations: false,
    });
  } finally {
    restore();
  }
});

test('mistral caps hits at 20 for limit above max', async () => {
  const refs = Array.from({ length: 25 }, (_, i) => ({ type: 'tool_reference', url: `https://example.com/${i}`, title: `T${i}` }));
  const { restore } = mockFetch(async () => jsonResponse({ outputs: [messageOutput(refs)] }));
  try {
    const out = await mistralSearchAdapter.search(input({ limit: 50 }));
    assert.equal(out.hits.length, 20);
  } finally {
    restore();
  }
});

test('mistral title capped at 500 chars, description at 8000', async () => {
  const { restore } = mockFetch(async () =>
    jsonResponse({
      outputs: [
        messageOutput([
          { type: 'tool_reference', url: 'https://example.com/a', title: `T${'x'.repeat(600)}`, description: `D${'y'.repeat(9000)}` },
        ]),
      ],
    }),
  );
  try {
    const out = await mistralSearchAdapter.search(input());
    assert.equal(out.hits[0]!.title.length, 500);
    assert.equal(out.hits[0]!.snippet.length, 8000);
  } finally {
    restore();
  }
});

test('mistral malformed rows dropped; non-http urls skipped', async () => {
  const { restore } = mockFetch(async () =>
    jsonResponse({
      outputs: [
        messageOutput('answer'),
        messageOutput([
          { type: 'tool_reference', title: 'no-url' },
          { type: 'tool_reference', url: 'ftp://example.com/x', title: 'bad-scheme' },
          { type: 'tool_reference', url: 'https://example.com/ok', title: 'Ok' },
          42,
          null,
          { type: 'other', content: 'ignored' },
        ]),
        'stray',
        null,
      ],
    }),
  );
  try {
    const out = await mistralSearchAdapter.search(input());
    assert.equal(out.hits.length, 1);
    assert.equal(out.hits[0]!.url, 'https://example.com/ok');
  } finally {
    restore();
  }
});

test('mistral empty answer and no sources rejects as invalid', async () => {
  const { calls, restore } = mockFetch(async () => jsonResponse({ outputs: [] }));
  try {
    await assert.rejects(() => mistralSearchAdapter.search(input()), /invalid response/);
    assert.equal(calls.length, 1);
  } finally {
    restore();
  }
});

test('mistral missing outputs array rejects as invalid', async () => {
  for (const body of [{}, { outputs: 'nope' }, [1, 2]]) {
    const { restore } = mockFetch(async () => jsonResponse(body));
    try {
      await assert.rejects(() => mistralSearchAdapter.search(input()), /invalid response/);
    } finally {
      restore();
    }
  }
});

test('mistral 3xx rejected without retry', async () => {
  const { calls, restore } = mockFetch(async () => new Response(null, { status: 301, headers: { location: 'https://example.com' } }));
  try {
    await assert.rejects(() => mistralSearchAdapter.search(input()), /Redirect rejected/);
    assert.equal(calls.length, 1);
  } finally {
    restore();
  }
});

test('mistral 401, 429, 500 fail once with safe status-only errors', async () => {
  for (const status of [401, 429, 500]) {
    const { calls, restore } = mockFetch(async () => jsonResponse({ message: 'upstream detail' }, status));
    try {
      const error = await mistralSearchAdapter.search(input()).then(
        () => null,
        (e: unknown) => e as Error,
      );
      assert.ok(error instanceof Error, `status ${status} must throw`);
      assert.match(error.message, new RegExp(`HTTP ${status}`));
      assert.ok(!error.message.includes(SECRET), 'key must not leak');
      assert.ok(!error.message.includes('upstream detail'), 'upstream body must not leak');
      assert.equal(calls.length, 1, `status ${status} must not retry`);
    } finally {
      restore();
    }
  }
});

test('mistral oversized JSON rejected', async () => {
  const { calls, restore } = mockFetch(
    async () => new Response('x', { status: 200, headers: { 'content-length': '2000000' } }),
  );
  try {
    await assert.rejects(() => mistralSearchAdapter.search(input()), /too large|exceeded size limit/);
    assert.equal(calls.length, 1);
  } finally {
    restore();
  }
});

test('mistral caller abort propagates', async () => {
  const controller = new AbortController();
  controller.abort();
  const { calls, restore } = mockFetch(async (_url, init) => {
    init?.signal?.throwIfAborted();
    return jsonResponse({ outputs: [] });
  });
  try {
    await assert.rejects(() => mistralSearchAdapter.search(input({ signal: controller.signal })));
    assert.equal(calls.length, 1);
  } finally {
    restore();
  }
});

test('mistral answer discarded when native answers disabled', async () => {
  const body = {
    outputs: [messageOutput([{ type: 'text', text: 'native answer' }, { type: 'tool_reference', url: 'https://example.com/a', title: 'A' }])],
  };
  const { restore } = mockFetch(async () => jsonResponse(body));
  try {
    const out = await mistralSearchAdapter.search(input({ nativeAi: { summaries: false, answers: false } }));
    assert.equal(out.hits.length, 1);
    assert.deepEqual(out.generatedText, []);
  } finally {
    restore();
  }
});
