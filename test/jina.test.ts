import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  JINA_READER_PREFIX,
  JINA_SEARCH_ENDPOINT,
  JINA_SEARCH_RESULT_MAX,
  jinaFetchAdapter,
  jinaSearchAdapter,
} from '../src/jina.js';

const SENTINEL = 'jina-sentinel-key-abc123';
const ENV = { JINA_API_KEY: SENTINEL } as Record<string, string | undefined>;

import { jsonResponse, mockFetch } from './web-provider-test-utils.js';

function searchRow(i: number): Record<string, unknown> {
  return {
    url: `https://example.com/page-${i}`,
    title: `Title ${i}`,
    content: `Content snippet ${i}`,
  };
}

function publicLookup() {
  return async () => [{ address: '93.184.216.34', family: 4, port: 0 }];
}

test('search uses exact fixed origin, encoded query, bearer auth, no cookie headers', async () => {
  const mocked = mockFetch(() => jsonResponse({ data: [searchRow(1)] }));
  try {
    const out = await jinaSearchAdapter.search({
      query: 'hello world & more?',
      limit: 5,
      env: ENV,
      nativeAi: { summaries: true, answers: true },
    });
    assert.equal(mocked.calls.length, 1);
    const call = mocked.calls[0]!;
    assert.equal(call.url, `${JINA_SEARCH_ENDPOINT}?q=${encodeURIComponent('hello world & more?')}`);
    assert.equal(call.init.method, 'GET');
    const headers = call.init.headers as Record<string, string>;
    assert.equal(headers.Accept, 'application/json');
    assert.equal(headers.Authorization, `Bearer ${SENTINEL}`);
    assert.ok(!('Cookie' in headers || 'cookie' in headers));
    assert.ok(!('X-Set-Cookie' in headers));
    assert.equal(out.backend, 'jina');
    assert.equal(out.hits.length, 1);
    assert.deepEqual(out.generatedText, []);
  } finally {
    mocked.restore();
  }
});

test('search caps at five rows and honors smaller limit', async () => {
  const rows = [1, 2, 3, 4, 5, 6, 7].map(searchRow);
  const mocked = mockFetch(() => jsonResponse({ data: rows }));
  try {
    const full = await jinaSearchAdapter.search({
      query: 'q', limit: 10, env: ENV, nativeAi: { summaries: true, answers: true },
    });
    assert.equal(full.hits.length, JINA_SEARCH_RESULT_MAX);
    assert.equal(JINA_SEARCH_RESULT_MAX, 5);
    assert.equal(mocked.calls.length, 1);
  } finally {
    mocked.restore();
  }
  const mocked2 = mockFetch(() => jsonResponse({ data: rows }));
  try {
    const small = await jinaSearchAdapter.search({
      query: 'q', limit: 2, env: ENV, nativeAi: { summaries: true, answers: true },
    });
    assert.equal(small.hits.length, 2);
  } finally {
    mocked2.restore();
  }
});

test('search drops malformed siblings, keeps valid rows', async () => {
  const mocked = mockFetch(() => jsonResponse({ data: [
    { url: 'not-a-url', title: 'bad', content: 'x' },
    { url: 'https://example.com/good', title: 'Good', description: 'Desc here' },
    { noUrl: true },
    { url: 'https://example.com/empty', title: 'Empty' },
  ] }));
  try {
    const out = await jinaSearchAdapter.search({
      query: 'q', limit: 5, env: ENV, nativeAi: { summaries: true, answers: true },
    });
    assert.equal(out.hits.length, 1);
    assert.equal(out.hits[0]!.url, 'https://example.com/good');
    assert.equal(out.hits[0]!.snippet, 'Desc here');
  } finally {
    mocked.restore();
  }
});

