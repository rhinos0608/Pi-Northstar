import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runAdaptiveCore, type AgentProgress } from '../../../src/web/agent/agent-core.js';
import { validateAgentResult } from '../../../src/web/agent/agent-contract.js';
import { stripAgentModelDeps } from '../../../src/web/agent/agent-jobs.js';
import { extractMaterialClauses } from '../../../src/web/agent/agent-verifier.js';

// Wave 6 mandatory test: EXACT model-call counts per ladder path. Every role
// seam is a counting fake (one invocation = one model call attempt, matching
// the utilityCallsUsed attempt semantics); the run's reported done-progress
// utilityCallsUsed must equal the counted total.

const FILLER =
  ' Additional background context about the product lineup and release notes follows here for completeness and extra length.';
const OVERVIEW = `Acme Pro overview page with general marketing words and nothing about cost specifics here at all today.${FILLER}`;

// Descriptive claim: no numbers/quotes/dates/comparisons, so the semantic
// gate stays closed and verification costs zero model calls.
const DESCRIPTIVE = 'Acme Pro overview page carries general marketing words.';
// Priced claim: the $199 value token is absent from the excerpt (no same-slot
// number to conflict with), so the deterministic rung yields
// not_enough_evidence and the semantic gate opens exactly once.
const PRICED = 'Acme Pro launch price is $199 per month.';

interface Counts {
  planner: number;
  evaluator: number;
  synthesizer: number;
  verifier: number;
  repairer: number;
}
const freshCounts = (): Counts => ({ planner: 0, evaluator: 0, synthesizer: 0, verifier: 0, repairer: 0 });
const total = (counts: Counts): number =>
  counts.planner + counts.evaluator + counts.synthesizer + counts.verifier + counts.repairer;

const evIdsIn = (prompt: string): string[] => [...new Set([...prompt.matchAll(/\bev-[0-9a-f]+/g)].map((m) => m[0]))];

function promptEvidence(prompt: string): Array<{ id: string; questionIds: string[] }> {
  const out: Array<{ id: string; questionIds: string[] }> = [];
  for (const line of prompt.split('\n')) {
    const match = /^-\s+(ev-\S+)\s+\[([^\]]*)\]/.exec(line);
    if (match) out.push({ id: match[1]!, questionIds: match[2]!.split(',').filter((s) => s !== '') });
  }
  return out;
}

function steeringDeps(
  counts: Counts,
  seams: {
    synthesizer: (args: { prompt: string }) => Promise<unknown>;
    verifier?: (args: { prompt: string }) => Promise<unknown>;
    repairer?: (args: { prompt: string }) => Promise<unknown>;
  },
) {
  return {
    search: async () => [{ title: 'Overview', url: 'https://example.com/overview' }],
    fetchText: async () => OVERVIEW,
    planner: async () => {
      counts.planner += 1;
      return {
        questions: [{ question: 'What is the launch price of Acme Pro?', priority: 3, required: true }],
        scopeNotes: [],
      };
    },
    evaluator: async ({ prompt }: { prompt: string }) => {
      counts.evaluator += 1;
      const [first] = promptEvidence(prompt);
      assert.ok(first, 'evaluator prompt carries this-round evidence with ids');
      return {
        questionUpdates: [{ questionId: first!.questionIds[0], status: 'answered' as const, evidenceIds: [first!.id] }],
        nextActions: [],
        shouldContinue: false,
      };
    },
    synthesizer: async ({ prompt }: { prompt: string }) => {
      counts.synthesizer += 1;
      return seams.synthesizer({ prompt });
    },
    ...(seams.verifier === undefined
      ? {}
      : {
          verifier: async ({ prompt }: { prompt: string }) => {
            counts.verifier += 1;
            return seams.verifier!({ prompt });
          },
        }),
    ...(seams.repairer === undefined
      ? {}
      : {
          repairer: async ({ prompt }: { prompt: string }) => {
            counts.repairer += 1;
            return seams.repairer!({ prompt });
          },
        }),
  };
}

function descriptiveIR(evIds: string[]): unknown {
  return {
    claimUnits: [{ id: 'cu-0', text: DESCRIPTIVE, evidenceIds: evIds }],
    blocks: [{ id: 'b-0', sectionId: 'pricing', prose: DESCRIPTIVE, claimUnitIds: ['cu-0'] }],
    unresolvedGaps: [],
  };
}

async function runCounted(deps: Parameters<typeof runAdaptiveCore>[1]): Promise<{
  doneUtility: number;
  warnings: string[];
  reportText: string;
}> {
  const seen: AgentProgress[] = [];
  const result = await runAdaptiveCore('Acme Pro pricing overview', {
    ...deps,
    onProgress: (progress) => {
      seen.push(progress);
    },
  });
  assert.ok(validateAgentResult(result).ok, JSON.stringify(validateAgentResult(result).issues));
  const done = seen.find((progress) => progress.stage === 'done');
  assert.ok(done, 'done progress emitted');
  assert.ok(typeof done.utilityCallsUsed === 'number', 'done progress reports utility calls used');
  return { doneUtility: done.utilityCallsUsed as number, warnings: result.warnings, reportText: result.reportText };
}

