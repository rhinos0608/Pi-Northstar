import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DIFFBOT_LLM_HOST } from '../src/diffbot-transport.js';

const SENTINEL = 'SENTINEL_DIFFBOT_TOKEN_abc123xyz';

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

async function load(): Promise<typeof import('../src/diffbot-search.js')> {
  return import('../src/diffbot-search.js');
}

function webSearchBody() {
  return {
    search_results: [
      { score: 0.9, pageUrl: 'https://example.com/a', title: '  Alpha  ', content: '  snippet a  ', date: '2026-01-01' },
      { score: 0.8, pageUrl: 'https://example.com/b', title: 'Beta', content: 'snippet b' },
      { pageUrl: 'not-a-url', title: 'Bad', content: 'skip me' },
      { pageUrl: 'https://example.com/a', title: 'Alpha dup', content: 'dup' },
      { title: 'No URL', content: 'skip me too' },
    ],
    timeMs: 12,
  };
}

test('POSTs JSON with Bearer auth to fixed host, never ?token=', async () => {
  const mod = await load();
  let seenUrl = '';
  let seenMethod = '';
  let seenAuth: string | null = null;
  let seenContentType: string | null = null;
  let seenBody: Record<string, unknown> | undefined;
  const restore = mockFetch((url, init) => {
    seenUrl = url;
    seenMethod = String(init?.method ?? '');
    const headers = new Headers(init?.headers);
    seenAuth = headers.get('authorization');
    seenContentType = headers.get('content-type');
    seenBody = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
    return jsonResponse(webSearchBody());
  });
  try {
    await mod.searchDiffbot('latest AI news', 5, { DIFFBOT_TOKEN: SENTINEL });
    assert.ok(seenUrl.startsWith(`${DIFFBOT_LLM_HOST}/api/v1/web_search`), `unexpected url: ${seenUrl}`);
    assert.equal(seenMethod, 'POST');
    assert.equal(seenAuth, `Bearer ${SENTINEL}`);
    assert.ok(!seenUrl.includes('token='), 'bearer mode must not put token in query');
    assert.match(seenContentType ?? '', /application\/json/);
    assert.equal(seenBody?.text, 'latest AI news');
    assert.equal(seenBody?.size, 5);
  } finally {
    restore();
  }
});

test('normalizes search_results to WebResult rows, drops invalid urls, bounds to limit', async () => {
  const mod = await load();
  const restore = mockFetch(() => jsonResponse(webSearchBody()));
  try {
    const rows = await mod.searchDiffbot('q', 2, { DIFFBOT_TOKEN: SENTINEL });
    assert.equal(rows.length, 2);
    assert.deepEqual(rows[0], { title: 'Alpha', url: 'https://example.com/a', snippet: 'snippet a', source: 'diffbot' });
    assert.deepEqual(rows[1], { title: 'Beta', url: 'https://example.com/b', snippet: 'snippet b', source: 'diffbot' });
  } finally {
    restore();
  }
});

test('missing token returns [] without network', async () => {
  const mod = await load();
  let calls = 0;
  const restore = mockFetch(() => {
    calls += 1;
    return jsonResponse(webSearchBody());
  });
  try {
    assert.deepEqual(await mod.searchDiffbot('q', 5, {}), []);
    assert.deepEqual(await mod.searchDiffbot('q', 5, { DIFFBOT_TOKEN: '   ' }), []);
    assert.equal(calls, 0);
    assert.equal(mod.diffbotConfigured({}), false);
    assert.equal(mod.diffbotConfigured({ DIFFBOT_TOKEN: SENTINEL }), true);
  } finally {
    restore();
  }
});

test('non-object response rejects as contract_invalid_response without token leak', async () => {
  const mod = await load();
  const restore = mockFetch(() => jsonResponse([1, 2, 3]));
  try {
    await assert.rejects(
      mod.searchDiffbot('q', 5, { DIFFBOT_TOKEN: SENTINEL }),
      (err: unknown) => {
        assert.ok(err instanceof Error);
        assert.equal((err as { code?: string }).code, 'contract_invalid_response');
        assert.ok(!err.message.includes(SENTINEL), 'sentinel token leaked');
        return true;
      },
    );
  } finally {
    restore();
  }
});

test('missing results array rejects as contract_invalid_response', async () => {
  const mod = await load();
  const restore = mockFetch(() => jsonResponse({ timeMs: 1 }));
  try {
    await assert.rejects(
      mod.searchDiffbot('q', 5, { DIFFBOT_TOKEN: SENTINEL }),
      (err: unknown) => err instanceof Error && (err as { code?: string }).code === 'contract_invalid_response',
    );
  } finally {
    restore();
  }
});

