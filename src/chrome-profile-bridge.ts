// Chrome profile loopback bridge (Worker 2).
//
// Pi-side HTTP transport for the authorized user-Chrome path. Consumes Worker 1
// contract/auth vocabulary only: no browser-policy, network-policy, adapter, or
// companion imports. No runtime dependencies beyond Node built-ins.
//
// Topology: Pi serves HTTP bound to literal 127.0.0.1:17319 (never pi-chrome
// 17318). The companion extension long-polls GET /next and completes work via
// POST /result. The Pi-local adapter enqueues via ChromeBridgeClient which
// POSTs /command with no browser headers.
//
// Security rules enforced here:
// - Bind host fixed literal 127.0.0.1; no bind-host override exists.
// - POST /command accepts only headerless local callers: any `Origin` or
//   `Sec-Fetch-Site` header is rejected. Browser fetches always carry one.
// - GET /next and POST /result accept only the pinned extension origin
//   `chrome-extension://<manifest-id>` (exact match).
// - Request/result byte caps; oversize rejected without echoing the body.
// - Unknown protocol/version fails closed.
// - Foreign-protocol port occupant reports conflict; never forwards blindly.
// - EADDRINUSE sharing allowed only after a successful protocol handshake.
// - No request/response body is ever logged. Error messages never echo bodies,
//   session keys, or grant ids.
// - Revoke purges queues first; late results are withheld, never resolved as
//   success-after-revoke.

import { randomUUID, timingSafeEqual } from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  CHROME_BRIDGE_INSTANCE_STALE_MS,
  CHROME_BRIDGE_MAX_REQUEST_BYTES,
  CHROME_BRIDGE_MAX_RESULT_BYTES,
  CHROME_BRIDGE_PORT,
  CHROME_BRIDGE_PROTOCOL,
  type ChromeBridgeCommand,
  type ChromeBridgeInstanceInfo,
  type ChromeBridgeResult,
  type ChromeProfileErrorCode,
  parseChromeBridgeCommand,
  parseChromeBridgeResult,
} from './chrome-profile-contract.js';

export { CHROME_BRIDGE_INSTANCE_STALE_MS, type ChromeBridgeInstanceInfo } from './chrome-profile-contract.js';

/** Literal loopback bind host. No override is offered by design. */
export const CHROME_BRIDGE_HOST = '127.0.0.1';

export const CHROME_BRIDGE_HEALTH_PATH = '/health';
export const CHROME_BRIDGE_COMMAND_PATH = '/command';
export const CHROME_BRIDGE_NEXT_PATH = '/next';
export const CHROME_BRIDGE_RESULT_PATH = '/result';
export const CHROME_BRIDGE_REGISTER_PATH = '/register';

export const CHROME_BRIDGE_DEFAULT_COMMAND_TIMEOUT_MS = 60_000;
export const CHROME_BRIDGE_DEFAULT_NEXT_WAIT_MS = 30_000;
export const CHROME_BRIDGE_MAX_NEXT_WAIT_MS = 60_000;
export const CHROME_BRIDGE_DEFAULT_HANDSHAKE_TIMEOUT_MS = 2_000;
export const CHROME_BRIDGE_INSTANCE_ID_MAX = 128;
export const CHROME_BRIDGE_CLAIM_MAX = 64;
export const CHROME_BRIDGE_CAPS_MAX = 256;

/** HTTP-level error envelope (transport rejections carry no command id). */
export interface ChromeBridgeHttpErrorBody {
  protocol: 1;
  ok: false;
  error: { code: ChromeProfileErrorCode; message: string; retryable: boolean };
}

export class ChromeBridgeError extends Error {
  readonly code: ChromeProfileErrorCode;
  readonly retryable: boolean;
  readonly status: number;
  constructor(code: ChromeProfileErrorCode, message: string, retryable = false, status = 400) {
    super(message);
    this.name = 'ChromeBridgeError';
    this.code = code;
    this.retryable = retryable;
    this.status = status;
  }
}

/** Port occupant speaks a foreign protocol; blind forwarding refused. */
export class ChromeBridgeConflictError extends ChromeBridgeError {
  constructor(message = 'bridge port occupied by foreign protocol') {
    super('chrome_extension_unavailable', message, false, 409);
    this.name = 'ChromeBridgeConflictError';
  }
}

/** Pinned extension origin for a manifest extension id. */
export function extensionOriginForId(extensionId: string): string {
  return `chrome-extension://${extensionId}`;
}

function header(headers: Record<string, string | string[] | undefined>, name: string): string | undefined {
  const value = headers[name];
  if (Array.isArray(value)) return value[0];
  return value;
}

/**
 * POST /command accepts Pi-local callers only. Browser-issued fetches always
 * carry Origin or Sec-Fetch-Site, so any presence fails closed.
 */
