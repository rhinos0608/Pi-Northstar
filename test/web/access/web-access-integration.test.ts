import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildFetchRoute } from '../../../src/index.js';
import { callNativeTool } from '../../../src/native-tools.js';

test('buildFetchRoute registers retrieve union', () => {
  const route = buildFetchRoute({ mode: 'retrieve', responseId: 'r1', findText: 'x' });
  assert.equal(route.tool, 'fetch');
  assert.equal((route.args as { action: string }).action, 'retrieve');
});

test('buildFetchRoute registers source_check union', () => {
  const route = buildFetchRoute({ mode: 'source_check', responseId: 'r1', claims: ['c1'] });
  assert.equal((route.args as { action: string }).action, 'source_check');
});

test('buildFetchRoute registers urls array', () => {
  const route = buildFetchRoute({ mode: 'batch_read', urls: ['https://example.com/a', 'https://example.com/b'] });
  assert.equal(route.tool, 'fetch');
  assert.deepEqual((route.args as { urls: string[] }).urls, ['https://example.com/a', 'https://example.com/b']);
});

test('buildFetchRoute urls array preserves query passage selector', async () => {
  const route = buildFetchRoute({ mode: 'batch_crawl', urls: ['https://example.com/a'], query: 'passage' });
  assert.equal(route.tool, 'fetch');
  assert.equal((route.args as { query: string }).query, 'passage');
  // Contract accepts urls+query on the fetch tool (old route threw 'url is required').
  const { parseWebAccessFetchRequest } = await import('../../../src/web/access/web-access-contract.js');
  parseWebAccessFetchRequest({ urls: ['https://example.com/a'], query: 'passage' });
});

test('web_search caches fused hits for retrieve', async () => {
  const { cacheWebSearchForRetrieve } = await import('../../../src/native-tools.js');
  const responseId = cacheWebSearchForRetrieve('alpha query', [
    { title: 'Alpha', url: 'https://example.com/alpha', snippet: 'alpha snippet', backend: 'tavily' },
  ]);
  assert.ok(typeof responseId === 'string' && responseId.length > 0, 'search must issue a responseId');
  const out = await callNativeTool('fetch', { action: 'retrieve', responseId });
  assert.ok(JSON.stringify(out).includes('alpha snippet'), 'cached corpus must serve stored hits');
});

test('buildFetchRoute rejects unknown action; contract rejects mixed selectors', async () => {
  assert.throws(() => buildFetchRoute({ action: 'read', responseId: 'r' } as never), /fetch requires explicit mode/);
  const { parseWebAccessFetchRequest } = await import('../../../src/web/access/web-access-contract.js');
  assert.throws(() => parseWebAccessFetchRequest({ url: 'https://example.com', urls: ['https://example.com'] }), /batch accepts only/);
});

test('fetch retrieve on empty cache throws contract-guided error, no network', async () => {
  await assert.rejects(
    () => callNativeTool('fetch', { action: 'retrieve', responseId: 'missing-id' }, { env: {} }),
    /No stored results for responseId/,
  );
});

test('fetch source_check on empty cache throws contract-guided error, no network', async () => {
  await assert.rejects(
    () => callNativeTool('fetch', { action: 'source_check', responseId: 'missing-id', claims: ['claim'] }, { env: {} }),
    /No stored results for responseId/,
  );
});