test('empty query and out-of-range limit reject, never clamp', async () => {
  const mod = await load();
  await assert.rejects(mod.searchDiffbot('   ', 5, { DIFFBOT_TOKEN: SENTINEL }), /query is required/);
  await assert.rejects(mod.searchDiffbot('q', 0, { DIFFBOT_TOKEN: SENTINEL }), /limit must be an integer/);
  await assert.rejects(mod.searchDiffbot('q', 51, { DIFFBOT_TOKEN: SENTINEL }), /limit must be an integer/);
});

test('default DIFFBOT_SEARCH_SIZE caps Diffbot limit at 10, never clamps', async () => {
  const mod = await load();
  let calls = 0;
  let seenSize: unknown;
  const restore = mockFetch((_url, init) => {
    calls += 1;
    seenSize = (JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>).size;
    return jsonResponse(webSearchBody());
  });
  try {
    const rows = await mod.searchDiffbot('q', 10, { DIFFBOT_TOKEN: SENTINEL });
    assert.ok(rows.length > 0);
    assert.equal(seenSize, 10);
    assert.equal(calls, 1);
    await assert.rejects(
      mod.searchDiffbot('q', 11, { DIFFBOT_TOKEN: SENTINEL }),
      (err: unknown) => err instanceof Error && /DIFFBOT_SEARCH_SIZE/.test(err.message),
    );
    assert.equal(calls, 1, 'limit above default operator cap must reject without a paid call');
  } finally {
    restore();
  }
});

test('lower DIFFBOT_SEARCH_SIZE rejects limits above it without paid call', async () => {
  const mod = await load();
  let calls = 0;
  let seenSize: unknown;
  const restore = mockFetch((_url, init) => {
    calls += 1;
    seenSize = (JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>).size;
    return jsonResponse(webSearchBody());
  });
  try {
    const rows = await mod.searchDiffbot('q', 3, { DIFFBOT_TOKEN: SENTINEL, DIFFBOT_SEARCH_SIZE: '3' });
    assert.ok(rows.length > 0);
    assert.equal(seenSize, 3);
    await assert.rejects(
      mod.searchDiffbot('q', 4, { DIFFBOT_TOKEN: SENTINEL, DIFFBOT_SEARCH_SIZE: '3' }),
      (err: unknown) => err instanceof Error && /DIFFBOT_SEARCH_SIZE/.test(err.message),
    );
    assert.equal(calls, 1, 'limit above configured operator cap must reject without a paid call');
  } finally {
    restore();
  }
});

test('out-of-range or malformed DIFFBOT_SEARCH_SIZE rejects without paid call', async () => {
  const mod = await load();
  for (const size of ['0', '51', 'NaN', 'abc']) {
    let calls = 0;
    const restore = mockFetch(() => {
      calls += 1;
      return jsonResponse(webSearchBody());
    });
    try {
      await assert.rejects(
        mod.searchDiffbot('q', 5, { DIFFBOT_TOKEN: SENTINEL, DIFFBOT_SEARCH_SIZE: size }),
        /out of range|limit must be an integer|DIFFBOT_SEARCH_SIZE/,
      );
      assert.equal(calls, 0, `DIFFBOT_SEARCH_SIZE=${size} must reject without a paid call`);
    } finally {
      restore();
    }
  }
});

test('mapDiffbotResults tolerates data/results aliases and trims fields', async () => {
  const mod = await load();
  const rows = mod.mapDiffbotResults(
    { data: [{ url: 'https://example.com/x', snippet: '  s  ' }] },
    10,
  );
  assert.deepEqual(rows, [{ title: 'https://example.com/x', url: 'https://example.com/x', snippet: 's', source: 'diffbot' }]);
  assert.deepEqual(mod.mapDiffbotResults({ results: [] }, 10), []);
  assert.equal(mod.mapDiffbotResults({ search_results: 'nope' }, 10), undefined);
});

test('mapDiffbotResults returns duplicate URLs without dedupe when limit reaches both rows', async () => {
  const mod = await load();
  const rows = mod.mapDiffbotResults(
    {
      search_results: [
        { pageUrl: 'https://example.com/a', title: 'Alpha', content: 'first' },
        { pageUrl: 'https://example.com/a', title: 'Alpha dup', content: 'second' },
      ],
    },
    2,
  );
  assert.equal(rows?.length, 2);
  assert.deepEqual(rows?.map((row) => row.url), ['https://example.com/a', 'https://example.com/a']);
});
