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
  caps?: { outputModes: string[]; correlationV2?: { ownerPattern: string; roles: string[] } };
  failCode?: string;
}): { provider: {
  refreshReady(): Promise<boolean>;
  runLeaf(prompt: string, runOpts?: CapturedCall['opts']): Promise<{ text: string }>;
  getNegotiatedCapabilities(): { outputModes: string[]; correlationV2?: { ownerPattern: string; roles: string[] } } | undefined;
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
};

test('leaf model happy path: plan/evaluation/IR parse in json mode', async () => {
  const { createLeafModelClient } = await import('../../../src/web/agent/agent-model.js');
  const planText = JSON.stringify({ questions: [{ question: 'What evidence backs this claim?', priority: 2, required: true }], scopeNotes: ['n1'] });
  const evalText = JSON.stringify({ questionUpdates: [], nextQueries: ['q1 query here'], shouldContinue: false });
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
