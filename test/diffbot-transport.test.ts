import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  DIFFBOT_API_HOST,
  DIFFBOT_KG_HOST,
  DIFFBOT_LLM_HOST,
  DIFFBOT_NL_HOST,
  diffbotFetch,
  redactDiffbotError,
  resolveDiffbotSpend,
} from '../src/diffbot-transport.js';

const SENTINEL = 'SENTINEL_DIFFBOT_TOKEN_abc123xyz';

function mockFetch(handler: (url: string, init?: RequestInit) => Response | Promise<Response>): () => void {
  const prev = globalThis.fetch;
  globalThis.fetch = (async (url: unknown, init?: RequestInit) => handler(String(url), init)) as typeof fetch;
  return () => {
    globalThis.fetch = prev;
  };
}

function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

test('fixed host constants cover the four Diffbot hosts', () => {
  assert.equal(DIFFBOT_LLM_HOST, 'https://llm.diffbot.com');
  assert.equal(DIFFBOT_KG_HOST, 'https://kg.diffbot.com');
  assert.equal(DIFFBOT_NL_HOST, 'https://nl.diffbot.com');
  assert.equal(DIFFBOT_API_HOST, 'https://api.diffbot.com');
});

test('rejects unknown host override with unsupported_option', async () => {
  await assert.rejects(
    // @ts-expect-error intentional hostile host
    diffbotFetch({ host: 'https://evil.example.com', path: '/x', token: SENTINEL }),
    (err: unknown) =>
      err instanceof Error && (err as { code?: string }).code === 'unsupported_option',
  );
});

test('query-token mode appends ?token= and Bearer mode uses header without query token', async () => {
  let seenUrl = '';
  let seenAuth: string | null = null;
  let restore = mockFetch((url, init) => {
    seenUrl = url;
    seenAuth = new Headers(init?.headers).get('authorization');
    return jsonResponse({ ok: true });
  });
  await diffbotFetch({ host: DIFFBOT_KG_HOST, path: '/kg/v3/dql', token: SENTINEL, query: { type: 'query' } });
  assert.match(seenUrl, /token=/);
  assert.ok(seenUrl.includes(encodeURIComponent(SENTINEL)) || seenUrl.includes(SENTINEL), 'query-token auth must carry token param');
  assert.equal(seenAuth, null);
  restore();

  restore = mockFetch((url, init) => {
    seenUrl = url;
    seenAuth = new Headers(init?.headers).get('authorization');
    return jsonResponse({ ok: true });
  });
  await diffbotFetch({ host: DIFFBOT_LLM_HOST, path: '/api/v1/web_search', token: SENTINEL, bearer: true, method: 'POST', body: { text: 'hi' } });
  assert.ok(!seenUrl.includes('token='), 'bearer mode must not put token in query');
  assert.equal(seenAuth, `Bearer ${SENTINEL}`);
  restore();
});

test('HTTP-200 error envelope rejects as upstream_error without token leak', async () => {
  const restore = mockFetch(() => jsonResponse({ error: 'bad token', errorCode: 401 }));
  try {
    await assert.rejects(
      diffbotFetch({ host: DIFFBOT_KG_HOST, path: '/kg/v3/dql', token: SENTINEL }),
      (err: unknown) => {
        assert.ok(err instanceof Error);
        assert.equal((err as { code?: string }).code, 'upstream_error');
        assert.equal((err as { retryable?: boolean }).retryable, false);
        assert.ok(!err.message.includes(SENTINEL), 'sentinel token leaked in envelope error');
        return true;
      },
    );
  } finally {
    restore();
  }
});

