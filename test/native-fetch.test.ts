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

test('native-fetch: url-array mixed maps northstar partial + ordered entries, caches prior success', async () => {
  const fetched = await callNativeTool(
    'fetch',
    { urls: ['https://example.com/nf-ok', 'https://example.com/nf-bad'] },
    {
      env: {},
      lookup: async () => [{ address: '93.184.216.34', family: 4 as const }],
      fetchPageText: async (url: string) => {
        if (url.includes('/nf-bad')) throw new Error('boom upstream failure');
        return PAGE_HTML;
      },
    } as unknown as Parameters<typeof callNativeTool>[2],
  );
  const details = (fetched as { details?: Record<string, unknown> }).details ?? {};
  assert.equal((details.northstar as { status?: string })?.status, 'partial');
  assert.deepEqual(
    (details.entries as Array<{ url: string; status: string }>).map((e) => [e.url, e.status]),
    [['https://example.com/nf-ok', 'ok'], ['https://example.com/nf-bad', 'error']],
  );
  const failure = (details.entries as Array<{ error?: Record<string, unknown> }>)[1]?.error;
  assert.equal(failure?.code, 'backend_unavailable');
  assert.equal(failure?.retryable, true);
  assert.match(String(failure?.message ?? ''), /boom upstream failure/);
  assert.ok(String(failure?.message ?? '').length <= 500);
  assert.deepEqual(Object.keys(failure ?? {}).sort(), ['code', 'message', 'retryable']);
  assert.ok(!JSON.stringify(details).includes('"stack"'), 'no raw stack in output metadata');
  const text = JSON.stringify(fetched);
  assert.match(text, /NativeFetch body words/);
  assert.match(text, /boom upstream failure/);
  assert.ok(text.indexOf('NativeFetch body words') < text.indexOf('Error: boom upstream failure'), 'rendered content order preserved');
  const responseId = responseIdOf(fetched);
  const out = await callNativeTool('fetch', { action: 'retrieve', responseId }, { env: {} });
  assert.ok(JSON.stringify(out).includes('https://example.com/nf-ok'));
});

test('native-fetch: url-array all-failed maps northstar error, all-success maps ok', async () => {
  const allFailed = await callNativeTool(
    'fetch',
    { urls: ['https://example.com/nf-bad-a', 'https://example.com/nf-bad-b'] },
    {
      env: {},
      lookup: async () => [{ address: '93.184.216.34', family: 4 as const }],
      fetchPageText: async () => { throw new Error('boom upstream failure'); },
    } as unknown as Parameters<typeof callNativeTool>[2],
  );
  const failedDetails = (allFailed as { details?: Record<string, unknown> }).details ?? {};
  assert.equal((failedDetails.northstar as { status?: string })?.status, 'error');
  assert.deepEqual(
    (failedDetails.entries as Array<{ status: string }>).map((e) => e.status),
    ['error', 'error'],
  );
  const allOk = await callNativeTool(
    'fetch',
    { urls: ['https://example.com/nf-ok-a', 'https://example.com/nf-ok-b'] },
    seamOptions(),
  );
  const okDetails = (allOk as { details?: Record<string, unknown> }).details ?? {};
  assert.equal((okDetails.northstar as { status?: string })?.status, 'ok');
  assert.deepEqual(
    (okDetails.entries as Array<{ status: string }>).map((e) => e.status),
    ['ok', 'ok'],
  );
});

test('native-fetch: url-array abort during a URL stays cancelled, never an isolated error', async () => {
  const controller = new AbortController();
  await assert.rejects(
    () =>
      callNativeTool(
        'fetch',
        { urls: ['https://example.com/nf-abort-a', 'https://example.com/nf-abort-b'] },
        {
          env: {},
          lookup: async () => [{ address: '93.184.216.34', family: 4 as const }],
          fetchPageText: async () => {
            controller.abort();
            throw Object.assign(new Error('aborted'), { name: 'AbortError' });
          },
          signal: controller.signal,
        } as unknown as Parameters<typeof callNativeTool>[2],
      ),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.equal(error.name, 'AbortError');
      return true;
    },
  );
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
    // issues/pulls URLs route to the github tool first; the stub throws
    // there, so tryGithubUrlFetch fails closed and the reader serves via seam.
    const gh = await callNativeTool('fetch', { url: 'https://github.com/o/r/issues/9' }, seamOptions());
    assert.match(JSON.stringify(gh), /NativeFetch body words/);
  } finally {
    globalThis.fetch = savedFetch;
  }
});

