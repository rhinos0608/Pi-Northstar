import assert from 'node:assert/strict';
import { test } from 'node:test';
import { callNativeTool } from '../src/native-tools.js';

const PAGE_HTML =
  '<html><head><title>Cacheable Article</title></head>' +
  '<body><article><p>Cacheable article body words for retrieve roundtrip.</p></article></body></html>';

function seamOptions() {
  return {
    env: {},
    lookup: async () => [{ address: '93.184.216.34', family: 4 as const }],
    fetchPageText: async () => PAGE_HTML,
  } as unknown as Parameters<typeof callNativeTool>[2];
}

function responseIdOf(result: unknown): string {
  const details = (result as { details?: { responseId?: unknown } }).details;
  assert.equal(typeof details?.responseId, 'string', 'fetch must issue a responseId');
  return details!.responseId as string;
}

test('fetch read populates the retrieve cache (cache-only retrieve serves it)', async () => {
  const fetched = await callNativeTool('fetch', { url: 'https://example.com/article' }, seamOptions());
  const responseId = responseIdOf(fetched);
  const out = await callNativeTool('fetch', { action: 'retrieve', responseId }, { env: {} });
  assert.ok(JSON.stringify(out).includes('Cacheable article body words'), 'cached corpus must serve fetched content');
});

test('fetch urls array populates one corpus entry per URL', async () => {
  const fetched = await callNativeTool(
    'fetch',
    { urls: ['https://example.com/a', 'https://example.com/b'] },
    seamOptions(),
  );
  const responseId = responseIdOf(fetched);
  const out = await callNativeTool(
    'fetch',
    { action: 'retrieve', responseId, sourceIds: ['s-1-0'] },
    { env: {} },
  );
  const details = (out as { details?: { sources?: Array<{ sourceId: string; url: string }> } }).details;
  assert.deepEqual(details?.sources?.map((s) => s.sourceId), ['s-1-0']);
  assert.equal(details?.sources?.[0]?.url, 'https://example.com/b');
});

test('fetch array failure isolates per URL and still caches prior results', async () => {
  const fetched = await callNativeTool(
    'fetch',
    { urls: ['https://example.com/ok', 'http://127.0.0.1:9/nope'] },
    seamOptions(),
  );
  const text = JSON.stringify(fetched);
  assert.match(text, /Cacheable article body words/);
  assert.match(text, /127\.0\.0\.1/);
  const responseId = responseIdOf(fetched);
  const out = await callNativeTool('fetch', { action: 'retrieve', responseId }, { env: {} });
  assert.ok(JSON.stringify(out).includes('https://example.com/ok'));
});

test('fetch rejects hidden provider control', async () => {
  await assert.rejects(
    () => callNativeTool('fetch', { url: 'https://example.com/a', provider: 'tavily' }, { env: {} }),
    /operator-only/,
  );
});

test('fetch routes feed urls through the feeds subsystem', async () => {
  const savedFetch = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response(
      '<rss><channel><item><title>Feed Item Alpha</title><link>https://example.com/alpha</link></item></channel></rss>',
      { status: 200, headers: { 'content-type': 'application/rss+xml' } },
    )) as typeof fetch;
  try {
    const out = await callNativeTool('fetch', { url: 'https://example.com/feed.xml' }, { env: {} });
    assert.match(JSON.stringify(out), /Feed Item Alpha/);
  } finally {
    globalThis.fetch = savedFetch;
  }
});

test('fetch routes media urls through the media subsystem (keyless oEmbed)', async () => {
  const savedFetch = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = String(input);
    if (url.startsWith('https://www.youtube.com/oembed')) {
      return new Response(JSON.stringify({ title: 'OEmbed Special', author_name: 'Chan' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    throw new Error(`unexpected fetch ${url}`);
  }) as typeof fetch;
  try {
    const out = await callNativeTool('fetch', { url: 'https://www.youtube.com/watch?v=oemb1' }, { env: {} });
    assert.match(JSON.stringify(out), /OEmbed Special/);
  } finally {
    globalThis.fetch = savedFetch;
  }
});

test('fetch github urls fall back to the page reader when the github tool cannot serve them', async () => {
  // No token and a non-mapping shape (issues URL): must not throw, page reader serves via seam.
  const out = await callNativeTool(
    'fetch',
    { url: 'https://github.com/o/r/issues/1' },
    seamOptions(),
  );
  assert.match(JSON.stringify(out), /Cacheable article body words/);
});

test('parseGithubFetchUrl maps repo/blob shapes and declines the rest', async () => {
  const { parseGithubFetchUrl } = await import('../src/native-tools.js');
  assert.deepEqual(parseGithubFetchUrl('https://github.com/o/r'), { action: 'repo', owner: 'o', repo: 'r' });
  assert.deepEqual(parseGithubFetchUrl('https://github.com/o/r/blob/main/src/a.ts'), {
    action: 'file',
    owner: 'o',
    repo: 'r',
    path: 'src/a.ts',
    ref: 'main',
  });
  assert.deepEqual(parseGithubFetchUrl('https://github.com/o/r/tree/main/docs'), {
    action: 'tree',
    owner: 'o',
    repo: 'r',
    path: 'docs',
    ref: 'main',
  });
  assert.equal(parseGithubFetchUrl('https://github.com/o/r/issues/1'), undefined);
  assert.equal(parseGithubFetchUrl('https://example.com/o/r'), undefined);
  assert.equal(parseGithubFetchUrl('not a url'), undefined);
});

test('cacheFetchForRetrieve roundtrips through retrieve with source identity', async () => {
  const { cacheFetchForRetrieve } = await import('../src/native-tools.js');
  const responseId = cacheFetchForRetrieve({
    query: 'roundtrip query',
    title: 'Roundtrip',
    url: 'https://example.com/roundtrip',
    snippet: 'roundtrip snippet',
    content: 'roundtrip full body text',
  });
  assert.ok(typeof responseId === 'string' && responseId.length > 0);
  const out = await callNativeTool('fetch', { action: 'retrieve', responseId }, { env: {} });
  const text = JSON.stringify(out);
  assert.match(text, /roundtrip full body text/);
  assert.match(text, /s-0-0/);
  assert.equal(cacheFetchForRetrieve({ query: '', title: 't', url: 'u', snippet: 's', content: 'c' }), undefined);
  assert.equal(cacheFetchForRetrieve({ query: 'q', title: 't', url: 'u', snippet: 's', content: '' }), undefined);
});
