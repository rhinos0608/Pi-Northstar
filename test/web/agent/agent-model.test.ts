import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createScriptedModel } from './helpers/agent-model-fake.js';

test('scripted model matches prompts and records calls', async () => {
  const model = createScriptedModel([
    { match: 'plan', value: { questions: [] } },
    { fail: 'boom' },
  ]);
  const first = await model.completeJson<{ questions: unknown[] }>('please plan now', 'plan');
  assert.deepEqual(first, { ok: true, value: { questions: [] } });
  const second = await model.completeJson('other prompt', 'eval');
  assert.deepEqual(second, { ok: true, value: { questions: [] } });
  assert.deepEqual(model.calls, [
    { prompt: 'please plan now', schemaName: 'plan' },
    { prompt: 'other prompt', schemaName: 'eval' },
  ]);
});

test('scripted model returns failures and repeats the last step', async () => {
  const model = createScriptedModel([{ fail: 'down' }]);
  assert.deepEqual(await model.completeJson('a', 's'), { ok: false, reason: 'down' });
  assert.deepEqual(await model.completeJson('b', 's'), { ok: false, reason: 'down' });
});

test('scripted model deep-clones values and supports regex match', async () => {
  const model = createScriptedModel([{ match: /eval-\d+/, value: { list: [1] } }]);
  const out = await model.completeJson<{ list: number[] }>('run eval-42 now', 'eval');
  assert.ok(out.ok);
  if (out.ok) {
    out.value.list.push(2);
  }
  const again = await model.completeJson<{ list: number[] }>('run eval-42 now', 'eval');
  assert.deepEqual(again, { ok: true, value: { list: [1] } });
});

interface CapturedCall {
  prompt: string;
  opts?: { maxOutputTokens?: number; timeoutMs?: number; outputSchema?: unknown; role?: string; stage?: string };
}

function leafFake(opts: {
  text?: string;
  caps?: { outputModes: string[]; correlationV2?: { ownerPattern: string; roles: string[] }; jsonSchema?: 'flat-v1' | 'structured-v1' };
  failCode?: string;
} ): { provider: {
  refreshReady(): Promise<boolean>;
  runLeaf(prompt: string, runOpts?: CapturedCall['opts']): Promise<{ text: string }>;
  getNegotiatedCapabilities(): { outputModes: string[]; correlationV2?: { ownerPattern: string; roles: string[] }; jsonSchema?: 'flat-v1' | 'structured-v1' } | undefined;
}; calls: CapturedCall[] } {
  const calls: CapturedCall[] = [];
  return {
    calls,
    provider: {
      refreshReady: async () => true,
      runLeaf: async (prompt: string, runOpts?: CapturedCall['opts']) => {
        calls.push(runOpts === undefined ? { prompt } : { prompt, opts: runOpts });
        if (opts.failCode !== undefined) {
          const error = new Error('provider blew up with sk-secret-123') as Error & { code: string };
          error.code = opts.failCode;
          throw error;
        }
        return { text: opts.text ?? '' };
      },
      getNegotiatedCapabilities: () => opts.caps,
    },
  };
}

const JSON_CAPS = {
  outputModes: ['text', 'json'],
  correlationV2: { ownerPattern: '^[a-z][a-z0-9_-]{2,31}$', roles: ['coverage_planner', 'researcher', 'synthesizer'] },
  jsonSchema: 'structured-v1' as const,
};

