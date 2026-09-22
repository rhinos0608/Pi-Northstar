import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  AGENT_JOB_TTL_MS as AGENT_JOB_TTL_MS_FROM_JOBS,
  AGENT_POLL_VISIBILITY_TTL_MS,
  AGENT_RESULT_RETENTION_TTL_MS,
  AGENT_RUN_DEADLINE_MAX_MS,
  AGENT_RUN_DEADLINE_MS,
  __resetAgentJobs,
  countRepairRejectedWarnings,
  parseRepairAppliedWarning,
  parseSynthesisDropsWarning,
  parseSynthesisOrphanedCitationsWarning,
  parseVerificationWarning,
  __setAgentJobClock,
  __setAgentJobProgress,
  createAgentJobEntry,
  executeAgentJob,
  __getAgentEventJournal,
  getAgentJob,
  getAgentJobSnapshot,
  hasUnexpiredJob,
  isAgentJobSnapshotStale,
  setAgentJobRunner,
} from '../../../src/web/agent/agent-jobs.js';
import { AGENT_JOB_TTL_MS, validateAgentResult } from '../../../src/web/agent/agent-contract.js';
import {
  MAX_JOURNAL_BYTES,
  replayable,
  serializeJournal,
  type AgentResearchEvent,
} from '../../../src/web/agent/agent-events.js';
import { setLeafRuntimeProvider } from '../../../src/web/agent/agent-rpc.js';
import {
  __setAgentJobCreator,
  createAgentJob,
  type CreateAgentJobParams,
} from '../../../src/web/agent/agent-job-seam.js';
import { buildSearchRoute } from '../../../src/web/web-search-route.js';
import { runAdaptiveCore } from '../../../src/web/agent/agent-core.js';
import { snapshotForJob } from '../../../src/web/agent/agent-capabilities.js';

function mockRunner() {
  setAgentJobRunner({
    search: async () => [{ title: 'A', url: 'https://example.com/a', snippet: 'alpha words' }],
    fetchText: async () => 'alpha words about the query topic in detail',
  });
}

test('job runs sync-inside-job to ready with a snapshot', async () => {
  __resetAgentJobs();
  mockRunner();
  let n = 0;
  __setAgentJobClock(() => 1_000_000, () => `job-${(n += 1)}`);
  try {
    const job = createAgentJobEntry({ query: 'alpha topic' });
    assert.equal(job.status, 'running');
    assert.ok(job.rpc.attempted);
    assert.equal(job.rpc.negotiated, false);
    const done = await executeAgentJob(job.jobId);
    assert.equal(done.status, 'ready');
    const snapshot = getAgentJobSnapshot(job.jobId);
    const parsed = JSON.parse(snapshot);
    assert.equal(parsed.jobId, job.jobId);
    assert.equal(parsed.status, 'ready');
    assert.ok(parsed.result.query.includes('alpha'));
    assert.ok(hasUnexpiredJob());
  } finally {
    __setAgentJobClock(undefined);
    setAgentJobRunner(undefined);
    __resetAgentJobs();
  }
});

test('TTL split constants carry the roadmap values', () => {
    // Single-sourcing: tests read budgets from the jobs module. The legacy
    // AGENT_JOB_TTL_MS stays exported (contract derives it as the max).
    assert.equal(AGENT_RUN_DEADLINE_MS, 30 * 60 * 1000);
    assert.equal(AGENT_RUN_DEADLINE_MAX_MS, 2 * 60 * 60 * 1000);
    assert.equal(AGENT_RESULT_RETENTION_TTL_MS, 24 * 60 * 60 * 1000);
    assert.equal(AGENT_POLL_VISIBILITY_TTL_MS, 5 * 60 * 1000);
    assert.equal(typeof AGENT_JOB_TTL_MS, 'number');
    assert.equal(AGENT_JOB_TTL_MS_FROM_JOBS, AGENT_JOB_TTL_MS);
  });

  test('deadlineMs rejects past the cap, never clamps', async () => {
  __resetAgentJobs();
  mockRunner();
  try {
    assert.throws(
      () => createAgentJobEntry({ query: 'cap probe', deadlineMs: AGENT_RUN_DEADLINE_MAX_MS + 1 }),
      /exceeds maximum/,
    );
    assert.throws(() => createAgentJobEntry({ query: 'cap probe', deadlineMs: 0 }), /greater than 0/);
    const job = createAgentJobEntry({ query: 'cap probe' });
    await executeAgentJob(job.jobId);
    await assert.rejects(executeAgentJob(job.jobId, { deadlineMs: AGENT_RUN_DEADLINE_MAX_MS + 1 }), /exceeds maximum/);
  } finally {
    setAgentJobRunner(undefined);
    __resetAgentJobs();
  }
  });

  test('running jobs expire past the run deadline', async () => {
  __resetAgentJobs();
  let at = 1_000_000;
  __setAgentJobClock(() => at);
  try {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    setAgentJobRunner({
      search: async () => {
        await gate;
        return [{ title: 'Gated', url: 'https://example.com/gated' }];
      },
      fetchText: async () => 'gated body',
    });
    const job = createAgentJobEntry({ query: 'deadline probe' });
    assert.equal(getAgentJob(job.jobId)?.status, 'running');
    at += AGENT_RUN_DEADLINE_MS + 1;
    assert.equal(getAgentJob(job.jobId), undefined);
    assert.throws(() => getAgentJobSnapshot(job.jobId), /unknown or expired agent job/);
    assert.equal(hasUnexpiredJob(), false);
    release();
    // The orphaned drive settles on the unregistered job; let it land.
    await new Promise((resolve) => setTimeout(resolve, 100));
  } finally {
    __setAgentJobClock(undefined);
    setAgentJobRunner(undefined);
    __resetAgentJobs();
  }
  });

  test('terminal results stay pollable past the run deadline until retention', async () => {
  __resetAgentJobs();
  mockRunner();
  let at = 1_000_000;
  __setAgentJobClock(() => at);
  try {
    const job = createAgentJobEntry({ query: 'retention probe' });
    await executeAgentJob(job.jobId);
    at += AGENT_RUN_DEADLINE_MS + 1;
    assert.ok(getAgentJobSnapshot(job.jobId).includes(job.jobId));
    assert.equal(hasUnexpiredJob(), true);
    assert.equal(isAgentJobSnapshotStale(job.jobId), false);
    at += AGENT_RESULT_RETENTION_TTL_MS + 1;
    assert.equal(getAgentJob(job.jobId), undefined);
    assert.throws(() => getAgentJobSnapshot(job.jobId), /unknown or expired agent job/);
    assert.equal(hasUnexpiredJob(), false);
  } finally {
    __setAgentJobClock(undefined);
    setAgentJobRunner(undefined);
    __resetAgentJobs();
  }
  });

  test('visibility staleness never expires an in-flight snapshot', async () => {
  __resetAgentJobs();
  let at = 1_000_000;
  __setAgentJobClock(() => at);
  try {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    setAgentJobRunner({
      search: async () => {
        await gate;
        return [{ title: 'Stale', url: 'https://example.com/stale' }];
      },
      fetchText: async () => 'stale body',
    });
    const job = createAgentJobEntry({ query: 'staleness probe' });
    at += AGENT_POLL_VISIBILITY_TTL_MS + 1;
    assert.equal(isAgentJobSnapshotStale(job.jobId), true);
    // Stale still polls; activation still sees the live job.
    assert.ok(getAgentJobSnapshot(job.jobId).includes(job.jobId));
    assert.equal(hasUnexpiredJob(), true);
    release();
    await new Promise((resolve) => setTimeout(resolve, 100));
  } finally {
    __setAgentJobClock(undefined);
    setAgentJobRunner(undefined);
    __resetAgentJobs();
  }
  });

  test('progress advances across stages and stays byte-stable', async () => {
  __resetAgentJobs();
  mockRunner();
  try {
    const job = createAgentJobEntry({ query: 'progress probe' });
    await executeAgentJob(job.jobId);
    const stages = ['plan', 'gather', 'evaluate', 'synthesize'] as const;
    stages.forEach((stage, index) => {
      __setAgentJobProgress(job.jobId, {
        stage,
        round: index + 1,
        questionsAnswered: index,
        questionsTotal: 4,
        searchesUsed: index + 1,
        fetchesUsed: (index + 1) * 2,
      });
      const parsed = JSON.parse(getAgentJobSnapshot(job.jobId)) as {
        progress: {
          stage: string;
          round: number;
          questionsAnswered: number;
          questionsTotal: number;
          searchesUsed: number;
          fetchesUsed: number;
        };
      };
      assert.equal(parsed.progress.stage, stage);
      assert.equal(parsed.progress.round, index + 1);
      assert.equal(parsed.progress.questionsAnswered, index);
      assert.equal(parsed.progress.questionsTotal, 4);
      assert.equal(parsed.progress.searchesUsed, index + 1);
      assert.equal(parsed.progress.fetchesUsed, (index + 1) * 2);
    });
    const first = getAgentJobSnapshot(job.jobId);
    assert.equal(getAgentJobSnapshot(job.jobId), first);
    assert.ok(!first.includes('provider') && !first.includes('model'));
  } finally {
    setAgentJobRunner(undefined);
    __resetAgentJobs();
  }
  });

  test('progress stays owner-gated and absent without reports', async () => {
  __resetAgentJobs();
  mockRunner();
  try {
    const job = createAgentJobEntry({ query: 'gated progress', owner: 'owner-1' });
    await executeAgentJob(job.jobId);
    // Live core reports end-to-end: settled done with exact leg counts.
    const settled = JSON.parse(getAgentJobSnapshot(job.jobId, 'owner-1')) as {
      progress: { stage: string; round: number; questionsTotal: number; searchesUsed: number; fetchesUsed: number };
    };
    assert.equal(settled.progress.stage, 'done');
    assert.equal(settled.progress.round, 1);
    assert.equal(settled.progress.questionsTotal, 1);
    assert.equal(settled.progress.searchesUsed, 1);
    assert.equal(settled.progress.fetchesUsed, 1);
    __setAgentJobProgress(job.jobId, {
      stage: 'gather',
      round: 1,
      questionsAnswered: 0,
      questionsTotal: 2,
      searchesUsed: 1,
      fetchesUsed: 2,
    });
    assert.equal(
      (JSON.parse(getAgentJobSnapshot(job.jobId, 'owner-1')) as { progress: { stage: string } }).progress.stage,
      'gather',
    );
    assert.throws(() => getAgentJobSnapshot(job.jobId, 'intruder'), /unknown or expired agent job/);
    assert.throws(() => isAgentJobSnapshotStale(job.jobId, 'intruder'), /unknown or expired agent job/);
    __setAgentJobProgress(job.jobId, undefined);
    assert.ok(!('progress' in (JSON.parse(getAgentJobSnapshot(job.jobId, 'owner-1')) as Record<string, unknown>)));
  } finally {
    setAgentJobRunner(undefined);
    __resetAgentJobs();
  }
  });

  test('an aborted caller signal fails the job closed with a generic error', async () => {
  __resetAgentJobs();
  mockRunner();
  try {
    const job = createAgentJobEntry({ query: 'abort probe', signal: AbortSignal.abort() });
    const done = await executeAgentJob(job.jobId);
    assert.equal(done.status, 'failed');
    assert.equal(done.error, 'agent_job_failed');
    const parsed = JSON.parse(getAgentJobSnapshot(job.jobId)) as { error: string };
    assert.equal(parsed.error, 'agent_job_failed');
  } finally {
    setAgentJobRunner(undefined);
    __resetAgentJobs();
  }
  });

  test('expired jobs read as missing; registry drains', async () => {
  __resetAgentJobs();
  mockRunner();
  let at = 1_000_000;
  let n = 0;
  __setAgentJobClock(() => at, () => `job-${(n += 1)}`);
  try {
    const job = createAgentJobEntry({ query: 'expiry probe' });
    await executeAgentJob(job.jobId);
    // Terminal jobs outlive the run deadline; retention TTL governs expiry.
    at += AGENT_RUN_DEADLINE_MS + 1;
    assert.ok(getAgentJobSnapshot(job.jobId).includes(job.jobId));
    assert.equal(hasUnexpiredJob(), true);
    at += AGENT_RESULT_RETENTION_TTL_MS + 1;
    assert.throws(() => getAgentJobSnapshot(job.jobId), /unknown or expired/);
    assert.equal(hasUnexpiredJob(), false);
  } finally {
    __setAgentJobClock(undefined);
    setAgentJobRunner(undefined);
    __resetAgentJobs();
  }
});