export function isLocalCommandAllowed(headers: Record<string, string | string[] | undefined>): boolean {
  const origin = header(headers, 'origin');
  const secFetchSite = header(headers, 'sec-fetch-site');
  if (origin !== undefined && origin !== '') return false;
  if (secFetchSite !== undefined && secFetchSite !== '') return false;
  return true;
}

/** GET /next and POST /result accept only the exact pinned extension origin.
 * Canonical poll is GET /next (long-poll); POST /next is rejected with 405. */
export function isExtensionRequestAllowed(
  headers: Record<string, string | string[] | undefined>,
  extensionOrigin: string,
): boolean {
  const origin = header(headers, 'origin');
  return origin === extensionOrigin;
}

function httpErrorBody(code: ChromeProfileErrorCode, message: string, retryable = false): ChromeBridgeHttpErrorBody {
  return { protocol: CHROME_BRIDGE_PROTOCOL, ok: false, error: { code, message, retryable } };
}

const INSTANCE_ID_PATTERN = /^[A-Za-z0-9_-]{8,128}$/;
const CLAIM_PATTERN = /^[A-Za-z0-9_.-]{1,64}$/;
const CAPS_PATTERN = /^[A-Za-z0-9_,.+-]{0,256}$/;
const VERSION_PATTERN = /^\d+\.\d+\.\d+$/;

export function parseBridgeInstanceClaim(value: unknown): { instanceId: string; family: string; version: string; caps: string } {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new ChromeBridgeError('chrome_invalid_request', 'invalid instance registration');
  }
  const record = value as Record<string, unknown>;
  if (record['protocol'] !== undefined && record['protocol'] !== CHROME_BRIDGE_PROTOCOL) {
    throw new ChromeBridgeError('chrome_version_mismatch', 'unsupported bridge protocol');
  }
  const instanceId = record['instanceId'];
  const family = record['family'];
  const version = record['version'];
  const caps = record['caps'] ?? '';
  if (typeof instanceId !== 'string' || !INSTANCE_ID_PATTERN.test(instanceId)) {
    throw new ChromeBridgeError('chrome_invalid_request', 'invalid instanceId');
  }
  if (typeof family !== 'string' || !CLAIM_PATTERN.test(family)) {
    throw new ChromeBridgeError('chrome_invalid_request', 'invalid instance family');
  }
  if (typeof version !== 'string' || !VERSION_PATTERN.test(version)) {
    throw new ChromeBridgeError('chrome_version_mismatch', 'unsupported instance version');
  }
  if (typeof caps !== 'string' || !CAPS_PATTERN.test(caps)) {
    throw new ChromeBridgeError('chrome_invalid_request', 'invalid instance caps');
  }
  return { instanceId, family: family.toLowerCase(), version, caps };
}

export function parseBridgeInstanceQuery(url: URL): { instanceId: string; family: string; version: string; caps: string } | null {
  const instanceId = url.searchParams.get('instanceId');
  if (instanceId === null || instanceId === '') return null;
  const protocol = url.searchParams.get('protocol');
  if (protocol !== null && protocol !== String(CHROME_BRIDGE_PROTOCOL)) {
    throw new ChromeBridgeError('chrome_version_mismatch', 'unsupported bridge protocol');
  }
  return parseBridgeInstanceClaim({
    instanceId,
    family: url.searchParams.get('family') ?? '',
    version: url.searchParams.get('version') ?? '',
    caps: url.searchParams.get('caps') ?? '',
  });
}

export interface ChromeBridgeServerOptions {
  /** Manifest extension id used to pin the allowed origin. Required. */
  extensionId: string;
  /** TCP port. Defaults to 17319. Host is always literal 127.0.0.1. */
  port?: number | undefined;
  commandTimeoutMs?: number | undefined;
  maxRequestBytes?: number | undefined;
  maxResultBytes?: number | undefined;
  handshakeTimeoutMs?: number | undefined;
  now?: (() => number) | undefined;
}

interface CommandWaiter {
  id: string;
  resolve: (result: ChromeBridgeResult) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
  settled: boolean;
}

interface NextWaiter {
  /** Poller instanceId when the poll carried a claim; null for anonymous polls. */
  instanceId: string | null;
  resolve: (command: ChromeBridgeCommand | null) => void;
  timer: NodeJS.Timeout;
  settled: boolean;
}

function readBody(req: http.IncomingMessage, maxBytes: number): Promise<{ ok: true; text: string } | { ok: false; tooLarge: boolean }> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let received = 0;
    let tooLarge = false;
    let done = false;
    const finish = (value: { ok: true; text: string } | { ok: false; tooLarge: boolean }): void => {
      if (done) return;
      done = true;
      resolve(value);
    };
    req.on('data', (chunk: Buffer) => {
      received += chunk.length;
      if (received > maxBytes + 8 * 1024 * 1024) {
        req.destroy();
        finish({ ok: false, tooLarge: true });
        return;
      }
      if (received > maxBytes) {
        tooLarge = true;
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (tooLarge) finish({ ok: false, tooLarge: true });
      else finish({ ok: true, text: Buffer.concat(chunks).toString('utf8') });
    });
    req.on('error', () => {
      finish({ ok: false, tooLarge: false });
    });
  });
}

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(text),
    'cache-control': 'no-store',
  });
  res.end(text);
}