test('native-fetch: agenticBrowse read issues responseId and wordCount', async () => {
  const out = await callNativeTool('browse', { action: 'read', url: 'https://example.com/nf-read' }, seamOptions());
  const details = (out as { details?: { responseId?: unknown; wordCount?: unknown } }).details;
  assert.equal(typeof details?.responseId, 'string');
  assert.ok(typeof details?.wordCount === 'number');
});

test('native-fetch: singular url+query ranks chunks and caches retrieve', async () => {
  const longHtml =
    '<html><head><title>Query Page</title></head><body><article><p>' +
    'NativeFetch query ranking body words pricing details repeated for chunk length. '.repeat(8) +
    '</p></article></body></html>';
  const fetched = await callNativeTool('fetch', { url: 'https://example.com/nf-query', query: 'pricing', topK: 3 }, {
    env: {},
    lookup: async () => [{ address: '93.184.216.34', family: 4 as const }],
    fetchPageText: async () => longHtml,
  } as unknown as Parameters<typeof callNativeTool>[2]);
  const text = JSON.stringify(fetched);
  assert.match(text, /## https:\/\/example\.com\/nf-query/);
  assert.match(text, /pricing/);
  const responseId = responseIdOf(fetched);
  const out = await callNativeTool('fetch', { action: 'retrieve', responseId }, { env: {} });
  assert.ok(JSON.stringify(out).includes('pricing'));
});

test('native-fetch: singular whitespace query keeps plain read path', async () => {
  const out = await callNativeTool('fetch', { url: 'https://example.com/nf-ws', query: '   ' }, seamOptions());
  const details = (out as { details?: { url?: unknown } }).details;
  assert.equal(details?.url, 'https://example.com/nf-ws');
  assert.match(JSON.stringify(out), /NativeFetch body words/);
});

test('native-fetch: out-of-range topK rejects instead of falling back (reject, never clamp)', async () => {
  await assert.rejects(
    () => callNativeTool('fetch', { url: 'https://example.com/nf-fb', query: 'pricing', topK: 99999 }, seamOptions()),
    /topK must be an integer 1\.\.20/,
  );
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

test('native-fetch: inline data: URI in fetch result returns marker, not payload', async () => {
  const html =
    '<html><head><title>DataUri Page</title></head><body><article><p>Words before ' +
    'data:image/png;base64,SGVsbG8= words after.</p></article></body></html>';
  const out = await callNativeTool('fetch', { url: 'https://example.com/nf-data-uri' }, {
    env: {},
    lookup: async () => [{ address: '93.184.216.34', family: 4 as const }],
    fetchPageText: async () => html,
  } as unknown as Parameters<typeof callNativeTool>[2]);
  const text = JSON.stringify(out);
  assert.match(text, /\[pi-northstar inline data URI omitted;/);
  assert.match(text, /retrieval=not-retained/);
  // M1 sanitizes model-visible `content` text; `details` envelopes are untouched.
  const body = (out as { content?: Array<{ type?: string; text?: string }> }).content?.[0]?.text ?? '';
  assert.match(body, /\[pi-northstar inline data URI omitted;/);
  assert.ok(!body.includes('SGVsbG8='), 'base64 payload must not reach content text');
});

test('native-fetch: browse path shares the M1 sanitize choke point', async () => {
  const html =
    '<html><head><title>Browse DataUri</title></head><body><article><p>Before ' +
    'data:image/png;base64,SGVsbG8= after.</p></article></body></html>';
  const out = await callNativeTool('browse', { url: 'https://example.com/nf-browse-uri' }, {
    env: {},
    lookup: async () => [{ address: '93.184.216.34', family: 4 as const }],
    fetchPageText: async () => html,
  } as unknown as Parameters<typeof callNativeTool>[2]);
  const body = (out as { content?: Array<{ type?: string; text?: string }> }).content?.[0]?.text ?? '';
  assert.match(body, /\[pi-northstar inline data URI omitted;/);
  assert.ok(!body.includes('SGVsbG8='), 'browse content must not carry the payload');
});

test('native-fetch: parseGithubIssuePrFetchUrl maps issues/pulls, declines rest', async () => {
  const { parseGithubIssuePrFetchUrl } = await import('../src/github/github-issue-pr-url.js');
  assert.deepEqual(parseGithubIssuePrFetchUrl('https://github.com/o/r/issues/1'), {
    owner: 'o', repo: 'r', kind: 'issue', number: 1,
  });
  assert.deepEqual(parseGithubIssuePrFetchUrl('https://github.com/o/r/pull/2'), {
    owner: 'o', repo: 'r', kind: 'pull', number: 2,
  });
  assert.deepEqual(parseGithubIssuePrFetchUrl('https://github.com/o/r/pull/2/conversation'), {
    owner: 'o', repo: 'r', kind: 'pull', number: 2, subpath: 'conversation',
  });
  assert.deepEqual(parseGithubIssuePrFetchUrl('https://github.com/o/r/pull/2/files'), {
    owner: 'o', repo: 'r', kind: 'pull', number: 2, subpath: 'files',
  });
  assert.deepEqual(parseGithubIssuePrFetchUrl('https://github.com/o/r/issues/1#issuecomment-9'), {
    owner: 'o', repo: 'r', kind: 'issue', number: 1, anchor: 'issuecomment-9',
  });
  assert.deepEqual(parseGithubIssuePrFetchUrl('https://github.com/o/r/pull/2#discussion_r9'), {
    owner: 'o', repo: 'r', kind: 'pull', number: 2, anchor: 'discussion_r9',
  });
  assert.deepEqual(parseGithubIssuePrFetchUrl('https://www.github.com/o/r/issues/1'), {
    owner: 'o', repo: 'r', kind: 'issue', number: 1,
  });
  // Declines: commits/gists/other hosts/bad numbers/unknown subpaths/issues subpaths.
  assert.equal(parseGithubIssuePrFetchUrl('https://github.com/o/r/commits'), undefined);
  assert.equal(parseGithubIssuePrFetchUrl('https://gist.github.com/o/abc'), undefined);
  assert.equal(parseGithubIssuePrFetchUrl('https://example.com/o/r/issues/1'), undefined);
  assert.equal(parseGithubIssuePrFetchUrl('https://github.com/o/r/issues/0'), undefined);
  assert.equal(parseGithubIssuePrFetchUrl('https://github.com/o/r/issues/1.5'), undefined);
  assert.equal(parseGithubIssuePrFetchUrl('https://github.com/o/r/pull/2/unknown'), undefined);
  assert.equal(parseGithubIssuePrFetchUrl('https://github.com/o/r/issues/1/extra'), undefined);
  assert.equal(parseGithubIssuePrFetchUrl('https://github.com/o/r/blob/main/f'), undefined);
  assert.equal(parseGithubIssuePrFetchUrl('https://github.com/o/r'), undefined);
  assert.equal(parseGithubIssuePrFetchUrl('not a url'), undefined);
  assert.equal(parseGithubIssuePrFetchUrl('https://github.com/o--x/r/issues/1'), undefined);
});

test('native-fetch: issues/pulls fetch reaches the github tool with capped comments', async () => {
  const savedFetch = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = String(input);
    if (url.includes('/issues/1/comments')) {
      return new Response(
        JSON.stringify([{ id: 11, user: { login: 'carol' }, body: 'I can reproduce this' }]),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }
    if (url.endsWith('/issues/1')) {
      return new Response(
        JSON.stringify({
          id: 9, number: 1, title: 'Atlas bug', state: 'open',
          user: { login: 'octo' }, html_url: 'https://github.com/o/r/issues/1',
          body: 'repro steps', labels: [], comments: 1,
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }
    if (url.includes('/issues/2/comments')) {
      return new Response(JSON.stringify([]), {
        status: 200, headers: { 'content-type': 'application/json' },
      });
    }
    if (url.endsWith('/pulls/2')) {
      return new Response(
        JSON.stringify({
          id: 5, number: 2, title: 'Atlas feat', state: 'open',
          user: { login: 'dev' }, html_url: 'https://github.com/o/r/pull/2', body: 'b', labels: [],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }
    throw new Error(`unexpected fetch ${url}`);
  }) as typeof fetch;
  try {
    const lookup = async () => [{ address: '140.82.114.4', family: 4 as const }];
    const issue = await callNativeTool('fetch', { url: 'https://github.com/o/r/issues/1' }, {
      env: {}, lookup,
    } as unknown as Parameters<typeof callNativeTool>[2]);
    const issueText = JSON.stringify(issue);
    assert.match(issueText, /Atlas bug/);
    assert.match(issueText, /Top comments/);
    assert.match(issueText, /carol/);
    assert.match(issueText, /I can reproduce this/);
    const pull = await callNativeTool('fetch', { url: 'https://github.com/o/r/pull/2' }, {
      env: {}, lookup,
    } as unknown as Parameters<typeof callNativeTool>[2]);
    assert.match(JSON.stringify(pull), /Atlas feat/);
    // Deferred-render subpath falls through to the page reader via seam.
    const files = await callNativeTool('fetch', { url: 'https://github.com/o/r/pull/2/files' }, {
      env: {},
      lookup,
      fetchPageText: async () => PAGE_HTML,
    } as unknown as Parameters<typeof callNativeTool>[2]);
    assert.match(JSON.stringify(files), /NativeFetch body words/);
  } finally {
    globalThis.fetch = savedFetch;
  }
});

test('native-fetch: image URL returns metadata envelope; unsniffable falls to reader', async () => {
  const png = new Uint8Array([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d,
    0x49, 0x48, 0x44, 0x52, 0x00, 0x00, 0x03, 0x20, 0x00, 0x00, 0x02, 0x58,
    0x08, 0x02, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
  ]);
  const savedFetch = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = String(input);
    if (url === 'https://example.com/nf-pic.png') {
      return new Response(png.buffer.slice(png.byteOffset, png.byteOffset + png.byteLength), {
        status: 200, headers: { 'content-type': 'image/png' },
      });
    }
    if (url === 'https://example.com/nf-fake.png') {
      return new Response('just text, no magic', {
        status: 200, headers: { 'content-type': 'text/html' },
      });
    }
    throw new Error(`unexpected fetch ${url}`);
  }) as typeof fetch;
  try {
    const lookup = async () => [{ address: '93.184.216.34', family: 4 as const }];
    const image = await callNativeTool('fetch', { url: 'https://example.com/nf-pic.png' }, {
      env: {}, lookup,
    } as unknown as Parameters<typeof callNativeTool>[2]);
    const imageJson = JSON.stringify(image);
    assert.match(imageJson, /Image fetched/);
    assert.match(imageJson, /image\/png/);
    const details = (image as { details?: { image?: Record<string, unknown> } }).details;
    assert.equal(details?.image?.mime, 'image/png');
    assert.equal(typeof details?.image?.bytes, 'number');
    assert.equal(details?.image?.width, 800);
    assert.equal(details?.image?.height, 600);
    // Unsniffable bytes fail closed to the page reader via seam.
    const fake = await callNativeTool('fetch', { url: 'https://example.com/nf-fake.png' }, {
      env: {},
      lookup,
      fetchPageText: async () => PAGE_HTML,
    } as unknown as Parameters<typeof callNativeTool>[2]);
    assert.match(JSON.stringify(fake), /NativeFetch body words/);
  } finally {
    globalThis.fetch = savedFetch;
  }
});

test('native-fetch: auth profile bypasses bridge/Diffbot/external and owns the host (T6)', async () => {
  const { ScraplingBridge } = await import('../src/web/access/scrapling-bridge.js');
  const savedFetch = globalThis.fetch;
  const savedBridgeFetch = ScraplingBridge.prototype.fetch;
  let bridgeCalls = 0;
  (ScraplingBridge.prototype as unknown as { fetch: unknown }).fetch = async function (this: unknown, ...args: unknown[]) {
    bridgeCalls += 1;
    return (savedBridgeFetch as (...a: unknown[]) => Promise<unknown>).apply(this, args);
  };
  const fetchedUrls: string[] = [];
  let seamCalls = 0;
  globalThis.fetch = (async (input: string | URL | Request) => {
    fetchedUrls.push(String(input));
    // A YouTube watch URL would normally route to the media specialist
    // (oEmbed) — the auth guard must win and serve the page directly.
    return new Response(
      '<html><head><title>Auth Watch</title></head><body><article><p>Auth watch body words.</p></article></body></html>',
      { status: 200, headers: { 'content-type': 'text/html' } },
    );
  }) as typeof fetch;
  try {
    const out = await callNativeTool('fetch', { url: 'https://www.youtube.com/watch?v=auth1' }, {
      env: {
        PI_FETCH_AUTH_PROFILES: JSON.stringify({ yt: { provider: 'youtube', hosts: ['www.youtube.com'] } }),
        // Eligible-but-skipped: Diffbot/external must still never run (T6).
        DIFFBOT_TOKEN: 'fake-token-for-skip-proof',
      },
      lookup: async () => [{ address: '142.250.72.14', family: 4 as const }],
      fetchPageText: async () => { seamCalls += 1; return PAGE_HTML; },
    } as unknown as Parameters<typeof callNativeTool>[2]);
    const text = JSON.stringify(out);
    assert.match(text, /Auth watch body words/);
    assert.ok(!text.includes('oEmbed') && !text.includes('oembed'), 'media specialist must not run on auth hosts');
    assert.equal(bridgeCalls, 0);
    assert.equal(seamCalls, 0);
    assert.ok(fetchedUrls.length > 0 && fetchedUrls.every((url) => url.startsWith('https://www.youtube.com/')));
    const details = (out as { details?: Record<string, unknown> }).details ?? {};
    assert.deepEqual(details.authFetch, { profile: 'yt', cachePolicy: 'off', externalProcessing: false });
    assert.equal(details.responseId, undefined);
  } finally {
    globalThis.fetch = savedFetch;
    ScraplingBridge.prototype.fetch = savedBridgeFetch;
  }
});

test('native-fetch: YouTube URL with nothing opted in behaves exactly as today', async () => {
  const savedFetch = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = String(input);
    if (url.startsWith('https://www.youtube.com/oembed')) {
      return new Response(JSON.stringify({ title: 'NF OEmbed Plain', author_name: 'Chan' }), {
        status: 200, headers: { 'content-type': 'application/json' },
      });
    }
    throw new Error(`unexpected fetch ${url}`);
  }) as typeof fetch;
  try {
    const out = await callNativeTool('fetch', { url: 'https://www.youtube.com/watch?v=plain1' }, {
      env: {},
      lookup: async () => [{ address: '142.250.72.14', family: 4 as const }],
    } as unknown as Parameters<typeof callNativeTool>[2]);
    const details = (out as { details?: Record<string, unknown> }).details ?? {};
    assert.match(JSON.stringify(out), /NF OEmbed Plain/);
    assert.equal(details.video, undefined);
    assert.equal(details.degraded, undefined);
    assert.equal(details.generatedText, undefined);
  } finally {
    globalThis.fetch = savedFetch;
  }
});

test('native-fetch: YouTube opt-in envelope carries keyframe evidence, degrades without binaries', async () => {
  const savedFetch = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = String(input);
    if (url.startsWith('https://www.youtube.com/oembed')) {
      return new Response(JSON.stringify({ title: 'NF OEmbed Frames', author_name: 'Chan' }), {
        status: 200, headers: { 'content-type': 'application/json' },
      });
    }
    throw new Error(`unexpected fetch ${url}`);
  }) as typeof fetch;
  try {
    // PATH without binaries: yt-dlp/ffmpeg resolve to ENOENT, so no child can
    // run and no network is needed beyond the stubbed oEmbed fetch.
    const out = await callNativeTool('fetch', { url: 'https://www.youtube.com/watch?v=frames1' }, {
      env: { PI_VISION_FETCH_VIDEO_FRAMES: '1', PATH: '/nonexistent-bin-dir' },
      lookup: async () => [{ address: '142.250.72.14', family: 4 as const }],
    } as unknown as Parameters<typeof callNativeTool>[2]);
    const body = (out as { content?: Array<{ text?: string }> }).content?.[0]?.text ?? '';
    const details = (out as { details?: Record<string, unknown> }).details ?? {};
    assert.match(body, /NF OEmbed Frames/);
    assert.deepEqual((details.video as Record<string, unknown>).keyframes, 0);
    assert.equal((details.video as Record<string, unknown>).synthesized, false);
    assert.equal(details.degraded, true);
    assert.match(JSON.stringify(details), /Keyframes were requested but unavailable/);
    assert.equal(details.generatedText, undefined);
  } finally {
    globalThis.fetch = savedFetch;
  }
});

test('native-fetch: synthesis rides details.generatedText, never content', async () => {
  const savedFetch = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url.startsWith('https://www.youtube.com/oembed')) {
      return new Response(JSON.stringify({ title: 'NF OEmbed Synth', author_name: 'Chan' }), {
        status: 200, headers: { 'content-type': 'application/json' },
      });
    }
    if (url.endsWith('/chat/completions')) {
      assert.match(String(init?.body ?? ''), /NF OEmbed Synth/);
      return new Response(
        JSON.stringify({ choices: [{ message: { content: 'SYNTH-DIGEST-9' } }] }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }
    throw new Error(`unexpected fetch ${url}`);
  }) as typeof fetch;
  try {
    const out = await callNativeTool('fetch', { url: 'https://www.youtube.com/watch?v=synth1' }, {
      env: {
        PI_VISION_FETCH_VIDEO_FRAMES: '1',
        PATH: '/nonexistent-bin-dir',
        PI_VISION_OPENAI_COMPAT_BASE_URL: 'https://example.com/v1',
        PI_VISION_OPENAI_COMPAT_MODEL: 'test-model',
      },
      lookup: async () => [{ address: '142.250.72.14', family: 4 as const }],
    } as unknown as Parameters<typeof callNativeTool>[2]);
    const body = (out as { content?: Array<{ text?: string }> }).content?.[0]?.text ?? '';
    const details = (out as { details?: Record<string, unknown> }).details ?? {};
    assert.ok(!body.includes('SYNTH-DIGEST-9'), 'synthesis must not merge into content');
    const generated = details.generatedText as Array<{ kind?: string; text?: string }>;
    assert.equal(generated?.length, 1);
    assert.equal(generated?.[0]?.kind, 'video-synthesis');
    assert.equal(generated?.[0]?.text, 'SYNTH-DIGEST-9');
  } finally {
    globalThis.fetch = savedFetch;
  }
});

test('native-fetch: image branch never runs on an authenticated fetch', async () => {
  const savedFetch = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response(
      '<html><head><title>Auth Image Page</title></head><body><article><p>Auth image page body.</p></article></body></html>',
      { status: 200, headers: { 'content-type': 'text/html' } },
    )) as typeof fetch;
  try {
    const out = await callNativeTool('fetch', { url: 'https://www.reddit.com/nf-auth-pic.png' }, {
      env: {
        PI_FETCH_AUTH_PROFILES: JSON.stringify({ rd: { provider: 'reddit', hosts: ['www.reddit.com'] } }),
      },
      lookup: async () => [{ address: '151.101.1.140', family: 4 as const }],
    } as unknown as Parameters<typeof callNativeTool>[2]);
    const details = (out as { details?: Record<string, unknown> }).details ?? {};
    assert.deepEqual(details.authFetch, { profile: 'rd', cachePolicy: 'off', externalProcessing: false });
    assert.equal(details.image, undefined);
    assert.match(JSON.stringify(out), /Auth image page body/);
  } finally {
    globalThis.fetch = savedFetch;
  }
});

test('native-fetch: retrieve cache stores sanitized text, never raw data: payloads (M1)', async () => {
  const html =
    '<html><head><title>Cache Sanitize</title></head><body><article><p>Cache words ' +
    'data:image/png;base64,SGVsbG8= trailing.</p></article></body></html>';
  const fetched = await callNativeTool('fetch', { url: 'https://example.com/nf-cache-san' }, {
    env: {},
    lookup: async () => [{ address: '93.184.216.34', family: 4 as const }],
    fetchPageText: async () => html,
  } as unknown as Parameters<typeof callNativeTool>[2]);
  const responseId = responseIdOf(fetched);
  const out = await callNativeTool('fetch', { action: 'retrieve', responseId }, { env: {} });
  const text = JSON.stringify(out);
  assert.match(text, /\[pi-northstar inline data URI omitted;/);
  assert.ok(!text.includes('SGVsbG8='), 'cached retrieve text must not carry the raw payload');
});

test('native-fetch: query-branch cache stores sanitized text (M1)', async () => {
  const longHtml =
    '<html><head><title>Query Sanitize</title></head><body><article><p>' +
    'Query cache ranking body words data:image/png;base64,SGVsbG8= repeated for chunk length. '.repeat(8) +
    '</p></article></body></html>';
  const fetched = await callNativeTool('fetch', { url: 'https://example.com/nf-qcache', query: 'ranking', topK: 3 }, {
    env: {},
    lookup: async () => [{ address: '93.184.216.34', family: 4 as const }],
    fetchPageText: async () => longHtml,
  } as unknown as Parameters<typeof callNativeTool>[2]);
  const responseId = responseIdOf(fetched);
  const out = await callNativeTool('fetch', { action: 'retrieve', responseId }, { env: {} });
  const text = JSON.stringify(out);
  assert.ok(!text.includes('SGVsbG8='), 'cached query text must not carry the raw payload');
});

test('native-fetch: query fetch on auth host skips semanticCrawl and owns caching (T5/T6)', async () => {
  const savedFetch = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response(
      '<html><head><title>Auth Query</title></head><body><article><p>Auth query body words pricing details.</p></article></body></html>',
      { status: 200, headers: { 'content-type': 'text/html' } },
    )) as typeof fetch;
  const lookup = async () => [{ address: '151.101.1.140', family: 4 as const }];
  try {
    // Cache off: no cache entry, semanticCrawl never consumes the seam.
    let seamCalls = 0;
    const off = await callNativeTool('fetch', { url: 'https://www.reddit.com/r/x/nf-auth-q', query: 'pricing' }, {
      env: { PI_FETCH_AUTH_PROFILES: JSON.stringify({ rd: { provider: 'reddit', hosts: ['www.reddit.com'] } }) },
      lookup,
      fetchPageText: async () => { seamCalls += 1; return PAGE_HTML; },
    } as unknown as Parameters<typeof callNativeTool>[2]);
    assert.equal(seamCalls, 0, 'semanticCrawl must not run on auth hosts');
    const offDetails = (off as { details?: Record<string, unknown> }).details ?? {};
    assert.deepEqual(offDetails.authFetch, { profile: 'rd', cachePolicy: 'off', externalProcessing: false });
    assert.equal(offDetails.responseId, undefined);
    assert.match(JSON.stringify(off), /Auth query body words/);
    // Session: cached once, retrievable.
    const sess = await callNativeTool('fetch', { url: 'https://www.reddit.com/r/x/nf-auth-qs', query: 'pricing' }, {
      env: { PI_FETCH_AUTH_PROFILES: JSON.stringify({ rd: { provider: 'reddit', hosts: ['www.reddit.com'], cache: 'session' } }) },
      lookup,
      fetchPageText: async () => PAGE_HTML,
    } as unknown as Parameters<typeof callNativeTool>[2]);
    const sessDetails = (sess as { details?: Record<string, unknown> }).details ?? {};
    assert.deepEqual(sessDetails.authFetch, { profile: 'rd', cachePolicy: 'session', externalProcessing: false });
    assert.equal(typeof sessDetails.responseId, 'string');
    const out = await callNativeTool(
      'fetch', { action: 'retrieve', responseId: sessDetails.responseId as string }, { env: {} },
    );
    assert.match(JSON.stringify(out), /Auth query body words/);
  } finally {
    globalThis.fetch = savedFetch;
  }
});

test('native-fetch: array urls+query on auth host skips semanticCrawl, cache off stores nothing', async () => {
  const savedFetch = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response(
      '<html><head><title>Auth Array</title></head><body><article><p>Auth array body words.</p></article></body></html>',
      { status: 200, headers: { 'content-type': 'text/html' } },
    )) as typeof fetch;
  try {
    let seamCalls = 0;
    const out = await callNativeTool('fetch', { urls: ['https://www.reddit.com/r/x/nf-auth-arr'], query: 'array' }, {
      env: { PI_FETCH_AUTH_PROFILES: JSON.stringify({ rd: { provider: 'reddit', hosts: ['www.reddit.com'] } }) },
      lookup: async () => [{ address: '151.101.1.140', family: 4 as const }],
      fetchPageText: async () => { seamCalls += 1; return PAGE_HTML; },
    } as unknown as Parameters<typeof callNativeTool>[2]);
    assert.equal(seamCalls, 0, 'semanticCrawl must not run on auth hosts');
    assert.match(JSON.stringify(out), /Auth array body words/);
    const details = (out as { details?: Record<string, unknown> }).details ?? {};
    assert.equal(details.responseId, undefined);
  } finally {
    globalThis.fetch = savedFetch;
  }
});

test('native-fetch: parseGithubFetchUrl normalizes leading www. like the issue/PR parser', async () => {
  const { parseGithubFetchUrl } = await import('../src/native-fetch.js');
  assert.deepEqual(parseGithubFetchUrl('https://www.github.com/o/r'), { action: 'repo', owner: 'o', repo: 'r' });
  assert.deepEqual(parseGithubFetchUrl('https://www.github.com/o/r/blob/main/src/a.ts'), {
    action: 'file', owner: 'o', repo: 'r', path: 'src/a.ts', ref: 'main',
  });
  assert.deepEqual(parseGithubFetchUrl('https://github.com/o/r/blob/main/src/a.ts'), {
    action: 'file', owner: 'o', repo: 'r', path: 'src/a.ts', ref: 'main',
  });
  assert.equal(parseGithubFetchUrl('https://www.example.com/o/r'), undefined);
  assert.equal(parseGithubFetchUrl('https://notgithub.com/o/r'), undefined);
});

test('native-fetch: issue/PR anchor surfaces as a details note, never a URL echo', async () => {
  const savedFetch = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = String(input);
    if (url.includes('/issues/1/comments')) {
      return new Response(JSON.stringify([]), {
        status: 200, headers: { 'content-type': 'application/json' },
      });
    }
    if (url.endsWith('/issues/1')) {
      return new Response(
        JSON.stringify({
          id: 9, number: 1, title: 'Atlas anchor bug', state: 'open',
          user: { login: 'octo' }, html_url: 'https://github.com/o/r/issues/1',
          body: 'repro steps', labels: [], comments: 0,
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }
    throw new Error(`unexpected fetch ${url}`);
  }) as typeof fetch;
  try {
    const lookup = async () => [{ address: '140.82.114.4', family: 4 as const }];
    const anchored = await callNativeTool('fetch', { url: 'https://github.com/o/r/issues/1#issuecomment-9' }, {
      env: {}, lookup,
    } as unknown as Parameters<typeof callNativeTool>[2]);
    const details = (anchored as { details?: Record<string, unknown> }).details ?? {};
    assert.equal(details.anchor, 'issuecomment-9');
    assert.match(String(details.anchorNote ?? ''), /issuecomment-9/);
    assert.ok(!String(details.anchorNote ?? '').includes('https://'), 'anchor note must not echo URL parts');
    const plain = await callNativeTool('fetch', { url: 'https://github.com/o/r/issues/1' }, {
      env: {}, lookup,
    } as unknown as Parameters<typeof callNativeTool>[2]);
    const plainDetails = (plain as { details?: Record<string, unknown> }).details ?? {};
    assert.equal(plainDetails.anchor, undefined);
  } finally {
    globalThis.fetch = savedFetch;
  }
});
