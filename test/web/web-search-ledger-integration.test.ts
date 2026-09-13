import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  classifySearchFailure,
  createWebSearchExecute,
  priorSearchResult,
  searchLedgerOptions,
} from '../../src/index.js';
import { WebSearchLedger } from '../../src/web/web-search-ledger.js';
import type { SearchBackend } from '../../src/backend.js';

function stubClient(handler: (tool: string, args: Record<string, unknown>) => unknown): SearchBackend {
  const calls: Array<{ tool: string; args: Record<string, unknown> }> = [];
  const client = {
    calls,
    async callTool(tool: string, args: Record<string, unknown>) {
      calls.push({ tool, args });
      return handler(tool, args);
    },
    async close() {},
  };
  return client as unknown as SearchBackend;
}

const ENV: Record<string, string | undefined> = {};

test('searchLedgerOptions carries safe filters only, never cursor or bodies', () => {
  const options = searchLedgerOptions({
    query: 'secret query text stays out of options',
    limit: 8,
    includeContent: true,
    recency: 'week',
    domains: ['example.com', '-blocked.com'],
    yearFrom: 2020,
    mode: 'agent',
    category: 'news',
    knowledge: { entities: true, facts: false },
    cursor: 'opaque-continuation-token',
  });
  assert.deepEqual(options, {
    limit: 8,
    includeContent: true,
    recency: 'week',
    domains: ['example.com', '-blocked.com'],
    yearFrom: 2020,
    mode: 'agent',
    category: 'news',
    knowledge: { entities: true },
  });
});

test('classifySearchFailure maps timeout/oversize/invalid/upstream conservatively', () => {
  assert.deepEqual(classifySearchFailure(new Error('request timed out after 30000ms')), { retryable: true, code: 'timeout' });
  assert.deepEqual(classifySearchFailure(new Error('response too large: 2MB exceeds limit')), { retryable: false, code: 'response_too_large' });
  assert.deepEqual(classifySearchFailure(new Error('invalid response contract')), { retryable: false, code: 'invalid_response' });
  assert.deepEqual(classifySearchFailure(new Error('socket hang up')), { retryable: true, code: 'upstream_error' });
});

test('priorSearchResult is static concise text without caller content', () => {
  for (const reason of ['suppressed', 'blocked'] as const) {
    const result = priorSearchResult(reason);
    const text = (result.content as Array<{ text: string }>)[0]!.text;
    assert.ok(text.length < 300, 'suppression pointer stays concise');
    assert.ok(!text.includes('s3cr3t'), 'no caller content in pointer');
    assert.equal((result.details as { ledger: string }).ledger, reason);
  }
});

test('concurrent duplicate shares the leader result with one backend call', async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const client = stubClient(async () => {
    await gate;
    return { ok: true, marker: 'leader' };
  });
  const execute = createWebSearchExecute(client, ENV, new WebSearchLedger());
  const first = execute('call-1', { query: 'shared concurrent query' }, undefined);
  const second = execute('call-2', { query: 'shared concurrent query' }, undefined);
  release();
  const [leader, follower] = await Promise.all([first, second]);
  assert.deepEqual(follower, leader);
  assert.equal((follower.details as { ledger?: string }).ledger, undefined);
  assert.equal((client as unknown as { calls: unknown[] }).calls.length, 1);
});

test('second identical search suppresses without a paid call', async () => {
  const client = stubClient(() => ({ ok: true }));
  const execute = createWebSearchExecute(client, ENV, new WebSearchLedger());
  const first = await execute('call-1', { query: 'pi agent ledger' }, undefined);
  assert.ok((first.details as { ledger?: string }).ledger === undefined, 'first run dispatches');
  const second = await execute('call-2', { query: 'pi agent ledger' }, undefined);
  assert.equal((second.details as { ledger: string }).ledger, 'suppressed');
  assert.equal((client as unknown as { calls: unknown[] }).calls.length, 1);
});

