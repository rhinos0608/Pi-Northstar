import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildFetchRoute } from '../../../src/index.js';
import { callNativeTool } from '../../../src/native-tools.js';

test('buildFetchRoute registers retrieve union', () => {
  const route = buildFetchRoute({ responseId: 'r1', offset: 0, limit: 10, findText: 'x' });
  assert.equal(route.tool, 'fetch');
  assert.equal((route.args as { responseId: string }).responseId, 'r1');
  assert.equal((route.args as { findText: string }).findText, 'x');
});

test('buildFetchRoute registers source_check union', () => {
  const route = buildFetchRoute({ responseId: 'r1', claims: ['c1'] });
  assert.deepEqual((route.args as { claims: string[] }).claims, ['c1']);
});

test('buildFetchRoute registers urls array', () => {
  const route = buildFetchRoute({ urls: ['https://example.com/a', 'https://example.com/b'] });
  assert.equal(route.tool, 'fetch');
  assert.deepEqual((route.args as { urls: string[] }).urls, ['https://example.com/a', 'https://example.com/b']);
});

test('buildFetchRoute urls array preserves query passage selector', async () => {
  const route = buildFetchRoute({ urls: ['https://example.com/a'], query: 'passage' });
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
  const out = await callNativeTool('fetch', { responseId });
  assert.ok(JSON.stringify(out).includes('alpha snippet'), 'cached corpus must serve stored hits');
});

test('unknown read modes reject; readable|raw|answer route', () => {
  assert.throws(() => buildFetchRoute({ mode: 'batch_read', urls: ['https://example.com/a'] } as never), /must be one of/);
  assert.throws(() => buildFetchRoute({ mode: 'batch_crawl', urls: ['https://example.com/a'], query: 'q' } as never), /must be one of/);
  assert.equal(buildFetchRoute({ mode: 'raw', url: 'https://example.com/a' }).args.mode, 'raw');
  assert.equal(
    buildFetchRoute({ mode: 'answer', url: 'https://example.com/a', prompt: 'what?' }).args.mode,
    'answer',
  );
});

const stubLookup = async () => [{ address: '93.184.216.34', family: 4 as const }];

function stubRawFetch(body: string, init?: { status?: number; contentType?: string }): typeof fetch {
  return (async () => new Response(body, {
    status: init?.status ?? 200,
    headers: { 'content-type': init?.contentType ?? 'text/html; charset=utf-8' },
  })) as typeof fetch;
}

function fetchTextOf(result: unknown): string {
  const content = (result as { content?: Array<{ type?: string; text?: string }> }).content ?? [];
  return content.filter((c) => c?.type === 'text').map((c) => String(c?.text ?? '')).join('\n');
}

test('specialist fallback never swallows caller cancellation', async () => {
  const { dispatchFetch } = await import('../../../src/native-fetch.js');
  const controller = new AbortController();
  controller.abort();
  let fallbackReads = 0;
  await assert.rejects(
    () => dispatchFetch(
      { url: 'https://example.com/cancelled.pdf' },
      {
        signal: controller.signal,
        lookup: stubLookup,
        fetchPageText: async () => {
          fallbackReads += 1;
          return '<html>should not run</html>';
        },
      },
    ),
    /abort/i,
  );
  assert.equal(fallbackReads, 0, 'cancelled specialist must not fall through to another reader');
});

test('fetch raw returns admitted HTTP text with stub fetch', async () => {
  const { dispatchFetch } = await import('../../../src/native-fetch.js');
  const out = await dispatchFetch(
    { url: 'https://example.com/a', mode: 'raw' },
    { lookup: stubLookup, rawFetchImpl: stubRawFetch('<html>hello raw</html>') },
  );
  assert.ok(fetchTextOf(out).includes('hello raw'), 'raw must serve the admitted HTTP text body');
});

test('fetch raw preserves non-2xx bodies with status', async () => {
  const { dispatchFetch } = await import('../../../src/native-fetch.js');
  const out = await dispatchFetch(
    { url: 'https://example.com/missing', mode: 'raw' },
    { lookup: stubLookup, rawFetchImpl: stubRawFetch('not here', { status: 404 }) },
  );
  const text = fetchTextOf(out);
  assert.ok(text.includes('not here'), 'non-2xx body must be preserved');
  assert.equal((out as { details?: Record<string, unknown> }).details?.status, 404);
});

test('fetch raw rejects non-text content types', async () => {
  const { dispatchFetch } = await import('../../../src/native-fetch.js');
  await assert.rejects(
    () => dispatchFetch(
      { url: 'https://example.com/a', mode: 'raw' },
      { lookup: stubLookup, rawFetchImpl: stubRawFetch('{}', { contentType: 'application/octet-stream' }) },
    ),
    /rejects content-type/,
  );
});

test('fetch raw cancels rejected bodies instead of buffering them', async () => {
  const { dispatchFetch } = await import('../../../src/native-fetch.js');
  let cancelled = false;
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new Uint8Array([1, 2, 3]));
    },
    cancel() {
      cancelled = true;
    },
  });
  const fetchImpl = (async () => new Response(body, {
    status: 200,
    headers: { 'content-type': 'application/octet-stream' },
  })) as typeof fetch;
  await assert.rejects(
    () => dispatchFetch(
      { url: 'https://example.com/a', mode: 'raw' },
      { lookup: stubLookup, rawFetchImpl: fetchImpl },
    ),
    /rejects content-type/,
  );
  assert.equal(cancelled, true, 'rejected raw bodies must be cancelled, never drained into memory');
});

