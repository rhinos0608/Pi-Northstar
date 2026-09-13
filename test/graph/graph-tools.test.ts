import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { DiffbotFetchOptions } from '../../src/diffbot/diffbot-transport.js';
import { validateGraphResult } from '../../src/graph/graph-contract.js';
import { callGraphTool } from '../../src/graph/graph-tools.js';

const ENV = { DIFFBOT_TOKEN: 'test-token-xyz' };

function mockFetch(handler: (options: DiffbotFetchOptions) => unknown) {
  const calls: DiffbotFetchOptions[] = [];
  const fetchFn = async (options: DiffbotFetchOptions): Promise<unknown> => {
    calls.push(options);
    return handler(options);
  };
  return { calls, fetchFn };
}

function graphDetails(result: unknown): Record<string, unknown> {
  const details = (result as { details: Record<string, unknown> }).details;
  assert.ok(details && typeof details === 'object');
  return details;
}

function graphEnvelope(result: unknown): Record<string, unknown> {
  const graph = graphDetails(result).graph as Record<string, unknown>;
  assert.ok(graph && typeof graph === 'object');
  assert.equal(validateGraphResult(graph).ok, true, JSON.stringify(validateGraphResult(graph)));
  return graph;
}

function textOf(result: unknown): string {
  const content = (result as { content: Array<{ type: string; text: string }> }).content;
  assert.equal(content.length, 1);
  return content[0]!.text;
}

test('invalid action inputs cause zero paid calls', async () => {
  const { calls, fetchFn } = mockFetch(() => ({}));
  const result = await callGraphTool({ action: 'query', language: 'dql', query: '' }, { env: ENV, fetchFn });
  const envelope = graphEnvelope(result);
  assert.equal(envelope.status, 'error');
  assert.equal(calls.length, 0);
});

test('missing token returns auth_required without HTTP', async () => {
  const { calls, fetchFn } = mockFetch(() => ({}));
  const result = await callGraphTool({ action: 'query', language: 'dql', query: 'type:Organization' }, { env: {}, fetchFn });
  const envelope = graphEnvelope(result);
  assert.equal(envelope.status, 'error');
  const errors = envelope.errors as Array<{ code: string }>;
  assert.equal(errors[0]?.code, 'auth_required');
  assert.equal(calls.length, 0);
});

test('query rows paginate through opaque cursor bound to request', async () => {
  const { calls, fetchFn } = mockFetch(() => ({
    hits: 25, facet: false,
    data: [{ score: 1, entity: { diffbotUri: 'https://diffbot.com/entity/1', type: 'Organization', name: 'A' } }],
  }));
  const first = await callGraphTool({ action: 'query', language: 'dql', query: 'type:Organization', pageSize: 10 }, { env: ENV, fetchFn });
  const firstEnv = graphEnvelope(first);
  assert.equal(firstEnv.status, 'ok');
  const pagination = firstEnv.pagination as { hasMore: boolean; nextCursor?: string };
  assert.equal(pagination.hasMore, true);
  assert.ok(typeof pagination.nextCursor === 'string');
  assert.equal((calls[0]!.body as Record<string, unknown>).from, 0);
  const second = await callGraphTool(
    { action: 'query', language: 'dql', query: 'type:Organization', pageSize: 10, cursor: pagination.nextCursor },
    { env: ENV, fetchFn },
  );
  assert.equal(graphEnvelope(second).status, 'ok');
  assert.equal((calls[1]!.body as Record<string, unknown>).from, 10);
});

test('cursor mismatch on query text rejected before HTTP', async () => {
  const { calls, fetchFn } = mockFetch(() => ({ hits: 25, facet: false, data: [] }));
  const first = await callGraphTool({ action: 'query', language: 'dql', query: 'type:Organization' }, { env: ENV, fetchFn });
  const cursor = (graphEnvelope(first).pagination as { nextCursor?: string }).nextCursor!;
  const retry = await callGraphTool({ action: 'query', language: 'dql', query: 'type:Person', cursor }, { env: ENV, fetchFn });
  const envelope = graphEnvelope(retry);
  assert.equal(envelope.status, 'error');
  assert.equal((envelope.errors as Array<{ code: string }>)[0]?.code, 'cursor_invalid');
  assert.equal(calls.length, 1);
});

test('probe returns per-query ok/error items with partial status', async () => {
  const { fetchFn } = mockFetch((options) => {
    const body = options.body as Record<string, unknown>;
    if (body.query === 'type:Missing') return {};
    return { hits: 4 };
  });
  const result = await callGraphTool({ action: 'probe', language: 'dql', queries: ['type:Organization', 'type:Missing'] }, { env: ENV, fetchFn });
  const envelope = graphEnvelope(result);
  assert.equal(envelope.status, 'partial');
  const items = (envelope.data as { items: Array<{ status: string }> }).items;
  assert.deepEqual(items.map((i) => i.status), ['ok', 'error']);
});

test('schema types lists ontology types with freshness metadata', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'graph-tools-test-'));
  try {
    const cachePath = join(dir, 'cache.json');
    const { calls, fetchFn } = mockFetch(() => ({
      metadata: {}, types: { Person: { name: 'Person', fields: {} }, Organization: { name: 'Organization', fields: {} } },
    }));
    const result = await callGraphTool({ action: 'schema', language: 'dql', view: 'types' }, { env: ENV, fetchFn, cachePath });
    const envelope = graphEnvelope(result);
    assert.equal(envelope.status, 'ok');
    const data = envelope.data as { result: { view: string; types: string[] }; meta?: { stale?: boolean } };
    assert.deepEqual(data.result.types, ['Organization', 'Person']);
    assert.equal(data.meta?.stale, false);
    assert.equal(calls.length, 1);
    // second call serves fresh cache with zero HTTP
    const cached = await callGraphTool({ action: 'schema', language: 'dql', view: 'types' }, { env: ENV, fetchFn, cachePath });
    assert.equal(graphEnvelope(cached).status, 'ok');
    assert.equal(calls.length, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('schema falls back to stale cache with partial status on retrieval failure', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'graph-tools-test-'));
  try {
    const cachePath = join(dir, 'cache.json');
    const { fetchFn: good } = mockFetch(() => ({ metadata: {}, types: { Person: { name: 'Person', fields: {} } } }));
    await callGraphTool({ action: 'schema', language: 'dql', view: 'types' }, { env: ENV, fetchFn: good, cachePath });
    // age the cache past TTL by rewriting fetchedAt
    const { readFile, writeFile } = await import('node:fs/promises');
    const raw = JSON.parse(await readFile(cachePath, 'utf8')) as Record<string, unknown>;
    raw.fetchedAt = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString();
    await writeFile(cachePath, JSON.stringify(raw));
    const { fetchFn: bad } = mockFetch(() => { throw new Error('network down'); });
    const result = await callGraphTool({ action: 'schema', language: 'dql', view: 'types' }, { env: ENV, fetchFn: bad, cachePath });
    const envelope = graphEnvelope(result);
    assert.equal(envelope.status, 'partial');
    const data = envelope.data as { meta?: { stale?: boolean } };
    assert.equal(data.meta?.stale, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('tool text is concise untrusted evidence framed exactly once', async () => {
  const { fetchFn } = mockFetch(() => ({ hits: 1, facet: false, data: [] }));
  const result = await callGraphTool({ action: 'query', language: 'dql', query: 'type:Organization' }, { env: ENV, fetchFn });
  const text = textOf(result);
  assert.ok(text.includes('external evidence/data'));
  assert.equal(text.match(/EXTERNAL_EVIDENCE_/g)?.length, 2);
});