test('search rejects invalid envelope (missing/non-array data)', async () => {
  for (const payload of [{ nope: 1 }, { data: 'str' }, { data: {} }, [1, 2]]) {
    const mocked = mockFetch(() => jsonResponse(payload));
    try {
      await assert.rejects(
        jinaSearchAdapter.search({ query: 'q', limit: 5, env: ENV, nativeAi: { summaries: true, answers: true } }),
        /Invalid Jina search response/,
      );
    } finally {
      mocked.restore();
    }
  }
});

test('search rejects redirects and 429/5xx with exactly one call, sentinel absent', async () => {
  const redirect = mockFetch(() => new Response(null, {
    status: 302, headers: { location: 'https://example.com/other' },
  }));
  try {
    await assert.rejects(
      jinaSearchAdapter.search({ query: 'q', limit: 5, env: ENV, nativeAi: { summaries: true, answers: true } }),
      /Redirect rejected/,
    );
    assert.equal(redirect.calls.length, 1);
  } finally {
    redirect.restore();
  }
  for (const status of [429, 500, 402]) {
    const mocked = mockFetch(() => jsonResponse({ error: 'x' }, status));
    try {
      const err = await jinaSearchAdapter.search({
        query: 'q', limit: 5, env: ENV, nativeAi: { summaries: true, answers: true },
      }).then(() => undefined, (e: unknown) => e);
      assert.ok(err instanceof Error);
      assert.ok(!String((err as Error).message).includes(SENTINEL));
      assert.equal(mocked.calls.length, 1);
    } finally {
      mocked.restore();
    }
  }
});

test('search requires configured key and non-empty query before any call', async () => {
  const mocked = mockFetch(() => jsonResponse({ data: [] }));
  try {
    await assert.rejects(
      jinaSearchAdapter.search({ query: 'q', limit: 5, env: {}, nativeAi: { summaries: true, answers: true } }),
      /not configured/,
    );
    await assert.rejects(
      jinaSearchAdapter.search({ query: '   ', limit: 5, env: ENV, nativeAi: { summaries: true, answers: true } }),
      /non-empty query/,
    );
    assert.equal(mocked.calls.length, 0);
    assert.equal(jinaSearchAdapter.configured({}), false);
    assert.equal(jinaSearchAdapter.configured({ JINA_API_KEY: '  ' }), false);
    assert.equal(jinaSearchAdapter.configured(ENV), true);
  } finally {
    mocked.restore();
  }
});

test('reader validates target and DNS before any vendor call', async () => {
  const mocked = mockFetch(() => jsonResponse({ data: { content: 'x' } }));
  try {
    await assert.rejects(
      jinaFetchAdapter.fetch({
        url: 'http://localhost:3000/private', env: ENV, timeoutMs: 15_000, lookup: publicLookup(),
      }),
      /Blocked hostname|Private/,
    );
    await assert.rejects(
      jinaFetchAdapter.fetch({
        url: 'https://example.com/?x=1', env: ENV, timeoutMs: 15_000,
        lookup: async () => [{ address: '10.0.0.5', family: 4, port: 0 }],
      }),
      /private\/reserved/,
    );
    await assert.rejects(
      jinaFetchAdapter.fetch({
        url: 'https://user:pass@example.com/', env: ENV, timeoutMs: 15_000, lookup: publicLookup(),
      }),
      /credentials/,
    );
    assert.equal(mocked.calls.length, 0);
  } finally {
    mocked.restore();
  }
});

test('reader builds fixed prefix URL, maps bounded fields, no generated text', async () => {
  const mocked = mockFetch((url) => {
    assert.equal(url, `${JINA_READER_PREFIX}https://example.com/article`);
    const headers = (mocked.calls.at(-1)!.init.headers ?? {}) as Record<string, string>;
    assert.equal(headers.Accept, 'application/json');
    assert.equal(headers.Authorization, `Bearer ${SENTINEL}`);
    assert.ok(!('Cookie' in headers));
    return jsonResponse({ data: {
      url: 'https://example.com/article',
      title: '  Article Title  ',
      content: '  Body text here.  ',
    } });
  });
  try {
    const page = await jinaFetchAdapter.fetch({
      url: 'https://example.com/article', env: ENV, timeoutMs: 15_000, lookup: publicLookup(),
    });
    assert.equal(page.url, 'https://example.com/article');
    assert.equal(page.title, 'Article Title');
    assert.equal(page.content, 'Body text here.');
    assert.equal(page.backend, 'jina');
    assert.equal(page.externalProcessing, true);
    assert.deepEqual(page.generatedText, []);
  } finally {
    mocked.restore();
  }
});