test('leaf model happy path: plan/evaluation/IR parse in json mode', async () => {
  const { createLeafModelClient } = await import('../../../src/web/agent/agent-model.js');
  const planText = JSON.stringify({ questions: [{ question: 'What evidence backs this claim?', priority: 2, required: true }], scopeNotes: ['n1'] });
  const evalText = JSON.stringify({ questionUpdates: [], nextActions: [], shouldContinue: false });
  const irText = JSON.stringify({
    blocks: [{ sectionId: 's', prose: 'p', claimUnitIds: ['c1'] }],
    claimUnits: [{ text: 't', evidenceIds: ['e1'] }],
  });
  const planFake = leafFake({ text: planText, caps: JSON_CAPS });
  const plan = await createLeafModelClient(planFake.provider).completeJson<{ questions: unknown[] }>('GOAL x', 'plan');
  assert.deepEqual(plan, { ok: true, value: JSON.parse(planText) });
  assert.equal(planFake.calls[0]?.opts?.maxOutputTokens, 2048);
  assert.equal(planFake.calls[0]?.opts?.role, 'coverage_planner');
  assert.deepEqual((planFake.calls[0]?.opts?.outputSchema as { required: string[] })?.required, ['questions']);

  const evalFake = leafFake({ text: evalText, caps: JSON_CAPS });
  const evaluation = await createLeafModelClient(evalFake.provider).completeJson('GOAL x', 'evaluation');
  assert.ok(evaluation.ok);
  assert.equal(evalFake.calls[0]?.opts?.maxOutputTokens, 2048);
  assert.equal(evalFake.calls[0]?.opts?.role, 'researcher');

  const irFake = leafFake({ text: irText, caps: JSON_CAPS });
  const ir = await createLeafModelClient(irFake.provider).completeJson('GOAL x', 'synthesis-ir');
  assert.ok(ir.ok);
  assert.equal(irFake.calls[0]?.opts?.maxOutputTokens, 4096);
  assert.equal(irFake.calls[0]?.opts?.role, 'synthesizer');
});

test('leaf model: parse failure and wire-gate failure map to schema_error without provider text', async () => {
  const { createLeafModelClient } = await import('../../../src/web/agent/agent-model.js');
  const bad = leafFake({ text: 'not json at all {{{ SECRET-MARKER', caps: JSON_CAPS });
  const parsed = await createLeafModelClient(bad.provider).completeJson('p', 'plan');
  assert.deepEqual(parsed, { ok: false, reason: 'schema_error' });
  const shape = leafFake({ text: JSON.stringify({ nope: 1 }), caps: JSON_CAPS });
  assert.deepEqual(await createLeafModelClient(shape.provider).completeJson('p', 'plan'), {
    ok: false,
    reason: 'schema_error',
  });
  const failing = leafFake({ failCode: 'provider_error' });
  const failed = await createLeafModelClient(failing.provider).completeJson('p', 'plan');
  assert.deepEqual(failed, { ok: false, reason: 'provider_error' });
  assert.ok(!JSON.stringify(failed).includes('sk-secret-123'));
  const unknown = leafFake({ text: '{}', caps: JSON_CAPS });
  assert.deepEqual(await createLeafModelClient(unknown.provider).completeJson('p', 'nope'), {
    ok: false,
    reason: 'unknown_schema',
  });
});

test('leaf model: text-mode fallback parses fenced JSON, omits outputSchema, uses v1 researcher role', async () => {
  const { createLeafModelClient } = await import('../../../src/web/agent/agent-model.js');
  const inner = JSON.stringify({ questions: [{ question: 'Why does this matter here?' }] });
  const fake = leafFake({ text: `\`\`\`json\n${inner}\n\`\`\``, caps: { outputModes: ['text'] } });
  const out = await createLeafModelClient(fake.provider).completeJson<{ questions: unknown[] }>('GOAL x', 'plan');
  assert.deepEqual(out, { ok: true, value: JSON.parse(inner) });
  assert.equal(fake.calls[0]?.opts?.role, 'researcher');
  assert.ok(!('outputSchema' in (fake.calls[0]?.opts ?? {})));
  // No capabilities at all: same v1 text path.
  const bare = leafFake({ text: inner });
  const bareOut = await createLeafModelClient(bare.provider).completeJson('GOAL x', 'evaluation');
  assert.equal(bareOut.ok, false);
  assert.equal(bare.calls[0]?.opts?.role, 'researcher');
});

test('leaf model: per-call token override wins over role default', async () => {
  const { createLeafModelClient } = await import('../../../src/web/agent/agent-model.js');
  const text = JSON.stringify({ questions: [{ question: 'What changed in this release?' }] });
  const fake = leafFake({ text, caps: JSON_CAPS });
  const out = await createLeafModelClient(fake.provider).completeJson('GOAL x', 'plan', { maxOutputTokens: 512 });
  assert.ok(out.ok);
  assert.equal(fake.calls[0]?.opts?.maxOutputTokens, 512);
});