/**
 * Probe whether the bridge port already serves our protocol. Resolves true
 * only when GET /health returns `{protocol:1, ok:true}`. Any other answer,
 * including foreign JSON or connection refusal, resolves false. Never sends
 * command payloads during the probe.
 */
export function probeBridgeHandshake(
  port: number = CHROME_BRIDGE_PORT,
  options?: { timeoutMs?: number | undefined; signal?: AbortSignal | undefined },
): Promise<boolean> {
  const timeoutMs = options?.timeoutMs ?? CHROME_BRIDGE_DEFAULT_HANDSHAKE_TIMEOUT_MS;
  return new Promise((resolve) => {
    if (options?.signal?.aborted === true) {
      resolve(false);
      return;
    }
    const req = http.request(
      {
        host: CHROME_BRIDGE_HOST,
        port,
        path: CHROME_BRIDGE_HEALTH_PATH,
        method: 'GET',
      },
      (res) => {
        const chunks: Buffer[] = [];
        let received = 0;
        res.on('data', (chunk: Buffer) => {
          received += chunk.length;
          if (received < 64 * 1024) chunks.push(chunk);
        });
        res.on('end', () => {
          try {
            const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>;
            resolve(body['protocol'] === CHROME_BRIDGE_PROTOCOL && body['ok'] === true);
          } catch {
            resolve(false);
          }
        });
        res.on('error', () => {
          resolve(false);
        });
      },
    );
    req.on('error', () => {
      resolve(false);
    });
    const timer = setTimeout(() => {
      req.destroy();
      resolve(false);
    }, timeoutMs);
    req.on('close', () => {
      clearTimeout(timer);
    });
    const onAbort = (): void => {
      req.destroy();
      resolve(false);
    };
    options?.signal?.addEventListener('abort', onAbort, { once: true });
    req.end();
  });
}

export class ChromeBridgeServer {
  private readonly extensionOrigin: string;
  private readonly port: number;
  private readonly commandTimeoutMs: number;
  private readonly maxRequestBytes: number;
  private readonly maxResultBytes: number;
  private readonly handshakeTimeoutMs: number;
  private server: http.Server | null = null;
  /** Per-instance command queues keyed by targetInstanceId: a command is only
   *  ever delivered to the poller whose claim matches its target. */
  private readonly queues = new Map<string, ChromeBridgeCommand[]>();
  private readonly waiters = new Map<string, CommandWaiter>();
  private readonly nextWaiters: NextWaiter[] = [];
  /** Ids revoked while a command was in flight; late results withheld. */
  private readonly revokedIds = new Set<string>();
  /**
   * Bound the withheld-result set: unknown ids stay withheld via the waiter
   * check, so dropping old entries cannot resolve a late result as success.
   */
  private trimRevokedIds(): void {
    if (this.revokedIds.size <= 2000) return;
    this.revokedIds.clear();
  }
  /** Registered companion instances keyed by ephemeral instanceId. */
  private readonly instances = new Map<string, ChromeBridgeInstanceInfo>();
  /** Session token minted at construction; every /command must carry it.
   *  Never logged, never echoed in errors. Shared with the companion via the
   *  origin-pinned /register response only. */
  private readonly sessionToken: string = randomUUID();
  private readonly now: () => number;
  private started = false;
  /** Port already served our protocol; this instance shares instead of binds. */
  private shared = false;

  constructor(options: ChromeBridgeServerOptions) {
    if (options.extensionId.length === 0) {
      throw new ChromeBridgeError('chrome_invalid_request', 'extensionId must be a non-empty string');
    }
    this.extensionOrigin = extensionOriginForId(options.extensionId);
    this.port = options.port ?? CHROME_BRIDGE_PORT;
    this.commandTimeoutMs = options.commandTimeoutMs ?? CHROME_BRIDGE_DEFAULT_COMMAND_TIMEOUT_MS;
    this.maxRequestBytes = options.maxRequestBytes ?? CHROME_BRIDGE_MAX_REQUEST_BYTES;
    this.maxResultBytes = options.maxResultBytes ?? CHROME_BRIDGE_MAX_RESULT_BYTES;
    this.handshakeTimeoutMs = options.handshakeTimeoutMs ?? CHROME_BRIDGE_DEFAULT_HANDSHAKE_TIMEOUT_MS;
    this.now = options.now ?? Date.now;
  }

  get pinnedOrigin(): string {
    return this.extensionOrigin;
  }

  /** Session token the owning Pi session stamps on every command. */
  get bridgeToken(): string {
    return this.sessionToken;
  }

  get isShared(): boolean {
    return this.shared;
  }