test('reader falls back to submitted URL when vendor url invalid; rejects empty content', async () => {
  const good = mockFetch(() => jsonResponse({ data: { url: 'ftp://x/y', title: 'T', content: 'kept' } }));
  try {
    const page = await jinaFetchAdapter.fetch({
      url: 'https://example.com/a', env: ENV, timeoutMs: 15_000, lookup: publicLookup(),
    });
    assert.equal(page.url, 'https://example.com/a');
  } finally {
    good.restore();
  }
  for (const payload of [{ data: { content: '   ' } }, { data: { title: 'no content' } }, { nodata: 1 }]) {
    const mocked = mockFetch(() => jsonResponse(payload));
    try {
      const err = await jinaFetchAdapter.fetch({
        url: 'https://example.com/a', env: ENV, timeoutMs: 15_000, lookup: publicLookup(),
      }).then(() => undefined, (e: unknown) => e);
      assert.ok(err instanceof Error);
      assert.ok(!String((err as Error).message).includes(SENTINEL));
    } finally {
      mocked.restore();
    }
  }
});

test('reader rejects redirects, oversize responses, and propagates abort; no retry', async () => {
  const redirect = mockFetch(() => new Response(null, {
    status: 301, headers: { location: 'https://example.com/x' },
  }));
  try {
    await assert.rejects(
      jinaFetchAdapter.fetch({ url: 'https://example.com/a', env: ENV, timeoutMs: 15_000, lookup: publicLookup() }),
      /Redirect rejected/,
    );
    assert.equal(redirect.calls.length, 1);
  } finally {
    redirect.restore();
  }
  const big = mockFetch(() => new Response('x'.repeat(100), {
    status: 200, headers: { 'content-length': '2000000' },
  }));
  try {
    await assert.rejects(
      jinaFetchAdapter.fetch({ url: 'https://example.com/a', env: ENV, timeoutMs: 15_000, lookup: publicLookup() }),
      /too large/,
    );
  } finally {
    big.restore();
  }
  const controller = new AbortController();
  const abortMock = mockFetch((_url, init) => {
    controller.abort();
    if ((init.signal as AbortSignal | undefined)?.aborted) {
      throw new DOMException('This operation was aborted', 'AbortError');
    }
    return jsonResponse({ data: { content: 'x' } });
  });
  try {
    await assert.rejects(
      jinaFetchAdapter.fetch({
        url: 'https://example.com/a', env: ENV, timeoutMs: 15_000, lookup: publicLookup(), signal: controller.signal,
      }),
    );
    assert.equal(abortMock.calls.length, 1, 'abort must occur at the reader request after DNS preflight');
  } finally {
    abortMock.restore();
  }
});

test('reader rejects out-of-range timeout and missing key before calls', async () => {
  const mocked = mockFetch(() => jsonResponse({ data: { content: 'x' } }));
  try {
    await assert.rejects(
      jinaFetchAdapter.fetch({ url: 'https://example.com/a', env: {}, timeoutMs: 15_000, lookup: publicLookup() }),
      /not configured/,
    );
    await assert.rejects(
      jinaFetchAdapter.fetch({ url: 'https://example.com/a', env: ENV, timeoutMs: 50, lookup: publicLookup() }),
      /timeoutMs/,
    );
    assert.equal(mocked.calls.length, 0);
    assert.equal(jinaFetchAdapter.configured(ENV), true);
  } finally {
    mocked.restore();
  }
});
