import assert from 'node:assert/strict';
import test from 'node:test';
import type { BackendCallResult } from '../../src/backend.js';
import { createCommandContext } from '../../src/commands/command-context.js';
import { runCommand } from '../../src/cli/cli.js';
import { callNativeTool } from '../../src/native-tools.js';
import { executeKgSearch } from '../../src/commands/kg-search-handler.js';
import { executeKgEnhance } from '../../src/commands/kg-enhance-handler.js';
import { executeGraphQuery } from '../../src/commands/graph-query-handler.js';
import { executeGraphProbe } from '../../src/commands/graph-probe-handler.js';

type CommandView = {
  commandId: string; outcome: string;
  error?: { code: string; message: string; retryable: boolean };
};

function commandOf(result: BackendCallResult): CommandView {
  const command = (result.details as Record<string, unknown>).northstarCommand as CommandView;
  assert.ok(command, 'expected a northstarCommand on result');
  return command;
}

function ctx(env: Record<string, string | undefined> = {}) {
  return createCommandContext({ surface: 'test', env });
}

test('CLI discovery exposes kg/graph domains, capabilities, and help', async () => {
  const domains = await runCommand(['domains'], {});
  assert.ok((domains.data as string[]).includes('kg'));
  assert.ok((domains.data as string[]).includes('graph'));
  const caps = await runCommand(['capabilities'], {});
  for (const id of ['kg.search', 'kg.enhance', 'graph.query', 'graph.probe']) {
    assert.ok((caps.data as string[]).includes(id), `missing ${id}`);
  }
  for (const [domain, sub, id] of [['kg', 'search', 'kg.search'], ['kg', 'enhance', 'kg.enhance'], ['graph', 'query', 'graph.query'], ['graph', 'probe', 'graph.probe']] as const) {
    const result = await runCommand([domain, sub, '--help'], {});
    assert.equal(result.ok, true);
    assert.equal((result.data as { commandId: string }).commandId, id);
  }
});

test('CLI kg/graph reject malformed use strictly', async () => {
  assert.equal((await runCommand(['kg', 'search', '--bogus'], {})).error?.code, 'unknown_flag');
  assert.equal((await runCommand(['kg', 'enhance', '--name', 'Acme'], {})).error?.code, 'invalid_usage');
  assert.equal((await runCommand(['graph', 'query', '--query', 'q'], {})).error?.code, 'invalid_usage');
  assert.equal((await runCommand(['graph', 'query', '--language', 'dql'], {})).error?.code, 'invalid_usage');
  assert.equal((await runCommand(['graph', 'probe', '--language', 'dql', '--query', 'a', '--page-size', '5'], {})).error?.code, 'invalid_usage');
  assert.equal((await runCommand(['graph', 'query', '--language', 'dql', '--query', 'a', '--query', 'b'], {})).error?.code, 'invalid_usage');
  // Range stays contract-owned: CLI accepts integers, handler rejects out-of-range.
  const badLimit = await runCommand(['kg', 'search', 'Acme', '--limit', '99', '--json'], {});
  assert.equal(badLimit.ok, false);
  const cursor = await runCommand(['kg', 'search', 'Acme', '--cursor', 'AAAA', '--json'], {});
  assert.equal(cursor.ok, false);
  assert.match(JSON.stringify(cursor.data), /cursor_invalid/);
});

test('kg.search narrow slice parity: direct handler and CLI fail terminal without token', async () => {
  const direct = commandOf(await executeKgSearch({ query: 'type:Organization' }, ctx()));
  assert.equal(direct.commandId, 'kg.search');
  assert.equal(direct.outcome, 'failed');
  const cli = await runCommand(['kg', 'search', 'type:Organization', '--json'], {});
  assert.equal(cli.ok, false);
});

test('kg.enhance narrow slice parity: direct handler and CLI fail terminal without token', async () => {
  const direct = commandOf(await executeKgEnhance({ type: 'Organization', name: 'Acme' }, ctx()));
  assert.equal(direct.commandId, 'kg.enhance');
  assert.equal(direct.outcome, 'failed');
  const cli = await runCommand(['kg', 'enhance', '--type', 'Organization', '--name', 'Acme', '--json'], {});
  assert.equal(cli.ok, false);
});

test('native kg stays on the legacy owner for narrow and fanout composition alike', async () => {
  // Native kg keeps the legacy owner (spend policy, groups/evidence, paging live
  // only there): narrow and fanout calls alike never carry a narrow-slice
  // commandResult — they return the legacy envelope or throw raw.
  for (const args of [
    { action: 'search', query: 'type:Organization' },
    { action: 'enhance', type: 'Organization', name: 'Acme' },
    { action: 'search', query: 'type:Organization', providers: ['diffbot'] },
    { action: 'search', query: 'type:Organization', maxProviders: 2 },
  ]) {
    try {
      const result = await callNativeTool('kg', args, { env: {} });
      assert.equal((result.details as Record<string, unknown>).northstarCommand, undefined, `fanout leaked into registry: ${JSON.stringify(args)}`);
    } catch (error) {
      assert.ok(error instanceof Error && !('commandResult' in error), `fanout leaked into registry: ${JSON.stringify(args)}`);
    }
  }
});

test('native kg cursor continuation uses shared handler', async () => {
  await assert.rejects(
    () => callNativeTool('kg', { action: 'search', query: 'type:Organization', cursor: 'AAAA' }, { env: {} }),
    (error: unknown) => error instanceof Error && 'commandResult' in error,
  );
});

test('graph.query parity: direct, native, CLI reject bad pageSize without network', async () => {
  const direct = commandOf(await executeGraphQuery({ language: 'dql', query: 'type:Organization', pageSize: 999 }, ctx()));
  assert.equal(direct.error?.code, 'invalid_input');
  const native = commandOf(await callNativeTool('graph', { action: 'query', language: 'dql', query: 'type:Organization', pageSize: 999 }, { env: {} }));
  assert.equal(native.commandId, 'graph.query');
  assert.equal(native.error?.code, 'invalid_input');
  const cli = await runCommand(['graph', 'query', '--language', 'dql', '--query', 'type:Organization', '--page-size', '999', '--json'], {});
  assert.equal(cli.ok, false);
});

test('graph.probe routes through the registry; schema stays legacy', async () => {
  const probe = await executeGraphProbe({ language: 'dql', queries: ['type:Organization'] }, ctx());
  assert.equal(commandOf(probe).commandId, 'graph.probe');
  const nativeProbe = commandOf(await callNativeTool('graph', { action: 'probe', language: 'dql', queries: ['type:Organization'] }, { env: {} }));
  assert.equal(nativeProbe.commandId, 'graph.probe');
  // graph.schema has no handler: legacy envelope only, no query/probe command result.
  const schema = await callNativeTool('graph', { action: 'schema', language: 'dql', view: 'types' }, { env: {} });
  assert.equal((schema.details as Record<string, unknown>).northstarCommand, undefined);
});