  get pendingCommandCount(): number {
    let total = 0;
    for (const queue of this.queues.values()) total += queue.length;
    return total;
  }

  get pendingResultCount(): number {
    return this.waiters.size;
  }

  /** Upsert a companion instance claim; refreshes lastSeen heartbeat. */
  registerInstance(claim: { instanceId: string; family: string; version: string; caps: string }): ChromeBridgeInstanceInfo {
    const parsed = parseBridgeInstanceClaim(claim);
    const info: ChromeBridgeInstanceInfo = { ...parsed, lastSeen: this.now() };
    this.instances.set(parsed.instanceId, info);
    return { ...info };
  }

  /** Refresh heartbeat for a known instance; false when unknown. */
  heartbeat(instanceId: string): boolean {
    const existing = this.instances.get(instanceId);
    if (existing === undefined) return false;
    existing.lastSeen = this.now();
    return true;
  }

  /** Live instances within the staleness window (default 90s). */
  listInstances(now?: number): ChromeBridgeInstanceInfo[] {
    const at = now ?? this.now();
    const out: ChromeBridgeInstanceInfo[] = [];
    for (const info of this.instances.values()) {
      if (at - info.lastSeen <= CHROME_BRIDGE_INSTANCE_STALE_MS) out.push({ ...info });
    }
    return out;
  }

  get liveInstanceCount(): number {
    return this.listInstances().length;
  }

  /** True when >1 live instance claims the same family: callers fail closed. */
  hasFamilyConflict(family: string, now?: number): boolean {
    const at = now ?? this.now();
    let count = 0;
    for (const info of this.instances.values()) {
      if (at - info.lastSeen <= CHROME_BRIDGE_INSTANCE_STALE_MS && info.family === family.toLowerCase()) {
        count += 1;
        if (count > 1) return true;
      }
    }
    return false;
  }

  /** Drop instances older than the staleness window; returns evicted ids. */
  purgeStaleInstances(now?: number): string[] {
    const at = now ?? this.now();
    const evicted: string[] = [];
    for (const [id, info] of this.instances) {
      if (at - info.lastSeen > CHROME_BRIDGE_INSTANCE_STALE_MS) {
        this.instances.delete(id);
        evicted.push(id);
      }
    }
    return evicted;
  }

