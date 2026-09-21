import { open, rm, readFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { brokerEndpoint, ensureOwnerOnlyDirectory } from './broker-endpoint.js';

export interface BrokerLockRecord {
  pid: number;
  startedAt: number;
  mode: 'serve' | 'session';
}

export class BrokerLockError extends Error {
  constructor(
    readonly code: 'lock_held' | 'stale_lock_removal_failed' | 'lock_io_error',
    message: string,
  ) {
    super(message);
    this.name = 'BrokerLockError';
  }
}

function lockPath(projectId: string, rootDir?: string): string {
  return `${brokerEndpoint(projectId, rootDir).rootDir}/broker.lock`;
}

/**
 * Returns true if the pid in the lock record is demonstrably dead (ESRCH only).
 * Returns false if the process is alive (signal 0 succeeded) or liveness cannot
 * be ruled out (EPERM means a live process we lack permission to signal).
 * Throws lock_io_error if pid is invalid or unexpected error occurs.
 */
function assertLockStaleOrHeld(record: BrokerLockRecord): boolean {
  if (!Number.isSafeInteger(record.pid) || record.pid <= 0) {
    throw new BrokerLockError('lock_io_error', `Corrupt lock record: invalid pid ${record.pid}`);
  }
  try {
    process.kill(record.pid, 0);
    return false;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ESRCH') {
      return true;
    }
    if (code === 'EPERM') {
      return false;
    }
    throw new BrokerLockError('lock_io_error', `Process liveness check failed: ${(err as Error).message}`);
  }
}

/**
 * Acquire the advisory broker lock.
 * Fails with BrokerLockError('lock_held') if a live owner holds it.
 * Removes stale lock (dead owner) and retakes it.
 * Never blindly removes a lock without confirming owner is dead.
 */
export async function acquireBrokerLock(
  projectId: string,
  mode: BrokerLockRecord['mode'],
  rootDir?: string,
): Promise<void> {
  await ensureOwnerOnlyDirectory(brokerEndpoint(projectId, rootDir).rootDir);
  const path = lockPath(projectId, rootDir);
  const record: BrokerLockRecord = { pid: process.pid, startedAt: Date.now(), mode };

  const maxAttempts = 3;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      const handle = await open(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
      await handle.writeFile(JSON.stringify(record));
      await handle.close();
      return;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') {
        throw new BrokerLockError('lock_io_error', `Lock file error: ${(err as Error).message}`);
      }
    }

    // Lock file exists — check if owner is alive
    let existing: BrokerLockRecord;
    try {
      const raw = await readFile(path, 'utf8');
      existing = JSON.parse(raw) as BrokerLockRecord;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        continue;
      }
      throw new BrokerLockError('lock_io_error', 'Cannot read existing lock file');
    }

    const isStale = assertLockStaleOrHeld(existing);
    if (!isStale) {
      throw new BrokerLockError('lock_held', `Broker already running (pid ${existing.pid}, mode: ${existing.mode})`);
    }

    // Owner is dead — safe to remove and retake atomically
    try {
      await rm(path, { force: true });
    } catch {
      throw new BrokerLockError('stale_lock_removal_failed', 'Cannot remove stale lock file');
    }

    // Retake with O_EXCL under lock error handling: a racing contender
    // winning the slot surfaces as lock_held, not a raw EEXIST.
    try {
      const retake = await open(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
      await retake.writeFile(JSON.stringify(record));
      await retake.close();
      return;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'EEXIST') {
        throw new BrokerLockError('lock_held', 'Failed to acquire broker lock after retries: lock contested');
      }
      throw new BrokerLockError('lock_io_error', `Lock file error: ${(err as Error).message}`);
    }
  }

  throw new BrokerLockError('lock_held', 'Failed to acquire broker lock after retries: lock contested');
}

/** Release the advisory lock. Only removes if current pid owns it. */
export async function releaseBrokerLock(projectId: string, rootDir?: string): Promise<void> {
  const path = lockPath(projectId, rootDir);
  try {
    const raw = await readFile(path, 'utf8');
    const record = JSON.parse(raw) as BrokerLockRecord;
    if (record.pid === process.pid) {
      await rm(path, { force: true });
    }
  } catch {
    // Lock already gone or unreadable — no-op
  }
}

/** Read the current lock state without acquiring. Returns undefined if no lock. */
export async function readBrokerLock(projectId: string, rootDir?: string): Promise<BrokerLockRecord | undefined> {
  const path = lockPath(projectId, rootDir);
  try {
    const raw = await readFile(path, 'utf8');
    return JSON.parse(raw) as BrokerLockRecord;
  } catch {
    return undefined;
  }
}