test('leaf model: verification happy path passes, per-item reason optional', async () => {
  const { createLeafModelClient } = await import('../../../src/web/agent/agent-model.js');
  const full = JSON.stringify({
    clauseVerdicts: [
      { clause: 'Revenue grew 12% in 2025.', verdict: 'supported', reason: 'excerpt states it' },
      { clause: 'Churn fell.', verdict: 'not_enough_evidence' },
    ],
    reason: 'checked against admitted excerpts',
  });
  const okFake = leafFake({ text: full, caps: JSON_CAPS });
  const ok = await createLeafModelClient(okFake.provider).completeJson('verify this', 'verification');
  assert.deepEqual(ok, { ok: true, value: JSON.parse(full) });

  const noItemReason = JSON.stringify({
    clauseVerdicts: [{ clause: 'Revenue grew.', verdict: 'refuted' }],
    reason: 'contradicted by excerpt',
  });
  const bareFake = leafFake({ text: noItemReason, caps: JSON_CAPS });
  assert.deepEqual(await createLeafModelClient(bareFake.provider).completeJson('verify this', 'verification'), {
    ok: true,
    value: JSON.parse(noItemReason),
  });
});

test('leaf model: verification rejects missing clause and unknown verdict', async () => {
  const { createLeafModelClient } = await import('../../../src/web/agent/agent-model.js');
  const missing = leafFake({
    text: JSON.stringify({ clauseVerdicts: [{ verdict: 'supported' }], reason: 'r' }),
    caps: JSON_CAPS,
  });
  assert.deepEqual(await createLeafModelClient(missing.provider).completeJson('p', 'verification'), {
    ok: false,
    reason: 'schema_error',
  });
  const unknown = leafFake({
    text: JSON.stringify({ clauseVerdicts: [{ clause: 'c', verdict: 'maybe' }], reason: 'r' }),
    caps: JSON_CAPS,
  });
  assert.deepEqual(await createLeafModelClient(unknown.provider).completeJson('p', 'verification'), {
    ok: false,
    reason: 'schema_error',
  });
});

test('createAgentModelSeams: each role calls completeJson with its schema name', async () => {
  const { createAgentModelSeams } = await import('../../../src/web/agent/agent-model.js');
  const planText = JSON.stringify({ questions: [{ question: 'What evidence backs this claim?' }] });
  const evalText = JSON.stringify({ questionUpdates: [], nextActions: [], shouldContinue: false });
  const irText = JSON.stringify({
    blocks: [{ sectionId: 's', prose: 'p', claimUnitIds: ['c1'] }],
    claimUnits: [{ text: 't', evidenceIds: ['e1'] }],
  });
  const verifyText = JSON.stringify({ clauseVerdicts: [], reason: 'checked' });
  const byStage: Record<string, string> = {
    'agent-plan': planText,
    'agent-evaluate': evalText,
    'agent-synthesize': irText,
    'agent-verify': verifyText,
  };
  const seenStages: Array<string | undefined> = [];
  const seams = createAgentModelSeams({
    refreshReady: async () => true,
    runLeaf: async (_prompt: string, runOpts?: { stage?: string }) => {
      seenStages.push(runOpts?.stage);
      return { text: byStage[runOpts?.stage ?? ''] ?? planText };
    },
  });
  const plan = await seams.planner('goal topic', { maxRounds: 3, maxSearches: 4, maxFetches: 12, maxUtilityCalls: 8 });
  assert.deepEqual(plan, JSON.parse(planText));
  assert.deepEqual(await seams.evaluator({ prompt: 'e' }), JSON.parse(evalText));
  assert.deepEqual(await seams.synthesizer({ prompt: 's' }), JSON.parse(irText));
  assert.deepEqual(await seams.verifier({ prompt: 'v' }), JSON.parse(verifyText));
  // Repairer reuses the synthesis schema/model: same stage, IR value.
  assert.deepEqual(await seams.repairer({ prompt: 'r' }), JSON.parse(irText));
  assert.deepEqual(seenStages, ['agent-plan', 'agent-evaluate', 'agent-synthesize', 'agent-verify', 'agent-synthesize']);
  // Shared client is the same machinery: unknown schema stays unknown_schema.
  assert.deepEqual(await seams.utilityModelClient.completeJson('p', 'nope'), {
    ok: false,
    reason: 'unknown_schema',
  });
});