  /** Bind literal 127.0.0.1. On EADDRINUSE, share only after handshake. */
  async start(): Promise<void> {
    if (this.started) return;
    this.server = http.createServer((req, res) => {
      void this.handle(req, res);
    });
    try {
      const persistentError = (): void => {};
      this.server?.on('error', persistentError);
      await new Promise<void>((resolve, reject) => {
        this.server?.once('error', reject);
        this.server?.listen(this.port, CHROME_BRIDGE_HOST, () => {
          this.server?.removeListener('error', reject);
          resolve();
        });
      });
      this.started = true;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'EADDRINUSE') throw error;
      const ours = await probeBridgeHandshake(this.port, { timeoutMs: this.handshakeTimeoutMs });
      if (!ours) {
        try {
          this.server?.close();
        } catch {
          // Intentionally ignored: bind already failed.
        }
        this.server = null;
        throw new ChromeBridgeConflictError();
      }
      // Ours: share the existing bridge; this instance routes in-process only.
      this.shared = true;
      this.started = true;
      try {
        this.server?.close();
      } catch {
        // Intentionally ignored: nothing bound.
      }
      this.server = null;
    }
  }

  async stop(): Promise<void> {
    for (const waiter of this.waiters.values()) {
      if (!waiter.settled) {
        waiter.settled = true;
        clearTimeout(waiter.timer);
        waiter.reject(new ChromeBridgeError('chrome_revoked', 'bridge stopped', false, 503));
      }
    }
    this.waiters.clear();
    this.queues.clear();
    this.instances.clear();
    for (const next of this.nextWaiters.splice(0)) {
      if (!next.settled) {
        next.settled = true;
        clearTimeout(next.timer);
        next.resolve(null);
      }
    }
    this.started = false;
    this.shared = false;
    if (this.server !== null) {
      const server = this.server;
      this.server = null;
      await new Promise<void>((resolve) => {
        server.close(() => {
          resolve();
        });
      });
    }
  }

  /** Local address of the bound socket; null when sharing or stopped. */
  boundAddress(): { host: string; port: number } | null {
    const address = this.server?.address() as AddressInfo | null;
    if (!address || typeof address === 'string') return null;
    return { host: address.address, port: address.port };
  }

  /**
   * Revoke one in-flight or queued command. Queued entries drop; in-flight
   * waiters reject with chrome_revoked; late results for the id are withheld.
   */
  revokeCommand(id: string, code: ChromeProfileErrorCode = 'chrome_revoked'): void {
    this.revokedIds.add(id);
    this.trimRevokedIds();
    for (const [target, queue] of this.queues) {
      const queued = queue.findIndex((command) => command.id === id);
      if (queued >= 0) {
        queue.splice(queued, 1);
        if (queue.length === 0) this.queues.delete(target);
      }
    }
    const waiter = this.waiters.get(id);
    if (waiter !== undefined && !waiter.settled) {
      waiter.settled = true;
      clearTimeout(waiter.timer);
      this.waiters.delete(id);
      waiter.reject(new ChromeBridgeError(code, 'command revoked before completion', false, 409));
    }
  }

  /** Revoke everything: purge queue, reject waiters, withhold late results. */
  revokeAll(code: ChromeProfileErrorCode = 'chrome_revoked'): void {
    for (const queue of this.queues.values()) {
      for (const command of queue) {
        this.revokedIds.add(command.id);
      }
    }
    this.queues.clear();
    this.trimRevokedIds();
    for (const [id, waiter] of [...this.waiters]) {
      if (!waiter.settled) {
        waiter.settled = true;
        clearTimeout(waiter.timer);
        this.waiters.delete(id);
        this.revokedIds.add(id);
        waiter.reject(new ChromeBridgeError(code, 'command revoked before completion', false, 409));
      }
    }
  }

  /** Constant-time session-token comparison; never reveals which byte differed. */
  private checkBridgeToken(presented: string): boolean {
    const expected = Buffer.from(this.sessionToken, 'utf8');
    const actual = Buffer.from(presented, 'utf8');
    if (actual.length !== expected.length) return false;
    return timingSafeEqual(actual, expected);
  }
  /** True when a late result for id must be withheld (revoked or unknown). */
  isWithheld(id: string): boolean {
    return this.revokedIds.has(id) || !this.waiters.has(id);
  }

  private async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', `http://${CHROME_BRIDGE_HOST}`);
    const headers = req.headers as Record<string, string | string[] | undefined>;
    if (req.method === 'GET' && url.pathname === CHROME_BRIDGE_HEALTH_PATH) {
      sendJson(res, 200, { protocol: CHROME_BRIDGE_PROTOCOL, ok: true });
      return;
    }
    if (req.method === 'POST' && url.pathname === CHROME_BRIDGE_COMMAND_PATH) {
      await this.handleCommand(req, res, headers);
      return;
    }
    if (req.method === 'GET' && url.pathname === CHROME_BRIDGE_NEXT_PATH) {
      await this.handleNext(req, res, headers, url);
      return;
    }
    if (req.method === 'POST' && url.pathname === CHROME_BRIDGE_REGISTER_PATH) {
      await this.handleRegister(req, res, headers);
      return;
    }
    if (req.method === 'POST' && url.pathname === CHROME_BRIDGE_NEXT_PATH) {
      // Canonical poll is GET /next; POST /next is a client bug (legacy
      // companion). Reject explicitly so the mismatch surfaces, never routes.
      sendJson(res, 405, httpErrorBody('chrome_invalid_request', 'poll with GET /next'));
      return;
    }
    if (req.method === 'POST' && url.pathname === CHROME_BRIDGE_RESULT_PATH) {
      await this.handleResult(req, res, headers, url);
      return;
    }
    sendJson(res, 404, httpErrorBody('chrome_invalid_request', 'unknown bridge path'));
  }

  private async handleCommand(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    headers: Record<string, string | string[] | undefined>,
  ): Promise<void> {
    if (!isLocalCommandAllowed(headers)) {
      sendJson(res, 403, httpErrorBody('chrome_invalid_request', 'bridge command rejects browser origins'));
      return;
    }
    const body = await readBody(req, this.maxRequestBytes);
    if (!body.ok) {
      sendJson(
        res,
        413,
        httpErrorBody('chrome_invalid_request', body.tooLarge ? 'command exceeds byte cap' : 'command read failed'),
      );
      return;
    }
    let command: ChromeBridgeCommand;
    try {
      command = parseChromeBridgeCommand(JSON.parse(body.text) as unknown);
    } catch {
      // Never echo the body: it may carry grant material or typed values.
      sendJson(res, 400, httpErrorBody('chrome_invalid_request', 'invalid bridge command'));
      return;
    }
    if (this.revokedIds.has(command.id)) {
      sendJson(res, 409, httpErrorBody('chrome_revoked', 'command revoked before completion'));
      return;
    }
    if (this.waiters.has(command.id)) {
      sendJson(res, 409, httpErrorBody('chrome_invalid_request', 'duplicate command id'));
      return;
    }
    // Session token: any local process can reach loopback, so the token minted
    // at construction gates every command including authorize. Mismatch fails
    // closed without echoing the body (it may carry grant material).
    if (!this.checkBridgeToken(command.bridgeToken)) {
      sendJson(res, 403, httpErrorBody('chrome_invalid_request', 'bridge command rejected'));
      return;
    }
    // Per-instance targeting: commands bind to the selected companion only.
    // Unknown targets fail closed instead of landing in the wrong browser.
    if (!this.instances.has(command.targetInstanceId)) {
      sendJson(res, 409, httpErrorBody('chrome_extension_unavailable', 'unknown target companion instance'));
      return;
    }
    const outcome = await new Promise<ChromeBridgeResult>((resolve, reject) => {
      const timer = setTimeout(() => {
        const waiter = this.waiters.get(command.id);
        if (waiter === undefined || waiter.settled) return;
        waiter.settled = true;
        this.waiters.delete(command.id);
        const targetQueue = this.queues.get(command.targetInstanceId);
        if (targetQueue !== undefined) {
          const queued = targetQueue.findIndex((entry) => entry.id === command.id);
          if (queued >= 0) targetQueue.splice(queued, 1);
          if (targetQueue.length === 0) this.queues.delete(command.targetInstanceId);
        }
        this.revokedIds.add(command.id);
        this.trimRevokedIds();
        reject(new ChromeBridgeError('chrome_timeout', 'bridge command timed out', true, 504));
      }, this.commandTimeoutMs);
      const waiter: CommandWaiter = {
        id: command.id,
        resolve: (result) => {
          clearTimeout(timer);
          resolve(result);
        },
        reject,
        timer,
        settled: false,
      };
      this.waiters.set(command.id, waiter);
      this.enqueue(command);
      req.on('close', () => {
        const pending = this.waiters.get(command.id);
        if (pending !== undefined && !pending.settled && res.writableEnded === false) {
          pending.settled = true;
          clearTimeout(pending.timer);
          this.waiters.delete(command.id);
          const targetQueue = this.queues.get(command.targetInstanceId);
          if (targetQueue !== undefined) {
            const queued = targetQueue.findIndex((entry) => entry.id === command.id);
            if (queued >= 0) {
              targetQueue.splice(queued, 1);
              if (targetQueue.length === 0) this.queues.delete(command.targetInstanceId);
            }
          }
          pending.reject(new ChromeBridgeError('chrome_timeout', 'bridge command aborted', true, 499));
        }
      });
    }).then(
      (result) => ({ settled: true as const, result }),
      (error: unknown) => ({ settled: false as const, error }),
    );
    if (!outcome.settled) {
      const error = outcome.error as ChromeBridgeError;
      const status = error instanceof ChromeBridgeError ? error.status : 500;
      const code: ChromeProfileErrorCode =
        error instanceof ChromeBridgeError ? error.code : 'chrome_invalid_result';
      sendJson(res, status, httpErrorBody(code, error.message, error instanceof ChromeBridgeError && error.retryable));
      return;
    }
    const text = JSON.stringify(outcome.result);
    if (Buffer.byteLength(text) > this.maxResultBytes) {
      sendJson(res, 502, httpErrorBody('chrome_invalid_result', 'bridge result exceeds byte cap'));
      return;
    }
    sendJson(res, 200, outcome.result);
  }

  private enqueue(command: ChromeBridgeCommand): void {
    // Targeted delivery only: a long-polling companion receives commands
    // addressed to its own instanceId, never another family's grant.
    const index = this.nextWaiters.findIndex((next) => !next.settled && next.instanceId === command.targetInstanceId);
    if (index >= 0) {
      const next = this.nextWaiters.splice(index, 1)[0]!;
      next.settled = true;
      clearTimeout(next.timer);
      next.resolve(command);
      return;
    }
    const queue = this.queues.get(command.targetInstanceId) ?? [];
    queue.push(command);
    this.queues.set(command.targetInstanceId, queue);
  }

  private async handleRegister(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    headers: Record<string, string | string[] | undefined>,
  ): Promise<void> {
    if (!isExtensionRequestAllowed(headers, this.extensionOrigin)) {
      sendJson(res, 403, httpErrorBody('chrome_invalid_request', 'extension origin not allowed'));
      return;
    }
    const body = await readBody(req, this.maxRequestBytes);
    if (!body.ok) {
      sendJson(
        res,
        413,
        httpErrorBody('chrome_invalid_request', body.tooLarge ? 'registration exceeds byte cap' : 'registration read failed'),
      );
      return;
    }
    try {
      const claim = parseBridgeInstanceClaim(JSON.parse(body.text) as unknown);
      const info = this.registerInstance(claim);
      sendJson(res, 200, { protocol: CHROME_BRIDGE_PROTOCOL, ok: true, instanceId: info.instanceId, bridgeToken: this.sessionToken });
    } catch (error) {
      // Never echo the body: it carries instance claims, never grant secrets.
      if (error instanceof ChromeBridgeError) {
        sendJson(res, error.status, httpErrorBody(error.code, error.message, error.retryable));
        return;
      }
      sendJson(res, 400, httpErrorBody('chrome_invalid_request', 'invalid instance registration'));
    }
  }

  private async handleNext(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    headers: Record<string, string | string[] | undefined>,
    url: URL,
  ): Promise<void> {
    if (!isExtensionRequestAllowed(headers, this.extensionOrigin)) {
      sendJson(res, 403, httpErrorBody('chrome_invalid_request', 'extension origin not allowed'));
      return;
    }
    // Instance registration doubles as heartbeat: query claims upsert the
    // registry, so one port tracks many ephemeral companions. Claims are
    // anonymous (no poll when absent); strict when present. Never carry
    // sessionKey/grantId in poll query or body.
    let pollerId: string | null = null;
    try {
      const claim = parseBridgeInstanceQuery(url);
      if (claim !== null) {
        this.registerInstance(claim);
        pollerId = claim.instanceId;
      } else {
        const bare = url.searchParams.get('instanceId');
        if (bare !== null && bare !== '') pollerId = bare;
      }
    } catch (error) {
      if (error instanceof ChromeBridgeError) {
        sendJson(res, error.status, httpErrorBody(error.code, error.message, error.retryable));
        return;
      }
      sendJson(res, 400, httpErrorBody('chrome_invalid_request', 'invalid instance claim'));
      return;
    }
    // Targeted dequeue: this poller only receives commands addressed to its
    // own instanceId. Anonymous polls (no claim) receive nothing, never a
    // grant bound for another companion.
    if (pollerId !== null) {
      const targeted = this.queues.get(pollerId);
      const queued = targeted !== undefined ? targeted.shift() : undefined;
      if (targeted !== undefined && targeted.length === 0) this.queues.delete(pollerId);
      if (queued !== undefined) {
        sendJson(res, 200, queued);
        return;
      }
    }
    const requested = Number(url.searchParams.get('timeoutMs') ?? CHROME_BRIDGE_DEFAULT_NEXT_WAIT_MS);
    const waitMs = Number.isFinite(requested)
      ? Math.min(Math.max(Math.trunc(requested), 0), CHROME_BRIDGE_MAX_NEXT_WAIT_MS)
      : CHROME_BRIDGE_DEFAULT_NEXT_WAIT_MS;
    if (waitMs === 0) {
      res.writeHead(204);
      res.end();
      return;
    }
    const command = await new Promise<ChromeBridgeCommand | null>((resolve) => {
      const waiter: NextWaiter = {
        instanceId: pollerId,
        resolve,
        timer: setTimeout(() => {
          waiter.settled = true;
          resolve(null);
        }, waitMs),
        settled: false,
      };
      this.nextWaiters.push(waiter);
      req.on('close', () => {
        if (!waiter.settled) {
          waiter.settled = true;
          clearTimeout(waiter.timer);
          const index = this.nextWaiters.indexOf(waiter);
          if (index >= 0) this.nextWaiters.splice(index, 1);
          resolve(null);
        }
      });
    });
    if (command === null) {
      if (!res.writableEnded) {
        res.writeHead(204);
        res.end();
      }
      return;
    }
    sendJson(res, 200, command);
  }

  private async handleResult(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    headers: Record<string, string | string[] | undefined>,
    url?: URL,
  ): Promise<void> {
    if (!isExtensionRequestAllowed(headers, this.extensionOrigin)) {
      sendJson(res, 403, httpErrorBody('chrome_invalid_request', 'extension origin not allowed'));
      return;
    }
    // Heartbeat on result path: instanceId query refreshes lastSeen.
    if (url !== undefined) {
      try {
        const claim = parseBridgeInstanceQuery(url);
        if (claim !== null) this.registerInstance(claim);
        else {
          const bare = url.searchParams.get('instanceId');
          if (bare !== null && bare !== '') this.heartbeat(bare);
        }
      } catch {
        // Invalid heartbeat claims never block result delivery; strict poll
        // registration already rejects malformed claims on /next.
      }
    }
    const body = await readBody(req, this.maxResultBytes);
    if (!body.ok) {
      sendJson(
        res,
        413,
        httpErrorBody('chrome_invalid_result', body.tooLarge ? 'result exceeds byte cap' : 'result read failed'),
      );
      return;
    }
    let result: ChromeBridgeResult;
    try {
      result = parseChromeBridgeResult(JSON.parse(body.text) as unknown);
    } catch {
      // Never echo the body back to the extension transport.
      sendJson(res, 400, httpErrorBody('chrome_invalid_result', 'invalid bridge result'));
      return;
    }
    const waiter = this.waiters.get(result.id);
    if (waiter === undefined || waiter.settled || this.revokedIds.has(result.id)) {
      // Withheld: revoked, timed out, or never dispatched. Acknowledge without
      // resolving any Pi waiter as success-after-revoke.
      this.revokedIds.add(result.id);
      sendJson(res, 200, { protocol: CHROME_BRIDGE_PROTOCOL, received: true, withheld: true });
      return;
    }
    waiter.settled = true;
    clearTimeout(waiter.timer);
    this.waiters.delete(result.id);
    waiter.resolve(result);
    sendJson(res, 200, { protocol: CHROME_BRIDGE_PROTOCOL, received: true, withheld: false });
  }
}

