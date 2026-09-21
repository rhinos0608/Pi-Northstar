import assert from 'node:assert/strict';
import test from 'node:test';
import type { BackendCallResult } from '../../src/backend.js';
import { createCommandContext } from '../../src/commands/command-context.js';
import {
  executeGraphProbe,
  GRAPH_PROBE_COMMAND,
  mapGraphProbeCommandResult,
} from '../../src/commands/graph-probe-handler.js';
import { buildGraphResult } from '../../src/graph/graph-contract.js';

function ctx(env: Record<string, string | undefined> = {}, surface = 'cli') {
  return createCommandContext({ surface, env, invocationId: `graph-probe-${surface}` });
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
    await executeGraphProbe(args, ctx(env));
  } catch (error) {
    const command = (error as { commandResult?: CommandView }).commandResult;
    assert.ok(command, 'expected a commandResult on failure');
    return command;
  }
  assert.fail('expected executeGraphProbe to throw');
}

test('graph.probe maps envelope statuses to command outcomes', () => {
  const okItems = [{ query: 'type:Organization', status: 'ok' as const, hits: 3 }];
  for (const [status, outcome] of [['ok', 'success'], ['partial', 'partial']] as const) {
    const envelope = buildGraphResult({
      status, language: 'dql', provider: 'diffbot',
      data: { kind: 'probe', items: status === 'partial' ? [...okItems, { query: 'bad', status: 'error' as const, error: { code: 'upstream_error' as const, message: 'x', retryable: false } }] : okItems },
      ...(status === 'partial' ? { errors: [{ code: 'upstream_error' as const, message: 'x', retryable: false }] } : {}),
    });
    const result = mapGraphProbeCommandResult(envelope, ctx());
    assert.equal(result.commandId, GRAPH_PROBE_COMMAND);
    assert.equal(result.outcome, outcome);
    assert.equal(result.trust, 'external');
    assert.equal(result.resolvedSurface, GRAPH_PROBE_COMMAND);
  }
});

test('graph.probe full-error envelope maps to failed', () => {
  const envelope = buildGraphResult({
    status: 'error', language: 'dql', provider: 'diffbot',
    data: { kind: 'probe', items: [{ query: 'bad', status: 'error', error: { code: 'rate_limited', message: 'slow', retryable: true } }] },
    errors: [{ code: 'rate_limited', message: 'slow', retryable: true }],
  });
  const result = mapGraphProbeCommandResult(envelope, ctx());
  assert.equal(result.outcome, 'failed');
  assert.equal(result.error?.code, 'rate_limited');
  assert.equal(result.retryability, 'retryable');
});

test('graph.probe rejects wrong action without network', async () => {
  const command = await fails({ action: 'query', query: 'type:Organization' });
  assert.equal(command.error?.code, 'invalid_input');
  assert.match(command.error?.message ?? '', /action must be "probe"/);
});

test('graph.probe rejects batch bound violations instead of clamping, no network', async () => {
  const empty = commandOf(await executeGraphProbe({ queries: [] }, ctx()));
  assert.equal(empty.error?.code, 'invalid_input');
  const tooMany = commandOf(await executeGraphProbe({ queries: Array.from({ length: 33 }, (_, i) => `q${i}`) }, ctx()));
  assert.equal(tooMany.error?.code, 'invalid_input');
  assert.match(tooMany.error?.message ?? '', /1\.\.32/);
});

test('graph.probe maps abort to cancelled', async () => {
  const controller = new AbortController();
  controller.abort();
  try {
    await executeGraphProbe({ queries: ['type:Organization'] }, { ...ctx(), signal: controller.signal });
  } catch (error) {
    assert.equal((error as { commandResult?: CommandView }).commandResult?.outcome, 'cancelled');
    return;
  }
  assert.fail('expected cancellation to throw');
});
