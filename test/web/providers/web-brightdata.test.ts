import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  BRIGHTDATA_REQUEST_ENDPOINT,
  BRIGHTDATA_SEARCH_RESULT_MAX,
  BRIGHTDATA_ZONE_PATTERN,
  brightdataSearchAdapter,
} from '../../../src/web/providers/web-brightdata.js';
import type { WebProviderSearchInput } from '../../../src/web/web-search-types.js';

const SECRET = 'brightdata-secret-key-1';
const ZONE = 'serp-zone_1';

function input(overrides?: Partial<WebProviderSearchInput>): WebProviderSearchInput {
  return {
    query: 'transformer interpretability',
    limit: 5,
    env: { BRIGHTDATA_API_KEY: SECRET, BRIGHTDATA_SERP_ZONE: ZONE },
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
    const signal = init?.signal as AbortSignal | undefined;
    if (signal?.aborted) {
      const error = new Error('This operation was aborted');
      error.name = 'AbortError';
      throw error;
    }
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

test('brightdata configured: key+zone, blanks and malformed zone rejected', () => {
  assert.equal(brightdataSearchAdapter.id, 'brightdata');
  assert.equal(BRIGHTDATA_SEARCH_RESULT_MAX, 20);
  assert.ok(BRIGHTDATA_ZONE_PATTERN.test('abc-123_X'));
  assert.ok(!BRIGHTDATA_ZONE_PATTERN.test('bad zone!'));
  assert.equal(
    brightdataSearchAdapter.configured({ BRIGHTDATA_API_KEY: 'k', BRIGHTDATA_SERP_ZONE: ZONE }),
    true,
  );
  assert.equal(brightdataSearchAdapter.configured({ BRIGHTDATA_API_KEY: 'k' }), false);
  assert.equal(brightdataSearchAdapter.configured({ BRIGHTDATA_SERP_ZONE: ZONE }), false);
  assert.equal(
    brightdataSearchAdapter.configured({ BRIGHTDATA_API_KEY: 'k', BRIGHTDATA_SERP_ZONE: 'bad zone!' }),
    false,
  );
  assert.equal(brightdataSearchAdapter.configured({}), false);
});

test('brightdata unconfigured returns empty output without a call', async () => {
  const { calls, restore } = mockFetch(async () => jsonResponse({ organic: [] }));
  try {
    const out = await brightdataSearchAdapter.search(input({ env: {} }));
    assert.deepEqual(out, { backend: 'brightdata', hits: [], generatedText: [] });
    assert.equal(calls.length, 0);
  } finally {
    restore();
  }
});

test('brightdata invalid zone rejects before fetch', async () => {
  const { calls, restore } = mockFetch(async () => jsonResponse({ organic: [] }));
  try {
    await assert.rejects(
      () =>
        brightdataSearchAdapter.search(
          input({ env: { BRIGHTDATA_API_KEY: SECRET, BRIGHTDATA_SERP_ZONE: 'bad zone!' } }),
        ),
      /SERP zone is invalid/,
    );
    assert.equal(calls.length, 0);
  } finally {
    restore();
  }
});

test('brightdata exact endpoint, POST Bearer, parsed_light/brd_json triple', async () => {
  const { calls, restore } = mockFetch(async () => jsonResponse({ organic: [] }));
  try {
    await brightdataSearchAdapter.search(input());
    assert.equal(calls.length, 1);
    assert.equal(calls[0]!.url, BRIGHTDATA_REQUEST_ENDPOINT);
    assert.equal(calls[0]!.init?.method, 'POST');
    const headers = calls[0]!.init?.headers as Record<string, string>;
    assert.equal(headers.Authorization, `Bearer ${SECRET}`);
    const body = JSON.parse(String(calls[0]!.init?.body)) as Record<string, unknown>;
    assert.equal(body.zone, ZONE);
    assert.equal(body.format, 'raw');
    assert.equal(body.data_format, 'parsed_light');
    const serp = new URL(String(body.url));
    assert.equal(serp.origin + serp.pathname, 'https://www.google.com/search');
    assert.equal(serp.searchParams.get('q'), 'transformer interpretability');
    assert.equal(serp.searchParams.get('num'), '10');
    assert.equal(serp.searchParams.get('brd_json'), '1');
    assert.equal(serp.searchParams.get('tbs'), null);
  } finally {
    restore();
  }
});

test('brightdata recency maps to tbs, domains rewrite q with site: plus headroom', async () => {
  const { calls, restore } = mockFetch(async () => jsonResponse({ organic: [] }));
  try {
    await brightdataSearchAdapter.search(input({ recency: 'day', domains: ['example.com', '-evil.com'] }));
    const body = JSON.parse(String(calls[0]!.init?.body)) as Record<string, unknown>;
    const serp = new URL(String(body.url));
    assert.equal(serp.searchParams.get('tbs'), 'qdr:d');
    assert.equal(serp.searchParams.get('q'), 'transformer interpretability site:example.com -site:evil.com');
    assert.equal(serp.searchParams.get('num'), '10');
  } finally {
    restore();
  }
});

test('brightdata hostname post-filter excludes non-matching and evil hosts', async () => {
  const { restore } = mockFetch(async () =>
    jsonResponse({
      organic: [
        { title: 'Keep', link: 'https://example.com/a', description: 'kept' },
        { title: 'Other', link: 'https://other.com/a', description: 'dropped by include filter' },
        { title: 'Evil', link: 'https://evil.com/a', description: 'dropped by exclude filter' },
        { title: 'EvilSub', link: 'https://sub.evil.com/a', description: 'dropped subdomain' },
      ],
    }),
  );
  try {
    const out = await brightdataSearchAdapter.search(input({ domains: ['example.com', '-evil.com'] }));
    assert.equal(out.hits.length, 1);
    assert.equal(out.hits[0]!.url, 'https://example.com/a');
    const urls = out.hits.map((h) => h.url).join('\n');
    assert.ok(!urls.includes('other.com'), 'other.com excluded');
    assert.ok(!urls.includes('evil.com'), 'evil.com excluded');
  } finally {
    restore();
  }
});

test('brightdata maps organic link/title/description, skips link-less rows', async () => {
  const { restore } = mockFetch(async () =>
    jsonResponse({
      organic: [
        { title: 'T', link: 'https://example.com/a', description: 'bright excerpt' },
        { title: 'NoLink', description: 'x' },
      ],
    }),
  );
  try {
    const out = await brightdataSearchAdapter.search(input());
    assert.equal(out.backend, 'brightdata');
    assert.deepEqual(out.generatedText, []);
    assert.equal(out.hits.length, 1);
    assert.deepEqual(out.hits[0], {
      title: 'T',
      url: 'https://example.com/a',
      snippet: 'bright excerpt',
      backend: 'brightdata',
    });
    assert.ok(!JSON.stringify(out).includes(SECRET));
  } finally {
    restore();
  }
});

test('brightdata billed-200 error envelope rejects as invalid response', async () => {
  const { calls, restore } = mockFetch(async () =>
    jsonResponse({ error: 'zone not found', code: 'zone_missing' }),
  );
  try {
    await assert.rejects(() => brightdataSearchAdapter.search(input()), (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /invalid response/);
      assert.ok(!error.message.includes(SECRET), 'key must not leak into error');
      return true;
    });
    assert.equal(calls.length, 1);
  } finally {
    restore();
  }
});

test('brightdata missing organic array rejects', async () => {
  const { restore } = mockFetch(async () => jsonResponse({ results: [] }));
  try {
    await assert.rejects(() => brightdataSearchAdapter.search(input()), /expected organic array/);
  } finally {
    restore();
  }
});

test('brightdata 3xx rejects with one call', async () => {
  const { calls, restore } = mockFetch(
    async () => new Response(null, { status: 302, headers: { location: 'https://example.com/' } }),
  );
  try {
    await assert.rejects(() => brightdataSearchAdapter.search(input()), /Redirect rejected/);
    assert.equal(calls.length, 1);
  } finally {
    restore();
  }
});

test('brightdata 401/429/500 throw safe status-only errors naming zone, one call each', async () => {
  for (const status of [401, 429, 500]) {
    const { calls, restore } = mockFetch(async () => jsonResponse({ message: 'denied' }, status));
    try {
      await assert.rejects(() => brightdataSearchAdapter.search(input({ limit: 3 })), (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.equal(error.message, `Bright Data search failed with HTTP ${status} for zone ${ZONE}`);
        assert.ok(!error.message.includes(SECRET));
        return true;
      });
      assert.equal(calls.length, 1);
    } finally {
      restore();
    }
  }
});

test('brightdata oversized JSON rejects safe', async () => {
  const { calls, restore } = mockFetch(
    async () => new Response('x', { status: 200, headers: { 'content-length': '2000000' } }),
  );
  try {
    await assert.rejects(() => brightdataSearchAdapter.search(input()), (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.ok(!error.message.includes(SECRET));
      return true;
    });
    assert.equal(calls.length, 1);
  } finally {
    restore();
  }
});

test('brightdata caller abort propagates', async () => {
  const controller = new AbortController();
  controller.abort();
  const { restore } = mockFetch(async () => jsonResponse({ organic: [] }));
  try {
    await assert.rejects(() => brightdataSearchAdapter.search(input({ signal: controller.signal })));
  } finally {
    restore();
  }
});

test('brightdata empty organic succeeds empty', async () => {
  const { restore } = mockFetch(async () => jsonResponse({ organic: [] }));
  try {
    const out = await brightdataSearchAdapter.search(input());
    assert.deepEqual(out, { backend: 'brightdata', hits: [], generatedText: [] });
  } finally {
    restore();
  }
});
