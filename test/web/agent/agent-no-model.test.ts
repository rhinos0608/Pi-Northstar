import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  EVIDENCE_ONLY_DEGRADED_WARNING,
  runAgentCore,
} from '../../../src/web/agent/agent-core.js';
import { validateAgentResult } from '../../../src/web/agent/agent-contract.js';
import {
  AGENT_STEERING_ENV_VAR,
  isAgentSteeringDisabled,
  stripAgentModelDeps,
} from '../../../src/web/agent/agent-jobs.js';
import { snapshotForJob } from '../../../src/web/agent/agent-capabilities.js';

// Wave 6 ladder: absent synthesizer (kill-switch) degrades to the
// evidence-only floor — ledger-only output, no passage-composed prose.
const FILLER =
  ' Additional background context about the product lineup and release notes follows here for completeness and extra length.';
const OVERVIEW = `Acme Pro overview page with general marketing words and nothing about cost specifics here at all today.${FILLER}`;

const fullModelDeps = () => ({
  search: async () => [{ title: 'Overview', url: 'https://example.com/overview' }],
  fetchText: async () => OVERVIEW,
  planner: async () => ({ questions: [], scopeNotes: [] }),
  evaluator: async () => ({ questionUpdates: [], nextActions: [], shouldContinue: false }),
  synthesizer: async () => ({ blocks: [], claimUnits: [], unresolvedGaps: [] }),
  verifier: async () => ({ clauseVerdicts: [], reason: 'unused' }),
  repairer: async () => ({ blocks: [], claimUnits: [], unresolvedGaps: [] }),
  utilityModelClient: { completeJson: async () => ({ ok: false, reason: 'provider_error' }) },
  capabilitiesSnapshot: snapshotForJob({}),
  deadlineMs: 12345,
  signal: new AbortController().signal,
  onProgress: () => {},
});

const runnableStripped = () => {
  const stripped = stripAgentModelDeps(fullModelDeps() as Parameters<typeof stripAgentModelDeps>[0]);
  // Time-bound legs are preserved by the strip (asserted above) but would
  // fail the deterministic ladder: deadlineMs is an absolute clock bound
  // and the fixture value sits in the past. Drop them for this run only.
  delete stripped.deadlineMs;
  delete stripped.signal;
  return stripped;
};

test('kill-switch env name is exact and only exact 0 disables', () => {
  assert.equal(AGENT_STEERING_ENV_VAR, 'PI_NORTHSTAR_AGENT_STEERING');
  assert.equal(isAgentSteeringDisabled({ [AGENT_STEERING_ENV_VAR]: '0' }), true);
  for (const value of ['1', '', 'false', '00', ' 0']) {
    assert.equal(isAgentSteeringDisabled({ [AGENT_STEERING_ENV_VAR]: value }), false, JSON.stringify(value));
  }
  assert.equal(isAgentSteeringDisabled({}), false);
});

test('kill-switch strips every model-call dep and keeps the legs', () => {
  const deps = fullModelDeps() as Parameters<typeof stripAgentModelDeps>[0];
  const stripped = stripAgentModelDeps(deps);
  assert.equal(stripped.planner, undefined);
  assert.equal(stripped.evaluator, undefined);
  assert.equal(stripped.synthesizer, undefined);
  assert.equal(stripped.verifier, undefined);
  assert.equal(stripped.repairer, undefined);
  assert.equal(stripped.utilityModelClient, undefined);
  assert.equal(typeof stripped.search, 'function');
  assert.equal(typeof stripped.fetchText, 'function');
  assert.equal('report' in stripped, false, 'report leg dep is gone');
  assert.equal(stripped.capabilitiesSnapshot, deps.capabilitiesSnapshot);
  assert.equal(stripped.deadlineMs, deps.deadlineMs);
  assert.equal(stripped.signal, deps.signal);
  assert.equal(stripped.onProgress, deps.onProgress);
});

test('stripped deps run the evidence-only ladder end to end', async () => {
  const result = await runAgentCore('Acme Pro pricing overview', runnableStripped());
  assert.ok(validateAgentResult(result).ok, JSON.stringify(validateAgentResult(result).issues));
  // Ledger-only output: the kill-switch degrades to evidence-only composition.
  assert.ok(result.warnings.includes(EVIDENCE_ONLY_DEGRADED_WARNING), JSON.stringify(result.warnings));
  assert.ok(!result.warnings.includes('synthesis from evidence IR'), 'no IR synthesis without the seam');
  // Preserved sources: the fetched URL still ships as an extracted source.
  assert.ok(result.sources.length > 0, 'local evidence still composes sources');
  assert.ok(
    result.sources.every((source) => source.sourceKind === 'extracted'),
    `ledger-only sources; got ${JSON.stringify(result.sources.map((s) => s.sourceKind))}`,
  );
  assert.ok(result.sources.some((source) => source.url === 'https://example.com/overview'));
  // No passage-narrative path: claims cite catalog sources only, and the
  // admitted excerpt ships verbatim instead of recomposed prose.
  for (const claim of result.claims) {
    assert.equal(claim.sourceIds.length, 1);
    for (const id of claim.sourceIds) assert.ok(result.sources.some((source) => source.id === id));
  }
  assert.ok(result.reportText.includes('Acme Pro overview page'), `admitted excerpt ships; got ${result.reportText}`);
});

test('kill-switch output shape equals failed-synthesis output shape', async () => {
  const failing = {
    ...runnableStripped(),
    synthesizer: async () => {
      throw new Error('synth down');
    },
  };
  const [killed, failed] = await Promise.all([
    runAgentCore('Acme Pro pricing overview', runnableStripped()),
    runAgentCore('Acme Pro pricing overview', failing),
  ]);
  assert.ok(validateAgentResult(killed).ok);
  assert.ok(validateAgentResult(failed).ok);
  // Same composition shape: identical sources, claims, and report body.
  assert.deepEqual(killed.sources, failed.sources);
  assert.deepEqual(killed.claims, failed.claims);
  assert.equal(killed.reportText, failed.reportText);
  // Same floor markers; the failed path additionally names the synthesis
  // failure that forced it there.
  for (const result of [killed, failed]) {
    assert.ok(result.warnings.includes(EVIDENCE_ONLY_DEGRADED_WARNING), JSON.stringify(result.warnings));
    assert.ok(!result.warnings.includes('synthesis from evidence IR'));
  }
  assert.ok(
    failed.warnings.includes('synthesis IR invalid; using cycle composition'),
    JSON.stringify(failed.warnings),
  );
  assert.ok(
    !killed.warnings.includes('synthesis IR invalid; using cycle composition'),
    `absent seam never attempts synthesis; got ${JSON.stringify(killed.warnings)}`,
  );
});
