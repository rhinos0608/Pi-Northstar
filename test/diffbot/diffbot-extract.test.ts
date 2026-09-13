import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  ANALYZE_FALLBACK_BUDGET_DEFAULT,
  ANALYZE_FALLBACK_BUDGET_MAX,
  DIFFBOT_ANALYZE_FIELDS,
  analyzePage,
  createAnalyzeBudget,
  resolveAnalyzeBudget,
} from '../../src/diffbot/diffbot-extract.js';
import { DiffbotError } from '../../src/diffbot/diffbot-transport.js';

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

/** DNS lookup stub resolving everything to a public IP. */
function publicLookup() {
  return async () => [{ address: '93.184.216.34', family: 4 as const }];
}

function analyzeBody(overrides: Record<string, unknown> = {}): unknown {
  return {
    request: { api: 'analyze' },
    objects: [
      {
        type: 'article',
        title: 'Example Title',
        pageUrl: 'https://example.com/article',
        text: 'Hello world content.',
        links: ['https://example.com/related', 'https://example.org/other'],
        ...overrides,
      },
    ],
  };
}

test('fixed Analyze fields are allContent,links', () => {
  assert.equal(DIFFBOT_ANALYZE_FIELDS, 'allContent,links');
});

test('budget defaults to 3 with ceiling 25', () => {
  assert.equal(ANALYZE_FALLBACK_BUDGET_DEFAULT, 3);
  assert.equal(ANALYZE_FALLBACK_BUDGET_MAX, 25);
  assert.equal(resolveAnalyzeBudget({}), 3);
  assert.equal(resolveAnalyzeBudget({ DIFFBOT_FALLBACK_BUDGET: '5' }), 5);
  assert.equal(resolveAnalyzeBudget({ DIFFBOT_FALLBACK_BUDGET: '0' }), 0);
  assert.equal(resolveAnalyzeBudget({ DIFFBOT_FALLBACK_BUDGET: '' }), 3);
  assert.throws(() => resolveAnalyzeBudget({ DIFFBOT_FALLBACK_BUDGET: '26' }), /out of range/);
  assert.throws(() => resolveAnalyzeBudget({ DIFFBOT_FALLBACK_BUDGET: '-1' }), /out of range/);
  assert.throws(() => resolveAnalyzeBudget({ DIFFBOT_FALLBACK_BUDGET: 'abc' }), /out of range/);
});

test('budget primitive counts per-call consumption; zero disables', () => {
  const budget = createAnalyzeBudget(2);
  assert.equal(budget.remaining, 2);
  assert.equal(budget.tryConsume(), true);
  assert.equal(budget.remaining, 1);
  assert.equal(budget.tryConsume(), true);
  assert.equal(budget.remaining, 0);
  assert.equal(budget.tryConsume(), false);
  assert.equal(budget.remaining, 0);

  const zero = createAnalyzeBudget(0);
  assert.equal(zero.tryConsume(), false);
});

test('createAnalyzeBudget defaults to operator env', () => {
  assert.equal(createAnalyzeBudget(undefined, { DIFFBOT_FALLBACK_BUDGET: '2' }).remaining, 2);
  assert.equal(createAnalyzeBudget(undefined, {}).remaining, 3);
});

test('GET Analyze with url + allContent,links; normalizes page', async () => {
  let seenUrl = '';
  const restore = mockFetch((url) => {
    seenUrl = url;
    return jsonResponse(analyzeBody());
  });
  try {
    const page = await analyzePage('https://example.com/article', {
      token: SENTINEL,
      lookup: publicLookup(),
    });
    assert.equal(page.url, 'https://example.com/article');
    assert.equal(page.title, 'Example Title');
    assert.equal(page.content, 'Hello world content.');
    assert.deepEqual(page.links, ['https://example.com/related', 'https://example.org/other']);
    const parsed = new URL(seenUrl);
    assert.equal(`${parsed.origin}${parsed.pathname}`, 'https://api.diffbot.com/v3/analyze');
    assert.equal(parsed.searchParams.get('fields'), 'allContent,links');
    assert.equal(parsed.searchParams.get('url'), 'https://example.com/article');
    assert.ok(seenUrl.includes('token='), 'Analyze GET must carry ?token= auth');
    assert.ok(!JSON.stringify(page).includes(SENTINEL), 'normalized page leaks token');
  } finally {
    restore();
  }
});