test('non-retryable failure blocks the repeat without another backend call', async () => {
  const failing = stubClient(() => {
    throw new Error('invalid_response: backend returned malformed JSON');
  });
  const ledger = new WebSearchLedger();
  const execute = createWebSearchExecute(failing, ENV, ledger);
  await assert.rejects(execute('call-1', { query: 'poisoned ledger query' }, undefined));
  const blocked = await execute('call-2', { query: 'poisoned ledger query' }, undefined);
  assert.equal((blocked.details as { ledger: string }).ledger, 'blocked');
  assert.equal((failing as unknown as { calls: unknown[] }).calls.length, 1);
});

test('retryable failure allows one retry then blocks', async () => {
  const failing = stubClient(() => {
    throw new Error('socket hang up');
  });
  const ledger = new WebSearchLedger();
  const execute = createWebSearchExecute(failing, ENV, ledger);
  await assert.rejects(execute('call-1', { query: 'flaky ledger query' }, undefined));
  const retry = createWebSearchExecute(failing, ENV, ledger);
  await assert.rejects(retry('call-2', { query: 'flaky ledger query' }, undefined));
  const blocked = await createWebSearchExecute(failing, ENV, ledger)('call-3', { query: 'flaky ledger query' }, undefined);
  assert.equal((blocked.details as { ledger: string }).ledger, 'blocked');
  assert.equal((failing as unknown as { calls: unknown[] }).calls.length, 2);
});

test('validation errors cancel without recording a failure block', async () => {
  const client = stubClient(() => ({ ok: true }));
  const ledger = new WebSearchLedger();
  const execute = createWebSearchExecute(client, ENV, ledger);
  await assert.rejects(
    execute('call-1', { query: 'x', limit: 21 }, undefined),
    (error: unknown) => (error as { code?: string }).code === 'invalid_request',
    'web limit overflow must reject with invalid_request',
  );
  const again = await execute('call-2', { query: 'x', limit: 8 }, undefined);
  assert.ok((again.details as { ledger?: string }).ledger === undefined, 'no failure recorded for validation errors');
});

test('cursor continuations bypass the ledger and always dispatch', async () => {
  const client = stubClient(() => ({ ok: true }));
  const ledger = new WebSearchLedger();
  const execute = createWebSearchExecute(client, ENV, ledger);
  await execute('call-1', { query: 'research topic', category: 'research', source: 'arxiv', limit: 5 }, undefined);
  const continued = await execute(
    'call-2',
    { query: 'research topic', category: 'research', source: 'arxiv', limit: 5, cursor: 'opaque-token' },
    undefined,
  );
  assert.ok((continued.details as { ledger?: string }).ledger === undefined, 'cursor reads must not suppress');
});

test('ledger debug snapshot never stores query text, bodies, or secrets', async () => {
  const secret = 's3cr3t-token-body-value';
  const client = stubClient(() => ({ leaked: secret }));
  const ledger = new WebSearchLedger();
  const execute = createWebSearchExecute(client, ENV, ledger);
  const result = await execute('call-1', { query: `query carrying ${secret}` }, undefined);
  assert.ok(JSON.stringify(result).includes(secret), 'result body still reaches the caller');
  const snapshot = JSON.stringify(ledger.debugEntries());
  assert.ok(!snapshot.includes(secret), 'raw query text must not be stored');
  assert.ok(!snapshot.includes('s3cr3t'), 'secret fragments must not be stored');
});

test('web reject-on-overflow preserved through ledged dispatch', async () => {
  const client = stubClient(() => ({ ok: true }));
  const execute = createWebSearchExecute(client, ENV, new WebSearchLedger());
  await assert.rejects(
    execute('call-1', { query: 'overflow', limit: 21 }, undefined),
    (error: unknown) => (error as { code?: string }).code === 'invalid_request',
  );
  await assert.rejects(
    execute('call-2', { query: 'overflow', category: 'research', limit: 31 }, undefined),
    (error: unknown) => (error as { code?: string }).code === 'invalid_request',
  );
  assert.equal((client as unknown as { calls: unknown[] }).calls.length, 0);
});
