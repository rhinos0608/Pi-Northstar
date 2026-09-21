import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { jobsStatusCommand } from '../../src/commands/jobs-status-handler.js';
import { validateCommandResult } from '../../src/commands/command-result.js';
import { BrokerServer } from '../../src/runtime/broker-server.js';

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

test('jobsStatusCommand returns broker_query_unimplemented when broker socket is probed live', async () => {
  if (process.platform === 'win32') return;

  const tempDir = await mkdtemp(join(tmpdir(), 'ns-jobs-live-'));
  const projectId = 'live';
  const server = new BrokerServer({
    projectId,
    rootDir: tempDir,
    handler: () => ({ version: 1, requestId: 'r1', method: 'result', success: true, data: {} }),
  });
  await server.start();

  try {
    const result = await jobsStatusCommand({
      projectId,
      requestId: 'req-456',
      rootDir: tempDir,
    });

    assert.equal(result.outcome, 'failed');
    assert.equal(result.error?.code, 'broker_query_unimplemented');
    assert.equal(result.error?.retryable, false);
    assert.match(result.error?.message ?? '', /Broker query unimplemented/);
    assert.equal(validateCommandResult(result).ok, true);
  } finally {
    await server.stop();
    await rm(tempDir, { recursive: true, force: true });
  }
});