test('normalizes title/url fallbacks and object link entries', async () => {
  const restore = mockFetch(() =>
    jsonResponse(
      analyzeBody({
        title: undefined,
        name: 'Fallback Name',
        pageUrl: undefined,
        resolvedPageUrl: 'https://example.com/resolved',
        links: [{ href: 'https://example.com/a' }, { url: 'https://example.com/b' }, 42, ''],
      }),
    ),
  );
  try {
    const page = await analyzePage('https://example.com/article', {
      token: SENTINEL,
      lookup: publicLookup(),
    });
    assert.equal(page.title, 'Fallback Name');
    assert.equal(page.url, 'https://example.com/resolved');
    assert.deepEqual(page.links, ['https://example.com/a', 'https://example.com/b']);
  } finally {
    restore();
  }
});

test('private target URL rejected before submission without network', async () => {
  let calls = 0;
  const restore = mockFetch(() => {
    calls += 1;
    return jsonResponse(analyzeBody());
  });
  try {
    await assert.rejects(
      analyzePage('http://localhost:3000/debug', { token: SENTINEL, lookup: publicLookup() }),
    );
    await assert.rejects(
      analyzePage('http://169.254.169.254/latest/meta-data/', { token: SENTINEL, lookup: publicLookup() }),
    );
    assert.equal(calls, 0);
  } finally {
    restore();
  }
});

test('DNS resolving to private address rejects without submission', async () => {
  let calls = 0;
  const restore = mockFetch(() => {
    calls += 1;
    return jsonResponse(analyzeBody());
  });
  try {
    await assert.rejects(
      analyzePage('https://example.com/article', {
        token: SENTINEL,
        lookup: async () => [{ address: '10.0.0.5', family: 4 as const }],
      }),
    );
    assert.equal(calls, 0);
  } finally {
    restore();
  }
});

test('exhausted budget throws without network', async () => {
  let calls = 0;
  const restore = mockFetch(() => {
    calls += 1;
    return jsonResponse(analyzeBody());
  });
  try {
    await assert.rejects(
      analyzePage('https://example.com/article', {
        token: SENTINEL,
        lookup: publicLookup(),
        budget: createAnalyzeBudget(0),
      }),
      (err: unknown) => err instanceof DiffbotError && err.code === 'unsupported_option',
    );
    assert.equal(calls, 0);
  } finally {
    restore();
  }
});

test('empty objects rejects as contract error without token leak', async () => {
  const restore = mockFetch(() => jsonResponse({ request: {}, objects: [] }));
  try {
    await assert.rejects(
      analyzePage('https://example.com/article', { token: SENTINEL, lookup: publicLookup() }),
      (err: unknown) => {
        assert.ok(err instanceof DiffbotError);
        assert.ok(!err.message.includes(SENTINEL), 'sentinel token leaked');
        return true;
      },
    );
  } finally {
    restore();
  }
});

test('empty content rejects as semantic error', async () => {
  const restore = mockFetch(() => jsonResponse(analyzeBody({ text: '   ' })));
  try {
    await assert.rejects(
      analyzePage('https://example.com/article', { token: SENTINEL, lookup: publicLookup() }),
      (err: unknown) => err instanceof DiffbotError && err.code === 'semantic_invalid_response',
    );
  } finally {
    restore();
  }
});

test('analyzePage falls back to allContent when text is omitted', async () => {
  const restore = mockFetch(() => jsonResponse(analyzeBody({ text: undefined, allContent: 'Fallback body words.' })));
  try {
    const page = await analyzePage('https://example.com/article', { token: SENTINEL, lookup: publicLookup() });
    assert.equal(page.content, 'Fallback body words.');
  } finally {
    restore();
  }
});

test('upstream envelope error carries no token or email selector', async () => {
  const restore = mockFetch(() =>
    jsonResponse({ error: `bad token for user@example.com ${SENTINEL}`, errorCode: 401 }),
  );
  try {
    await assert.rejects(
      analyzePage('https://example.com/article', { token: SENTINEL, lookup: publicLookup() }),
      (err: unknown) => {
        assert.ok(err instanceof Error);
        assert.ok(!err.message.includes(SENTINEL), 'sentinel token leaked');
        assert.ok(!err.message.includes('user@example.com'), 'email selector leaked');
        return true;
      },
    );
  } finally {
    restore();
  }
});