test('3xx redirect rejects, never follows, sentinel absent', async () => {
  let calls = 0;
  const restore = mockFetch(() => {
    calls += 1;
    return new Response('', { status: 302, headers: { location: 'https://kg.diffbot.com/other' } });
  });
  try {
    await assert.rejects(
      diffbotFetch({ host: DIFFBOT_KG_HOST, path: '/kg/v3/dql', token: SENTINEL }),
      (err: unknown) => {
        assert.ok(err instanceof Error);
        assert.match(err.message, /never forwarded/);
        assert.ok(!err.message.includes(SENTINEL), 'sentinel token leaked in redirect error');
        return true;
      },
    );
    assert.equal(calls, 1);
  } finally {
    restore();
  }
});

test('non-2xx error never contains sentinel token', async () => {
  const restore = mockFetch(() => jsonResponse({ error: 'forbidden' }, 403));
  try {
    await assert.rejects(
      diffbotFetch({ host: DIFFBOT_KG_HOST, path: '/kg/v3/dql', token: SENTINEL }),
      (err: unknown) => {
        assert.ok(err instanceof Error);
        assert.ok(!err.message.includes(SENTINEL), 'sentinel token leaked in non-2xx error');
        assert.equal((err as { retryable?: boolean }).retryable, false);
        return true;
      },
    );
  } finally {
    restore();
  }
});

test('redaction strips token and email, slices to 500 chars', () => {
  const long = `fail ${SENTINEL} contact user@example.com ${'x'.repeat(600)}`;
  const out = redactDiffbotError(long, SENTINEL);
  assert.ok(!out.includes(SENTINEL));
  assert.ok(!out.includes('user@example.com'));
  assert.ok(out.length <= 500);
});

test('spend resolver rejects out-of-range, never clamps; budget 0 disables', () => {
  assert.deepEqual(resolveDiffbotSpend({}), {
    searchSize: 10,
    enhanceSize: 1,
    nlpMaxChars: 100000,
    maxProviders: 3,
    fallbackBudget: 3,
  });
  assert.equal(resolveDiffbotSpend({ DIFFBOT_FALLBACK_BUDGET: '0' }).fallbackBudget, 0);
  assert.throws(() => resolveDiffbotSpend({ DIFFBOT_SEARCH_SIZE: '0' }), /out of range/);
  assert.throws(() => resolveDiffbotSpend({ DIFFBOT_SEARCH_SIZE: '51' }), /out of range/);
  assert.throws(() => resolveDiffbotSpend({ DIFFBOT_SEARCH_SIZE: 'NaN' }), /out of range/);
  assert.throws(() => resolveDiffbotSpend({ DIFFBOT_ENHANCE_SIZE: '11' }), /out of range/);
  assert.throws(() => resolveDiffbotSpend({ DIFFBOT_MAX_PROVIDERS: '9' }), /out of range/);
  assert.throws(() => resolveDiffbotSpend({ DIFFBOT_FALLBACK_BUDGET: '26' }), /out of range/);
});

test('timeout abort surfaces retryable transport error', async () => {
  const restore = mockFetch((_url, init) => {
    return new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new DOMException('The operation was aborted', 'AbortError')));
    });
  });
  try {
    await assert.rejects(
      diffbotFetch({ host: DIFFBOT_KG_HOST, path: '/kg/v3/dql', token: SENTINEL, timeoutMs: 20 }),
      (err: unknown) => {
        assert.ok(err instanceof Error);
        assert.equal((err as { retryable?: boolean }).retryable, true);
        assert.ok(!err.message.includes(SENTINEL));
        return true;
      },
    );
  } finally {
    restore();
  }
});

test('oversize body maps to non-retryable response_too_large', async () => {
  const restore = mockFetch(() => new Response('x'.repeat(100), { status: 200, headers: { 'content-length': '100' } }));
  try {
    await assert.rejects(
      diffbotFetch({ host: DIFFBOT_KG_HOST, path: '/kg/v3/dql', token: SENTINEL, maxBytes: 10 }),
      (err: unknown) => {
        assert.ok(err instanceof Error);
        assert.equal((err as { code?: string }).code, 'response_too_large');
        assert.equal((err as { retryable?: boolean }).retryable, false);
        return true;
      },
    );
  } finally {
    restore();
  }
});
