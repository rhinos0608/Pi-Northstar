import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildFetchRoute } from '../../src/web/web-fetch-route.js';

test('single-url branch routes to fetch read-query path', () => {
  const route = buildFetchRoute({ url: 'https://example.com/page' });
  assert.equal(route.tool, 'fetch');
  assert.equal(route.args.url, 'https://example.com/page');
  assert.ok(!('action' in route.args));
  assert.equal(route.timeout, 120_000);
});

test('single-url branch carries optional query/topK/maxChars', () => {
  const route = buildFetchRoute({ url: 'https://example.com/page', query: 'pricing', topK: 5, maxChars: 1000 });
  assert.equal(route.tool, 'fetch');
  assert.equal(route.args.query, 'pricing');
  assert.equal(route.args.topK, 5);
  assert.equal(route.args.maxChars, 1000);
});

test('multi-url branch routes to fetch without maxPages', () => {
  const route = buildFetchRoute({ urls: ['https://example.com/a', 'https://example.com/b'], query: 'docs', topK: 4 });
  assert.equal(route.tool, 'fetch');
  assert.deepEqual(route.args.urls, ['https://example.com/a', 'https://example.com/b']);
  assert.equal(route.args.query, 'docs');
  assert.equal(route.args.topK, 4);
  assert.ok(!('maxPages' in route.args));
  assert.throws(() => buildFetchRoute({ urls: ['https://example.com/a'], maxPages: 3 } as never), /rejects field 'maxPages'/);
});

test('sitemap branch unchanged', () => {
  const route = buildFetchRoute({ url: 'https://example.com/docs/', siteMap: true, query: 'api', maxPages: 5 });
  assert.equal(route.tool, 'fetch');
  assert.deepEqual(route.args, { url: 'https://example.com/docs/', siteMap: true, query: 'api', maxPages: 5 });
  assert.equal(route.timeout, 180_000);
  assert.throws(() => buildFetchRoute({ url: 'https://example.com/', siteMap: 'yes' as never }), /siteMap:true/);
});

test('retrieve branch serves cached slice fields', () => {
  const route = buildFetchRoute({ responseId: 'r1', sourceIds: ['s-0'], offset: 1, limit: 5, findText: 'hi' });
  assert.equal(route.tool, 'fetch');
  assert.equal(route.args.action, 'retrieve');
  assert.equal(route.timeout, 60_000);
});

test('claim-check branch rejects offset/limit/findText naming the field', () => {
  const route = buildFetchRoute({ responseId: 'r1', claims: ['alpha exists'] });
  assert.equal(route.args.action, 'source_check');
  assert.throws(() => buildFetchRoute({ responseId: 'r1', claims: ['c'], offset: 1 } as never), /rejects 'offset'/);
  assert.throws(() => buildFetchRoute({ responseId: 'r1', claims: ['c'], limit: 2 } as never), /rejects 'limit'/);
  assert.throws(() => buildFetchRoute({ responseId: 'r1', claims: ['c'], findText: 'x' } as never), /rejects 'findText'/);
  assert.throws(() => buildFetchRoute({ responseId: 'r1', claims: [] }), /claims\[1\.\.20\]/);
});

test('legacy discriminants reject; mode is now read vocabulary', () => {
  for (const key of ['action', 'source', 'searchQuery', 'followLinks', 'maxDepth'] as const) {
    assert.throws(() => buildFetchRoute({ [key]: 'x', url: 'https://example.com/' } as never), new RegExp(`no longer accepts '${key}'`));
  }
  // mode readable|raw|answer routes; unknown modes fail closed.
  assert.equal(buildFetchRoute({ mode: 'readable', url: 'https://example.com/' }).args.mode, 'readable');
  assert.equal(buildFetchRoute({ mode: 'raw', url: 'https://example.com/' }).args.mode, 'raw');
  assert.equal(
    buildFetchRoute({ mode: 'answer', url: 'https://example.com/', prompt: 'what?' }).args.mode,
    'answer',
  );
  assert.throws(() => buildFetchRoute({ mode: 'crawl', url: 'https://example.com/' } as never), /must be one of/);
  assert.throws(() => buildFetchRoute({ mode: 'read', url: 'https://example.com/' } as never), /must be one of/);
  assert.throws(
    () => buildFetchRoute({ mode: 'batch_read', urls: ['https://example.com/a'] } as never),
    /must be one of/,
  );
  assert.throws(
    () => buildFetchRoute({ url: 'https://example.com/a', mode: 'raw', maxChars: 100 }),
    /raw rejects 'maxChars'/,
  );
  assert.throws(
    () => buildFetchRoute({ url: 'https://example.com/a', mode: 'answer', prompt: 'what?', maxChars: 100 }),
    /answer rejects 'maxChars'/,
  );
});

test('filesystem paths and non-http schemes reject on the public fetch route', () => {
  assert.throws(() => buildFetchRoute({ url: '/etc/passwd' }), /HTTP\(S\) or GitHub asset URL/);
  assert.throws(() => buildFetchRoute({ url: 'file:///etc/passwd' }), /HTTP\(S\) or GitHub asset URL/);
  assert.throws(() => buildFetchRoute({ urls: ['https://example.com/a', './relative'] } as never), /HTTP\(S\) or GitHub asset URL/);
  assert.throws(() => buildFetchRoute({ url: 'https://example.com/', unknownField: 1 } as never), /rejects field 'unknownField'/);

  assert.throws(
    () => buildFetchRoute({ url: '/tmp/operator-clip.mp4' }),
    /HTTP\(S\) or GitHub asset URL/,
  );
  assert.throws(
    () => buildFetchRoute({ url: 'file:///tmp/operator-clip.webm', mode: 'readable' }),
    /HTTP\(S\) or GitHub asset URL/,
  );
});

test('url+urls together and empty input reject', () => {
  assert.throws(() => buildFetchRoute({ url: 'https://example.com/a', urls: ['https://example.com/b'] } as never), /either url or urls/);
  assert.throws(() => buildFetchRoute({ url: '', urls: ['https://example.com/b'] } as never), /either url or urls/);
  assert.throws(() => buildFetchRoute({} as never), /requires one of/);
  assert.throws(() => buildFetchRoute('nope' as never), /must be an object/);
});
