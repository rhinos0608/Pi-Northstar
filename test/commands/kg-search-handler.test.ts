import assert from 'node:assert/strict';
import test from 'node:test';
import type { BackendCallResult } from '../../src/backend.js';
import { createCommandContext } from '../../src/commands/command-context.js';
import {
  executeKgSearch,
  KG_SEARCH_COMMAND,
  mapKgSearchCommandResult,
} from '../../src/commands/kg-search-handler.js';
import { buildKnowledgeResult } from '../../src/knowledge/knowledge-contract.js';

function ctx(env: Record<string, string | undefined> = {}, surface = 'cli') {
  return createCommandContext({ surface, env, invocationId: `kg-search-${surface}` });
}

type CommandView = {
  commandId: string; outcome: string; retryability: string;
  error?: { code: string; message: string; retryable: boolean };
};

function commandOf(result: BackendCallResult): CommandView {
  const command = (result.details as Record<string, unknown>).northstarCommand as CommandView;
  assert.ok(command, 'expected a northstarCommand on result');
  return command;
}

async function fails(args: Record<string, unknown>, env: Record<string, string | undefined> = {}): Promise<CommandView> {
  try {
    await executeKgSearch(args, ctx(env));
  } catch (error) {
    const command = (error as { commandResult?: CommandView }).commandResult;
    assert.ok(command, 'expected a commandResult on failure');
    return command;
  }
  assert.fail('expected executeKgSearch to throw');
}

const ENTITY = { entityVersion: 1, id: 'kg-acme', type: 'Organization', name: 'Acme', url: 'https://example.com/acme' } as const;

test('kg.search maps envelope statuses to command outcomes', () => {
  for (const [status, outcome] of [['ok', 'success'], ['empty', 'empty'], ['partial', 'partial'], ['degraded', 'degraded']] as const) {
    const envelope = buildKnowledgeResult({
      request: { tool: 'kg', action: 'search' },
      outcomes: status === 'empty'
        ? [{ provider: 'diffbot', entities: [], invalid: 0 }]
        : status === 'partial'
          ? [{ provider: 'diffbot', entities: [{ ...ENTITY }], invalid: 1 }]
          : [{ provider: 'diffbot', entities: [{ ...ENTITY }], ...(status === 'degraded' ? { degraded: true } : {}) }],
    });
    assert.equal(envelope.status, status, `fixture status ${status}`);
    const result = mapKgSearchCommandResult(envelope, ctx());
    assert.equal(result.commandId, KG_SEARCH_COMMAND);
    assert.equal(result.outcome, outcome);
    assert.equal(result.trust, 'external');
    assert.equal(result.resolvedSurface, KG_SEARCH_COMMAND);
  }
});

test('kg.search error envelope maps to failed with typed code', () => {
  const envelope = buildKnowledgeResult({
    request: { tool: 'kg', action: 'search' },
    outcomes: [{ provider: 'diffbot', entities: [], error: { code: 'upstream_error', message: 'boom', retryable: false } }],
  });
  assert.equal(envelope.status, 'error');
  const result = mapKgSearchCommandResult(envelope, ctx());
  assert.equal(result.outcome, 'failed');
  assert.equal(result.error?.code, 'upstream_error');
  assert.equal(result.error?.category, 'kg');
});

test('kg.search rejects missing query, unknown fields, and bad action', async () => {
  assert.equal((await fails({ query: '   ' })).error?.code, 'invalid_input');
  assert.equal((await fails({ query: 'Acme', bogus: 1 })).error?.code, 'invalid_input');
  assert.match((await fails({ query: 'Acme', bogus: 1 })).error?.message ?? '', /unknown kg\.search field/);
  assert.equal((await fails({ query: 'Acme', action: 'enhance' })).error?.code, 'invalid_input');
});

test('kg.search rejects out-of-range limits instead of clamping', async () => {
  for (const limit of [0, 51, 99, 2.5, Number.NaN, '10']) {
    const command = await fails({ query: 'Acme', limit });
    assert.equal(command.error?.code, 'invalid_input', `limit ${String(limit)}`);
    assert.match(command.error?.message ?? '', /limit must be an integer 1\.\.50/);
  }
});

test('kg.search rejects malformed cursors with cursor_invalid', async () => {
  const command = await fails({ query: 'Acme', cursor: 'AAAA' });
  assert.equal(command.outcome, 'failed');
  assert.equal(command.error?.code, 'cursor_invalid');
});

test('kg.search first page returns continuation cursor when page is full', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response(JSON.stringify({
    facet: false,
    data: Array.from({ length: 10 }, (_, index) => ({
      entity: { diffbotUri: `https://diffbot.com/entity/${index}`, type: 'Organization', name: `Org ${index}` },
    })),
  }), { status: 200, headers: { 'content-type': 'application/json' } })) as typeof fetch;
  try {
    const result = await executeKgSearch({ query: 'type:Organization' }, ctx({ DIFFBOT_TOKEN: 'test-token' }));
    const knowledge = (result.details as Record<string, unknown>).knowledge as { pagination?: { hasMore?: boolean; nextCursor?: string } };
    assert.equal(knowledge.pagination?.hasMore, true);
    assert.equal(typeof knowledge.pagination?.nextCursor, 'string');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('kg.search without token fails terminal without network', async () => {
  const result = await executeKgSearch({ query: 'Acme' }, ctx());
  const command = commandOf(result);
  assert.equal(command.outcome, 'failed');
  assert.equal(command.error?.code, 'contract_invalid_response');
  assert.equal(command.retryability, 'not_retryable');
});

test('kg.search validation failure echoes no secret', async () => {
  const command = await fails({ query: 'Acme', limit: 99 }, { DIFFBOT_TOKEN: 'secret-token-xyz' });
  assert.equal(command.error?.code, 'invalid_input');
  assert.ok(!(command.error?.message ?? '').includes('secret-token-xyz'), 'token must never echo into errors');
});

test('kg.search maps abort to cancelled', async () => {
  const controller = new AbortController();
  controller.abort();
  try {
    await executeKgSearch({ query: 'Acme' }, { ...ctx(), signal: controller.signal });
  } catch (error) {
    assert.equal((error as { commandResult?: CommandView }).commandResult?.outcome, 'cancelled');
    return;
  }
  assert.fail('expected cancellation to throw');
});