test('foreign-owner access reads as a miss, never another owner bytes', async () => {
  __resetAgentJobs();
  mockRunner();
  __setAgentJobClock(() => 2_000_000, () => 'owned-job');
  try {
    const job = createAgentJobEntry({ query: 'owned topic', owner: 'alice' });
    await executeAgentJob(job.jobId);
    const own = getAgentJobSnapshot(job.jobId, 'alice');
    assert.ok(own.includes('owned-job'));
    assert.throws(() => getAgentJobSnapshot(job.jobId, 'bob'), /unknown or expired/);
    assert.throws(() => getAgentJobSnapshot(job.jobId), /unknown or expired/);
    // Unowned jobs stay pollable without an owner.
    const open = createAgentJobEntry({ query: 'open topic' });
    await executeAgentJob(open.jobId);
    assert.ok(getAgentJobSnapshot(open.jobId).includes(open.jobId));
  } finally {
    __setAgentJobClock(undefined);
    setAgentJobRunner(undefined);
    __resetAgentJobs();
  }
});

test('leaf path records transport and steers through staged seams; snapshot clean', async () => {
  __resetAgentJobs();
  mockRunner();
  const modelId = 'testprov/test-model-xyz';
  const prior = process.env.PI_NORTHSTAR_LEAF_MODEL;
  process.env.PI_NORTHSTAR_LEAF_MODEL = modelId;
  // Task 4: steering seams drive staged leaf calls; with the report leg
  // deleted, every leaf call carries a stage.
  const stages: Array<string | undefined> = [];
  setLeafRuntimeProvider({
    refreshReady: async () => true,
    runLeaf: async (_prompt: string, runOpts?: { stage?: string }) => {
      stages.push(runOpts?.stage);
      if (runOpts?.stage === 'agent-plan') {
        return { text: JSON.stringify({ questions: [{ question: 'What evidence backs this claim?', priority: 1, required: true }] }) };
      }
      if (runOpts?.stage === 'agent-evaluate') {
        return { text: JSON.stringify({ questionUpdates: [], nextActions: [], shouldContinue: false }) };
      }
      return { text: 'leaf-composed report sentence one. Sentence two here.' };
    },
  });
  let n = 0;
  __setAgentJobClock(() => 4_000_000, () => `leaf-job-${(n += 1)}`);
  try {
    const job = createAgentJobEntry({ query: 'leaf topic' });
    const done = await executeAgentJob(job.jobId);
    assert.equal(done.status, 'ready');
    assert.equal(done.rpc.transport, 'leaf-runtime');
    assert.equal(done.rpc.reason, 'negotiated exact leaf model');
    assert.ok(stages.includes('agent-plan'), 'planner steers through the leaf');
    assert.ok(stages.includes('agent-evaluate'), 'evaluator steers through the leaf');
    assert.ok(stages.length > 0 && stages.every((stage) => stage !== undefined), 'every leaf call is staged; no report leg remains');
    const snapshot = getAgentJobSnapshot(job.jobId);
    const parsed = JSON.parse(snapshot) as { rpc: { transport: string; reason: string } };
    assert.equal(parsed.rpc.transport, 'leaf-runtime');
    // Snapshot bytes never carry provider/model identity.
    assert.ok(!snapshot.includes(modelId));
    assert.ok(!snapshot.includes('testprov'));
    assert.ok(!snapshot.includes('provider'));
  } finally {
    if (prior === undefined) delete process.env.PI_NORTHSTAR_LEAF_MODEL;
    else process.env.PI_NORTHSTAR_LEAF_MODEL = prior;
    setLeafRuntimeProvider(undefined);
    __setAgentJobClock(undefined);
    setAgentJobRunner(undefined);
    __resetAgentJobs();
  }
});

test('leaf seam failure degrades to the deterministic ladder; no model ids leak', async () => {
  __resetAgentJobs();
  mockRunner();
  const modelId = 'testprov/test-model-xyz';
  const prior = process.env.PI_NORTHSTAR_LEAF_MODEL;
  process.env.PI_NORTHSTAR_LEAF_MODEL = modelId;
  setLeafRuntimeProvider({
    refreshReady: async () => true,
    runLeaf: async () => {
      throw Object.assign(new Error('boom SECRET-MARKER testprov/test-model-xyz'), { code: 'runtime_unavailable' });
    },
  });
  let n = 0;
  __setAgentJobClock(() => 5_000_000, () => `leaffail-${(n += 1)}`);
  try {
    const job = createAgentJobEntry({ query: 'fallback topic' });
    const done = await executeAgentJob(job.jobId);
    assert.equal(done.status, 'ready');
    // Negotiation stands; the staged seams degrade one by one to the
    // deterministic ladder (fallback plan, skipped rounds, evidence-only floor).
    assert.equal(done.rpc.transport, 'leaf-runtime');
    assert.equal(done.rpc.negotiated, true);
    const warnings = done.result!.warnings.join('\n');
    assert.ok(warnings.includes('synthesis unavailable; evidence-only result composed from admitted evidence'));
    assert.ok(!warnings.includes('SECRET-MARKER'));
    assert.ok(!warnings.includes(modelId));
    const snapshot = getAgentJobSnapshot(job.jobId);
    assert.ok(!snapshot.includes(modelId));
    assert.ok(!snapshot.includes('SECRET-MARKER'));
  } finally {
    if (prior === undefined) delete process.env.PI_NORTHSTAR_LEAF_MODEL;
    else process.env.PI_NORTHSTAR_LEAF_MODEL = prior;
    setLeafRuntimeProvider(undefined);
    __setAgentJobClock(undefined);
    setAgentJobRunner(undefined);
    __resetAgentJobs();
  }
});

