import assert from 'node:assert/strict';
import { test } from 'node:test';
import { snapshotForJob } from '../../../src/web/agent/agent-capabilities.js';
import {
  gatherExecutor,
  type GatherCounters,
  type GatherTools,
} from '../../../src/web/agent/agent-gather.js';
import {
  canDispatchAnyAction,
  resolveBudgets,
  stopPolicy,
  type GatherLane,
  type StopPolicyContext,
} from '../../../src/web/agent/agent-policy.js';
import { createAgentState } from '../../../src/web/agent/agent-state.js';
import {
  __getAgentEventJournal,
  __resetAgentJobs,
  createAgentJobEntry,
  executeAgentJob,
  setAgentJobRunner,
} from '../../../src/web/agent/agent-jobs.js';

// Wave 5 budget truth: preflight deletion + maxSearches web-lane scope +
// one shared exhaustion predicate for executor planning and stopPolicy().

const FILLER = ' Additional background context about the product lineup and release notes follows here for completeness and extra length.';
const BODY = (text: string): string => `${text} ${FILLER}`;

function webTools(overrides?: Partial<GatherTools>): GatherTools {
  return {
    search: async (query: string) => [
      { title: `Hit for ${query}`, url: 'https://example.com/page-one', snippet: 'snippet words here' },
    ],
    fetchText: async (url: string) => BODY(`Body text about the topic from ${url} with plenty of detail words for the passage.`),
    ...overrides,
  };
}

function gatherCtx(tools: GatherTools, counters?: GatherCounters, budgets?: ReturnType<typeof resolveBudgets>) {
  return {
    snapshot: snapshotForJob({}),
    state: createAgentState({ goal: 'budget truth probe' }),
    counters: counters ?? { searchesUsed: 0, fetchesUsed: 0 },
    tools,
    ...(budgets === undefined ? {} : { budgets }),
  };
}

const researchStub = async () => ({
  abstracts: [{ abstract: 'Study abstract showing the launch price effect with measured words and conclusions drawn here.', canonicalUrl: 'https://example.com/paper' }],
});
const githubStub = async () => ({
  contents: [{ content: BODY('Repository file content describing the pricing config with many words and negatives.'), canonicalUrl: 'https://github.com/acme/pro/blob/main/price.md' }],
});

// (a) No search executes before the controller in the driveAgentJob path:
// a single-round job performs exactly one backend search, journaled after
// the plan is accepted — zero acquisitions before round 1.
test('budget truth: driveAgentJob searches exactly once, after PlanAccepted', async () => {
  __resetAgentJobs();
  const seenQueries: string[] = [];
  setAgentJobRunner({
    search: async (query: string) => {
      seenQueries.push(query);
      return [{ title: 'A', url: 'https://example.com/a', snippet: 'alpha words' }];
    },
    fetchText: async () => 'alpha words about the query topic in detail',
  });
  try {
    const job = createAgentJobEntry({ query: 'budget truth topic' });
    const done = await executeAgentJob(job.jobId);
    assert.equal(done.status, 'ready');
    assert.deepEqual(seenQueries, ['budget truth topic']);
    const journal = __getAgentEventJournal(job.jobId);
    assert.ok(journal !== undefined);
    const types = journal.events.map((event) => event.type);
    const planAt = types.indexOf('PlanAccepted');
    const firstSearchAt = types.indexOf('SearchCompleted');
    assert.ok(planAt >= 0 && firstSearchAt >= 0);
    assert.ok(firstSearchAt > planAt, 'zero acquisitions before round 1');
  } finally {
    setAgentJobRunner(undefined);
    __resetAgentJobs();
  }
});

// (b) Specialist actions never consume maxSearches: tight web-search budget,
// research + github legs still dispatch and admit with searchesUsed untouched.
test('budget truth: specialist legs dispatch under an exhausted web-search budget', async () => {
  const budgets = resolveBudgets({ maxSearches: 1, maxGatherActions: 12, maxFetches: 16 });
  const tools = webTools({ research: researchStub, github: githubStub });
  const ctx = gatherCtx(tools, { searchesUsed: 1, fetchesUsed: 0 }, budgets);
  const outcome = await gatherExecutor(
    [
      { kind: 'web_search', query: 'Acme Pro launch price details' },
      { kind: 'research_search', query: 'Acme Pro pricing academic studies' },
      { kind: 'github_search', scope: 'files', query: 'config/pricing.ts', repoHint: 'acme/pro' },
    ],
    1,
    ctx,
  );
  assert.deepEqual(outcome.perAction, [
    { route: 'web', degraded: false, skipped: 'budget_exhausted' },
    { route: 'research', degraded: false },
    { route: 'github', degraded: false },
  ]);
  assert.ok(outcome.admitted.length >= 2, 'specialist legs admit evidence');
  // outcome.searchesUsed is the per-call delta: the skipped web leg and both
  // specialist successes added zero — specialists never consume maxSearches.
  assert.equal(outcome.searchesUsed, 0, 'specialist successes never consume maxSearches');
});

