// Leaf-runtime RPC v1 client over an EventBus. Fail-closed throughout:
// timeouts, malformed replies, and oversize payloads reject; late replies
// after settle are ignored. Run/provider/model metadata never leaves this
// module — runLeaf resolves to { text } only.

import { randomBytes } from 'node:crypto';
import {
  RUNTIME_RPC_BOUNDS,
  RUNTIME_RPC_METHODS,
  RUNTIME_RPC_READY_EVENT,
  RUNTIME_RPC_REQUEST_EVENT,
  runtimeRpcReplyEvent,
  validateReadyPayload,
  validateReply,
  validateRequest,
  type RuntimeReadyPayloadV1,
  type RuntimeRpcErrorCode,
  type RuntimeRpcMethod,
  type RuntimeRpcReply,
} from './runtime-rpc-protocol.js';

export interface LeafEventBus {
  emit(channel: string, data: unknown): void;
  on(channel: string, handler: (data: unknown) => void): () => void;
}

export interface LeafRuntimeClientOptions {
  events: LeafEventBus;
  /** Exact `provider/model` id. Injected (env read at wiring layer, never here). */
  modelId: string;
  /** Per-request timeout default (ms). Bounded by maxTimeoutMs. */
  defaultTimeoutMs?: number;
  /** Status/result poll interval (ms). */
  pollIntervalMs?: number;
}

export interface LeafRunOptions {
  maxOutputTokens?: number;
  timeoutMs?: number;
}

/** Opaque leaf result: text only, no run/provider/model/token metadata. */
export interface ProviderOpaqueLeafResult {
  text: string;
}

/** Safe local error: allowlisted code only, never provider exception text. */
export class LeafRuntimeError extends Error {
  readonly code: RuntimeRpcErrorCode | 'timeout' | 'disposed' | 'invalid_reply';
  constructor(code: LeafRuntimeError['code'], message: string) {
    super(message);
    this.name = 'LeafRuntimeError';
    this.code = code;
  }
}

const LOCAL_TIMEOUT_MESSAGE = 'Leaf runtime request timed out.';
const DISPOSED_MESSAGE = 'Leaf runtime client disposed.';
const INVALID_REPLY_MESSAGE = 'Malformed leaf runtime reply.';
const RUN_ID_PATTERN = /^runtime_[A-Za-z0-9_-]{1,64}$/;
const REQUEST_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;
const POLL_INTERVAL_MS = 250;
const REFRESH_TIMEOUT_MS = 10_000;
const DEFAULT_START_TIMEOUT_MS = 60_000;
const RESULT_TEXT_MAX_BYTES = RUNTIME_RPC_BOUNDS.maxResultBytes;

interface Pending {
  requestId: string;
  method: RuntimeRpcMethod;
  resolve: (data: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
  unsubscribe: () => void;
  settled: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function newRequestId(): string {
  // 16 random bytes as hex: 32 chars, within [A-Za-z0-9_-]{1,128}.
  return randomBytes(16).toString('hex');
}

function asTimeoutMs(value: number | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || value < RUNTIME_RPC_BOUNDS.minTimeoutMs) {
    throw new LeafRuntimeError('timeout', 'timeoutMs out of range.');
  }
  if (value > RUNTIME_RPC_BOUNDS.maxTimeoutMs) {
    throw new LeafRuntimeError('timeout', 'timeoutMs exceeds maximum; rejected, never clamped.');
  }
  return value;
}

export class LeafRuntimeClient {
  private readonly events: LeafEventBus;
  private readonly modelId: string;
  private readonly defaultTimeoutMs: number;
  private readonly pollIntervalMs: number;
  private readonly pending = new Map<string, Pending>();
  private readonly startedRunIds: string[] = [];
  private readonly subscriptions: Array<() => void> = [];
  private ready: RuntimeReadyPayloadV1 | undefined;
  private disposed = false;

