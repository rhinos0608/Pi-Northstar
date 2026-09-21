import assert from 'node:assert/strict';
import test from 'node:test';
import type { BackendCallResult } from '../../src/backend.js';
import { createCommandContext } from '../../src/commands/command-context.js';
import {
  executeGraphQuery,
  GRAPH_QUERY_COMMAND,
  mapGraphQueryCommandResult,
} from '../../src/commands/graph-query-handler.js';
import { buildGraphResult } from '../../src/graph/graph-contract.js';

function ctx(env: Record<string, string | undefined> = {}, surface = 'cli') {
  return createCommandContext({ surface, env, invocationId: `graph-query-${surface}` });
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
    await executeGraphQuery(args, ctx(env));
  } catch (error) {
    const command = (error as { commandResult?: CommandView }).commandResult;
    assert.ok(command, 'expected a commandResult on failure');
    return command;
  }
  assert.fail('expected executeGraphQuery to throw');
}

test('graph.query maps envelope statuses to command outcomes', () => {
  for (const [status, outcome] of [['ok', 'success'], ['empty', 'empty'], ['partial', 'partial']] as const) {
    const envelope = buildGraphResult({
      status, language: 'dql', provider: 'diffbot',
      data: { kind: 'query', shape: 'rows', result: status === 'empty' ? [] : [{ id: '1' }] },
    });
    const result = mapGraphQueryCommandResult(envelope, ctx());
    assert.equal(result.commandId, GRAPH_QUERY_COMMAND);
    assert.equal(result.outcome, outcome);
    assert.equal(result.trust, 'external');
    assert.equal(result.resolvedSurface, GRAPH_QUERY_COMMAND);
  }
});

test('graph.query error envelope maps to failed with typed code', () => {
  const envelope = buildGraphResult({
    status: 'error', language: 'dql', provider: 'diffbot',
    data: { kind: 'query', shape: 'object', result: null },
    errors: [{ code: 'auth_required', message: 'no token', retryable: false }],
  });
  const result = mapGraphQueryCommandResult(envelope, ctx());
  assert.equal(result.outcome, 'failed');
  assert.equal(result.error?.code, 'auth_required');
  assert.equal(result.error?.category, 'graph');
  assert.equal(result.retryability, 'not_retryable');
});

test('graph.query rejects wrong action without network', async () => {
  const command = await fails({ action: 'probe', queries: ['q'] });
  assert.equal(command.error?.code, 'invalid_input');
  assert.match(command.error?.message ?? '', /action must be "query"/);
});

test('graph.query rejects out-of-range pageSize instead of clamping, no network', async () => {
  for (const pageSize of [0, 101, 999, 1.5, '10']) {
    const result = await executeGraphQuery({ query: 'type:Organization', pageSize }, ctx());
    const command = commandOf(result);
    assert.equal(command.outcome, 'failed', `pageSize ${String(pageSize)}`);
    assert.equal(command.error?.code, 'invalid_input', `pageSize ${String(pageSize)}`);
  }
});

test('graph.query rejects empty query and unknown fields without network', async () => {
  const empty = commandOf(await executeGraphQuery({ query: '   ' }, ctx()));
  assert.equal(empty.error?.code, 'invalid_input');
  const unknown = commandOf(await executeGraphQuery({ query: 'type:Organization', bogus: 1 }, ctx()));
  assert.equal(unknown.error?.code, 'invalid_input');
});

test('graph.query validation failure echoes no secret', async () => {
  const result = await executeGraphQuery({ query: 'type:Organization', pageSize: 999 }, ctx({ DIFFBOT_TOKEN: 'secret-token-xyz' }));
  const command = commandOf(result);
  assert.equal(command.error?.code, 'invalid_input');
  assert.ok(!JSON.stringify(result.details).includes('secret-token-xyz'), 'token must never echo');
});

test('graph.query maps abort to cancelled', async () => {
  const controller = new AbortController();
  controller.abort();
  try {
    await executeGraphQuery({ query: 'type:Organization' }, { ...ctx(), signal: controller.signal });
  } catch (error) {
    assert.equal((error as { commandResult?: CommandView }).commandResult?.outcome, 'cancelled');
    return;
  }
  assert.fail('expected cancellation to throw');
});
