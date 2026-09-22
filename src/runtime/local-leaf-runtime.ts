import { randomUUID } from 'node:crypto';
import type { AssistantMessage, Context, Models } from '@earendil-works/pi-ai';
import {
  RUNTIME_RPC_BOUNDS,
  type RuntimeRpcErrorCode,
  type RuntimeRpcMethod,
} from './runtime-rpc-protocol.js';
import {
  NORTHSTAR_LEAF_MODEL_ENV_VAR,
  resolveNorthstarModelId,
} from './northstar-config.js';

// Operator default model for the local leaf runtime: unified selection
// (PI_NORTHSTAR_MODEL env > ~/.pi-northstar/config.json) with
// PI_NORTHSTAR_LEAF_MODEL as the last-resort fallback. Id only — auth stays
// in Pi ModelRuntime auth.json. Undefined when nothing is configured, so
// callers without a model still fail closed.

type RunState = 'running' | 'completed' | 'failed' | 'cancelled';

interface LocalRun {
  runId: string;
  state: RunState;
  startedAt: number;
  updatedAt: number;
  output?: string;
  outputTokens?: number;
  error?: string;
  controller: AbortController;
  settled: Promise<void>;
}

export class LocalLeafRuntimeError extends Error {
  constructor(readonly code: RuntimeRpcErrorCode, message: string) {
    super(message);
    this.name = 'LocalLeafRuntimeError';
  }
}

export function resolveLocalLeafModelId(
  env: Record<string, string | undefined> = process.env as Record<string, string | undefined>,
): string | undefined {
  const unified = resolveNorthstarModelId(env);
  if (unified.source === 'env') {
    return unified.modelId?.trim() || undefined;
  }
  if (unified.modelId !== undefined && unified.modelId.trim() !== '') return unified.modelId.trim();
  const leaf = env[NORTHSTAR_LEAF_MODEL_ENV_VAR]?.trim();
  return leaf !== undefined && leaf !== '' ? leaf : undefined;
}

function splitModelId(modelId: string): { provider: string; id: string } {
  const slash = modelId.indexOf('/');
  if (slash <= 0 || slash === modelId.length - 1) {
    throw new LocalLeafRuntimeError('model_unavailable', 'Exact provider/model ID is required.');
  }
  return { provider: modelId.slice(0, slash), id: modelId.slice(slash + 1) };
}

function messageText(message: AssistantMessage): string {
  return message.content
    .filter((entry): entry is Extract<AssistantMessage['content'][number], { type: 'text' }> => entry.type === 'text')
    .map((entry) => entry.text)
    .join('');
}

function approxOutputTokens(text: string): number {
  return Math.max(0, Math.ceil(Buffer.byteLength(text, 'utf8') / 4));
}

export interface LocalLeafRuntimeOptions {
  retentionMs?: number;
  maxRuns?: number;
  models?: Models;
  env?: Record<string, string | undefined>;
}

export class LocalLeafRuntime {
  private modelsPromise: Promise<Models> | undefined;
  private readonly injectedModels: Models | undefined;
  private readonly runs = new Map<string, LocalRun>();
  private readonly retentionMs: number;
  private readonly maxRuns: number;
  private readonly env: Record<string, string>;

  constructor(options: LocalLeafRuntimeOptions = {}) {
    this.retentionMs = options.retentionMs ?? RUNTIME_RPC_BOUNDS.resultRetentionMs;
    this.maxRuns = options.maxRuns ?? RUNTIME_RPC_BOUNDS.maxIdempotencyRecords;
    this.env = {};
    for (const [key, value] of Object.entries(options.env ?? process.env)) {
      if (typeof value === 'string') this.env[key] = value;
    }
    this.injectedModels = options.models;
  }

  async request(method: RuntimeRpcMethod, params: Record<string, unknown>): Promise<unknown> {
    this.prune();
    switch (method) {
      case 'negotiate':
        return this.negotiate(params);
      case 'start':
        return this.start(params);
      case 'status':
        return this.status(params);
      case 'result':
        return this.result(params);
      case 'cancelAndSettle':
        return this.cancelAndSettle(params);
    }
  }

  async dispose(): Promise<void> {
    for (const run of this.runs.values()) {
      if (run.state === 'running') run.controller.abort();
    }
    await Promise.allSettled([...this.runs.values()].map((run) => run.settled));
    this.runs.clear();
  }

  private async models(): Promise<Models> {
    if (!this.modelsPromise) {
      this.modelsPromise = this.injectedModels
        ? Promise.resolve(this.injectedModels)
        : import('@earendil-works/pi-ai/providers/all').then(({ builtinModels }) => builtinModels());
    }
    return this.modelsPromise;
  }

  private async resolveModel(modelId: string) {
    const { provider, id } = splitModelId(modelId);
    const models = await this.models();
    let model = models.getModel(provider, id);
    if (model === undefined) {
      await models.refresh({ providers: [provider] });
      model = models.getModel(provider, id);
    }
    if (model === undefined) {
      throw new LocalLeafRuntimeError('model_unavailable', `Model '${modelId}' is unavailable.`);
    }
    return { models, model };
  }

  private async negotiate(params: Record<string, unknown>): Promise<unknown> {
    const modelId = String(params.modelId ?? '').trim() || resolveLocalLeafModelId(this.env) || '';
    await this.resolveModel(modelId);
    return {
      compatible: true,
      modelId,
      capabilities: {
        boundedCancellationSettlement: true,
        leafOnlyExecution: true,
        exactModelSelection: true,
        maxOutputTokensEnforced: true,
        backgroundExecution: true,
        maxParallelRuns: RUNTIME_RPC_BOUNDS.maxParallelRuns,
        maxResultBytes: RUNTIME_RPC_BOUNDS.maxResultBytes,
        minOutputTokens: RUNTIME_RPC_BOUNDS.minResponsesOutputTokens,
        maxOutputTokens: RUNTIME_RPC_BOUNDS.maxNegotiatedOutputTokens,
        outputModes: ['text'],
      },
    };
  }