test('createAgentModelSeams: leaf failure degrades to undefined with fixed safe reason, never throws', async () => {
  const { createAgentModelSeams } = await import('../../../src/web/agent/agent-model.js');
  const seams = createAgentModelSeams({
    refreshReady: async () => true,
    runLeaf: async () => {
      throw Object.assign(new Error('boom sk-secret-123'), { code: 'provider_error' });
    },
  });
  assert.equal(await seams.planner('goal topic', { maxRounds: 3, maxSearches: 4, maxFetches: 12, maxUtilityCalls: 8 }), undefined);
  assert.equal(await seams.evaluator({ prompt: 'e' }), undefined);
  assert.equal(await seams.synthesizer({ prompt: 's' }), undefined);
  assert.equal(await seams.verifier({ prompt: 'v' }), undefined);
  assert.equal(await seams.repairer({ prompt: 'r' }), undefined);
  const failed = await seams.utilityModelClient.completeJson('p', 'plan');
  assert.deepEqual(failed, { ok: false, reason: 'provider_error' });
  assert.ok(!JSON.stringify([failed]).includes('sk-secret-123'));
});

test('leaf model force-text guard: wire schema only on negotiated structured-v1', async () => {
  const { createLeafModelClient } = await import('../../../src/web/agent/agent-model.js');
  const planText = JSON.stringify({ questions: [{ question: 'What evidence backs this claim?' }] });
  // (a) json outputMode but no jsonSchema dialect → text mode, client parse used.
  const noDialect = leafFake({
    text: planText,
    caps: {
      outputModes: ['text', 'json'],
      correlationV2: { ownerPattern: '^[a-z][a-z0-9_-]{2,31}$', roles: ['coverage_planner'] },
    },
  });
  assert.deepEqual(await createLeafModelClient(noDialect.provider).completeJson('GOAL x', 'plan'), {
    ok: true,
    value: JSON.parse(planText),
  });
  assert.ok(!('outputSchema' in (noDialect.calls[0]?.opts ?? {})), 'no dialect → no wire schema');
  // (b) negotiated structured-v1 → outputSchema forwarded.
  const structured = leafFake({ text: planText, caps: JSON_CAPS });
  assert.ok((await createLeafModelClient(structured.provider).completeJson('GOAL x', 'plan')).ok);
  assert.deepEqual((structured.calls[0]?.opts?.outputSchema as { required: string[] })?.required, ['questions']);
  // (c) flat-v1 or garbage dialect → no wire schema, text parse still succeeds.
  // Cast: the negotiated type only carries known dialects (unknowns drop at
  // parse), but the wire gate must still stay text-mode if one ever arrives.
  for (const jsonSchema of ['flat-v1', 'structured-v2', '', 'STRUCTURED-V1']) {
    const fake = leafFake({
      text: planText,
      caps: {
        outputModes: ['text', 'json'],
        correlationV2: { ownerPattern: '^[a-z][a-z0-9_-]{2,31}$', roles: ['coverage_planner'] },
        jsonSchema: jsonSchema as 'flat-v1' | 'structured-v1',
      },
    });
    assert.deepEqual(await createLeafModelClient(fake.provider).completeJson('GOAL x', 'plan'), {
      ok: true,
      value: JSON.parse(planText),
    }, `dialect ${JSON.stringify(jsonSchema)} must stay text mode`);
    assert.ok(!('outputSchema' in (fake.calls[0]?.opts ?? {})), `dialect ${JSON.stringify(jsonSchema)} → no wire schema`);
  }
});

test('wire schema pins web_fetch kind + url property (WG1 mirror)', async () => {
  const { createLeafModelClient, GATHER_INTENT_WIRE_SCHEMA } = await import('../../../src/web/agent/agent-model.js');
  const props = GATHER_INTENT_WIRE_SCHEMA['properties'] as Record<string, Record<string, unknown>>;
  const kindEnum = props['kind']!['enum'] as string[];
  assert.ok(kindEnum.includes('web_fetch'), 'kind enum must contain web_fetch');
  assert.ok('url' in props, 'schema properties must include url');
  // Minimal web_fetch fixture passes the structured-v1 wire gate inside a plan.
  const planText = JSON.stringify({
    questions: [{ question: 'What does the source say?', intent: { kind: 'web_fetch', url: 'http://example.com/x' } }],
  });
  const fake = leafFake({ text: planText, caps: JSON_CAPS });
  assert.deepEqual(await createLeafModelClient(fake.provider).completeJson('GOAL x', 'plan'), {
    ok: true,
    value: JSON.parse(planText),
  });
});