export interface ChromeBridgeClientOptions {
  port?: number | undefined;
  timeoutMs?: number | undefined;
}

/** Pi-local client. Sends no Origin/Sec-Fetch-Site headers by construction. */
export class ChromeBridgeClient {
  private readonly port: number;
  private readonly timeoutMs: number;

  constructor(options?: ChromeBridgeClientOptions) {
    this.port = options?.port ?? CHROME_BRIDGE_PORT;
    this.timeoutMs = options?.timeoutMs ?? CHROME_BRIDGE_DEFAULT_COMMAND_TIMEOUT_MS;
  }

  async send(command: ChromeBridgeCommand, options?: { signal?: AbortSignal | undefined }): Promise<ChromeBridgeResult> {
    const text = JSON.stringify(command);
    if (Buffer.byteLength(text) > CHROME_BRIDGE_MAX_REQUEST_BYTES) {
      throw new ChromeBridgeError('chrome_invalid_request', 'command exceeds byte cap', false, 413);
    }
    return new Promise<ChromeBridgeResult>((resolve, reject) => {
      if (options?.signal?.aborted === true) {
        reject(new ChromeBridgeError('chrome_timeout', 'bridge command aborted', true, 499));
        return;
      }
      const req = http.request(
        {
          host: CHROME_BRIDGE_HOST,
          port: this.port,
          path: CHROME_BRIDGE_COMMAND_PATH,
          method: 'POST',
          headers: {
            'content-type': 'application/json; charset=utf-8',
            'content-length': Buffer.byteLength(text),
          },
        },
        (res) => {
          const chunks: Buffer[] = [];
          let received = 0;
          let tooLarge = false;
          res.on('data', (chunk: Buffer) => {
            received += chunk.length;
            if (received > CHROME_BRIDGE_MAX_RESULT_BYTES) {
              tooLarge = true;
              res.destroy();
              return;
            }
            chunks.push(chunk);
          });
          res.on('end', () => {
            if (tooLarge) {
              reject(new ChromeBridgeError('chrome_invalid_result', 'bridge result exceeds byte cap', false, 502));
              return;
            }
            const raw = Buffer.concat(chunks).toString('utf8');
            let parsed: unknown;
            try {
              parsed = JSON.parse(raw) as unknown;
            } catch {
              reject(new ChromeBridgeError('chrome_invalid_result', 'invalid bridge response', false, res.statusCode ?? 502));
              return;
            }
            if (res.statusCode !== 200) {
              const record = parsed as Record<string, unknown>;
              const error = record['error'] as { code?: unknown; message?: unknown; retryable?: unknown } | undefined;
              const code: ChromeProfileErrorCode =
                error?.code === 'chrome_locked' ||
                error?.code === 'chrome_revoked' ||
                error?.code === 'chrome_extension_unavailable' ||
                error?.code === 'chrome_version_mismatch' ||
                error?.code === 'chrome_domain_blocked' ||
                error?.code === 'chrome_no_owned_tab' ||
                error?.code === 'chrome_timeout' ||
                error?.code === 'chrome_invalid_request' ||
                error?.code === 'chrome_invalid_result' ||
                error?.code === 'chrome_debugger_conflict' ||
                error?.code === 'chrome_policy_failure'
                  ? error.code
                  : 'chrome_invalid_result';
              reject(
                new ChromeBridgeError(
                  code,
                  typeof error?.message === 'string' && error.message.length > 0
                    ? error.message.slice(0, 500)
                    : 'bridge command failed',
                  error?.retryable === true,
                  res.statusCode ?? 500,
                ),
              );
              return;
            }
            try {
              resolve(parseChromeBridgeResult(parsed));
            } catch {
              reject(new ChromeBridgeError('chrome_invalid_result', 'invalid bridge result', false, 502));
            }
          });
          res.on('error', (error: Error) => {
            reject(new ChromeBridgeError('chrome_extension_unavailable', error.message.slice(0, 500), true, 503));
          });
        },
      );
      req.on('error', (error: Error) => {
        reject(new ChromeBridgeError('chrome_extension_unavailable', error.message.slice(0, 500), true, 503));
      });
      const timer = setTimeout(() => {
        req.destroy();
        reject(new ChromeBridgeError('chrome_timeout', 'bridge command timed out', true, 504));
      }, this.timeoutMs);
      const cleanup = (): void => {
        clearTimeout(timer);
        options?.signal?.removeEventListener('abort', onAbort);
      };
      const onAbort = (): void => {
        cleanup();
        req.destroy();
        reject(new ChromeBridgeError('chrome_timeout', 'bridge command aborted', true, 499));
      };
      options?.signal?.addEventListener('abort', onAbort, { once: true });
      req.on('close', cleanup);
      req.end(text);
    });
  }

  /** Handshake probe: true only when our protocol answers on the port. */
  async handshake(options?: { signal?: AbortSignal | undefined }): Promise<boolean> {
    return probeBridgeHandshake(this.port, { signal: options?.signal });
  }
}
