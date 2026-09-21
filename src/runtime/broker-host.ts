import { spawn, type ChildProcess } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BrokerError } from './broker-errors.js';
import { acquireBrokerLock, releaseBrokerLock } from './broker-lock.js';
import { brokerEndpoint } from './broker-endpoint.js';

/** Typed error returned when broker binary is not installed. */
export class BrokerUnavailableError extends BrokerError {
  constructor(reason: string) {
    super('endpoint_unsafe');
    this.message = `Broker unavailable: ${reason}`;
    this.name = 'BrokerUnavailableError';
  }
}

export type BrokerHostMode = 'serve' | 'session';

export interface BrokerHostOptions {
  projectId: string;
  mode: BrokerHostMode;
  /** Override runtime root dir (for tests). */
  rootDir?: string;
  /** Path to compiled broker binary. Defaults to resolved package binary. */
  binaryPath?: string;
}

/** Resolve the expected path of the compiled northstar-broker binary. */
export function resolveBrokerBinaryPath(): string {
  // Binary lives at the package root's bin/ after build
  const pkgRoot = join(fileURLToPath(import.meta.url), '..', '..', '..', '..');
  return join(pkgRoot, 'bin', 'northstar-broker');
}

/**
 * Start the broker host.
 *
 * Two modes:
 * - 'serve': foreground, attached to calling process. For `northstar broker serve` CLI.
 * - 'session': Pi-session-owned. Terminates when Pi session exits.
 *
 * In both modes:
 * - Acquires single-owner advisory lock before spawn. Fails closed if lock is held.
 * - Binary must exist on disk. Fails with BrokerUnavailableError if missing.
 * - NEVER auto-spawns from ordinary CLI commands or model-triggered paths.
 *   Only call from explicit user-invoked serve command or Pi session startup code.
 * - Returns when the broker process exits (foreground: after signal; session: after Pi teardown).
 */
export async function startBrokerHost(options: BrokerHostOptions): Promise<void> {
  const { projectId, mode, rootDir, binaryPath } = options;
  const binary = binaryPath ?? resolveBrokerBinaryPath();

  // Verify binary exists
  const { access } = await import('node:fs/promises');
  try {
    await access(binary);
  } catch {
    throw new BrokerUnavailableError(`Binary not found at ${binary}. Install northstar-worker-service to enable stateful commands.`);
  }

  // Acquire single-owner lock
  await acquireBrokerLock(projectId, mode, rootDir);

  const endpoint = brokerEndpoint(projectId, rootDir);
  let child: ChildProcess | undefined;

  const cleanup = async (): Promise<void> => {
    child?.kill('SIGTERM');
    await releaseBrokerLock(projectId, rootDir);
  };

  process.once('SIGTERM', () => { void cleanup(); });
  process.once('SIGINT', () => { void cleanup(); });

  try {
    child = spawn(binary, ['--project-id', projectId, '--socket', endpoint.socketPath], {
      stdio: mode === 'serve' ? 'inherit' : 'pipe',
      detached: false, // never detach
    });

    await new Promise<void>((resolve, reject) => {
      child!.once('exit', (code, signal) => {
        if (code === 0 || signal === 'SIGTERM' || signal === 'SIGINT') {
          resolve();
        } else {
          const err = new BrokerError('transport_closed');
          err.message = `Broker exited with code ${code ?? signal}`;
          reject(err);
        }
      });
      child!.once('error', reject);
    });
  } finally {
    await cleanup();
  }
}

/**
 * Connect-only path: returns true if a healthy broker is already running for this project.
 * CLI commands use this before any stateful operation. They NEVER spawn a new broker.
 */
export async function probeExistingBroker(projectId: string, rootDir?: string): Promise<boolean> {
  const { lstat } = await import('node:fs/promises');
  const endpoint = brokerEndpoint(projectId, rootDir);
  try {
    const info = await lstat(endpoint.socketPath);
    return info.isSocket();
  } catch {
    return false;
  }
}