test('registry schemas fit the structured-v1 bounded subset (Task 9 enable check)', async () => {
  // Every SCHEMA_REGISTRY schema must fit the bounded structured subset the
  // negotiated dialect validates: object/array/primitives +
  // properties/required/items/enum/minimum/maximum/additionalProperties,
  // depth <= 10, keys <= 256, key length 1..128. Local mirror of the wire
  // rules — a registry schema failing here is a Task 9 blocker (tighten the
  // schema instead of widening the validator). Aliased registry names share
  // these objects, so covering each once covers the registry.
  const model = await import('../../../src/web/agent/agent-model.js');
  const { VERIFICATION_SCHEMA } = await import('../../../src/web/agent/agent-verifier.js');
  const schemas: Record<string, unknown> = {
    'agent-plan': model.AGENT_PLAN_SCHEMA,
    'agent-evaluation': model.AGENT_EVALUATION_SCHEMA,
    'synthesis-ir': model.AGENT_SYNTHESIS_IR_SCHEMA,
    verification: VERIFICATION_SCHEMA,
    'gather-intent-wire': model.GATHER_INTENT_WIRE_SCHEMA,
  };
  const ALLOWED_TYPES = new Set(['object', 'array', 'string', 'number', 'integer', 'boolean']);
  const ALLOWED_KEYS = new Set([
    'type', 'properties', 'required', 'items', 'enum', 'minimum', 'maximum', 'additionalProperties',
  ]);
  const check = (node: unknown, where: string, depth: number, keyCount: { count: number }): void => {
    assert.ok(depth <= 10, `${where}: depth ${depth} exceeds structured-v1 bound 10`);
    if (Array.isArray(node)) {
      for (let i = 0; i < node.length; i++) check(node[i], `${where}[${i}]`, depth + 1, keyCount);
      return;
    }
    if (typeof node !== 'object' || node === null) return;
    const record = node as Record<string, unknown>;
    for (const key of Object.keys(record)) {
      assert.ok(key.length >= 1 && key.length <= 128, `${where}: key length out of bounds`);
      assert.ok(ALLOWED_KEYS.has(key), `${where}: keyword '${key}' outside structured-v1 subset`);
      keyCount.count += 1;
    }
    assert.ok(keyCount.count <= 256, `${where}: keys exceed structured-v1 bound 256`);
    if (record['type'] !== undefined) assert.ok(ALLOWED_TYPES.has(record['type'] as string), `${where}: type '${String(record['type'])}' outside subset`);
    // properties maps field names to schema nodes: only the values recurse.
    if (record['properties'] !== undefined) {
      const props = record['properties'] as Record<string, unknown>;
      for (const [field, sub] of Object.entries(props)) {
        assert.ok(field.length >= 1 && field.length <= 128, `${where}.properties: field name out of bounds`);
        keyCount.count += 1;
        check(sub, `${where}.properties.${field}`, depth + 1, keyCount);
      }
      assert.ok(keyCount.count <= 256, `${where}: keys exceed structured-v1 bound 256`);
    }
    if (record['items'] !== undefined) check(record['items'], `${where}.items`, depth + 1, keyCount);
  };
  for (const [name, schema] of Object.entries(schemas)) {
    check(schema, name, 1, { count: 0 });
  }
  // Wire intent shape stays oneOf-free and enum-pinned (domain validator authoritative).
  const nestedIntent = (schema: unknown, arrayKey: string): unknown => {
    const root = schema as Record<string, unknown>;
    const props = root['properties'] as Record<string, unknown>;
    const arr = props[arrayKey] as Record<string, unknown>;
    const items = arr['items'] as Record<string, unknown>;
    const itemProps = items['properties'] as Record<string, unknown>;
    return itemProps['intent'];
  };
  assert.deepEqual(nestedIntent(model.AGENT_PLAN_SCHEMA, 'questions'), model.GATHER_INTENT_WIRE_SCHEMA);
  assert.deepEqual(nestedIntent(model.AGENT_EVALUATION_SCHEMA, 'nextActions'), model.GATHER_INTENT_WIRE_SCHEMA);
});
