import { spawn as realSpawn, type ChildProcess } from 'node:child_process';
import { createServer as realCreateServer } from 'node:net';
import { dirname, join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { buildPythonChildEnvironment } from './python-child-env.js';

const DEFAULT_PYTHON_PATH = 'python3';
// Package-root resolution (no cwd dependence): src/sidecar-manager.ts lives
// one level below the package root, next to sidecar/app.py.
const DEFAULT_SCRIPT_PATH = join(dirname(fileURLToPath(import.meta.url)), '..', 'sidecar', 'app.py');
const DEFAULT_MODEL = 'all-MiniLM-L6-v2';
const DEFAULT_STARTUP_TIMEOUT_MS = 60_000;
const PORT_LINE_TIMEOUT_MS = 10_000;
const HEALTH_POLL_INTERVAL_MS = 500;
const SIGKILL_AFTER_MS = 5_000;
const MAX_CONSECUTIVE_FAILURES = 5;
const DEFAULT_INITIAL_BACKOFF_MS = 1_000;
const DEFAULT_MAX_BACKOFF_MS = 30_000;

export interface SidecarManagerOptions {
  scriptPath?: string;
  pythonPath?: string;
  model?: string;
  device?: string;
  startupTimeout?: number;
  /** @internal Testing hook: initial backoff delay in ms */
  initialBackoffMs?: number;
  /** @internal Testing hook: max backoff delay in ms */
  maxBackoffMs?: number;
  /** @internal Testing hook: custom spawn function */
  _spawn?: typeof realSpawn;
  /** @internal Testing hook: custom createServer function */
  _createServer?: typeof realCreateServer;
}

export type SidecarStatus = 'stopped' | 'starting' | 'running' | 'error';

export interface SidecarHealth {
  status: SidecarStatus;
  port?: number;
  error?: string;
}

export class SidecarManager {
  // Internal-only full options shape so Required<> doesn't force _spawn / _createServer
  private readonly options: {
    scriptPath: string;
    pythonPath: string;
    model: string;
    device: string;
    startupTimeout: number;
    initialBackoffMs: number;
    maxBackoffMs: number;
  };
  private readonly _spawn: typeof realSpawn;
  private readonly _createServer: typeof realCreateServer;
  private _status: SidecarStatus = 'stopped';
  private _port: number | undefined;
  private _error: string | undefined;
  private process: ChildProcess | undefined;
  private consecutiveFailures = 0;
  private backoffTimer: ReturnType<typeof setTimeout> | undefined;
  private _startPromise: Promise<void> | undefined;
  private killTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(options?: SidecarManagerOptions) {
    this.options = {
      scriptPath: options?.scriptPath ?? DEFAULT_SCRIPT_PATH,
      pythonPath: options?.pythonPath ?? DEFAULT_PYTHON_PATH,
      model: options?.model ?? DEFAULT_MODEL,
      device: options?.device ?? '',
      startupTimeout: options?.startupTimeout ?? DEFAULT_STARTUP_TIMEOUT_MS,
      initialBackoffMs: options?.initialBackoffMs ?? DEFAULT_INITIAL_BACKOFF_MS,
      maxBackoffMs: options?.maxBackoffMs ?? DEFAULT_MAX_BACKOFF_MS,
    };
    this._spawn = options?._spawn ?? realSpawn;
    this._createServer = options?._createServer ?? realCreateServer;
  }

  async start(): Promise<void> {
    // If already running, no-op
    if (this._status === 'running') return;
    // Coalesce concurrent start calls
    if (this._status === 'starting' && this._startPromise) return this._startPromise;

    // Cancel any pending restart
    clearTimeout(this.backoffTimer);
    this.backoffTimer = undefined;

    // If there's a stale process from a previous attempt that never exited, clean it
    if (this.process) {
      try { this.process.kill('SIGKILL'); } catch { /* ignore */ }
      this.process = undefined;
    }

    // Set status BEFORE any awaits so ensureRunning() sees 'starting' immediately
    this._status = 'starting';
    this._error = undefined;

    this._startPromise = (async (): Promise<void> => {
      // Capture the promise reference for cleanup
      const currentPromise = this._startPromise;
      try {
        const port = await this.getRandomPort();
        this._port = port;

        const args = [
          this.options.scriptPath,
          '--port',
          String(port),
          '--model',
          this.options.model,
        ];
        if (this.options.device) {
          args.push('--device', this.options.device);
        }

        const child = this._spawn(this.options.pythonPath, args, {
          stdio: ['pipe', 'pipe', 'inherit'],
          env: buildPythonChildEnvironment(),
        });
        this.process = child;

        // Listen for unexpected exit from the very start
        child.on('exit', (code, signal) => {
          if (this.process === child) {
            this.handleExit(code, signal);
          }
        });

        // Set up port-line listener BEFORE the spawn-error check so stdout
        // data emitted on a later tick is not missed.
        const portLinePromise = this.waitForPortLine(child, port);

        // Catch spawn errors (ENOENT, etc.) — setImmediate pattern from cdp.ts
        const spawnError = await new Promise<Error | null>((resolve) => {
          child.on('error', resolve);
          setImmediate(() => resolve(null));
        });
        if (spawnError) {
          this.process = undefined;
          this._status = 'error';
          this._error = spawnError.message;
          // The port-line promise will be rejected by its own timeout or the
          // exit handler; we ignore the rejection since we're already failing.
          portLinePromise.catch(() => {});
          throw spawnError;
        }

        // Parse SIDECAR_PORT=<port> line from stdout
        await portLinePromise;

        // Poll /v1/health until ok
        await this.pollHealth(port);

        // Success
        this._status = 'running';
      } catch (err) {
        // Ensure status reflects failure (pollHealth already sets error;
        // other failures like getRandomPort or waitForPortLine do not).
        if (this._status !== 'error') {
          this._status = 'error';
        }
        if (!this._error) {
          this._error = err instanceof Error ? err.message : String(err);
        }
        // Kill the child process to avoid orphan processes on startup failure
        if (this.process) {
          try { this.process.kill('SIGKILL'); } catch { /* ignore */ }
          this.process = undefined;
        }
        throw err;
      } finally {
        if (this._startPromise === currentPromise) {
          this._startPromise = undefined;
        }
      }
    })();
    // Suppress unhandled rejection: errors propagate via return value and are handled by caller
    this._startPromise.catch(() => {});
    return this._startPromise;
  }

  private async waitForPortLine(child: ChildProcess, expectedPort: number): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`Timed out after ${PORT_LINE_TIMEOUT_MS}ms waiting for SIDECAR_PORT from sidecar process`));
      }, PORT_LINE_TIMEOUT_MS);

      let buffer = '';
      const onData = (chunk: Buffer) => {
        buffer += chunk.toString();
        const match = buffer.match(/SIDECAR_PORT=(\d+)/);
        if (match) {
          const parsed = parseInt(match[1]!, 10);
          if (parsed !== expectedPort) {
            clearTimeout(timer);
            reject(new Error(`Port mismatch: expected ${expectedPort}, got ${parsed}`));
            return;
          }
          clearTimeout(timer);
          resolve();
        }
      };

      if (child.stdout) {
        child.stdout.on('data', onData);
        child.stdout.once('error', (err) => {
          clearTimeout(timer);
          reject(err);
        });
      } else {
        clearTimeout(timer);
        reject(new Error('Sidecar process stdout unavailable'));
      }

      // If the process exits before printing the port line, reject
      child.once('exit', () => {
        clearTimeout(timer);
        reject(new Error('Sidecar process exited before printing SIDECAR_PORT'));
      });
    });
  }

  private async pollHealth(port: number): Promise<void> {
    const timeout = this.options.startupTimeout;
    const deadline = Date.now() + timeout;
    const baseUrl = `http://127.0.0.1:${port}`;
    let lastError: string | undefined;

    while (Date.now() < deadline) {
      // If process exited during polling, abort
      if (!this.process) {
        throw new Error(this._error ?? 'Sidecar process exited during startup');
      }

      try {
        const remaining = deadline - Date.now();
        if (remaining <= 0) break;
        const controller = new AbortController();
        const fetchTimer = setTimeout(() => controller.abort(), remaining);
        try {
          const response = await fetch(`${baseUrl}/v1/health`, { signal: controller.signal });
          if (response.ok) {
            const data = (await response.json()) as { status: string };
            if (data.status === 'ok') {
              return;
            }
          }
        } finally {
          clearTimeout(fetchTimer);
        }
      } catch (err) {
        lastError = err instanceof Error ? err.message : String(err);
      }

      await sleep(HEALTH_POLL_INTERVAL_MS);
    }

    // Timeout — set to 'error' before throw so the catch block sees it
    this._status = 'error';
    this._error = `Startup timed out after ${timeout}ms. Last health-check error: ${lastError ?? 'none'}`;
    throw new Error(this._error);
  }

  private handleExit(_code: number | null, _signal: string | null): void {
    // Clear process reference
    this.process = undefined;

    // If stop() was called, don't restart
    if (this._status === 'stopped') return;

    this.consecutiveFailures++;

    if (this.consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
      this._status = 'error';
      this._error = `Sidecar process crashed ${this.consecutiveFailures} consecutive times; giving up`;
      return;
    }

    // Exponential backoff: 1s, 2s, 4s, 8s, ... capped at 30s
    const delay = Math.min(
      this.options.initialBackoffMs * 2 ** (this.consecutiveFailures - 1),
      this.options.maxBackoffMs,
    );

    this._status = 'starting';
    this._startPromise = undefined; // Clear so start() creates a fresh attempt
    this.backoffTimer = setTimeout(() => {
      this.start().catch(() => {
        // Errors already captured in instance state by start()
      });
    }, delay);
  }

  async ensureRunning(): Promise<void> {
    // If external sidecar URL is configured, just health-check it
    const externalUrl = process.env.EMBEDDING_SIDECAR_BASE_URL;
    if (externalUrl) {
      try {
        const headers: Record<string, string> = {};
        const apiToken = process.env.EMBEDDING_SIDECAR_API_TOKEN;
        if (apiToken) headers.Authorization = `Bearer ${apiToken}`;
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 10_000);
        let response;
        try {
          response = await fetch(`${externalUrl}/v1/health`, { headers, signal: controller.signal });
        } finally {
          clearTimeout(timer);
        }
        if (response.ok) {
          const data = await response.json() as { status?: string };
          if (data.status === 'ok') {
            this._status = 'running';
            return;
          }
          throw new Error(`External embedding sidecar at ${externalUrl} returned status: ${data.status ?? 'unknown'}`);
        }
        throw new Error(`External embedding sidecar at ${externalUrl} returned HTTP ${response.status}`);
      } catch (err) {
        throw new Error(`External embedding sidecar at ${externalUrl} is unreachable: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    if (this._status === 'running') return;

    if (this._status === 'starting') {
      // Wait for startup to finish
      while (this._status === 'starting') {
        await sleep(100);
      }
      if (this._status !== 'running') {
        throw new Error(this._error ?? 'Sidecar failed to reach running state');
      }
      return;
    }

    // stopped or error
    await this.start();
  }

  health(): SidecarHealth {
    // Spread optional fields to satisfy exactOptionalPropertyTypes
    return {
      status: this._status,
      ...(this._port !== undefined ? { port: this._port } : {}),
      ...(this._error !== undefined ? { error: this._error } : {}),
    };
  }

  getBaseUrl(): string {
    // If external sidecar URL is configured, use it
    const externalUrl = process.env.EMBEDDING_SIDECAR_BASE_URL;
    if (externalUrl) return externalUrl.replace(/\/$/, '');

    if (!this._port) {
      throw new Error('Sidecar not started; no port assigned');
    }
    return `http://127.0.0.1:${this._port}`;
  }

  private async getRandomPort(): Promise<number> {
    return new Promise<number>((resolve, reject) => {
      const server = this._createServer();
      server.on('error', reject);
      server.listen(0, () => {
        const addr = server.address();
        if (!addr || typeof addr === 'string') {
          server.close(() => reject(new Error('Failed to determine random port')));
          return;
        }
        const port = addr.port;
        server.close(() => resolve(port));
      });
    });
  }

  async stop(): Promise<void> {
    this._status = 'stopped';
    this.consecutiveFailures = 0;

    clearTimeout(this.backoffTimer);
    this.backoffTimer = undefined;

    const child = this.process;
    if (!child) {
      this._port = undefined;
      return;
    }

    this.process = undefined;

    // Remove the exit handler we added in start() to prevent restart logic
    child.removeAllListeners('exit');

    // SIGTERM → SIGKILL after 5s (pattern from cli-backend.ts / reach-tools.ts)
    child.kill('SIGTERM');
    this.killTimer = setTimeout(() => {
      try {
        child.kill('SIGKILL');
      } catch {
        /* Already dead */
      }
    }, SIGKILL_AFTER_MS);

    // Wait for process to exit
    await new Promise<void>((resolve) => {
      let safetyTimer: ReturnType<typeof setTimeout>;
      const done = () => {
        clearTimeout(this.killTimer);
        this.killTimer = undefined;
        clearTimeout(safetyTimer);
        resolve();
      };
      child.once('exit', done);

      // Safety net: resolve after SIGKILL grace period
      safetyTimer = setTimeout(done, SIGKILL_AFTER_MS + 1_000);
    });

    this._port = undefined;
  }
}


