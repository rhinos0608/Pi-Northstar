import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { brokerServeCommand } from '../../src/commands/broker-serve-handler.js';
import { validateCommandResult } from '../../src/commands/command-result.js';
import { acquireBrokerLock } from '../../src/runtime/broker-lock.js';

test('brokerServeCommand rejects invalid projectId without touching host', async () => {
  const cases = [
    '../escape',
    '',
    'project/with/slashes',
    'project with spaces',
    'a'.repeat(97),
  ];

  for (const badId of cases) {
    const result = await brokerServeCommand({ projectId: badId });
    assert.equal(result.outcome, 'failed');
    assert.equal(result.error?.code, 'invalid_input');
    assert.equal(result.error?.retryable, false);
    assert.equal(validateCommandResult(result).ok, true);
  }
});

test('brokerServeCommand returns broker_unavailable when broker binary is not installed', async () => {
  const tempDir = await mkdtemp(join(tmpdir(), 'northstar-broker-serve-test-'));
  try {
    const result = await brokerServeCommand({
      projectId: 'test-project',
      rootDir: tempDir,
    });

    assert.equal(result.outcome, 'failed');
    assert.equal(result.error?.code, 'broker_unavailable');
    assert.equal(result.error?.retryable, false);
    assert.match(result.error?.message ?? '', /Binary not found/);
    assert.equal(validateCommandResult(result).ok, true);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test('brokerServeCommand maps BrokerLockError lock_held to broker_already_running when binary exists', async () => {
  const tempDir = await mkdtemp(join(tmpdir(), 'northstar-broker-serve-lock-'));
  const projectId = 'test-lock-project';
  const fakeBin = join(tempDir, 'fake-broker');
  try {
    // Create an executable fake binary so the binary existence check passes
    await writeFile(fakeBin, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    await chmod(fakeBin, 0o755);

    // Acquire the lock as a live owner (current process)
    await acquireBrokerLock(projectId, 'serve', tempDir);

    const result = await brokerServeCommand({
      projectId,
      rootDir: tempDir,
      binaryPath: fakeBin,
    });

    assert.equal(result.outcome, 'failed');
    assert.equal(result.error?.code, 'broker_already_running');
    assert.equal(result.error?.retryable, false);
    assert.match(result.error?.message ?? '', /Broker already running/);
    assert.equal(validateCommandResult(result).ok, true);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});
