import { chmod, lstat, mkdir, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { BrokerError } from './broker-errors.js';

export interface BrokerEndpoint { rootDir: string; socketPath: string; }
export function brokerEndpoint(projectId: string, root = process.env.NORTHSTAR_RUNTIME_DIR ?? join(homedir(), '.northstar', 'runtime')): BrokerEndpoint {
  if (!/^[A-Za-z0-9._-]{1,96}$/.test(projectId)) throw new BrokerError('endpoint_unsafe');
  const rootDir = join(root, projectId);
  return { rootDir, socketPath: process.platform === 'win32' ? `\\\\.\\pipe\\northstar-${projectId}` : join(rootDir, 'broker.sock') };
}
export async function ensureOwnerOnlyDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 }); await chmod(path, 0o700); await assertOwner(path, true);
}
export async function assertOwner(path: string, directory = false): Promise<void> {
  const info = await lstat(path).catch(() => { throw new BrokerError('endpoint_unsafe'); });
  if (info.isSymbolicLink()) throw new BrokerError('endpoint_unsafe');
  if (process.platform !== 'win32' && info.uid !== process.getuid?.()) throw new BrokerError('endpoint_unsafe');
  if (process.platform !== 'win32' && (info.mode & 0o077) !== 0) throw new BrokerError('endpoint_unsafe');
  if (directory && !info.isDirectory()) throw new BrokerError('endpoint_unsafe');
}
/** Remove stale endpoint only after parent/endpoint lstat ownership proof; symlinks are never removed. */
export async function removeStaleEndpoint(endpoint: BrokerEndpoint): Promise<boolean> {
  await assertOwner(endpoint.rootDir, true);
  const info = await lstat(endpoint.socketPath).catch(() => undefined);
  if (!info) return false;
  if (info.isSymbolicLink() || (!info.isSocket() && process.platform !== 'win32')) return false;
  if (process.platform !== 'win32' && (info.uid !== process.getuid?.() || (info.mode & 0o077) !== 0)) return false;
  await rm(endpoint.socketPath, { force: true }); return true;
}
export function defaultRuntimeRoot(): string { return process.env.NORTHSTAR_RUNTIME_DIR ?? join(homedir(), '.northstar', 'runtime'); }