test('utility count: full steering success costs exactly 3 model calls', async () => {
  const counts = freshCounts();
  const { doneUtility, warnings } = await runCounted(
    steeringDeps(counts, {
      synthesizer: async ({ prompt }) => descriptiveIR(evIdsIn(prompt)),
      verifier: async () => ({ clauseVerdicts: [], reason: 'unused' }),
      repairer: async () => ({ blocks: [], claimUnits: [], unresolvedGaps: [] }),
    }),
  );
  assert.ok(warnings.includes('synthesis from evidence IR'));
  assert.ok(warnings.some((w) => /^verification: \d+ supported/.test(w)), 'deterministic verification pass ran');
  assert.ok(!warnings.some((w) => w.startsWith('repair')), `no repair leg; got ${JSON.stringify(warnings)}`);
  assert.deepEqual(counts, { planner: 1, evaluator: 1, synthesizer: 1, verifier: 0, repairer: 0 });
  assert.equal(total(counts), 3);
  assert.equal(doneUtility, 3, 'reported utility spend matches counted model calls');
});

test('utility count: synthesis failure still counts the attempt (exactly 3)', async () => {
  const counts = freshCounts();
  const { doneUtility, warnings } = await runCounted(
    steeringDeps(counts, {
      synthesizer: async () => {
        throw new Error('synth down');
      },
      verifier: async () => ({ clauseVerdicts: [], reason: 'unused' }),
      repairer: async () => ({ blocks: [], claimUnits: [], unresolvedGaps: [] }),
    }),
  );
  assert.ok(warnings.includes('synthesis IR invalid; using cycle composition'));
  assert.ok(warnings.includes('synthesis unavailable; evidence-only result composed from admitted evidence'));
  assert.deepEqual(counts, { planner: 1, evaluator: 1, synthesizer: 1, verifier: 0, repairer: 0 });
  assert.equal(total(counts), 3);
  assert.equal(doneUtility, 3, 'failed synthesis attempt still reported as spent');
});

test('utility count: verifier failure into repair costs exactly 5 model calls', async () => {
  const counts = freshCounts();
  const refutedClauses = extractMaterialClauses(PRICED).map((clause) => ({ clause, verdict: 'refuted' as const }));
  assert.ok(refutedClauses.length > 0, 'priced claim extracts material clauses');
  const { doneUtility, warnings, reportText } = await runCounted(
    steeringDeps(counts, {
      synthesizer: async ({ prompt }) => ({
        claimUnits: [{ id: 'cu-0', text: PRICED, evidenceIds: evIdsIn(prompt) }],
        blocks: [{ id: 'b-0', sectionId: 'pricing', prose: PRICED, claimUnitIds: ['cu-0'] }],
        unresolvedGaps: [],
      }),
      verifier: async () => ({ clauseVerdicts: refutedClauses, reason: 'excerpts contradict the price' }),
      repairer: async ({ prompt }) => ({
        claimUnits: [{ id: 'cu-r', text: DESCRIPTIVE, evidenceIds: evIdsIn(prompt) }],
        blocks: [{ id: 'b-r', sectionId: 'pricing', prose: DESCRIPTIVE, claimUnitIds: ['cu-r'] }],
        unresolvedGaps: [],
      }),
    }),
  );
  assert.ok(warnings.includes('repair applied: 1 claims re-supported'), JSON.stringify(warnings));
  assert.ok(reportText.includes('general marketing words'), `repaired text ships; got ${reportText}`);
  assert.ok(!reportText.includes('$199'), `refuted price removed; got ${reportText}`);
  // planner + evaluator + synthesis + 1 semantic refute + repair; the
  // re-verify of the repaired descriptive claim resolves deterministically.
  assert.deepEqual(counts, { planner: 1, evaluator: 1, synthesizer: 1, verifier: 1, repairer: 1 });
  assert.equal(total(counts), 5);
  assert.equal(doneUtility, 5, 'repair + reverify spend reported exactly');
});

test('utility count: kill-switch costs exactly 0 model calls', async () => {
  const counts = freshCounts();
  const full = steeringDeps(counts, {
    synthesizer: async ({ prompt }) => descriptiveIR(evIdsIn(prompt)),
    verifier: async () => ({ clauseVerdicts: [], reason: 'unused' }),
    repairer: async () => ({ blocks: [], claimUnits: [], unresolvedGaps: [] }),
  });
  const stripped = stripAgentModelDeps(full as Parameters<typeof stripAgentModelDeps>[0]);
  const seen: AgentProgress[] = [];
  const result = await runAdaptiveCore('Acme Pro pricing overview', {
    ...stripped,
    onProgress: (progress) => {
      seen.push(progress);
    },
  });
  assert.ok(validateAgentResult(result).ok, JSON.stringify(validateAgentResult(result).issues));
  assert.ok(result.sources.length > 0, 'deterministic legs still gather');
  assert.deepEqual(counts, { planner: 0, evaluator: 0, synthesizer: 0, verifier: 0, repairer: 0 });
  const done = seen.find((progress) => progress.stage === 'done');
  assert.ok(done && typeof done.utilityCallsUsed === 'number');
  assert.equal(done.utilityCallsUsed, 0, 'no model calls, no utility spend');
});