test('refresh failure keeps standalone with precise reason', async () => {
  __resetAgentJobs();
  mockRunner();
  const prior = process.env.PI_NORTHSTAR_LEAF_MODEL;
  process.env.PI_NORTHSTAR_LEAF_MODEL = 'testprov/test-model-xyz';
  setLeafRuntimeProvider({
    refreshReady: async () => false,
    runLeaf: async () => ({ text: 'must not run' }),
  });
  let n = 0;
  __setAgentJobClock(() => 6_000_000, () => `standby-${(n += 1)}`);
  try {
    const job = createAgentJobEntry({ query: 'refresh-fail topic' });
    const done = await executeAgentJob(job.jobId);
    assert.equal(done.status, 'ready');
    assert.equal(done.rpc.transport, 'standalone');
    assert.ok(done.rpc.reason.includes('refresh failed'));
    assert.ok(!done.result!.reportText.includes('must not run'));
  } finally {
    if (prior === undefined) delete process.env.PI_NORTHSTAR_LEAF_MODEL;
    else process.env.PI_NORTHSTAR_LEAF_MODEL = prior;
    setLeafRuntimeProvider(undefined);
    __setAgentJobClock(undefined);
    setAgentJobRunner(undefined);
    __resetAgentJobs();
  }
});

test('registered leaf provider is sufficient after unified model resolution', async () => {
  __resetAgentJobs();
  mockRunner();
  const prior = process.env.PI_NORTHSTAR_LEAF_MODEL;
  delete process.env.PI_NORTHSTAR_LEAF_MODEL;
  const stages: Array<string | undefined> = [];
  setLeafRuntimeProvider({
    refreshReady: async () => true,
    runLeaf: async (_prompt: string, runOpts?: { stage?: string }) => {
      stages.push(runOpts?.stage);
      if (runOpts?.stage === 'agent-plan') {
        return { text: JSON.stringify({ questions: [{ question: 'What evidence?', priority: 1, required: true }] }) };
      }
      if (runOpts?.stage === 'agent-evaluate') {
        return { text: JSON.stringify({ questionUpdates: [], nextActions: [], shouldContinue: false }) };
      }
      return { text: 'leaf-composed report sentence one. Sentence two here.' };
    },
  });
  let n = 0;
  __setAgentJobClock(() => 7_000_000, () => `nomodel-${(n += 1)}`);
  try {
    const job = createAgentJobEntry({ query: 'unified-model topic' });
    const done = await executeAgentJob(job.jobId);
    assert.equal(done.status, 'ready');
    assert.equal(done.rpc.transport, 'leaf-runtime');
    assert.equal(done.rpc.reason, 'negotiated exact leaf model');
    assert.equal(stages.length, 0, 'transport may negotiate while agent steering remains explicitly off');
  } finally {
    if (prior === undefined) delete process.env.PI_NORTHSTAR_LEAF_MODEL;
    else process.env.PI_NORTHSTAR_LEAF_MODEL = prior;
    setLeafRuntimeProvider(undefined);
    __setAgentJobClock(undefined);
    setAgentJobRunner(undefined);
    __resetAgentJobs();
  }
});

