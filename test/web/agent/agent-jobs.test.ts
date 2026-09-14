import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  __resetAgentJobs,
  __setAgentJobClock,
  createAgentJobEntry,
  executeAgentJob,
  getAgentJobSnapshot,
  hasUnexpiredJob,
  setAgentJobRunner,
} from '../../../src/web/agent/agent-jobs.js';
import { AGENT_JOB_TTL_MS } from '../../../src/web/agent/agent-contract.js';

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

test('empty query rejects at creation', () => {
  __resetAgentJobs();
  try {
    assert.throws(() => createAgentJobEntry({ query: '   ' }), /non-empty query/);
  } finally {
    __resetAgentJobs();
  }
});
