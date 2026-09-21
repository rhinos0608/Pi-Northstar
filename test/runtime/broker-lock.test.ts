import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { acquireBrokerLock, releaseBrokerLock, readBrokerLock, BrokerLockError } from '../../src/runtime/broker-lock.js';

const PROJECT = 'lock-test-project';

async function withTempRoot(fn: (root: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'ns-lock-'));
  try { await fn(root); }
  finally { await rm(root, { recursive: true, force: true }); }
}

test('acquire and release lock round-trips', async () => {
  await withTempRoot(async (root) => {
    await acquireBrokerLock(PROJECT, 'serve', root);
    const rec = await readBrokerLock(PROJECT, root);
    assert.ok(rec, 'lock record should exist');
    assert.equal(rec!.pid, process.pid);
    assert.equal(rec!.mode, 'serve');
    await releaseBrokerLock(PROJECT, root);
    const after = await readBrokerLock(PROJECT, root);
    assert.equal(after, undefined, 'lock should be released');
  });
});

test('second acquire while held throws lock_held', async () => {
  await withTempRoot(async (root) => {
    await acquireBrokerLock(PROJECT, 'serve', root);
    try {
      await assert.rejects(
        () => acquireBrokerLock(PROJECT, 'session', root),
        (err: unknown) => err instanceof BrokerLockError && err.code === 'lock_held',
      );
    } finally {
      await releaseBrokerLock(PROJECT, root);
    }
  });
});

test('release by non-owner is a no-op', async () => {
  await withTempRoot(async (root) => {
    await acquireBrokerLock(PROJECT, 'serve', root);
    const before = await readBrokerLock(PROJECT, root);
    assert.ok(before);
    // Simulate a different process owning the lock: overwrite with a foreign pid.
    const foreignPid = before.pid === 1 ? 2 : 1;
    await writeFile(
      join(root, PROJECT, 'broker.lock'),
      JSON.stringify({ pid: foreignPid, startedAt: Date.now(), mode: 'serve' }),
    );
    await releaseBrokerLock(PROJECT, root);
    const after = await readBrokerLock(PROJECT, root);
    assert.ok(after, 'lock file must remain after non-owner release');
    assert.equal(after!.pid, foreignPid);
  });
});

test('read lock returns undefined when no lock exists', async () => {
  await withTempRoot(async (root) => {
    const rec = await readBrokerLock(PROJECT, root);
    assert.equal(rec, undefined);
  });
});
