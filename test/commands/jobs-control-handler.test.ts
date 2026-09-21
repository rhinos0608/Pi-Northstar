import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  jobsCancelCommand,
  jobsResultCommand,
  jobsStartCommand,
} from '../../src/commands/jobs-control-handler.js';
import { BrokerServer } from '../../src/runtime/broker-server.js';

test('job control handlers run start, result, and cancel against an existing broker', async () => {
  if (process.platform === 'win32') return;

  const rootDir = await mkdtemp(join(tmpdir(), 'ns-jobs-control-'));
  const projectId = 'jobs-control';
  const server = new BrokerServer({
    projectId,
    rootDir,
    authorize: () => true,
    handler: (request) => {
      const data =
        request.method === 'start'
          ? { runId: 'runtime_control_1', state: 'running' }
          : request.method === 'result'
            ? { runId: 'runtime_control_1', state: 'completed', output: 'done', outputTokens: 1, truncated: false }
            : request.method === 'cancelAndSettle'
              ? { settlements: [{ runId: 'runtime_control_1', state: 'cancelled' }] }
              : { runId: 'runtime_control_1', state: 'completed', startedAt: 1, updatedAt: 2 };
      return { version: 1, requestId: request.requestId, method: request.method, success: true, data };
    },
  });
  await server.start();

  try {
    const started = await jobsStartCommand({
      projectId,
      rootDir,
      requestId: 'job-control-req',
      modelId: 'provider/model',
      prompt: 'do work',
      maxOutputTokens: 16,
      timeoutMs: 1_000,
    });
    assert.equal(started.outcome, 'success');
    assert.equal((started.data as { jobId: string }).jobId, 'runtime_control_1');

    const result = await jobsResultCommand({ projectId, rootDir, requestId: 'job-control-req' });
    assert.equal(result.outcome, 'success');
    assert.equal(((result.data as { runtime: { output: string } }).runtime).output, 'done');

    const cancelled = await jobsCancelCommand({
      projectId,
      rootDir,
      requestId: 'job-control-req',
      settlementWindowMs: 100,
    });
    assert.equal(cancelled.outcome, 'success');
    assert.deepEqual((cancelled.data as { runtime: unknown }).runtime, {
      settlements: [{ runId: 'runtime_control_1', state: 'cancelled' }],
    });
  } finally {
    await server.stop();
    await rm(rootDir, { recursive: true, force: true });
  }
});

test('jobsStartCommand validates before trying to connect', async () => {
  const result = await jobsStartCommand({
    projectId: '../bad',
    modelId: 'provider/model',
    prompt: 'x',
  });
  assert.equal(result.outcome, 'failed');
  assert.equal(result.error?.code, 'invalid_input');
});