test('leaf job executes exactly one backend search; staged seams receive the query', async () => {
  __resetAgentJobs();
  let searchCalls = 0;
  const leafCalls: Array<{ stage: string | undefined; prompt: string }> = [];
  setAgentJobRunner({
    search: async () => {
      searchCalls += 1;
      return [{ title: 'Once', url: 'https://example.com/once', snippet: 'single-search-evidence' }];
    },
    fetchText: async () => 'single-search-evidence about the query topic in detail',
  });
  const prior = process.env.PI_NORTHSTAR_LEAF_MODEL;
  process.env.PI_NORTHSTAR_LEAF_MODEL = 'testprov/test-model-xyz';
  setLeafRuntimeProvider({
    refreshReady: async () => true,
    runLeaf: async (prompt: string, runOpts?: { stage?: string }) => {
      leafCalls.push({ stage: runOpts?.stage, prompt });
      return { text: 'leaf-composed report sentence one. Sentence two here.' };
    },
  });
  let n = 0;
  __setAgentJobClock(() => 8_000_000, () => `once-${(n += 1)}`);
  try {
    // createAgentJobEntry kicks background execution; await it via polling
    // (a second direct executeAgentJob drive would race and double-run).
    const job = createAgentJobEntry({ query: 'single search topic' });
    const deadline = Date.now() + 5_000;
    for (;;) {
      const current = getAgentJob(job.jobId);
      assert.ok(current !== undefined);
      if (current.status !== 'running') break;
      assert.ok(Date.now() < deadline, 'leaf job did not finish');
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    const done = getAgentJob(job.jobId)!;
    assert.equal(done.status, 'ready');
    assert.equal(searchCalls, 1);
    const planCall = leafCalls.find((call) => call.stage === 'agent-plan');
    assert.ok(planCall !== undefined, 'planner seam drove the leaf');
    assert.ok(planCall.prompt.includes('single search topic'), 'planner prompt carries the job query');
  } finally {
    if (prior === undefined) delete process.env.PI_NORTHSTAR_LEAF_MODEL;
    else process.env.PI_NORTHSTAR_LEAF_MODEL = prior;
    setLeafRuntimeProvider(undefined);
    __setAgentJobClock(undefined);
    setAgentJobRunner(undefined);
    __resetAgentJobs();
  }
});

test('direct entry rejects unsupported search constraints with no job registered', () => {
  __resetAgentJobs();
  try {
    for (const extra of [
      { limit: 5 },
      { category: 'news' },
      { yearFrom: 2020 },
      { recency: 'week' },
      { domains: ['example.com'] },
    ]) {
      assert.throws(
        () => createAgentJobEntry({ query: 'q', ...extra } as unknown as { query: string }),
        /unsupported by the job runtime/,
      );
    }
    assert.equal(hasUnexpiredJob(), false, 'rejected admissions register no job');
  } finally {
    __resetAgentJobs();
  }
});

test('search outage with negotiated leaf degrades inside round 1; transport stays negotiated', async () => {
  // Wave 5: the preflight is deleted, so a backend outage no longer throws
  // before the core starts. It surfaces as a round-1 gather warning and the
  // job completes ready; the leaf transport never threw, so no reset to
  // standalone happens. (Previously this pinned the preflight throw failing
  // the drive with transport reset.)
  __resetAgentJobs();
  setAgentJobRunner({
    search: async () => { throw new Error('backend exploded'); },
    fetchText: async () => 'unused',
  });
  const prior = process.env.PI_NORTHSTAR_LEAF_MODEL;
  process.env.PI_NORTHSTAR_LEAF_MODEL = 'testprov/test-model-xyz';
  setLeafRuntimeProvider({
    refreshReady: async () => true,
    runLeaf: async () => ({ text: 'must not run' }),
  });
  __setAgentJobClock(() => 9_200_000, () => 'early-throw-job');
  try {
    const job = createAgentJobEntry({ query: 'doomed leaf topic' });
    const done = await executeAgentJob(job.jobId);
    assert.equal(done.status, 'ready');
    assert.ok(done.result !== undefined);
    assert.equal(done.rpc.transport, 'leaf-runtime');
    assert.ok(done.result.warnings.some((warning) => warning.includes('search failed; query skipped')));
  } finally {
    if (prior === undefined) delete process.env.PI_NORTHSTAR_LEAF_MODEL;
    else process.env.PI_NORTHSTAR_LEAF_MODEL = prior;
    setLeafRuntimeProvider(undefined);
    __setAgentJobClock(undefined);
    setAgentJobRunner(undefined);
    __resetAgentJobs();
  }
});

test('TTL prune drops the in-flight drive handle', async () => {
  __resetAgentJobs();
  mockRunner();
  let at = 1_000_000;
  __setAgentJobClock(() => at, () => 'prune-drive-job');
  try {
    const job = createAgentJobEntry({ query: 'prune drive topic' });
    await executeAgentJob(job.jobId);
    at += AGENT_RESULT_RETENTION_TTL_MS + 1;
    assert.equal(hasUnexpiredJob(), false);
    await assert.rejects(executeAgentJob(job.jobId), /unknown agent job/);
  } finally {
    __setAgentJobClock(undefined);
    setAgentJobRunner(undefined);
    __resetAgentJobs();
  }
});

test('shutdown mid-flight degrades steering seams to the deterministic ladder', async () => {
  __resetAgentJobs();
  mockRunner();
  let leafCalls = 0;
  setLeafRuntimeProvider({
    refreshReady: async () => {
      // Seam clears between negotiation capture and steering-seam use.
      setLeafRuntimeProvider(undefined);
      return true;
    },
    runLeaf: async () => {
      leafCalls += 1;
      return { text: 'must not run' };
    },
  });
  const prior = process.env.PI_NORTHSTAR_LEAF_MODEL;
  process.env.PI_NORTHSTAR_LEAF_MODEL = 'testprov/test-model-xyz';
  __setAgentJobClock(() => 9_300_000, () => 'shutdown-flight-job');
  try {
    const job = createAgentJobEntry({ query: 'shutdown flight topic' });
    const done = await executeAgentJob(job.jobId);
    assert.equal(done.status, 'ready');
    assert.equal(leafCalls, 0, 'cleared provider must not be driven');
    // Negotiation stands; every staged seam fails closed to the ladder.
    assert.equal(done.rpc.transport, 'leaf-runtime');
    assert.equal(done.rpc.negotiated, true);
    assert.ok(done.result!.warnings.some((warning) => warning.includes('synthesis unavailable; evidence-only result composed from admitted evidence')));
  } finally {
    if (prior === undefined) delete process.env.PI_NORTHSTAR_LEAF_MODEL;
    else process.env.PI_NORTHSTAR_LEAF_MODEL = prior;
    setLeafRuntimeProvider(undefined);
    __setAgentJobClock(undefined);
    setAgentJobRunner(undefined);
    __resetAgentJobs();
  }
});

test('empty query rejects at creation', () => {
  __resetAgentJobs();
  try {
    assert.throws(() => createAgentJobEntry({ query: '   ' }), /non-empty query/);
  } finally {
    __resetAgentJobs();
  }
});

test('concurrent executeAgentJob calls share one execution', async () => {
  __resetAgentJobs();
  let searchCalls = 0;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  setAgentJobRunner({
    search: async () => {
      searchCalls += 1;
      await gate;
      return [{ title: 'C', url: 'https://example.com/c', snippet: 'concurrent words' }];
    },
    fetchText: async () => 'concurrent words about the query topic in detail',
  });
  __setAgentJobClock(() => 9_000_000, () => 'race-job');
  try {
    const job = createAgentJobEntry({ query: 'race topic' });
    // Background kick + direct caller race on the gated search leg.
    const direct = executeAgentJob(job.jobId);
    release();
    const [first, second] = await Promise.all([direct, executeAgentJob(job.jobId)]);
    assert.equal(first.status, 'ready');
    assert.equal(second.status, 'ready');
    assert.equal(searchCalls, 1, 'concurrent callers must reuse one in-flight drive');
    // Settled entry clears: a later call observes final status, no re-drive.
    const again = await executeAgentJob(job.jobId);
    assert.equal(again.status, 'ready');
    assert.equal(searchCalls, 1);
  } finally {
    __setAgentJobClock(undefined);
    setAgentJobRunner(undefined);
    __resetAgentJobs();
  }
});

test('search outage degrades to ready with generic warnings, never dependency text', async () => {
  // Wave 5: with no preflight, a total search outage is a round-1 gather
  // warning, not a failed drive. (Previously this pinned the failed-drive
  // shape: status failed + agent_job_failed.) The no-leak purpose stands:
  // backend error text never reaches the snapshot.
  __resetAgentJobs();
  setAgentJobRunner({
    search: async () => { throw new Error('backend SECRET-MARKER exploded'); },
    fetchText: async () => 'unused',
  });
  __setAgentJobClock(() => 9_100_000, () => 'fail-job');
  try {
    const job = createAgentJobEntry({ query: 'doomed topic' });
    const done = await executeAgentJob(job.jobId);
    assert.equal(done.status, 'ready');
    assert.ok(done.result !== undefined);
    assert.ok(done.result.warnings.some((warning) => warning.includes('search failed; query skipped')));
    const snapshot = getAgentJobSnapshot(job.jobId);
    assert.ok(!snapshot.includes('SECRET-MARKER'));
  } finally {
    __setAgentJobClock(undefined);
    setAgentJobRunner(undefined);
    __resetAgentJobs();
  }
});

test('seam rejects unsupported search constraints fail-closed', () => {
  __resetAgentJobs();
  try {
    for (const extra of [
      { limit: 5 },
      { category: 'news' },
      { yearFrom: 2020 },
      { recency: 'week' },
      { domains: ['example.com'] },
    ]) {
      assert.throws(
        () => createAgentJob({ query: 'q', ...extra } as unknown as CreateAgentJobParams),
        /unsupported by the job runtime/,
      );
    }
    assert.equal(hasUnexpiredJob(), false, 'rejected admissions register no job');
  } finally {
    __resetAgentJobs();
  }
});

test('agent route validates before creating a job', () => {
  __resetAgentJobs();
  let creations = 0;
  __setAgentJobCreator(() => { creations += 1; return { jobId: 'route-job-1' }; });
  try {
    assert.throws(() => buildSearchRoute({ query: '   ', mode: 'agent' }), /non-empty|invalid_request/);
    assert.throws(() => buildSearchRoute({ query: 'q', mode: 'agent', limit: 10_000 }), /mode "agent" rejects search constraint "limit"/);
    assert.equal(creations, 0, 'invalid requests register no job');
    assert.equal(hasUnexpiredJob(), false);
    const route = buildSearchRoute({ query: 'valid topic', mode: 'agent' });
    assert.equal(route.tool, 'agent_job');
    assert.equal(creations, 1);
  } finally {
    __setAgentJobCreator(undefined);
    __resetAgentJobs();
  }
});

test('journal accumulates across stages with sink forwarding', async () => {
  __resetAgentJobs();
  mockRunner();
  const seen: AgentResearchEvent[] = [];
  let n = 0;
  __setAgentJobClock(() => 1_000_000, () => `journal-${(n += 1)}`);
  try {
    const job = createAgentJobEntry({
      query: 'journal probe',
      owner: 'alice',
      eventSink: (event) => { seen.push(event); },
    });
    const done = await executeAgentJob(job.jobId);
    assert.equal(done.status, 'ready');
    const journal = __getAgentEventJournal(job.jobId, 'alice');
    assert.ok(journal !== undefined);
    const types = journal.events.map((event) => event.type);
    assert.deepEqual(types, [
      'JobCreated',
      'PlanAccepted',
      'SearchCompleted',
      'FetchCompleted',
      'CandidatesAccumulated',
      'EvaluationAccepted',
      'JobReady',
    ]);
    assert.deepEqual(seen.map((event) => event.type), types);
    assert.equal(replayable(job.jobId, journal), true);
    assert.ok(Buffer.byteLength(serializeJournal(journal), 'utf8') < MAX_JOURNAL_BYTES);
  } finally {
    __setAgentJobClock(undefined);
    setAgentJobRunner(undefined);
    __resetAgentJobs();
  }
});

test('no sink leaves snapshots byte-identical', async () => {
  __resetAgentJobs();
  mockRunner();
  __setAgentJobClock(() => 2_000_000, () => 'stable-job');
  try {
    const first = createAgentJobEntry({ query: 'stable probe' });
    await executeAgentJob(first.jobId);
    const snapA = getAgentJobSnapshot(first.jobId);
    const keysA = Object.keys(JSON.parse(snapA)).sort();
    assert.deepEqual(keysA, ['jobId', 'progress', 'query', 'result', 'rpc', 'status', 'updatedAt']);
    assert.ok(!snapA.includes('eventSink') && !snapA.includes('journal') && !snapA.includes('Journal'));
    const journalA = __getAgentEventJournal(first.jobId);
    assert.ok((journalA?.events.length ?? 0) > 0, 'journal accumulates even without a sink');
    __resetAgentJobs();
    const seen: AgentResearchEvent[] = [];
    const second = createAgentJobEntry({
      query: 'stable probe',
      eventSink: (event) => { seen.push(event); },
    });
    await executeAgentJob(second.jobId);
    assert.equal(getAgentJobSnapshot(second.jobId), snapA);
    assert.ok(seen.length > 0);
  } finally {
    __setAgentJobClock(undefined);
    setAgentJobRunner(undefined);
    __resetAgentJobs();
  }
});

test('journal read is owner-gated', async () => {
  __resetAgentJobs();
  mockRunner();
  let n = 0;
  __setAgentJobClock(() => 3_000_000, () => `gated-journal-${(n += 1)}`);
  try {
    const job = createAgentJobEntry({ query: 'gated journal probe', owner: 'alice' });
    await executeAgentJob(job.jobId);
    assert.throws(() => __getAgentEventJournal(job.jobId), /unknown or expired/);
    assert.throws(() => __getAgentEventJournal(job.jobId, 'bob'), /unknown or expired/);
    assert.ok((__getAgentEventJournal(job.jobId, 'alice')?.events.length ?? 0) > 0);
    assert.throws(() => __getAgentEventJournal('no-such-job', 'alice'), /unknown or expired/);
    const open = createAgentJobEntry({ query: 'open journal probe' });
    await executeAgentJob(open.jobId);
    assert.ok((__getAgentEventJournal(open.jobId)?.events.length ?? 0) > 0);
  } finally {
    __setAgentJobClock(undefined);
    setAgentJobRunner(undefined);
    __resetAgentJobs();
  }
});

test('search outage journals the failed slot, then still reaches JobReady', async () => {
  // Wave 5: with no preflight there is no pre-controller failure — the only
  // failing shape left for a search outage is the round-1 failed slot, and
  // the job still completes. (Previously this pinned journal=[JobCreated] +
  // no JobReady for the preflight throw.)
  __resetAgentJobs();
  setAgentJobRunner({
    search: async () => { throw new Error('backend exploded'); },
    fetchText: async () => 'unused',
  });
  __setAgentJobClock(() => 9_100_000, () => 'journal-fail-job');
  try {
    const job = createAgentJobEntry({ query: 'doomed journal topic' });
    const done = await executeAgentJob(job.jobId);
    assert.equal(done.status, 'ready');
    const journal = __getAgentEventJournal(job.jobId);
    assert.ok(journal !== undefined);
    const types = journal.events.map((event) => event.type);
    assert.deepEqual(types, ['JobCreated', 'PlanAccepted', 'SearchCompleted', 'CandidatesAccumulated', 'EvaluationAccepted', 'JobReady']);
    const completions = journal.events.filter((event) => event.type === 'SearchCompleted');
    assert.equal(completions.length, 1);
    assert.equal(completions[0]?.type, 'SearchCompleted');
    if (completions[0]?.type === 'SearchCompleted') assert.equal(completions[0].failed, true);
    assert.equal(replayable(job.jobId, journal), true);
  } finally {
    __setAgentJobClock(undefined);
    setAgentJobRunner(undefined);
    __resetAgentJobs();
  }
});

test('jobs drive injects frozen capabilities snapshot; planner prompt carries Capabilities block', async () => {
  __resetAgentJobs();
  mockRunner();
  // The exact resolver call the jobs shell makes per job: deterministic,
  // frozen, no network. The shell cannot expose its internal deps object,
  // so the prompt assertion runs through the real adaptive core with the
  // same snapshot value the drive injects.
  const snapshot = snapshotForJob(process.env as Record<string, string | undefined>);
  assert.equal(Object.isFrozen(snapshot), true);
  let seenPrompt = '';
  const probed = await runAdaptiveCore('capabilities probe topic', {
    search: async () => [{ title: 'Overview', url: 'https://example.com/overview' }],
    fetchText: async () => 'alpha words about the query topic in detail',
    utilityModelClient: {
      completeJson: async (prompt: string) => {
        seenPrompt = prompt;
        return { ok: false, reason: 'no script' };
      },
    },
    evaluator: async () => ({ questionUpdates: [], nextActions: [], shouldContinue: false }),
    capabilitiesSnapshot: snapshot,
  });
  assert.ok(probed.query.includes('capabilities'));
  assert.ok(seenPrompt.includes('Capabilities:'), 'injected snapshot reaches the planner prompt');
  try {
    const job = createAgentJobEntry({ query: 'snapshot injection probe' });
    const done = await executeAgentJob(job.jobId);
    assert.equal(done.status, 'ready');
  } finally {
    setAgentJobRunner(undefined);
    __resetAgentJobs();
  }
});

test('core search leg searches the live query exactly once (no preflight)', async () => {
  // Wave 5: Round 1 owns all acquisition — one backend search, inside the
  // controller loop. (Previously this pinned the preflight capture reuse.)
  __resetAgentJobs();
  const seenQueries: string[] = [];
  setAgentJobRunner({
    search: async (query: string) => {
      seenQueries.push(query);
      return [{ title: `Hit for ${query}`, url: 'https://example.com/live', snippet: 'live words' }];
    },
    fetchText: async () => 'live words about the query topic in detail',
  });
  __setAgentJobClock(() => 11_000_000, () => 'live-query-job');
  try {
    const job = createAgentJobEntry({ query: 'live query probe' });
    const done = await executeAgentJob(job.jobId);
    assert.equal(done.status, 'ready');
    assert.deepEqual(seenQueries, ['live query probe']);
    const journal = __getAgentEventJournal(job.jobId);
    const searchEvent = journal?.events.find((event) => event.type === 'SearchCompleted');
    assert.equal(searchEvent?.type, 'SearchCompleted');
    if (searchEvent?.type === 'SearchCompleted') {
      assert.equal(searchEvent.query, 'live query probe');
      assert.equal(searchEvent.hitCount, 1);
    }
  } finally {
    __setAgentJobClock(undefined);
    setAgentJobRunner(undefined);
    __resetAgentJobs();
  }
});

test('raw job query never reaches the backend; the controller searches the sanitized query once', async () => {
  // Wave 5: the preflight (which searched the RAW job query before the core
  // started) is deleted. The only backend call carries the sanitized query.
  // (Previously this pinned preflight-raw + live-sanitized = 2 calls.)
  __resetAgentJobs();
  const seenQueries: string[] = [];
  setAgentJobRunner({
    search: async (query: string) => {
      seenQueries.push(query);
      return [{ title: 'Hit', url: 'https://example.com/live', snippet: 'live words' }];
    },
    fetchText: async () => 'live words about the query topic in detail',
  });
  __setAgentJobClock(() => 11_100_000, () => 'sanitize-query-job');
  try {
    // Control character: the core sanitizes before dispatch, so the single
    // backend query is the sanitized form — the raw query never executes.
    const job = createAgentJobEntry({ query: 'live\u0000query probe' });
    const done = await executeAgentJob(job.jobId);
    assert.equal(done.status, 'ready');
    assert.deepEqual(seenQueries, ['livequery probe']);
    const journal = __getAgentEventJournal(job.jobId);
    const searchEvent = journal?.events.find((event) => event.type === 'SearchCompleted');
    assert.equal(searchEvent?.type, 'SearchCompleted');
    if (searchEvent?.type === 'SearchCompleted') {
      assert.ok(!searchEvent.query.includes('\u0000'), 'journal query sanitized before truncate');
    }
  } finally {
    __setAgentJobClock(undefined);
    setAgentJobRunner(undefined);
    __resetAgentJobs();
  }
});

test('failed fetches journal failed:true in record order, no index skew', async () => {
  __resetAgentJobs();
  setAgentJobRunner({
    search: async () => [
      { title: 'First', url: 'https://example.com/first', snippet: 'first words' },
      { title: 'Second', url: 'https://example.com/second', snippet: 'second words' },
    ],
    fetchText: async (url: string) => {
      if (url.includes('/second')) throw new Error('fetch exploded');
      return 'first words about the query topic in detail';
    },
  });
  __setAgentJobClock(() => 11_200_000, () => 'fetch-fail-journal-job');
  try {
    const job = createAgentJobEntry({ query: 'fetch failure probe' });
    const done = await executeAgentJob(job.jobId);
    assert.equal(done.status, 'ready');
    const journal = __getAgentEventJournal(job.jobId);
    assert.ok(journal !== undefined);
    const fetches = journal.events.filter((event) => event.type === 'FetchCompleted');
    assert.equal(fetches.length, 2);
    assert.equal(fetches[0]?.type, 'FetchCompleted');
    assert.equal(fetches[1]?.type, 'FetchCompleted');
    if (fetches[0]?.type === 'FetchCompleted' && fetches[1]?.type === 'FetchCompleted') {
      assert.equal(fetches[0].canonicalUrl, 'https://example.com/first');
      assert.equal(fetches[0].failed, undefined);
      assert.equal(fetches[0].fetchesUsed, 1);
      assert.equal(fetches[1].canonicalUrl, 'https://example.com/second');
      assert.equal(fetches[1].failed, true);
      assert.equal(fetches[1].byteLength, 0);
      assert.equal(fetches[1].fetchesUsed, 2);
    }
    assert.equal(replayable(job.jobId, journal), true);
  } finally {
    __setAgentJobClock(undefined);
    setAgentJobRunner(undefined);
    __resetAgentJobs();
  }
});

test('warning parsers read deterministic synth/verify counts; unknown omits', async () => {
  assert.deepEqual(parseSynthesisDropsWarning(['synthesis drops: claimUnits=2 blocks=1 orphaned=3']), {
    claimUnits: 2,
    blocks: 1,
    orphaned: 3,
  });
  assert.equal(parseSynthesisDropsWarning(['unrelated warning']), undefined);
  assert.deepEqual(parseVerificationWarning(['verification: 4 supported, 1 refuted, 2 without enough evidence']), {
    supported: 4,
    refuted: 1,
    unsupported: 2,
  });
  assert.equal(parseVerificationWarning(['verification skipped; utility budget exhausted']), undefined);
  assert.equal(parseRepairAppliedWarning(['repair applied: 2 claims re-supported']), 2);
  assert.equal(parseRepairAppliedWarning(['no repair']), undefined);
  assert.equal(countRepairRejectedWarnings(['repair rejected; best version kept (no improvement)', 'repair skipped; no re-verify budget']), 1);
  // Without the synthesizer/verifier seams the warnings never appear, so the
  // journal omits synth/verify events instead of emitting zeros.
  __resetAgentJobs();
  mockRunner();
  __setAgentJobClock(() => 11_300_000, () => 'omit-counts-job');
  try {
    const job = createAgentJobEntry({ query: 'omit counts probe' });
    const done = await executeAgentJob(job.jobId);
    assert.equal(done.status, 'ready');
    const journal = __getAgentEventJournal(job.jobId);
    const types = (journal?.events ?? []).map((event) => event.type);
    assert.ok(!types.includes('SynthesisCompleted'));
    assert.ok(!types.includes('VerificationCompleted'));
  } finally {
    __setAgentJobClock(undefined);
    setAgentJobRunner(undefined);
    __resetAgentJobs();
  }
});

test('negotiated caps land byte/count-capped in the record', async () => {
  __resetAgentJobs();
  mockRunner();
  const prior = process.env.PI_NORTHSTAR_LEAF_MODEL;
  process.env.PI_NORTHSTAR_LEAF_MODEL = 'testprov/test-model-xyz';
  setLeafRuntimeProvider({
    refreshReady: async () => true,
    runLeaf: async () => ({ text: 'leaf-composed report sentence one. Sentence two here.' }),
    getNegotiatedCapabilities: () => ({
      outputModes: ['json'],
      correlationV2: {
        ownerPattern: 'x'.repeat(300),
        roles: Array.from({ length: 20 }, () => 'r'.repeat(70)),
      },
      // E5 observability: the negotiated schema dialect rides the record.
      jsonSchema: 'structured-v1',
    }),
  });
  __setAgentJobClock(() => 11_400_000, () => 'caps-job');
  try {
    const job = createAgentJobEntry({ query: 'caps probe' });
    const done = await executeAgentJob(job.jobId);
    assert.equal(done.status, 'ready');
    const correlation = done.rpc.correlationV2;
    assert.ok(correlation !== undefined);
    assert.ok(Buffer.byteLength(correlation.ownerPattern, 'utf8') <= 256);
    assert.equal(correlation.roles.length, 16);
    for (const role of correlation.roles) {
      assert.ok(Buffer.byteLength(role, 'utf8') <= 64);
    }
    assert.equal(done.rpc.jsonSchema, 'structured-v1');
  } finally {
    if (prior === undefined) delete process.env.PI_NORTHSTAR_LEAF_MODEL;
    else process.env.PI_NORTHSTAR_LEAF_MODEL = prior;
    setLeafRuntimeProvider(undefined);
    __setAgentJobClock(undefined);
    setAgentJobRunner(undefined);
    __resetAgentJobs();
  }
});

test('non-function eventSink rejects fail-closed with no job registered', async () => {
  __resetAgentJobs();
  mockRunner();
  try {
    assert.throws(
      () => createAgentJobEntry({ query: 'sink probe', eventSink: 'nope' as unknown as never }),
      TypeError,
    );
    try {
      createAgentJobEntry({ query: 'sink probe', eventSink: 'nope' as unknown as never });
      assert.fail('non-function sink must throw');
    } catch (error) {
      assert.ok(error instanceof TypeError);
      assert.match(error.message, /eventSink must be a function/);
    }
    assert.equal(hasUnexpiredJob(), false, 'rejected admissions register no job');
    const job = createAgentJobEntry({ query: 'sink probe' });
    await executeAgentJob(job.jobId);
    // Settled: no in-flight drive to share, so opts validation runs.
    await executeAgentJob(job.jobId, { eventSink: 42 as unknown as never }).then(
      () => assert.fail('non-function sink must throw'),
      (error: unknown) => {
        assert.ok(error instanceof TypeError);
        assert.match((error as TypeError).message, /eventSink must be a function/);
      },
    );
  } finally {
    setAgentJobRunner(undefined);
    __resetAgentJobs();
  }
});

test('deadline throw surfaces research debt as a failed degraded result', async () => {
  __resetAgentJobs();
  setAgentJobRunner({
    search: async () => [{ title: 'Slow', url: 'https://example.com/slow', snippet: 'slow words' }],
    fetchText: async () => {
      await new Promise((resolve) => setTimeout(resolve, 300));
      return 'slow words about the query topic in detail';
    },
  });
  try {
    // Real clock (the core enforces an absolute deadline): the 300 ms fetch
    // outlives the 50 ms budget, so the core throws AgentDeadlineError with
    // accumulated debt. The drive race rejects first; the background drive
    // settles the degraded job — poll for it.
    const job = createAgentJobEntry({ query: 'deadline debt probe', deadlineMs: 50 });
    const deadline = Date.now() + 8_000;
    // Intended src behavior: expired() uses the job's own deadlineMs, so a
    // running job reads as undefined past 50 ms while the drive still settles
    // it to failed (terminal jobs stay pollable under the retention TTL).
    let done = getAgentJob(job.jobId);
    while (done === undefined || done.status === 'running') {
      assert.ok(Date.now() < deadline, 'deadline drive did not settle');
      await new Promise((resolve) => setTimeout(resolve, 10));
      done = getAgentJob(job.jobId);
    }
    assert.equal(done.status, 'failed');
    assert.equal(done.error, 'agent_job_deadline');
    assert.ok(done.result !== undefined, 'debt rides a degraded result');
    assert.ok(done.result.warnings.some((warning) => warning.includes('deadline exceeded')));
    assert.equal(validateAgentResult(done.result).ok, true);
    const parsed = JSON.parse(getAgentJobSnapshot(job.jobId)) as {
      status: string;
      error: string;
      result: { warnings: string[] };
    };
    assert.equal(parsed.status, 'failed');
    assert.equal(parsed.error, 'agent_job_deadline');
    assert.ok(parsed.result.warnings.some((warning) => warning.includes('deadline exceeded')));
  } finally {
    setAgentJobRunner(undefined);
    __resetAgentJobs();
  }
});

test('failed round-1 search journals failed:true, no fabrication', async () => {
  // Wave 5: no preflight success leg exists — the only slot is the failed
  // controller search. (Previously this pinned preflight-success + failed
  // live leg = 2 slots in record order.)
  __resetAgentJobs();
  setAgentJobRunner({
    search: async () => {
      throw new Error('round-1 search exploded');
    },
    fetchText: async () => 'unused body words about the query topic',
  });
  __setAgentJobClock(() => 12_000_000, () => 'search-fail-journal-job');
  try {
    const job = createAgentJobEntry({ query: 'fail\0search probe' });
    const done = await executeAgentJob(job.jobId);
    assert.equal(done.status, 'ready');
    assert.ok(done.result!.warnings.some((warning) => warning.includes('search failed; query skipped')));
    const journal = __getAgentEventJournal(job.jobId);
    assert.ok(journal !== undefined);
    const searches = journal.events.filter((event) => event.type === 'SearchCompleted');
    assert.equal(searches.length, 1);
    assert.equal(searches[0]?.type, 'SearchCompleted');
    if (searches[0]?.type === 'SearchCompleted') {
      // Single failed slot: failed:true, zero hits, sanitized query, no fabrication.
      assert.equal(searches[0].failed, true);
      assert.equal(searches[0].hitCount, 0);
      assert.equal(searches[0].searchesUsed, 1);
      assert.equal(searches[0].query, 'failsearch probe');
      assert.ok(!searches[0].query.includes('\0'), 'failed slot uses its logged query, never a fabrication');
    }
    assert.equal(replayable(job.jobId, journal), true);
  } finally {
    __setAgentJobClock(undefined);
    setAgentJobRunner(undefined);
    __resetAgentJobs();
  }
});

test('utility usage surfaces in progress; absent when never reported', async () => {
  __resetAgentJobs();
  mockRunner();
  try {
    const job = createAgentJobEntry({ query: 'utility probe' });
    await executeAgentJob(job.jobId);
    const settled = JSON.parse(getAgentJobSnapshot(job.jobId)) as { progress: { utilityCallsUsed?: number } };
    assert.equal(settled.progress.utilityCallsUsed, 0);
    // Seam projection without the additive field keeps the old byte shape.
    __setAgentJobProgress(job.jobId, {
      stage: 'gather',
      round: 1,
      questionsAnswered: 0,
      questionsTotal: 2,
      searchesUsed: 1,
      fetchesUsed: 1,
    });
    const stripped = JSON.parse(getAgentJobSnapshot(job.jobId)) as { progress: Record<string, unknown> };
    assert.ok(!('utilityCallsUsed' in stripped.progress));
  } finally {
    setAgentJobRunner(undefined);
    __resetAgentJobs();
  }
});

test('single-round job executes exactly one backend search (no shadow preflight)', async () => {
  // Wave 5: the preflight-vs-live race this test pinned no longer exists —
  // the raw query never executes, so even a slow-backend-shaped stub sees a
  // single sanitized call. (Previously: slow preflight slot 0 + fast live
  // slot 1 = 2 SearchCompleted events in record order.) Record-order slot
  // machinery stays covered by the failed-slot and failed-fetch tests.
  __resetAgentJobs();
  setAgentJobRunner({
    search: async (query: string) => {
      // Slow backend: proves no hidden second call is racing underneath.
      await new Promise((resolve) => setTimeout(resolve, 100));
      assert.ok(!query.includes('\0'), 'raw job query never reaches the backend');
      return [{ title: 'Fast', url: 'https://example.com/fast', snippet: 'fast words' }];
    },
    fetchText: async () => 'fast words about the query topic in detail',
  });
  __setAgentJobClock(() => 12_100_000, () => 'search-order-job');
  try {
    const job = createAgentJobEntry({ query: 'slow\0probe' });
    const done = await executeAgentJob(job.jobId);
    assert.equal(done.status, 'ready');
    const journal = __getAgentEventJournal(job.jobId);
    const searches = (journal?.events ?? []).filter((event) => event.type === 'SearchCompleted');
    assert.equal(searches.length, 1);
    assert.equal(searches[0]?.type, 'SearchCompleted');
    if (searches[0]?.type === 'SearchCompleted') {
      // Single slot, record order trivially holds: one search, one hit.
      assert.equal(searches[0].hitCount, 1);
      assert.equal(searches[0].searchesUsed, 1);
    }
    assert.equal(replayable(job.jobId, journal!), true);
  } finally {
    __setAgentJobClock(undefined);
    setAgentJobRunner(undefined);
    __resetAgentJobs();
  }
});

test('orphaned-citations line parses; unknown omits', () => {
  assert.equal(parseSynthesisOrphanedCitationsWarning(['synthesis orphaned citations: cu-1,cu-2,cu-3']), 3);
  assert.equal(parseSynthesisOrphanedCitationsWarning(['synthesis orphaned citations: solo']), 1);
  assert.equal(parseSynthesisOrphanedCitationsWarning(['synthesis orphaned citations:']), 0);
  assert.equal(parseSynthesisOrphanedCitationsWarning(['unrelated warning']), undefined);
  // Last matching line wins.
  assert.equal(parseSynthesisOrphanedCitationsWarning(['synthesis orphaned citations: a', 'synthesis orphaned citations: a,b']), 2);
  // Fold: drops-line orphaned plus citation orphans both contribute.
  assert.deepEqual(parseSynthesisDropsWarning(['synthesis drops: claimUnits=1 blocks=1 orphaned=2']), {
    claimUnits: 1,
    blocks: 1,
    orphaned: 2,
  });
});

test('jobs run unchanged without capability env (absent-capability compat)', async () => {
  __resetAgentJobs();
  mockRunner();
  const saved: Record<string, string | undefined> = {};
  for (const key of ['DIFFBOT_TOKEN', 'YOUTUBE_API_KEY', 'YOUTUBE_COOKIE', 'GRAPH_SPARQL_ENDPOINT']) {
    saved[key] = process.env[key];
    delete process.env[key];
  }
  try {
    const job = createAgentJobEntry({ query: 'compat probe topic' });
    const done = await executeAgentJob(job.jobId);
    assert.equal(done.status, 'ready');
    assert.ok(done.result!.query.includes('compat'));
    let seenPrompt = '';
    await runAdaptiveCore('compat probe topic', {
      search: async () => [{ title: 'Overview', url: 'https://example.com/overview' }],
      fetchText: async () => 'alpha words about the query topic in detail',
      utilityModelClient: {
        completeJson: async (prompt: string) => {
          seenPrompt = prompt;
          return { ok: false, reason: 'no script' };
        },
      },
      evaluator: async () => ({ questionUpdates: [], nextActions: [], shouldContinue: false }),
    });
    assert.ok(!seenPrompt.includes('Capabilities:'), 'absent snapshot keeps prompt unchanged');
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    setAgentJobRunner(undefined);
    __resetAgentJobs();
  }
});

test('journal carries real plan ids and admitted evidence (todo #14)', async () => {
  __resetAgentJobs();
  const body = 'Acme Pro launch price research notes with billable detail and regional availability notes. '.repeat(8);
  setAgentJobRunner({
    search: async () => [{ title: 'A', url: 'https://example.com/a', snippet: 'alpha words' }],
    fetchText: async () => body,
  });
  __setAgentJobClock(() => 4_000_000, () => 'fidelity-job');
  try {
    const seen: AgentResearchEvent[] = [];
    const job = createAgentJobEntry({
      query: 'fidelity probe',
      eventSink: (event) => { seen.push(event); },
    });
    const done = await executeAgentJob(job.jobId);
    assert.equal(done.status, 'ready');
    const journal = __getAgentEventJournal(job.jobId);
    assert.ok(journal !== undefined);
    const plan = journal.events.find((event) => event.type === 'PlanAccepted');
    assert.ok(plan !== undefined && plan.type === 'PlanAccepted');
    assert.ok(plan.questionsTotal > 0, 'fallback plan asks a real question');
    assert.equal(plan.questionIds.length, plan.questionsTotal);
    for (const id of plan.questionIds) {
      assert.match(id, /^q-[0-9a-f]{12}$/, 'real core question id, never synthetic');
    }
    const admitted = journal.events.filter((event) => event.type === 'EvidenceAdmitted');
    assert.ok(admitted.length > 0, 'admitted batches emit EvidenceAdmitted live');
    for (const event of admitted) {
      assert.equal(event.type, 'EvidenceAdmitted');
      if (event.type !== 'EvidenceAdmitted') continue;
      assert.match(event.evidenceId, /^ev-[0-9a-f]+$/);
      assert.ok(event.questionIds.length > 0);
      assert.match(event.excerptHash, /^[0-9a-f]{8,128}$/);
      assert.match(event.fingerprint, /^[0-9a-f]{8,128}$/);
    }
    const evaluation = journal.events.find((event) => event.type === 'EvaluationAccepted');
    assert.ok(evaluation !== undefined && evaluation.type === 'EvaluationAccepted');
    assert.equal(evaluation.answeredCount, 0, 'default evaluator answers nothing');
    assert.equal(evaluation.nextQueryCount, 0);
    assert.equal(evaluation.droppedNextQueries, 0);
    assert.deepEqual(seen.map((event) => event.type), journal.events.map((event) => event.type));
    assert.equal(replayable(job.jobId, journal), true);
  } finally {
    __setAgentJobClock(undefined);
    setAgentJobRunner(undefined);
    __resetAgentJobs();
  }
});

test('leaf-ready job passes steering seams: planner/evaluator fire staged leaf calls', async () => {
  __resetAgentJobs();
  const body = 'Steering seams probe evidence with billable detail and regional availability notes. '.repeat(8);
  setAgentJobRunner({
    search: async () => [{ title: 'A', url: 'https://example.com/a', snippet: 'alpha words' }],
    fetchText: async () => body,
  });
  const priorModel = process.env.PI_NORTHSTAR_LEAF_MODEL;
  const priorSteering = process.env.PI_NORTHSTAR_AGENT_STEERING;
  process.env.PI_NORTHSTAR_LEAF_MODEL = 'testprov/test-model-xyz';
  delete process.env.PI_NORTHSTAR_AGENT_STEERING;
  const stages: Array<string | undefined> = [];
  setLeafRuntimeProvider({
    refreshReady: async () => true,
    runLeaf: async (_prompt: string, runOpts?: { stage?: string }) => {
      stages.push(runOpts?.stage);
      if (runOpts?.stage === 'agent-plan') {
        return { text: JSON.stringify({ questions: [{ question: 'What evidence backs this claim?', priority: 2, required: true }] }) };
      }
      if (runOpts?.stage === 'agent-evaluate') {
        return { text: JSON.stringify({ questionUpdates: [], nextActions: [], shouldContinue: false }) };
      }
      if (runOpts?.stage === 'agent-verify') {
        return { text: JSON.stringify({ clauseVerdicts: [], reason: 'checked' }) };
      }
      if (runOpts?.stage === 'agent-synthesize') {
        return { text: 'not json' };
      }
      return { text: 'leaf-composed report sentence one. Sentence two here.' };
    },
  });
  __setAgentJobClock(() => 13_000_000, () => 'seams-job');
  try {
    const job = createAgentJobEntry({ query: 'steering seams probe' });
    const done = await executeAgentJob(job.jobId);
    assert.equal(done.status, 'ready');
    assert.equal(done.rpc.transport, 'leaf-runtime');
    assert.ok(stages.includes('agent-plan'), 'planner seam fired a staged leaf call');
    assert.ok(stages.includes('agent-evaluate'), 'evaluator seam fired a staged leaf call');
    assert.ok(stages.includes('agent-synthesize'), 'synthesizer seam fired a staged leaf call');
    // Synthesis IR invalid -> Task 3 evidence-only floor, never a throw.
    assert.ok(done.result!.warnings.some((warning) => warning.includes('evidence-only')));
  } finally {
    if (priorModel === undefined) delete process.env.PI_NORTHSTAR_LEAF_MODEL;
    else process.env.PI_NORTHSTAR_LEAF_MODEL = priorModel;
    if (priorSteering === undefined) delete process.env.PI_NORTHSTAR_AGENT_STEERING;
    else process.env.PI_NORTHSTAR_AGENT_STEERING = priorSteering;
    setLeafRuntimeProvider(undefined);
    __setAgentJobClock(undefined);
    setAgentJobRunner(undefined);
    __resetAgentJobs();
  }
});

test('kill-switch strips steering seams: no staged leaf calls, deterministic ladder', async () => {
  __resetAgentJobs();
  mockRunner();
  const priorModel = process.env.PI_NORTHSTAR_LEAF_MODEL;
  const priorSteering = process.env.PI_NORTHSTAR_AGENT_STEERING;
  process.env.PI_NORTHSTAR_LEAF_MODEL = 'testprov/test-model-xyz';
  process.env.PI_NORTHSTAR_AGENT_STEERING = '0';
  const stages: Array<string | undefined> = [];
  setLeafRuntimeProvider({
    refreshReady: async () => true,
    runLeaf: async (_prompt: string, runOpts?: { stage?: string }) => {
      stages.push(runOpts?.stage);
      return { text: 'leaf-composed report sentence one. Sentence two here.' };
    },
  });
  __setAgentJobClock(() => 13_100_000, () => 'killswitch-job');
  try {
    const job = createAgentJobEntry({ query: 'kill switch probe' });
    const done = await executeAgentJob(job.jobId);
    assert.equal(done.status, 'ready');
    assert.ok(stages.length === 0, 'no leaf calls at all under the kill-switch');
  } finally {
    if (priorModel === undefined) delete process.env.PI_NORTHSTAR_LEAF_MODEL;
    else process.env.PI_NORTHSTAR_LEAF_MODEL = priorModel;
    if (priorSteering === undefined) delete process.env.PI_NORTHSTAR_AGENT_STEERING;
    else process.env.PI_NORTHSTAR_AGENT_STEERING = priorSteering;
    setLeafRuntimeProvider(undefined);
    __setAgentJobClock(undefined);
    setAgentJobRunner(undefined);
    __resetAgentJobs();
  }
});

test('journal without admitted evidence omits EvidenceAdmitted (legacy shape)', async () => {
  __resetAgentJobs();
  mockRunner();
  __setAgentJobClock(() => 5_000_000, () => 'legacy-shape-job');
  try {
    const job = createAgentJobEntry({ query: 'legacy shape probe' });
    const done = await executeAgentJob(job.jobId);
    assert.equal(done.status, 'ready');
    const journal = __getAgentEventJournal(job.jobId);
    assert.ok(journal !== undefined);
    const types = journal.events.map((event) => event.type);
    assert.deepEqual(types, [
      'JobCreated',
      'PlanAccepted',
      'SearchCompleted',
      'FetchCompleted',
      // Executor gather legs always report candidate accounting, even 0/0:
      // the event is count-only telemetry, not evidence.
      'CandidatesAccumulated',
      'EvaluationAccepted',
      'JobReady',
    ]);
    assert.ok(!types.includes('EvidenceAdmitted'), 'no evidence, no event — never zero-filled');
    assert.equal(replayable(job.jobId, journal), true);
  } finally {
    __setAgentJobClock(undefined);
    setAgentJobRunner(undefined);
    __resetAgentJobs();
  }
});

test('job depth validates reject-not-clamp with no registration on invalid', async () => {
  __resetAgentJobs();
  try {
    assert.throws(
      () => createAgentJobEntry({ query: 'depth probe', depth: 'ultra' as unknown as never }),
      /depth must be/,
    );
    assert.equal(hasUnexpiredJob(), false, 'rejected admissions register no job');
  } finally {
    __resetAgentJobs();
  }
});

test('job depth deep accepted; execute opts depth validates and persists', async () => {
  __resetAgentJobs();
  mockRunner();
  try {
    const job = createAgentJobEntry({ query: 'deep probe', depth: 'deep' });
    const done = await executeAgentJob(job.jobId);
    assert.equal(done.status, 'ready');
    await assert.rejects(executeAgentJob(job.jobId, { depth: 'ultra' as unknown as never }), /depth must be/);
    const again = await executeAgentJob(job.jobId, { depth: 'balanced' });
    assert.equal(again.status, 'ready');
  } finally {
    setAgentJobRunner(undefined);
    __resetAgentJobs();
  }
});

test('kill-switch strips model deps but keeps the gather executor seam', async () => {
  const jobs = await import('../../../src/web/agent/agent-jobs.js');
  const executor = async () => ({
    admitted: [],
    candidates: [],
    warnings: [],
    searchesUsed: 0,
    fetchesUsed: 0,
    queriesSearched: [],
    queryRejected: 0,
    webContent: [],
    perAction: [],
  });
  const stripped = jobs.stripAgentModelDeps({
    search: async () => [],
    fetchText: async () => '',
    planner: async () => ({ questions: [], scopeNotes: [] }),
    evaluator: async () => ({ questionUpdates: [], nextActions: [], shouldContinue: false }),
    gatherExecutor: executor,
  });
  assert.equal(stripped.gatherExecutor, executor, 'executor survives the no-model ladder');
  assert.equal(stripped.planner, undefined);
  assert.equal(stripped.evaluator, undefined);
});

test('job journal carries count-only CandidatesAccumulated per gather round', async () => {
  __resetAgentJobs();
  const body = 'Candidate telemetry probe evidence with billable detail and regional availability notes. '.repeat(8);
  setAgentJobRunner({
    search: async () => [{ title: 'A', url: 'https://example.com/a', snippet: 'alpha words' }],
    fetchText: async () => body,
  });
  __setAgentJobClock(() => 5_000_000, () => 'candidate-job');
  try {
    const job = createAgentJobEntry({ query: 'candidate probe' });
    const done = await executeAgentJob(job.jobId);
    assert.equal(done.status, 'ready');
    const journal = __getAgentEventJournal(job.jobId);
    assert.ok(journal !== undefined);
    const accumulated = journal.events.filter((event) => event.type === 'CandidatesAccumulated');
    assert.ok(accumulated.length > 0, 'executor gather legs emit candidate accounting');
    for (const event of accumulated) {
      assert.equal(event.type, 'CandidatesAccumulated');
      if (event.type !== 'CandidatesAccumulated') continue;
      // Count-only: exact keys, no candidate content bytes anywhere.
      assert.deepEqual(Object.keys(event).sort(), ['added', 'dropped', 'jobId', 'round', 'type']);
      assert.ok(Number.isInteger(event.added) && event.added >= 0);
      assert.ok(Number.isInteger(event.dropped) && event.dropped >= 0);
      assert.ok(!JSON.stringify(event).includes('example.com'), 'no candidate identities leak into the journal');
    }
    assert.equal(replayable(job.jobId, journal), true);
  } finally {
    __setAgentJobClock(undefined);
    setAgentJobRunner(undefined);
    __resetAgentJobs();
  }
});
