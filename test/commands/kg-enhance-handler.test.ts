import assert from 'node:assert/strict';
import test from 'node:test';
import type { BackendCallResult } from '../../src/backend.js';
import { createCommandContext } from '../../src/commands/command-context.js';
import {
  executeKgEnhance,
  KG_ENHANCE_COMMAND,
  mapKgEnhanceCommandResult,
} from '../../src/commands/kg-enhance-handler.js';
import { buildKnowledgeResult } from '../../src/knowledge/knowledge-contract.js';

function ctx(env: Record<string, string | undefined> = {}, surface = 'cli') {
  return createCommandContext({ surface, env, invocationId: `kg-enhance-${surface}` });
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
    await executeKgEnhance(args, ctx(env));
  } catch (error) {
    const command = (error as { commandResult?: CommandView }).commandResult;
    assert.ok(command, 'expected a commandResult on failure');
    return command;
  }
  assert.fail('expected executeKgEnhance to throw');
}

const ENTITY = { entityVersion: 1, id: 'kg-acme', type: 'Organization', name: 'Acme' } as const;

test('kg.enhance maps envelope statuses to command outcomes', () => {
  for (const [status, outcome] of [['ok', 'success'], ['empty', 'empty'], ['partial', 'partial']] as const) {
    const envelope = buildKnowledgeResult({
      request: { tool: 'kg', action: 'enhance', providers: ['diffbot'] },
      outcomes: status === 'empty'
        ? [{ provider: 'diffbot', entities: [] }]
        : [{ provider: 'diffbot', entities: [{ ...ENTITY }], ...(status === 'partial' ? { invalid: 1 } : {}) }],
      data: {
        kind: 'enhance', entities: status === 'empty' ? [] : [{ ...ENTITY }],
        claims: [], conflicts: [], partitions: [{ provider: 'diffbot', status },
      ] },
    });
    assert.equal(envelope.status, status, `fixture status ${status}`);
    const result = mapKgEnhanceCommandResult(envelope, ctx());
    assert.equal(result.commandId, KG_ENHANCE_COMMAND);
    assert.equal(result.outcome, outcome);
    assert.equal(result.trust, 'external');
    assert.equal(result.resolvedSurface, KG_ENHANCE_COMMAND);
  }
});

test('kg.enhance rejects missing selectors, Person-only keys on Organization, and unknown fields', async () => {
  assert.equal((await fails({ type: 'Person' })).error?.code, 'invalid_input');
  assert.match((await fails({ type: 'Person' })).error?.message ?? '', /at least one selector/);
  assert.equal((await fails({ type: 'Organization', employer: 'Acme', name: 'Acme' })).error?.code, 'invalid_input');
  assert.equal((await fails({ type: 'Person', name: 'Ada', refresh: true })).error?.code, 'invalid_input');
  assert.match((await fails({ type: 'Person', name: 'Ada', refresh: true })).error?.message ?? '', /unknown kg\.enhance field/);
  assert.equal((await fails({ type: 'Person', name: 'Ada', action: 'search' })).error?.code, 'invalid_input');
});

test('kg.enhance rejects out-of-range maxEntities instead of clamping', async () => {
  for (const maxEntities of [0, 11, 99, 1.5, '3']) {
    const command = await fails({ type: 'Person', name: 'Ada', maxEntities });
    assert.equal(command.error?.code, 'invalid_input', `maxEntities ${String(maxEntities)}`);
    assert.match(command.error?.message ?? '', /maxEntities must be an integer 1\.\.10/);
  }
});

test('kg.enhance without token fails terminal and never echoes email/phone selectors', async () => {
  const result = await executeKgEnhance(
    { type: 'Person', name: 'Ada', email: 'ada@example.com', phone: '+1-555-0100' },
    ctx(),
  );
  const command = commandOf(result);
  assert.equal(command.outcome, 'failed');
  assert.equal(command.retryability, 'not_retryable');
  const text = JSON.stringify(result.details);
  assert.ok(!text.includes('ada@example.com'), 'email selector must never echo');
  assert.ok(!text.includes('555-0100'), 'phone selector must never echo');
});

test('kg.enhance validation failure echoes no secret', async () => {
  const command = await fails({ type: 'Person', name: 'Ada', maxEntities: 99 }, { DIFFBOT_TOKEN: 'secret-token-xyz' });
  assert.equal(command.error?.code, 'invalid_input');
  assert.ok(!(command.error?.message ?? '').includes('secret-token-xyz'), 'token must never echo into errors');
});

test('kg.enhance maps abort to cancelled', async () => {
  const controller = new AbortController();
  controller.abort();
  try {
    await executeKgEnhance({ type: 'Person', name: 'Ada' }, { ...ctx(), signal: controller.signal });
  } catch (error) {
    assert.equal((error as { commandResult?: CommandView }).commandResult?.outcome, 'cancelled');
    return;
  }
  assert.fail('expected cancellation to throw');
});
