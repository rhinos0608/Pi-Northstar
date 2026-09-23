import assert from 'node:assert/strict';
import { test } from 'node:test';
import { commandSurface } from '../../src/commands/command-registry.js';
import { createCommandContext } from '../../src/commands/command-context.js';
import { executeKgNative, KG_NATIVE_COMMAND } from '../../src/commands/kg-native-handler.js';
import { executeGraphSchema, GRAPH_SCHEMA_COMMAND } from '../../src/commands/graph-schema-handler.js';

function ctx() {
  return createCommandContext({
    surface: 'internal',
    env: {},
    invocationId: 'expansion-routing-test',
  });
}

function commandFailure(error: unknown) {
  return (error as {
    commandResult?: {
      commandId: string;
      outcome: string;
      error?: { code: string };
    };
  }).commandResult;
}

test('registry resolves internal routes without exposing them in CLI/skill discovery', () => {
  const surface = commandSurface();
  assert.equal(surface.includes(KG_NATIVE_COMMAND), false);
  assert.equal(surface.includes(GRAPH_SCHEMA_COMMAND), false);
});
test('kg.native validates all three public KG actions before provider dispatch', async () => {
  for (const request of [
    { action: 'search' },
    { action: 'enhance' },
    { action: 'analyze_text' },
  ]) {
    try {
      await executeKgNative(request, ctx());
      assert.fail('expected validation failure');
    } catch (error) {
      const failure = commandFailure(error);
      assert.equal(failure?.commandId, KG_NATIVE_COMMAND);
      assert.equal(failure?.outcome, 'failed');
      assert.ok(failure?.error?.code);
    }
  }
});

test('graph.schema returns a canonical command failure for invalid schema input', async () => {
  const result = await executeGraphSchema(
    { action: 'schema', language: 'dql', view: 'not-a-view' },
    ctx(),
  );
  const failure = (result.details as {
    northstarCommand?: {
      commandId: string;
      outcome: string;
      error?: { code: string };
    };
  }).northstarCommand;
  assert.equal(failure?.commandId, GRAPH_SCHEMA_COMMAND);
  assert.equal(failure?.outcome, 'failed');
  assert.ok(failure?.error?.code);
});
