import assert from 'node:assert/strict';
import { test } from 'node:test';
import { callNativeTool } from '../src/native-tools.js';

const PAGE_HTML =
  '<html><head><title>NativeFetch Article</title></head>' +
  '<body><article><p>NativeFetch body words for retrieve roundtrip.</p></article></body></html>';

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

test('native-fetch: parseGithubFetchUrl maps repo/blob/tree, declines rest', async () => {
  const { parseGithubFetchUrl } = await import('../src/native-fetch.js');
  assert.deepEqual(parseGithubFetchUrl('https://github.com/o/r'), { action: 'repo', owner: 'o', repo: 'r' });
  assert.deepEqual(parseGithubFetchUrl('https://github.com/o/r/blob/main/src/a.ts'), {
    action: 'file', owner: 'o', repo: 'r', path: 'src/a.ts', ref: 'main',
  });
  assert.deepEqual(parseGithubFetchUrl('https://github.com/o/r/tree/main/docs'), {
    action: 'tree', owner: 'o', repo: 'r', path: 'docs', ref: 'main',
  });
  assert.equal(parseGithubFetchUrl('https://github.com/o/r/issues/1'), undefined);
  assert.equal(parseGithubFetchUrl('https://example.com/o/r'), undefined);
  assert.equal(parseGithubFetchUrl('not a url'), undefined);
});

test('native-fetch: cache helpers roundtrip through retrieve', async () => {
  const { cacheFetchForRetrieve, cacheFetchEntries } = await import('../src/native-fetch.js');
  const responseId = cacheFetchForRetrieve({
    query: 'native-fetch roundtrip',
    title: 'Roundtrip',
    url: 'https://example.com/native-fetch-roundtrip',
    snippet: 'roundtrip snippet',
    content: 'native-fetch roundtrip body',
  });
  assert.ok(typeof responseId === 'string' && responseId.length > 0);
  const out = await callNativeTool('fetch', { action: 'retrieve', responseId }, { env: {} });
  assert.match(JSON.stringify(out), /native-fetch roundtrip body/);
  assert.equal(cacheFetchForRetrieve({ query: '', title: 't', url: 'u', snippet: 's', content: 'c' }), undefined);
  assert.equal(cacheFetchEntries('q', []), undefined);
  assert.equal(cacheFetchEntries('  ', [{ title: 't', url: 'u', snippet: 's', content: 'c' }]), undefined);
});

test('native-fetch: fetch read populates retrieve cache with responseId', async () => {
  const fetched = await callNativeTool('fetch', { url: 'https://example.com/nf-article' }, seamOptions());
  const responseId = responseIdOf(fetched);
  const out = await callNativeTool('fetch', { action: 'retrieve', responseId }, { env: {} });
  assert.ok(JSON.stringify(out).includes('NativeFetch body words'));
});

test('native-fetch: url-array isolates per-URL failure, caches prior results', async () => {
  const fetched = await callNativeTool(
    'fetch',
    { urls: ['https://example.com/nf-ok', 'http://127.0.0.1:9/nf-nope'] },
    seamOptions(),
  );
  const text = JSON.stringify(fetched);
  assert.match(text, /NativeFetch body words/);
  assert.match(text, /127\.0\.0\.1/);
  const responseId = responseIdOf(fetched);
  const out = await callNativeTool('fetch', { action: 'retrieve', responseId }, { env: {} });
  assert.ok(JSON.stringify(out).includes('https://example.com/nf-ok'));
});

test('native-fetch: rejects hidden provider/format controls', async () => {
  await assert.rejects(
    () => callNativeTool('fetch', { url: 'https://example.com/nf', provider: 'tavily' }, { env: {} }),
    /operator-only/,
  );
  await assert.rejects(
    () => callNativeTool('fetch', { url: 'https://example.com/nf', format: 'markdown' }, { env: {} }),
    /format is not a supported fetch field/,
  );
});

test('native-fetch: specialist fallback order feed/media/github-then-reader', async () => {
  const savedFetch = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = String(input);
    if (url.startsWith('https://www.youtube.com/oembed')) {
      return new Response(JSON.stringify({ title: 'NF OEmbed', author_name: 'Chan' }), {
        status: 200, headers: { 'content-type': 'application/json' },
      });
    }
    if (url.includes('feed.xml')) {
      return new Response(
        '<rss><channel><item><title>NF Feed Alpha</title><link>https://example.com/nf-alpha</link></item></channel></rss>',
        { status: 200, headers: { 'content-type': 'application/rss+xml' } },
      );
    }
    throw new Error(`unexpected fetch ${url}`);
  }) as typeof fetch;
  try {
    const lookup = async () => [{ address: '93.184.216.34', family: 4 as const }];
    const feed = await callNativeTool('fetch', { url: 'https://example.com/nf-feed.xml' }, {
      env: {}, lookup,
    } as unknown as Parameters<typeof callNativeTool>[2]);
    assert.match(JSON.stringify(feed), /NF Feed Alpha/);
    const media = await callNativeTool('fetch', { url: 'https://www.youtube.com/watch?v=nf1' }, {
      env: {}, lookup: async () => [{ address: '142.250.72.14', family: 4 as const }],
    } as unknown as Parameters<typeof callNativeTool>[2]);
    assert.match(JSON.stringify(media), /NF OEmbed/);
    // Non-mapping github shape falls through to page reader via seam.
    const gh = await callNativeTool('fetch', { url: 'https://github.com/o/r/issues/9' }, seamOptions());
    assert.match(JSON.stringify(gh), /NativeFetch body words/);
  } finally {
    globalThis.fetch = savedFetch;
  }
});

test('native-fetch: agenticBrowse read issues responseId and wordCount', async () => {
  const out = await callNativeTool('agentic_browse', { action: 'read', url: 'https://example.com/nf-read' }, seamOptions());
  const details = (out as { details?: { responseId?: unknown; wordCount?: unknown } }).details;
  assert.equal(typeof details?.responseId, 'string');
  assert.ok(typeof details?.wordCount === 'number');
});

test('native-fetch: pdf SSRF redirect to private target fails closed to reader fallback', async () => {
  const savedFetch = globalThis.fetch;
  let secondFetch = false;
  (globalThis as unknown as { fetch: unknown }).fetch = async (input: unknown) => {
    const url = String(input);
    if (url === 'https://example.com/nf-doc.pdf') {
      return new Response('', { status: 302, headers: { location: 'http://127.0.0.1:9/private.pdf' } });
    }
    secondFetch = true;
    throw new Error(`unexpected fetch ${url}`);
  };
  try {
    const out = await callNativeTool('fetch', { url: 'https://example.com/nf-doc.pdf' }, {
      env: {},
      lookup: async (host: string) => {
        if (host === 'example.com') return [{ address: '93.184.216.34', family: 4 as const }];
        throw Object.assign(new Error(`Blocked hostname: ${host}`), { code: 'ESSRF' });
      },
      fetchPageText: async () => PAGE_HTML,
    } as unknown as Parameters<typeof callNativeTool>[2]);
    // Redirect to loopback fails closed inside pdf path; fetch still serves via reader fallback.
    assert.match(JSON.stringify(out), /NativeFetch body words/);
    assert.equal(secondFetch, false);
  } finally {
    globalThis.fetch = savedFetch;
  }
});
