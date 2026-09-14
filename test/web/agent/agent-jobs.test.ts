import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  __resetAgentJobs,
  __setAgentJobClock,
  createAgentJobEntry,
  executeAgentJob,
  getAgentJob,
  getAgentJobSnapshot,
  hasUnexpiredJob,
  setAgentJobRunner,
} from '../../../src/web/agent/agent-jobs.js';
import { AGENT_JOB_TTL_MS } from '../../../src/web/agent/agent-contract.js';
import { setLeafRuntimeProvider } from '../../../src/web/agent/agent-rpc.js';
import {
  __setAgentJobCreator,
  createAgentJob,
  type CreateAgentJobParams,
} from '../../../src/web/agent/agent-job-seam.js';
import { buildSearchRoute } from '../../../src/web/web-search-route.js';

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

test('expired jobs read as missing; registry drains', async () => {
  __resetAgentJobs();
  mockRunner();
  let at = 1_000_000;
  let n = 0;
  __setAgentJobClock(() => at, () => `job-${(n += 1)}`);
  try {
    const job = createAgentJobEntry({ query: 'expiry probe' });
    await executeAgentJob(job.jobId);
    at += AGENT_JOB_TTL_MS + 1;
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

test('leaf path records transport and reports leaf text; snapshot clean', async () => {
  __resetAgentJobs();
  mockRunner();
  const modelId = 'testprov/test-model-xyz';
  const prior = process.env.PI_NORTHSTAR_LEAF_MODEL;
  process.env.PI_NORTHSTAR_LEAF_MODEL = modelId;
  setLeafRuntimeProvider({
    refreshReady: async () => true,
    runLeaf: async () => ({ text: 'leaf-composed report sentence one. Sentence two here.' }),
  });
  let n = 0;
  __setAgentJobClock(() => 4_000_000, () => `leaf-job-${(n += 1)}`);
  try {
    const job = createAgentJobEntry({ query: 'leaf topic' });
    const done = await executeAgentJob(job.jobId);
    assert.equal(done.status, 'ready');
    assert.equal(done.rpc.transport, 'leaf-runtime');
    assert.equal(done.rpc.reason, 'negotiated exact leaf model');
    assert.ok(done.result!.reportText.includes('leaf-composed'));
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

test('leaf start failure falls back with safe-code warning; no model ids leak', async () => {
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
    // Fallback reflects the ACTUAL producer: standalone, negotiated stays true.
    assert.equal(done.rpc.transport, 'standalone');
    assert.equal(done.rpc.negotiated, true);
    assert.ok(done.rpc.reason.includes('runtime_unavailable'));
    const warnings = done.result!.warnings.join('\n');
    assert.ok(warnings.includes('leaf runtime leg failed (runtime_unavailable); report leg fallback'));
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

test('registered runtime without model env stays standalone', async () => {
  __resetAgentJobs();
  mockRunner();
  const prior = process.env.PI_NORTHSTAR_LEAF_MODEL;
  delete process.env.PI_NORTHSTAR_LEAF_MODEL;
  setLeafRuntimeProvider({
    refreshReady: async () => true,
    runLeaf: async () => ({ text: 'must not run' }),
  });
  let n = 0;
  __setAgentJobClock(() => 7_000_000, () => `nomodel-${(n += 1)}`);
  try {
    const job = createAgentJobEntry({ query: 'no-model topic' });
    const done = await executeAgentJob(job.jobId);
    assert.equal(done.status, 'ready');
    assert.equal(done.rpc.transport, 'standalone');
    assert.ok(done.rpc.reason.includes('model unset'));
  } finally {
    if (prior === undefined) delete process.env.PI_NORTHSTAR_LEAF_MODEL;
    else process.env.PI_NORTHSTAR_LEAF_MODEL = prior;
    setLeafRuntimeProvider(undefined);
    __setAgentJobClock(undefined);
    setAgentJobRunner(undefined);
    __resetAgentJobs();
  }
});

test('leaf job executes exactly one backend search; prompt reuses same hits', async () => {
  __resetAgentJobs();
  let searchCalls = 0;
  let leafPrompt = '';
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
    runLeaf: async (prompt: string) => {
      leafPrompt = prompt;
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
    assert.ok(leafPrompt.includes('single-search-evidence'));
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

test('early search throw with negotiated leaf resets transport to standalone', async () => {
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
    assert.equal(done.status, 'failed');
    assert.equal(done.result, undefined);
    assert.equal(done.rpc.transport, 'standalone');
    assert.ok(done.rpc.reason.includes('before the report leg produced'));
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
    at += AGENT_JOB_TTL_MS + 1;
    assert.equal(hasUnexpiredJob(), false);
    await assert.rejects(executeAgentJob(job.jobId), /unknown agent job/);
  } finally {
    __setAgentJobClock(undefined);
    setAgentJobRunner(undefined);
    __resetAgentJobs();
  }
});

test('shutdown mid-flight aborts the captured leaf ref to fallback', async () => {
  __resetAgentJobs();
  mockRunner();
  let leafCalls = 0;
  setLeafRuntimeProvider({
    refreshReady: async () => {
      // Seam clears between negotiation capture and report-leg use.
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
    assert.equal(done.rpc.transport, 'standalone');
    assert.ok(done.rpc.reason.includes('provider_shutdown'));
    assert.ok(done.result!.warnings.some((warning) => warning.includes('provider_shutdown')));
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

test('failed jobs store a stable generic error code, never dependency text', async () => {
  __resetAgentJobs();
  setAgentJobRunner({
    search: async () => { throw new Error('backend SECRET-MARKER exploded'); },
    fetchText: async () => 'unused',
  });
  __setAgentJobClock(() => 9_100_000, () => 'fail-job');
  try {
    const job = createAgentJobEntry({ query: 'doomed topic' });
    const done = await executeAgentJob(job.jobId);
    assert.equal(done.status, 'failed');
    assert.equal(done.error, 'agent_job_failed');
    const snapshot = getAgentJobSnapshot(job.jobId);
    assert.ok(!snapshot.includes('SECRET-MARKER'));
    assert.ok(snapshot.includes('agent_job_failed'));
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
