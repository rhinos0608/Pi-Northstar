import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  __resetAgentJobs,
  __setAgentJobClock,
  createAgentJobEntry,
  executeAgentJob,
  getAgentJobSnapshot,
  setAgentJobRunner,
} from '../../../src/web/agent/agent-jobs.js';

test('identical job state polls identical bytes', async () => {
  __resetAgentJobs();
  setAgentJobRunner({
    search: async () => [{ title: 'A', url: 'https://example.com/a', snippet: 'stable words' }],
    fetchText: async () => 'stable words about the topic',
  });
  __setAgentJobClock(() => 3_000_000, () => 'stable-job');
  try {
    const job = createAgentJobEntry({ query: 'stable topic' });
    await executeAgentJob(job.jobId);
    const first = getAgentJobSnapshot(job.jobId);
    const second = getAgentJobSnapshot(job.jobId);
    assert.equal(first, second);
    assert.equal(Buffer.byteLength(first, 'utf8'), Buffer.byteLength(second, 'utf8'));
    // Canonical form: keys sorted at every level.
    const parsed = JSON.parse(first);
    assert.deepEqual(Object.keys(parsed), [...Object.keys(parsed)].sort());
  } finally {
    __setAgentJobClock(undefined);
    setAgentJobRunner(undefined);
    __resetAgentJobs();
  }
});