// (c) Executor refusal and stopPolicy stop agree under canDispatchAnyAction.
function stopCtx(overrides: {
  budgets: StopPolicyContext['budgets'];
  searchesUsed?: number;
  gatherActionsUsed?: number;
  laneActionsUsed?: Partial<Record<GatherLane, number>>;
  admissibleLanes?: GatherLane[];
}): StopPolicyContext {
  return {
    clockMs: 1,
    round: 1,
    roundsCompleted: 0,
    searchesUsed: 0,
    fetchesUsed: 0,
    utilityCallsUsed: 0,
    allRequiredGrounded: false,
    evaluatorRequestedContinue: true,
    growthLastTwoRounds: [1, 1],
    remainingNextQueries: ['open query probe here'],
    ...overrides,
  };
}

test('budget truth: executor refusal agrees with stopPolicy across the exhaustion matrix', async () => {
  const budgets = resolveBudgets({ maxSearches: 4, maxGatherActions: 6, maxFetches: 12 });
  const lanes: GatherLane[] = ['web', 'research', 'github'];
  const caps = budgets.laneCaps;
  const tools = webTools({ research: researchStub });
  const cases = [
    {
      name: 'both-open',
      gatherActionsUsed: 0,
      laneActionsUsed: {} as Partial<Record<GatherLane, number>>,
      searchesUsed: 0,
      expectDispatchable: true,
    },
    {
      name: 'envelope-exhausted',
      gatherActionsUsed: budgets.maxGatherActions,
      laneActionsUsed: {} as Partial<Record<GatherLane, number>>,
      searchesUsed: 0,
      expectDispatchable: false,
    },
    {
      name: 'lane-cap-exhausted',
      gatherActionsUsed: 0,
      laneActionsUsed: { web: caps.web, research: caps.research, github: caps.github },
      searchesUsed: 0,
      expectDispatchable: false,
    },
    {
      name: 'both-exhausted',
      gatherActionsUsed: budgets.maxGatherActions,
      laneActionsUsed: { web: caps.web, research: caps.research, github: caps.github },
      searchesUsed: 0,
      expectDispatchable: false,
    },
  ];
  for (const kase of cases) {
    const dispatchState = {
      gatherActionsUsed: kase.gatherActionsUsed,
      laneActionsUsed: kase.laneActionsUsed,
      searchesUsed: kase.searchesUsed,
      admissibleLanes: lanes,
    };
    const dispatchBudgets = { maxSearches: budgets.maxSearches, maxGatherActions: budgets.maxGatherActions, laneCaps: caps };
    assert.equal(
      canDispatchAnyAction(dispatchState, dispatchBudgets),
      kase.expectDispatchable,
      `${kase.name}: shared predicate`,
    );
    const ctx = gatherCtx(
      tools,
      { searchesUsed: kase.searchesUsed, fetchesUsed: 0, gatherActionsUsed: kase.gatherActionsUsed, laneActionsUsed: { ...kase.laneActionsUsed } },
      budgets,
    );
    const outcome = await gatherExecutor([{ kind: 'web_search', query: 'Acme Pro launch price details' }], 1, ctx);
    const refused = outcome.perAction[0]?.skipped !== undefined;
    assert.equal(refused, !kase.expectDispatchable, `${kase.name}: executor refusal`);
    const stop = stopPolicy(
      stopCtx({
        budgets,
        searchesUsed: kase.searchesUsed,
        gatherActionsUsed: kase.gatherActionsUsed,
        laneActionsUsed: { ...kase.laneActionsUsed },
        admissibleLanes: lanes,
      }),
    );
    assert.equal(stop.stop, !kase.expectDispatchable, `${kase.name}: stopPolicy stop`);
    assert.equal(refused, stop.stop, `${kase.name}: executor and stopPolicy agree`);
  }
});
