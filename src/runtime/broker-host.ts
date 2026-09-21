import { spawn, type ChildProcess } from 'node:child_process';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { chmod, unlink, writeFile } from 'node:fs/promises';
import { createServer, type Server, type Socket } from 'node:net';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BrokerError } from './broker-errors.js';
import { acquireBrokerLock, releaseBrokerLock } from './broker-lock.js';
import { brokerEndpoint } from './broker-endpoint.js';
import { BROKER_MAX_FRAME_BYTES } from './broker-protocol.js';
import type { LeafRuntimeClient } from './leaf-runtime-client.js';
import {
  type RuntimeRpcV1Request,
  validateReply,
  validateRequest,
} from './runtime-rpc-protocol.js';

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
  /** Optional LeafRuntimeClient for upstream leaf-runtime requests. */
  leafClient?: LeafRuntimeClient;
}

export interface ExecutorListenerOptions {
  socketPath: string;
  tokenPath: string;
  token: Buffer;
  leafClient?: LeafRuntimeClient | undefined;
}

/**
 * ExecutorListener: owner-only Unix socket listener for executor RPC composition.
 *
 * Protocol version: executorProtocol:1
 * Wire format: length-prefixed JSON frames (4-byte BE length + UTF-8 body, capped at 256KiB).
 *
 * Security invariants:
 * - Unix socket bound with owner-only (0600) permissions inside owner-only (0700) project runtime dir.
 * - Defense in depth alongside Rust-side UID attestation:
 *   Node lacks a cross-platform LOCAL_PEERPID / LOCAL_PEERCRED API, so TS side pairs:
 *   (a) Single-use 32-byte CSPRNG token file (0600, unlinked after first successful auth).
 *       Token never appears in argv/ps (file path only, deleted after first use).
 *   (b) Accepts only the FIRST connection while expecting the child.
 *   If first connection presents wrong/missing token -> destroy socket, close listener,
 *   and fail closed before serving.
 */
export class ExecutorListener {
  private server: Server | undefined;
  private activeSocket: Socket | undefined;
  private readonly socketPath: string;
  private readonly tokenPath: string;
  private readonly token: Buffer;
  private readonly leafClient: LeafRuntimeClient | undefined;
  private acceptedFirst = false;
  private authenticated = false;

  constructor(options: ExecutorListenerOptions) {
    this.socketPath = options.socketPath;
    this.tokenPath = options.tokenPath;
    this.token = Buffer.from(options.token);
    this.leafClient = options.leafClient;
  }

  /** Start listening on the Unix socket. */
  async listen(): Promise<void> {
    // Clean up any stale socket path first
    try {
      await unlink(this.socketPath);
    } catch {
      // ignore if not present
    }

    this.server = createServer((socket) => {
      this.handleConnection(socket);
    });

    await new Promise<void>((resolve, reject) => {
      this.server!.once('error', reject);
      this.server!.listen(this.socketPath, () => {
        this.server!.removeListener('error', reject);
        resolve();
      });
    });

    // Ensure socket file has 0600 permissions
    try {
      await chmod(this.socketPath, 0o600);
    } catch {
      // Ignore chmod errors on systems that do not support socket chmod
    }
  }

  private handleConnection(socket: Socket): void {
    // Rule (b): accept only the FIRST connection while expecting the child.
    if (this.acceptedFirst) {
      socket.destroy();
      return;
    }
    this.acceptedFirst = true;
    this.activeSocket = socket;

    // Close the server listener so no subsequent connections can connect
    if (this.server) {
      this.server.close();
      this.server = undefined;
    }

    let rxBuf = Buffer.alloc(0);

    socket.on('data', (chunk: Buffer) => {
      rxBuf = Buffer.concat([rxBuf, chunk]);

      while (rxBuf.length >= 4) {
        const frameLen = rxBuf.readUInt32BE(0);
        if (frameLen > BROKER_MAX_FRAME_BYTES) {
          socket.destroy();
          return;
        }
        if (rxBuf.length < 4 + frameLen) {
          break;
        }
        const frameBody = rxBuf.subarray(4, 4 + frameLen);
        rxBuf = rxBuf.subarray(4 + frameLen);
        this.handleFrame(socket, frameBody);
      }
    });

    socket.once('error', () => {
      socket.destroy();
    });
  }