  constructor(options: LeafRuntimeClientOptions) {
    // No process.env reads here: modelId and timeouts are injected.
    if (typeof options.modelId !== 'string' || options.modelId.length === 0) {
      throw new LeafRuntimeError('invalid_reply', 'LeafRuntimeClient requires an exact modelId.');
    }
    this.events = options.events;
    this.modelId = options.modelId;
    this.defaultTimeoutMs = asTimeoutMs(options.defaultTimeoutMs, DEFAULT_START_TIMEOUT_MS);
    const poll = options.pollIntervalMs ?? POLL_INTERVAL_MS;
    if (!Number.isInteger(poll) || poll <= 0) {
      throw new LeafRuntimeError('timeout', 'pollIntervalMs must be a positive integer.');
    }
    this.pollIntervalMs = poll;
    const unsubscribe = this.events.on(RUNTIME_RPC_READY_EVENT, (raw) => {
      const validated = validateReadyPayload(raw);
      if (validated.ok) this.ready = validated.value;
    });
    if (typeof unsubscribe === 'function') this.subscriptions.push(unsubscribe);
  }

  /** Last known readiness only; never trust a stale event — use refreshReady(). */
  isReady(): boolean {
    return this.ready !== undefined;
  }

  /**
   * Epoch-safe readiness: sends `negotiate` with a fresh requestId for the
   * configured leaf model. True only on a success reply; every failure mode
   * (runtime_unavailable, timeout, malformed) resolves false, never throws.
   */
  async refreshReady(): Promise<boolean> {
    if (this.disposed) return false;
    try {
      const data = await this.request('negotiate', { modelId: this.modelId }, { timeoutMs: Math.min(REFRESH_TIMEOUT_MS, RUNTIME_RPC_BOUNDS.maxTimeoutMs) });
      if (!isRecord(data) || data.compatible !== true) return false;
      if (data.modelId !== undefined && data.modelId !== this.modelId) return false;
      this.ready = { version: 1, protocol: 'subagents:runtime:v1', methods: [...RUNTIME_RPC_METHODS] };
      return true;
    } catch {
      return false;
    }
  }