  private async start(params: Record<string, unknown>): Promise<unknown> {
    const running = [...this.runs.values()].filter((run) => run.state === 'running').length;
    if (running >= RUNTIME_RPC_BOUNDS.maxParallelRuns) {
      throw new LocalLeafRuntimeError('capacity_exceeded', 'Local leaf runtime is at capacity.');
    }

    const modelId = String(params.modelId ?? '').trim() || resolveLocalLeafModelId(this.env) || '';
    const prompt = String(params.prompt ?? '');
    const maxOutputTokens = Number(params.maxOutputTokens);
    const timeoutMs = Number(params.timeoutMs);
    if (params.outputSchema !== undefined) {
      throw new LocalLeafRuntimeError('unsupported_capability', 'Local standalone runtime is text-only.');
    }

    const { models, model } = await this.resolveModel(modelId);
    const runId = `runtime_${randomUUID().replaceAll('-', '')}`;
    const controller = new AbortController();
    const startedAt = Date.now();
    let settle!: () => void;
    const settled = new Promise<void>((resolve) => { settle = resolve; });
    const run: LocalRun = {
      runId,
      state: 'running',
      startedAt,
      updatedAt: startedAt,
      controller,
      settled,
    };
    this.runs.set(runId, run);

    const context: Context = {
      messages: [{ role: 'user', content: prompt, timestamp: startedAt }],
    };
    void models.completeSimple(model, context, {
      signal: controller.signal,
      env: this.env,
      timeoutMs,
      maxTokens: maxOutputTokens,
      toolChoice: 'none',
      maxRetries: 0,
    }).then((message) => {
      if (run.state === 'cancelled') return;
      if (message.stopReason === 'error') {
        run.state = 'failed';
        run.error = message.errorMessage || 'provider_error';
        run.updatedAt = Date.now();
        return;
      }
      const output = messageText(message);
      if (Buffer.byteLength(output, 'utf8') > RUNTIME_RPC_BOUNDS.maxResultBytes) {
        run.state = 'failed';
        run.error = 'result_byte_limit_exceeded';
      } else {
        run.state = 'completed';
        run.output = output;
        run.outputTokens = message.usage?.output ?? approxOutputTokens(output);
      }
      run.updatedAt = Date.now();
    }).catch((error: unknown) => {
      if (run.state === 'cancelled') return;
      run.state = controller.signal.aborted ? 'cancelled' : 'failed';
      run.error = error instanceof Error ? error.message : 'provider_error';
      run.updatedAt = Date.now();
    }).finally(() => {
      settle();
      this.prune();
    });

    this.enforceRunBound();
    return { runId, state: 'running' };
  }

  private status(params: Record<string, unknown>): unknown {
    const run = this.requireRun(String(params.runId ?? ''));
    return {
      runId: run.runId,
      state: run.state,
      startedAt: run.startedAt,
      updatedAt: run.updatedAt,
    };
  }

  private result(params: Record<string, unknown>): unknown {
    const run = this.requireRun(String(params.runId ?? ''));
    if (run.state === 'running') {
      throw new LocalLeafRuntimeError('invalid_state', 'Run is still active.');
    }
    if (run.state === 'failed') {
      throw new LocalLeafRuntimeError('provider_error', run.error ?? 'Leaf provider failed.');
    }
    if (run.state === 'cancelled') {
      throw new LocalLeafRuntimeError('invalid_state', 'Run was cancelled.');
    }
    return {
      runId: run.runId,
      state: 'completed',
      output: run.output ?? '',
      outputTokens: run.outputTokens ?? 0,
      truncated: false,
    };
  }

  private async cancelAndSettle(params: Record<string, unknown>): Promise<unknown> {
    const runIds = Array.isArray(params.runIds) ? params.runIds.map(String) : [];
    const settlementWindowMs = Number(params.settlementWindowMs);
    const selected = runIds
      .map((runId) => this.runs.get(runId))
      .filter((run): run is LocalRun => run !== undefined);

    for (const run of selected) {
      if (run.state === 'running') {
        run.state = 'cancelled';
        run.updatedAt = Date.now();
        run.controller.abort();
      }
    }

    const deadline = Date.now() + settlementWindowMs;
    await Promise.all(selected.map(async (run) => {
      const remaining = Math.max(0, deadline - Date.now());
      if (remaining === 0) return;
      await Promise.race([
        run.settled,
        new Promise<void>((resolve) => setTimeout(resolve, remaining)),
      ]);
    }));

    return {
      settlements: runIds.map((runId) => {
        const run = this.runs.get(runId);
        return { runId, state: run?.state ?? 'unknown' };
      }),
    };
  }

  private requireRun(runId: string): LocalRun {
    const run = this.runs.get(runId);
    if (run === undefined) {
      throw new LocalLeafRuntimeError('not_found', 'Run was not found or has expired.');
    }
    return run;
  }

  private prune(): void {
    const cutoff = Date.now() - this.retentionMs;
    for (const [runId, run] of this.runs) {
      if (run.state !== 'running' && run.updatedAt < cutoff) this.runs.delete(runId);
    }
  }

  private enforceRunBound(): void {
    if (this.runs.size <= this.maxRuns) return;
    for (const [runId, run] of this.runs) {
      if (this.runs.size <= this.maxRuns) break;
      if (run.state !== 'running') this.runs.delete(runId);
    }
  }
}
