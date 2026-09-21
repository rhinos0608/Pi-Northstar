import test from 'node:test';
import assert from 'node:assert/strict';
import { access, mkdtemp, rm, writeFile, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { brokerServeCommand } from '../../src/commands/broker-serve-handler.js';
import { validateCommandResult } from '../../src/commands/command-result.js';
import { acquireBrokerLock, releaseBrokerLock } from '../../src/runtime/broker-lock.js';
import { resolveBrokerBinaryPath } from '../../src/runtime/broker-host.js';

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

test('broker binary resolution stays on fixed package or source-build paths', () => {
  const resolved = resolveBrokerBinaryPath();
  const normalized = resolved.replaceAll('\\', '/');
  assert.match(normalized, /\/(bin|rust\/target\/(release|debug))\/northstar-broker(?:\.exe)?$/);
});

test('brokerServeCommand ignores caller-supplied binaryPath and uses the default binary path', async () => {
  const tempDir = await mkdtemp(join(tmpdir(), 'northstar-broker-serve-lock-'));
  const projectId = 'test-lock-project';
  const fakeBin = join(tempDir, 'fake-broker');
  const marker = join(tempDir, 'fake-ran');
  try {
    // Create an executable fake binary; the handler must never execute it.
    await writeFile(fakeBin, `#!/bin/sh\ntouch "${marker}"\nexit 0\n`, { mode: 0o755 });
    await chmod(fakeBin, 0o755);

    // Acquire the lock as a live owner (current process)
    await acquireBrokerLock(projectId, 'serve', tempDir);
    try {
      // Caller-supplied binaryPath is not part of the handler surface. If a
      // source-built broker exists, the live lock wins; otherwise fixed-path
      // resolution reports unavailable. In neither case may fakeBin execute.
      const result = await brokerServeCommand({
        projectId,
        rootDir: tempDir,
        binaryPath: fakeBin,
      } as unknown as { projectId: string; rootDir: string });

      assert.equal(result.outcome, 'failed');
      assert.ok(
        result.error?.code === 'broker_unavailable' || result.error?.code === 'broker_already_running',
      );
      assert.equal(result.error?.retryable, false);
      assert.equal(await access(marker).then(() => true, () => false), false);
      assert.equal(validateCommandResult(result).ok, true);
    } finally {
      await releaseBrokerLock(projectId, tempDir);
    }
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});
