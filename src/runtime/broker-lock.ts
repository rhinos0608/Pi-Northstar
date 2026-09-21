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

/** Returns true if the pid in the lock record is demonstrably dead. */
async function isLockStale(record: BrokerLockRecord): Promise<boolean> {
  try {
    // Signal 0 checks existence without sending; throws if process not found
    process.kill(record.pid, 0);
    return false; // process exists
  } catch {
    return true; // ESRCH: process does not exist
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
  } catch {
    throw new BrokerLockError('lock_io_error', 'Cannot read existing lock file');
  }

  if (!(await isLockStale(existing))) {
    throw new BrokerLockError('lock_held', `Broker already running (pid ${existing.pid}, mode: ${existing.mode})`);
  }

  // Owner is dead — safe to remove and retake
  try {
    await rm(path, { force: true });
  } catch {
    throw new BrokerLockError('stale_lock_removal_failed', 'Cannot remove stale lock file');
  }

  const handle = await open(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
  await handle.writeFile(JSON.stringify(record));
  await handle.close();
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