  /** Correlated request: subscribe on the exact reply channel before emitting. */
  request(method: RuntimeRpcMethod, params: Record<string, unknown>, opts?: { timeoutMs?: number }): Promise<unknown> {
    if (this.disposed) return Promise.reject(new LeafRuntimeError('disposed', DISPOSED_MESSAGE));
    let timeoutMs: number;
    try {
      timeoutMs = asTimeoutMs(opts?.timeoutMs, this.defaultTimeoutMs);
    } catch (error) {
      return Promise.reject(error);
    }
    const requestId = newRequestId();
    if (!REQUEST_ID_PATTERN.test(requestId)) {
      return Promise.reject(new LeafRuntimeError('invalid_reply', INVALID_REPLY_MESSAGE));
    }
    const envelope = { version: 1 as const, requestId, method, params };
    const validated = validateRequest(envelope);
    if (!validated.ok) {
      return Promise.reject(new LeafRuntimeError('invalid_reply', validated.message));
    }
    return new Promise<unknown>((resolve, reject) => {
      const pending: Pending = {
        requestId,
        method,
        resolve: resolve as (data: unknown) => void,
        reject,
        timer: undefined as unknown as ReturnType<typeof setTimeout>,
        unsubscribe: () => undefined,
        settled: false,
      };
      const settleResolve = (data: unknown): void => {
        if (pending.settled) return;
        pending.settled = true;
        clearTimeout(pending.timer);
        try {
          pending.unsubscribe();
        } catch {
          // Unsubscribe is best-effort; settling still completes.
        }
        this.pending.delete(requestId);
        pending.resolve(data);
      };
      const settleReject = (error: Error): void => {
        if (pending.settled) return;
        pending.settled = true;
        clearTimeout(pending.timer);
        try {
          pending.unsubscribe();
        } catch {
          // Unsubscribe is best-effort; settling still completes.
        }
        this.pending.delete(requestId);
        pending.reject(error);
      };
      pending.unsubscribe = this.events.on(runtimeRpcReplyEvent(requestId), (raw) => {
        // Late replies after settle are ignored: subscription is removed.
        if (pending.settled) return;
        const checked = validateReply(raw, requestId, method);
        if (!checked.ok) {
          settleReject(new LeafRuntimeError('invalid_reply', INVALID_REPLY_MESSAGE));
          return;
        }
        const reply: RuntimeRpcReply = checked.value;
        if (reply.success) {
          settleResolve(reply.data);
          return;
        }
        settleReject(new LeafRuntimeError(reply.error.code, reply.error.message));
      });
      this.subscriptions.push(pending.unsubscribe);
      pending.timer = setTimeout(() => {
        settleReject(new LeafRuntimeError('timeout', LOCAL_TIMEOUT_MESSAGE));
        this.cancelKnownRuns();
      }, timeoutMs);
      if (typeof pending.timer === 'object' && pending.timer !== null && 'unref' in pending.timer) {
        (pending.timer as unknown as { unref(): void }).unref();
      }
      this.pending.set(requestId, pending);
      try {
        this.events.emit(RUNTIME_RPC_REQUEST_EVENT, envelope);
      } catch (error) {
        settleReject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  /**
   * Bounded leaf run: negotiate → start → poll status/result until terminal.
   * Resolves to { text } only; runId stays internal to the client.
   */
  async runLeaf(prompt: string, opts?: LeafRunOptions): Promise<ProviderOpaqueLeafResult> {
    if (this.disposed) throw new LeafRuntimeError('disposed', DISPOSED_MESSAGE);
    if (typeof prompt !== 'string' || prompt.length === 0) {
      throw new LeafRuntimeError('invalid_reply', 'prompt must be non-empty.');
    }
    if (Buffer.byteLength(prompt, 'utf8') > RUNTIME_RPC_BOUNDS.maxPromptBytes) {
      throw new LeafRuntimeError('invalid_reply', 'prompt exceeds byte limit; rejected, never clamped.');
    }
    const timeoutMs = asTimeoutMs(opts?.timeoutMs, this.defaultTimeoutMs);
    const maxOutputTokens = opts?.maxOutputTokens ?? 1024;
    if (!Number.isInteger(maxOutputTokens) || maxOutputTokens < 1 || maxOutputTokens > RUNTIME_RPC_BOUNDS.maxNegotiatedOutputTokens) {
      throw new LeafRuntimeError('invalid_reply', 'maxOutputTokens out of range.');
    }
    const deadline = Date.now() + timeoutMs;
    const remaining = (): number => Math.max(1, deadline - Date.now());

    await this.request('negotiate', { modelId: this.modelId }, { timeoutMs: Math.min(remaining(), REFRESH_TIMEOUT_MS) }).catch((error) => {
      throw error instanceof LeafRuntimeError ? error : new LeafRuntimeError('provider_error', 'Leaf negotiation failed.');
    });

    const startData = await this.request(
      'start',
      {
        modelId: this.modelId,
        prompt,
        maxOutputTokens,
        timeoutMs: Math.min(remaining(), RUNTIME_RPC_BOUNDS.maxTimeoutMs),
        correlation: {
          owner: 'northstar',
          correlationId: newRequestId().slice(0, 32),
          queryIndex: 0,
          role: 'synthesizer',
          stage: 'leaf-report',
          attempt: 0,
        },
      },
      { timeoutMs: remaining() },
    );
    if (!isRecord(startData) || typeof startData.runId !== 'string' || !RUN_ID_PATTERN.test(startData.runId)) {
      throw new LeafRuntimeError('invalid_reply', INVALID_REPLY_MESSAGE);
    }
    const runId = startData.runId;
    this.trackRunId(runId);

    for (;;) {
      if (Date.now() >= deadline) {
        this.cancelKnownRuns();
        throw new LeafRuntimeError('timeout', LOCAL_TIMEOUT_MESSAGE);
      }
      await this.sleep(this.pollIntervalMs);
      if (Date.now() >= deadline) {
        this.cancelKnownRuns();
        throw new LeafRuntimeError('timeout', LOCAL_TIMEOUT_MESSAGE);
      }
      const statusData = await this.request('status', { runId }, { timeoutMs: remaining() });
      if (!isRecord(statusData) || typeof statusData.state !== 'string') {
        throw new LeafRuntimeError('invalid_reply', INVALID_REPLY_MESSAGE);
      }
      const state = statusData.state;
      if (state === 'running') continue;
      if (state === 'completed') break;
      if (state === 'failed' || state === 'cancelled') {
        throw new LeafRuntimeError(state === 'cancelled' ? 'timeout' : 'provider_error', state === 'cancelled' ? LOCAL_TIMEOUT_MESSAGE : 'Leaf run failed.');
      }
      throw new LeafRuntimeError('invalid_reply', INVALID_REPLY_MESSAGE);
    }

    const resultData = await this.request('result', { runId }, { timeoutMs: remaining() });
    if (!isRecord(resultData) || typeof resultData.output !== 'string') {
      throw new LeafRuntimeError('invalid_reply', INVALID_REPLY_MESSAGE);
    }
    const text = resultData.output;
    if (Buffer.byteLength(text, 'utf8') > RESULT_TEXT_MAX_BYTES) {
      throw new LeafRuntimeError('result_byte_limit_exceeded', 'Result payload exceeds byte limit.');
    }
    this.forgetRunId(runId);
    return { text };
  }

  /** Fail-closed dispose: reject pending, remove subscriptions, stop timers. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const pending of [...this.pending.values()]) {
      if (pending.settled) continue;
      pending.settled = true;
      clearTimeout(pending.timer);
      try {
        pending.unsubscribe();
      } catch {
        // Best-effort cleanup.
      }
      pending.reject(new LeafRuntimeError('disposed', DISPOSED_MESSAGE));
    }
    this.pending.clear();
    this.startedRunIds.length = 0;
    for (const unsubscribe of this.subscriptions) {
      try {
        unsubscribe();
      } catch {
        // Best-effort cleanup.
      }
    }
    this.subscriptions.length = 0;
    this.ready = undefined;
  }

  private trackRunId(runId: string): void {
    if (this.startedRunIds.length >= RUNTIME_RPC_BOUNDS.maxCancelRunIds) {
      this.startedRunIds.shift();
    }
    this.startedRunIds.push(runId);
  }

  private forgetRunId(runId: string): void {
    const index = this.startedRunIds.indexOf(runId);
    if (index >= 0) this.startedRunIds.splice(index, 1);
  }

  /** Best-effort cancelAndSettle for known runs: fire-and-forget, bounded. */
  private cancelKnownRuns(): void {
    if (this.disposed || this.startedRunIds.length === 0) return;
    const runIds = this.startedRunIds.slice(0, RUNTIME_RPC_BOUNDS.maxCancelRunIds);
    const requestId = newRequestId();
    const envelope = {
      version: 1 as const,
      requestId,
      method: 'cancelAndSettle' as const,
      params: { runIds, settlementWindowMs: RUNTIME_RPC_BOUNDS.maxSettlementWindowMs },
    };
    if (!validateRequest(envelope).ok) return;
    const channel = runtimeRpcReplyEvent(requestId);
    try {
      const unsubscribe = this.events.on(channel, () => {
        try {
          unsubscribe();
        } catch {
          // Best-effort cleanup.
        }
      });
      if (typeof unsubscribe === 'function') {
        const timer = setTimeout(() => {
          try {
            unsubscribe();
          } catch {
            // Best-effort cleanup.
          }
        }, 5_000);
        if (typeof (timer as unknown as { unref?: unknown }).unref === 'function') {
          (timer as unknown as { unref(): void }).unref();
        }
      }
      this.events.emit(RUNTIME_RPC_REQUEST_EVENT, envelope);
    } catch {
      // Fire-and-forget: transport failures stay silent.
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, ms);
      if (typeof (timer as unknown as { unref?: unknown }).unref === 'function') {
        (timer as unknown as { unref(): void }).unref();
      }
    });
  }
}