  private handleFrame(socket: Socket, frameBody: Buffer): void {
    // If not yet authenticated, first frame MUST be the token authentication frame
    if (!this.authenticated) {
      let authPayload: unknown;
      try {
        authPayload = JSON.parse(frameBody.toString('utf8'));
      } catch {
        socket.destroy();
        return;
      }

      const presentedTokenStr =
        typeof authPayload === 'object' && authPayload !== null && 'token' in authPayload
          ? (authPayload as { token: unknown }).token
          : typeof authPayload === 'string'
            ? authPayload
            : undefined;

      if (typeof presentedTokenStr !== 'string') {
        socket.destroy();
        return;
      }

      const presentedToken = Buffer.from(presentedTokenStr, 'utf8');
      if (
        presentedToken.length !== this.token.length ||
        !timingSafeEqual(presentedToken, this.token)
      ) {
        socket.destroy();
        return;
      }

      this.authenticated = true;
      // Unlink token file immediately after first successful auth
      unlink(this.tokenPath).catch(() => {});
      return;
    }

    // Authenticated: serving length-prefixed JSON frames
    let parsed: unknown;
    try {
      parsed = JSON.parse(frameBody.toString('utf8'));
    } catch {
      socket.destroy();
      return;
    }

    const validatedReq = validateRequest(parsed);
    if (!validatedReq.ok) {
      socket.destroy();
      return;
    }

    const req = validatedReq.value;
    this.executeRequest(req)
      .then((reply) => {
        const validatedReply = validateReply(reply, req.requestId, req.method);
        if (!validatedReply.ok) {
          socket.destroy();
          return;
        }
        const replyJson = Buffer.from(JSON.stringify(validatedReply.value), 'utf8');
        if (replyJson.length > BROKER_MAX_FRAME_BYTES) {
          socket.destroy();
          return;
        }
        const out = Buffer.allocUnsafe(4 + replyJson.length);
        out.writeUInt32BE(replyJson.length, 0);
        replyJson.copy(out, 4);
        socket.write(out);
      })
      .catch(() => {
        socket.destroy();
      });
  }

  private async executeRequest(req: RuntimeRpcV1Request): Promise<unknown> {
    if (!this.leafClient) {
      return {
        version: 1,
        requestId: req.requestId,
        method: req.method,
        success: false,
        error: {
          code: 'runtime_unavailable',
          message: 'Leaf runtime client not configured on executor',
        },
      };
    }
    try {
      const data = await this.leafClient.request(req.method, req.params as Record<string, unknown>);
      return {
        version: 1,
        requestId: req.requestId,
        method: req.method,
        success: true,
        data,
      };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return {
        version: 1,
        requestId: req.requestId,
        method: req.method,
        success: false,
        error: {
          code: 'runtime_unavailable',
          message: msg,
        },
      };
    }
  }

  /** Close listener and active connection, unlinking socket and token files. */
  async close(): Promise<void> {
    if (this.activeSocket && !this.activeSocket.destroyed) {
      this.activeSocket.destroy();
      this.activeSocket = undefined;
    }
    if (this.server) {
      await new Promise<void>((resolve) => {
        this.server!.close(() => resolve());
      });
      this.server = undefined;
    }
    try {
      await unlink(this.socketPath);
    } catch {}
    try {
      await unlink(this.tokenPath);
    } catch {}
  }
}

/** Resolve the expected path of the compiled northstar-broker binary. */
export function resolveBrokerBinaryPath(): string {
  // Binary lives at the package root's bin/ after build
  const pkgRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
  const binaryName = process.platform === 'win32' ? 'northstar-broker.exe' : 'northstar-broker';
  return join(pkgRoot, 'bin', binaryName);
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

  // Setup executor listener and single-use token file inside the owner-only project runtime dir
  const executorSocketPath = process.platform === 'win32' ? `\\\\.\\pipe\\northstar-${projectId}-executor` : join(endpoint.rootDir, 'executor.sock');
  const executorTokenPath = join(endpoint.rootDir, 'executor.token');
  const executorToken = randomBytes(32);

  let executorListener: ExecutorListener | undefined;
  try {
    // Write 0600 token file before listener or child spawn
    await writeFile(executorTokenPath, executorToken.toString('hex'), { mode: 0o600 });

    executorListener = new ExecutorListener({
      socketPath: executorSocketPath,
      tokenPath: executorTokenPath,
      token: Buffer.from(executorToken.toString('hex'), 'utf8'),
      leafClient: options.leafClient,
    });

    await executorListener.listen();
  } catch (err) {
    // If listener setup fails -> fail closed BEFORE spawn
    if (executorListener) {
      await executorListener.close().catch(() => {});
    }
    try {
      await unlink(executorTokenPath);
    } catch {}
    await releaseBrokerLock(projectId, rootDir);
    throw err instanceof BrokerError ? err : new BrokerUnavailableError('Failed to initialize executor listener: ' + String(err));
  }

  const cleanup = async (): Promise<void> => {
    child?.kill('SIGTERM');
    await executorListener?.close();
    await releaseBrokerLock(projectId, rootDir);
  };

  process.once('SIGTERM', () => { void cleanup(); });
  process.once('SIGINT', () => { void cleanup(); });

  const childArgs = [
    '--project-id',
    projectId,
    '--socket',
    endpoint.socketPath,
    '--executor-socket',
    executorSocketPath,
    '--executor-token-file',
    executorTokenPath,
  ];

  try {
    child = spawn(binary, childArgs, {
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
  const endpoint = brokerEndpoint(projectId, rootDir);
  if (process.platform === 'win32') {
    const { connect } = await import('node:net');
    return new Promise<boolean>((resolve) => {
      const socket = connect(endpoint.socketPath);
      socket.once('connect', () => { socket.destroy(); resolve(true); });
      socket.once('error', () => { socket.destroy(); resolve(false); });
    });
  }
  const { lstat } = await import('node:fs/promises');
  try {
    const info = await lstat(endpoint.socketPath);
    return info.isSocket();
  } catch {
    return false;
  }
}