test('fetch raw redirect errors do not echo URL query material', async () => {
  const { dispatchFetch } = await import('../../../src/native-fetch.js');
  const sentinel = 'QUERY_SECRET_SHOULD_NOT_ECHO_7f3a';
  const redirectWithoutLocation = (async () =>
    new Response('', { status: 302, headers: { 'content-type': 'text/plain' } })) as typeof fetch;
  const error = await dispatchFetch(
    { url: `https://example.com/a?opaque=${sentinel}`, mode: 'raw' },
    { lookup: stubLookup, rawFetchImpl: redirectWithoutLocation },
  ).then(
    () => null,
    (caught: unknown) => caught,
  );
  assert.ok(error instanceof Error);
  assert.match(error.message, /fetch raw redirect failed/);
  assert.equal(error.message.includes(sentinel), false);
});

test('fetch answer returns model answer and caches full raw extract', async () => {
  const { dispatchFetch } = await import('../../../src/native-fetch.js');
  let seen: { system: string; page: string; prompt: string } | undefined;
  const out = await dispatchFetch(
    { url: 'https://example.com/a', mode: 'answer', prompt: 'what says?' },
    {
      lookup: stubLookup,
      env: { PI_NORTHSTAR_LEAF_MODEL: 'test/model' },
      fetchPageText: async () => '<html><body>page says apples</body></html>',
      answerModelCall: async (_model, messages) => {
        seen = messages;
        assert.ok(messages.page.startsWith('<page>'), 'extract must ride as untrusted <page> evidence');
        assert.ok(messages.page.includes('apples'), 'extract must reach the model call');
        return 'apples';
      },
    },
  );
  assert.ok(fetchTextOf(out).includes('apples'), 'answer text must be returned');
  assert.ok(seen !== undefined && seen.system.length > 0, 'system prompt must frame the call');
  const responseId = (out as { details?: Record<string, unknown> }).details?.responseId;
  assert.ok(typeof responseId === 'string' && responseId.length > 0, 'full raw must be kept in the responseId store');
  const retrieved = await dispatchFetch({ responseId }, { lookup: stubLookup });
  assert.ok(fetchTextOf(retrieved).includes('apples'), 'stored raw must serve the full extract');
});

test('fetch answer requires prompt', async () => {
  const { dispatchFetch } = await import('../../../src/native-fetch.js');
  await assert.rejects(
    () => dispatchFetch(
      { url: 'https://example.com/a', mode: 'answer' },
      { lookup: stubLookup, env: { PI_NORTHSTAR_LEAF_MODEL: 'test/model' }, fetchPageText: async () => 'x' },
    ),
    /requires prompt/,
  );
});

test('fetch local video file routes to the video-local path', async () => {
  const { mkdtempSync, writeFileSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const dir = mkdtempSync(join(tmpdir(), 'fetch-video-'));
  const file = join(dir, 'clip.mp4');
  writeFileSync(file, Buffer.alloc(1024, 0));
  const { dispatchFetch } = await import('../../../src/native-fetch.js');
  const out = await dispatchFetch({ url: file }, { lookup: stubLookup });
  const details = (out as { details?: Record<string, unknown> }).details as Record<string, unknown> | undefined;
  assert.ok(details?.video !== undefined, 'local video must return video details, not a page-reader error');
});

test('fetch answer can quick-investigate an operator-local video without exposing filesystem paths to the public route', async () => {
  const { mkdtempSync, writeFileSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const dir = mkdtempSync(join(tmpdir(), 'fetch-video-answer-'));
  const file = join(dir, 'clip.mp4');
  writeFileSync(file, Buffer.alloc(1024, 0));
  const { dispatchFetch } = await import('../../../src/native-fetch.js');
  let probed = false;
  const out = await dispatchFetch(
    { url: file, mode: 'answer', prompt: 'What is this clip?' },
    {
      lookup: stubLookup,
      probeCall: async (messages: { page: string; source: string }) => {
        probed = true;
        assert.ok(messages.page.includes('clip.mp4'), 'local metadata is framed as answer evidence');
        assert.ok(messages.source.includes(file), 'native answer keeps the operator-local source for provenance');
        return 'local-video-answer';
      },
    },
  );
  assert.equal(probed, true);
  const text = (out.content as Array<{ text?: string }> | undefined)?.map((item) => item.text ?? '').join('\n') ?? '';
  assert.match(text, /local-video-answer/);
});

test('buildFetchRoute rejects unknown action; contract rejects mixed selectors', async () => {
  assert.throws(() => buildFetchRoute({ action: 'read', responseId: 'r' } as never), /fetch no longer accepts 'action'/);
  const { parseWebAccessFetchRequest } = await import('../../../src/web/access/web-access-contract.js');
  assert.throws(() => parseWebAccessFetchRequest({ url: 'https://example.com', urls: ['https://example.com'] }), /urls accepts only/);
});

test('fetch retrieve on empty cache throws contract-guided error, no network', async () => {
  await assert.rejects(
    () => callNativeTool('fetch', { responseId: 'missing-id' }, { env: {} }),
    /No stored results for responseId/,
  );
});

test('fetch source_check on empty cache throws contract-guided error, no network', async () => {
  await assert.rejects(
    () => callNativeTool('fetch', { responseId: 'missing-id', claims: ['claim'] }, { env: {} }),
    /No stored results for responseId/,
  );
});
