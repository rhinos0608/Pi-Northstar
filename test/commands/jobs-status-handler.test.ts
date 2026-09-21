import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { jobsStatusCommand } from '../../src/commands/jobs-status-handler.js';
import { validateCommandResult } from '../../src/commands/command-result.js';
import { BrokerServer } from '../../src/runtime/broker-server.js';
import { BrokerClient, PUBLIC_CLI_BROKER_CLIENT_ID } from '../../src/runtime/broker-client.js';

test('jobsStatusCommand rejects malformed requestId without probing', async () => {
  const badRequestIds = [
    '',
    '../escape',
    'id with spaces',
    'bad$char',
    'a'.repeat(129),
  ];

  for (const badId of badRequestIds) {
    const result = await jobsStatusCommand({
      projectId: 'valid-project',
      requestId: badId,
    });
    assert.equal(result.outcome, 'failed');
    assert.equal(result.error?.code, 'invalid_input');
    assert.equal(result.error?.retryable, false);
    assert.equal(validateCommandResult(result).ok, true);
  }
});

test('jobsStatusCommand rejects malformed projectId without probing', async () => {
  const badProjectIds = [
    '',
    '../escape',
    'project/with/slashes',
    'project with spaces',
    'a'.repeat(97),
  ];

  for (const badId of badProjectIds) {
    const result = await jobsStatusCommand({
      projectId: badId,
      requestId: 'req-123',
    });
    assert.equal(result.outcome, 'failed');
    assert.equal(result.error?.code, 'invalid_input');
    assert.equal(result.error?.retryable, false);
    assert.equal(validateCommandResult(result).ok, true);
  }
});

test('jobsStatusCommand returns broker_unavailable when no socket exists', async () => {
  const tempDir = await mkdtemp(join(tmpdir(), 'ns-jobs-status-'));
  try {
    const result = await jobsStatusCommand({
      projectId: 'test-project',
      requestId: 'req-valid-123',
      rootDir: tempDir,
    });

    assert.equal(result.outcome, 'failed');
    assert.equal(result.error?.code, 'broker_unavailable');
    assert.equal(result.error?.retryable, false);
    assert.match(result.error?.message ?? '', /No active broker found/);
    assert.equal(validateCommandResult(result).ok, true);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test('jobsStatusCommand returns empty when a live broker has no matching receipt', async () => {
  if (process.platform === 'win32') return;

  const tempDir = await mkdtemp(join(tmpdir(), 'ns-jobs-live-'));
  const projectId = 'live';
  const server = new BrokerServer({
    projectId,
    rootDir: tempDir,
    authorize: () => true,
    handler: (request) => ({
      version: 1,
      requestId: request.requestId,
      method: request.method,
      success: true,
      data: {},
    }),
  });
  await server.start();

  try {
    const result = await jobsStatusCommand({ projectId, requestId: 'req-456', rootDir: tempDir });
    assert.equal(result.outcome, 'empty');
    assert.deepEqual(result.data, { projectId, requestId: 'req-456', status: 'not_found' });
    assert.equal(validateCommandResult(result).ok, true);
  } finally {
    await server.stop();
    await rm(tempDir, { recursive: true, force: true });
  }
});

test('jobsStatusCommand returns the durable submission receipt for the CLI identity', async () => {
  if (process.platform === 'win32') return;

  const tempDir = await mkdtemp(join(tmpdir(), 'ns-jobs-receipt-'));
  const projectId = 'receipt-live';
  const server = new BrokerServer({
    projectId,
    rootDir: tempDir,
    authorize: () => true,
    handler: (request) => ({
      version: 1,
      requestId: request.requestId,
      method: request.method,
      success: true,
      data: request.method === 'start'
        ? { runId: 'runtime_job_456', state: 'running' }
        : request.method === 'status'
          ? { runId: 'runtime_job_456', state: 'completed', startedAt: 1, updatedAt: 2 }
          : {},
    }),
  });
  await server.start();

  const submitter = new BrokerClient({
    endpoint: server.endpoint,
    projectId,
    clientId: PUBLIC_CLI_BROKER_CLIENT_ID,
    capabilities: ['start'],
  });
  try {
    await submitter.connect();
    const reply = await submitter.request({
      version: 1,
      requestId: 'req-456',
      method: 'start',
      params: {
        modelId: 'provider/model',
        prompt: 'test',
        maxOutputTokens: 16,
        timeoutMs: 1_000,
        correlation: {
          owner: 'northstar',
          correlationId: 'job-status-test',
          queryIndex: 0,
          role: 'researcher',
          stage: 'test',
          attempt: 0,
        },
      },
    });
    assert.equal(reply.success, true);
    submitter.close();

    const result = await jobsStatusCommand({ projectId, requestId: 'req-456', rootDir: tempDir });
    assert.equal(result.outcome, 'success');
    assert.deepEqual(result.data, {
      projectId,
      requestId: 'req-456',
      status: 'completed',
      receipt: {
        jobId: 'runtime_job_456',
        clientId: PUBLIC_CLI_BROKER_CLIENT_ID,
        requestId: 'req-456',
        submittedAt: (result.data as { receipt: { submittedAt: number } }).receipt.submittedAt,
      },
      runtime: {
        runId: 'runtime_job_456',
        state: 'completed',
        startedAt: 1,
        updatedAt: 2,
      },
    });
    assert.equal(validateCommandResult(result).ok, true);
  } finally {
    submitter.close();
    await server.stop();
    await rm(tempDir, { recursive: true, force: true });
  }
});
