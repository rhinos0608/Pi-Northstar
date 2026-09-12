import assert from 'node:assert/strict';
import { test } from 'node:test';

// Round-2 regression pins: PDF redirect SSRF, urls+query passage selector,
// per-URL failure isolation, bridgeless authorize fail-closed, retrieve/
// source_check field exclusivity.

function publicLookup() {
  return async () => [{ address: '93.184.216.34', family: 4 as const }];
}

function stubPage(title: string, body: string) {
  return async () => `<html><head><title>${title}</title></head><body><p>${body}</p></body></html>`;
}

test('pdf fetch never follows a redirect to a private target', async () => {
  const { callNativeTool } = await import('../src/native-tools.js');
  const fetched: string[] = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: unknown) => {
    const url = String(input);
    fetched.push(url);
    assert.ok(!url.includes('169.254'), `private redirect target must never be fetched, got ${url}`);
    return new Response('redirect', {
      status: 302,
      headers: { location: 'http://169.254.169.254/latest/meta-data/' },
    });
  }) as typeof fetch;
  try {
    const out = await callNativeTool(
      'fetch',
      { url: 'https://example.com/doc.pdf' },
      {
        fetchPageText: stubPage('stub', 'stub body text'),
        lookup: publicLookup() as never,
        env: {},
      },
    );
    assert.equal(fetched.length, 1);
    assert.ok(JSON.stringify(out).includes('stub body'));
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('urls+query honors the passage selector per URL', async () => {
  const { callNativeTool } = await import('../src/native-tools.js');
  const out = await callNativeTool(
    'fetch',
    { urls: ['https://example.com/a', 'https://example.com/b'], query: 'alpha passage ranking' },
    {
      fetchPageText: async (url: string) =>
        url.endsWith('/a')
          ? await stubPage('A', 'alpha passage ranking content dominates this page alpha alpha')()
          : await stubPage('B', 'alpha passage ranking appears here too alpha')(),
      lookup: publicLookup() as never,
      env: {},
    },
  );
  const body = JSON.stringify(out);
  assert.ok(body.includes('https://example.com/a'), 'per-URL attribution required');
  assert.ok(body.includes('alpha'), 'query-relevant chunks required, not silent full-text drop');
});

test('urls fetch isolates per-URL failures instead of aborting the array', async () => {
  const { callNativeTool } = await import('../src/native-tools.js');
  const out = await callNativeTool(
    'fetch',
    { urls: ['https://example.com/good', 'https://example.com/bad'] },
    {
      fetchPageText: async (url: string) => {
        if (url.includes('/bad')) throw new Error('boom');
        return await stubPage('good', 'good page content')();
      },
      lookup: publicLookup() as never,
      env: {},
    },
  );
  const body = JSON.stringify(out);
  assert.ok(body.includes('good page content'), 'prior results survive a later failure');
  assert.ok(body.includes('https://example.com/bad') && body.includes('boom'), 'failed URL becomes an error entry');
});

test('bridgeless chrome authorize fails closed, never reports authorized', async () => {
  const { ChromeProfileAdapter } = await import('../src/chrome-profile-adapter.js');
  const { ChromeProfileAuth } = await import('../src/chrome-profile-auth.js');
  const adapter = new ChromeProfileAdapter({ auth: new ChromeProfileAuth() });
  const result = await adapter.authorize(15 * 60 * 1000, true);
  const body = JSON.stringify(result);
  assert.ok(body.includes('chrome_extension_unavailable'), `expected fail-closed, got ${body}`);
  assert.equal(adapter.status().state, 'locked');
});

test('retrieve/source_check reject non-corpus fields at route and contract', async () => {
  const { buildFetchRoute } = await import('../src/index.js');
  const { parseWebAccessFetchRequest } = await import('../src/web-access-contract.js');
  assert.throws(() => buildFetchRoute({ action: 'retrieve', responseId: 'r1', topK: 5 }), /retrieve accepts only/);
  assert.throws(() => buildFetchRoute({ action: 'retrieve', responseId: 'r1', followLinks: true }), /retrieve accepts only/);
  assert.throws(
    () => buildFetchRoute({ action: 'source_check', responseId: 'r1', claims: ['c'], query: 'x' }),
    /source_check accepts only/,
  );
  assert.throws(
    () => parseWebAccessFetchRequest({ action: 'source_check', responseId: 'r1', claims: ['c'], url: 'https://example.com' }),
    /source_check accepts only/,
  );
  assert.throws(
    () => parseWebAccessFetchRequest({ action: 'retrieve', responseId: 'r1', maxChars: 100 }),
    /retrieve accepts only/,
  );
});

test('urls route forwards passage-selector bounds', async () => {
  const { buildFetchRoute } = await import('../src/index.js');
  const route = buildFetchRoute({ urls: ['https://example.com/a'], query: 'q', topK: 4, maxPages: 3 });
  assert.equal((route.args as { query: string }).query, 'q');
  assert.equal((route.args as { topK: number }).topK, 4);
  assert.equal((route.args as { maxPages: number }).maxPages, 3);
});
