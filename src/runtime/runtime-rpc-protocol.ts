// Leaf-runtime RPC v1 wire contract (Pi-Atlas copy, self-contained).
//
// Ground truth lives in pi-subagents src/api/runtime-rpc.ts; the constants
// below are copied verbatim so Pi-Atlas never imports the other repo.
// Unknown versions/methods/fields fail closed (reject, never clamp).

/** Protocol version. Unknown versions fail closed. */
export const RUNTIME_RPC_VERSION = 1;

/** Versioned event namespace. Never reuse the legacy `subagents:rpc:v1` names. */
export const RUNTIME_RPC_PROTOCOL = 'subagents:runtime:v1';
export const RUNTIME_RPC_READY_EVENT = 'subagents:runtime:v1:ready';
export const RUNTIME_RPC_REQUEST_EVENT = 'subagents:runtime:v1:request';
export const RUNTIME_RPC_REPLY_EVENT_PREFIX = 'subagents:runtime:v1:reply:';

export const RUNTIME_RPC_METHODS = ['negotiate', 'start', 'status', 'result', 'cancelAndSettle'] as const;
export type RuntimeRpcMethod = (typeof RUNTIME_RPC_METHODS)[number];

export function runtimeRpcReplyEvent(requestId: string): string {
  return `${RUNTIME_RPC_REPLY_EVENT_PREFIX}${requestId}`;
}

/** Server-side bounds, copied exactly from the ground-truth contract. */
export const RUNTIME_RPC_BOUNDS = {
  maxParallelRuns: 4,
  maxResultBytes: 262_144,
  maxPromptBytes: 262_144,
  maxTimeoutMs: 600_000,
  minTimeoutMs: 1,
  maxCancelRunIds: 64,
  minSettlementWindowMs: 1,
  maxSettlementWindowMs: 10_000,
  resultRetentionMs: 10 * 60 * 1000,
  retainedResultMemoryBytes: 32 * 1024 * 1024,
  maxRequestIdLength: 128,
  maxModelIdLength: 256,
  maxCorrelationIdLength: 128,
  maxStageLength: 64,
  maxQueryIndex: 1_000_000,
  maxAttempt: 1_000,
  /** Minimum output tokens for OpenAI Responses; requests below fail, never widen. */
  minResponsesOutputTokens: 16,
  /** Server ceiling for negotiated output tokens. Effective max is min(server, model). */
  maxNegotiatedOutputTokens: 16_384,
  /** Bounded idempotency records for duplicate request-ID defense. */
  maxIdempotencyRecords: 512,
  idempotencyTtlMs: 10 * 60 * 1000,
} as const;

export const RUNTIME_RPC_ROLES = ['coverage_planner', 'researcher', 'synthesizer'] as const;
export type RuntimeRpcRole = (typeof RUNTIME_RPC_ROLES)[number];

/** Closed content-free correlation metadata. No arbitrary fields. */
export interface RuntimeCorrelationV1 {
  owner: 'northstar';
  correlationId: string;
  queryIndex: number;
  role: RuntimeRpcRole;
  stage: string;
  attempt: number;
}

export interface RuntimeStartV1 {
  /** Exact `provider/model` ID. No fuzzy resolution, no thinking suffix, no fallback. */
  modelId: string;
  prompt: string;
  maxOutputTokens: number;
  timeoutMs: number;
  /** Syntactically accepted; semantically rejected while text-only. */
  outputSchema?: Record<string, unknown>;
  correlation: RuntimeCorrelationV1;
}

export type RuntimeRpcV1Request =
  | { version: 1; requestId: string; method: 'negotiate'; params: { modelId: string } }
  | { version: 1; requestId: string; method: 'start'; params: RuntimeStartV1 }
  | { version: 1; requestId: string; method: 'status'; params: { runId: string } }
  | { version: 1; requestId: string; method: 'result'; params: { runId: string } }
  | {
      version: 1;
      requestId: string;
      method: 'cancelAndSettle';
      params: { runIds: string[]; settlementWindowMs: number };
    };

export interface RuntimeReadyPayloadV1 {
  version: 1;
  protocol: typeof RUNTIME_RPC_PROTOCOL;
  methods: readonly RuntimeRpcMethod[];
}

export type RuntimeRpcErrorCode =
  | 'invalid_request'
  | 'invalid_params'
  | 'unsupported_version'
  | 'unsupported_method'
  | 'duplicate_request_id'
  | 'runtime_unavailable'
  | 'unsupported_capability'
  | 'capacity_exceeded'
  | 'not_found'
  | 'invalid_state'
  | 'model_unavailable'
  | 'provider_error'
  | 'timeout'
  | 'output_token_limit_exceeded'
  | 'result_byte_limit_exceeded'
  | 'output_contract_breach'
  | 'contract_breach';

const RUNTIME_RPC_ERROR_CODES: readonly RuntimeRpcErrorCode[] = [
  'invalid_request',
  'invalid_params',
  'unsupported_version',
  'unsupported_method',
  'duplicate_request_id',
  'runtime_unavailable',
  'unsupported_capability',
  'capacity_exceeded',
  'not_found',
  'invalid_state',
  'model_unavailable',
  'provider_error',
  'timeout',
  'output_token_limit_exceeded',
  'result_byte_limit_exceeded',
  'output_contract_breach',
  'contract_breach',
];

export type RuntimeRpcReply =
  | { version: 1; requestId: string; method: RuntimeRpcMethod; success: true; data: unknown }
  | {
      version: 1;
      requestId: string;
      method?: RuntimeRpcMethod;
      success: false;
      error: { code: RuntimeRpcErrorCode; message: string };
    };

/** Fixed safe messages. Never forward provider exception text. */
export const RUNTIME_RPC_ERROR_MESSAGES: Record<RuntimeRpcErrorCode, string> = {
  invalid_request: 'Malformed runtime request.',
  invalid_params: 'Invalid runtime params.',
  unsupported_version: 'Unsupported runtime version.',
  unsupported_method: 'Unsupported runtime method.',
  duplicate_request_id: 'Duplicate runtime request ID.',
  runtime_unavailable: 'Leaf runtime unavailable on this host.',
  unsupported_capability: 'Model or capability unsupported by leaf runtime.',
  capacity_exceeded: 'Leaf runtime at capacity.',
  not_found: 'Runtime run not found.',
  invalid_state: 'Runtime run is not in a state for that operation.',
  model_unavailable: 'Exact model unavailable.',
  provider_error: 'Provider execution failed.',
  timeout: 'Leaf run timed out.',
  output_token_limit_exceeded: 'Reported output tokens exceed requested cap.',
  result_byte_limit_exceeded: 'Result payload exceeds byte limit.',
  output_contract_breach: 'Provider output violated leaf contract.',
  contract_breach: 'Cancellation settlement breached; runtime unhealthy.',
};

export interface ValidationOk<T> {
  ok: true;
  value: T;
}
export interface ValidationErr {
  ok: false;
  code: 'invalid_request' | 'invalid_params' | 'unsupported_version' | 'unsupported_method';
  message: string;
}
export type Validation<T> = ValidationOk<T> | ValidationErr;

const REQUEST_ID = /^[A-Za-z0-9_-]{1,128}$/;
const ASCII_PRINTABLE = /^[\x20-\x7e]+$/;
const MODEL_ID = /^(?![\s\S]*[\x00-\x1f\x7f])[A-Za-z0-9_.-]+\/[A-Za-z0-9_.:+-]+$/;
const RUN_ID = /^runtime_[A-Za-z0-9_-]{1,64}$/;
const THINKING_SUFFIX = /:off$|:minimal$|:low$|:medium$|:high$|:xhigh$|:max$/;

function utf8Bytes(text: string): number {
  return Buffer.byteLength(text, 'utf8');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, allowed: readonly string[]): string | undefined {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) return key;
  }
  return undefined;
}

function checkRequestId(value: unknown): Validation<string> {
  if (typeof value !== 'string' || !REQUEST_ID.test(value)) {
    return { ok: false, code: 'invalid_request', message: 'requestId must match [A-Za-z0-9_-]{1,128}.' };
  }
  return { ok: true, value };
}

function checkModelId(value: unknown): Validation<string> {
  if (typeof value !== 'string' || value.length === 0 || value.length > RUNTIME_RPC_BOUNDS.maxModelIdLength) {
    return { ok: false, code: 'invalid_params', message: 'modelId length out of bounds.' };
  }
  if (!MODEL_ID.test(value)) {
    return { ok: false, code: 'invalid_params', message: 'modelId must be exact provider/id without control characters.' };
  }
  // Thinking suffixes would silently change the model; reject.
  if (THINKING_SUFFIX.test(value)) {
    return { ok: false, code: 'invalid_params', message: 'modelId must not carry a thinking suffix.' };
  }
  return { ok: true, value };
}

function checkCorrelation(value: unknown): Validation<RuntimeStartV1['correlation']> {
  if (!isRecord(value)) return { ok: false, code: 'invalid_params', message: 'correlation must be an object.' };
  const bad = exactKeys(value, ['owner', 'correlationId', 'queryIndex', 'role', 'stage', 'attempt']);
  if (bad) return { ok: false, code: 'invalid_params', message: `Unknown correlation field: ${bad}.` };
  if (value.owner !== 'northstar') return { ok: false, code: 'invalid_params', message: 'correlation.owner must be "northstar".' };
  if (
    typeof value.correlationId !== 'string' ||
    value.correlationId.length === 0 ||
    value.correlationId.length > RUNTIME_RPC_BOUNDS.maxCorrelationIdLength ||
    !ASCII_PRINTABLE.test(value.correlationId)
  ) {
    return { ok: false, code: 'invalid_params', message: 'correlation.correlationId must be bounded ASCII.' };
  }
  if (
    typeof value.queryIndex !== 'number' ||
    !Number.isInteger(value.queryIndex) ||
    value.queryIndex < 0 ||
    value.queryIndex > RUNTIME_RPC_BOUNDS.maxQueryIndex
  ) {
    return { ok: false, code: 'invalid_params', message: 'correlation.queryIndex out of range.' };
  }
  if (typeof value.role !== 'string' || !(RUNTIME_RPC_ROLES as readonly string[]).includes(value.role)) {
    return { ok: false, code: 'invalid_params', message: 'correlation.role must be coverage_planner, researcher, or synthesizer.' };
  }
  if (
    typeof value.stage !== 'string' ||
    value.stage.length === 0 ||
    value.stage.length > RUNTIME_RPC_BOUNDS.maxStageLength ||
    !ASCII_PRINTABLE.test(value.stage)
  ) {
    return { ok: false, code: 'invalid_params', message: 'correlation.stage must be bounded ASCII.' };
  }
  if (
    typeof value.attempt !== 'number' ||
    !Number.isInteger(value.attempt) ||
    value.attempt < 0 ||
    value.attempt > RUNTIME_RPC_BOUNDS.maxAttempt
  ) {
    return { ok: false, code: 'invalid_params', message: 'correlation.attempt out of range.' };
  }
  return {
    ok: true,
    value: {
      owner: 'northstar',
      correlationId: value.correlationId,
      queryIndex: value.queryIndex,
      role: value.role as RuntimeStartV1['correlation']['role'],
      stage: value.stage,
      attempt: value.attempt,
    },
  };
}

/** outputSchema bounds: byte cap matches prompt bounds; depth/key caps mirror record-validator conventions (reject, never clamp). */
const MAX_OUTPUT_SCHEMA_DEPTH = 10;
const MAX_OUTPUT_SCHEMA_KEYS = 256;
const MAX_OUTPUT_SCHEMA_KEY_LENGTH = 128;

function checkOutputSchema(value: unknown): Validation<Record<string, unknown>> {
  if (!isRecord(value)) {
    return { ok: false, code: 'invalid_params', message: 'outputSchema must be an object when present.' };
  }
  let serialized: string;
  try {
    serialized = JSON.stringify(value) ?? '';
  } catch {
    return { ok: false, code: 'invalid_params', message: 'outputSchema must be serializable.' };
  }
  if (utf8Bytes(serialized) > RUNTIME_RPC_BOUNDS.maxPromptBytes) {
    return { ok: false, code: 'invalid_params', message: 'outputSchema exceeds byte limit.' };
  }
  let keys = 0;
  const walk = (node: unknown, depth: number): boolean => {
    if (depth > MAX_OUTPUT_SCHEMA_DEPTH) return false;
    if (Array.isArray(node)) {
      for (const entry of node) {
        if (!walk(entry, depth + 1)) return false;
      }
      return true;
    }
    if (isRecord(node)) {
      for (const key of Object.keys(node)) {
        keys += 1;
        if (keys > MAX_OUTPUT_SCHEMA_KEYS) return false;
        if (key.length === 0 || key.length > MAX_OUTPUT_SCHEMA_KEY_LENGTH) return false;
        if (!walk(node[key], depth + 1)) return false;
      }
    }
    return true;
  };
  if (!walk(value, 0)) {
    return { ok: false, code: 'invalid_params', message: 'outputSchema exceeds depth/key bounds.' };
  }
  return { ok: true, value };
}

function checkStartParams(value: unknown): Validation<RuntimeStartV1> {
  if (!isRecord(value)) return { ok: false, code: 'invalid_params', message: 'start params must be an object.' };
  const bad = exactKeys(value, ['modelId', 'prompt', 'maxOutputTokens', 'timeoutMs', 'outputSchema', 'correlation']);
  if (bad) return { ok: false, code: 'invalid_params', message: `Unknown start field: ${bad}.` };
  const model = checkModelId(value.modelId);
  if (!model.ok) return model;
  if (typeof value.prompt !== 'string' || value.prompt.length === 0 || utf8Bytes(value.prompt) > RUNTIME_RPC_BOUNDS.maxPromptBytes) {
    return { ok: false, code: 'invalid_params', message: 'prompt must be non-empty within byte limit.' };
  }
  if (
    typeof value.maxOutputTokens !== 'number' ||
    !Number.isInteger(value.maxOutputTokens) ||
    value.maxOutputTokens < 1 ||
    value.maxOutputTokens > RUNTIME_RPC_BOUNDS.maxNegotiatedOutputTokens
  ) {
    return { ok: false, code: 'invalid_params', message: 'maxOutputTokens out of range.' };
  }
  if (
    typeof value.timeoutMs !== 'number' ||
    !Number.isInteger(value.timeoutMs) ||
    value.timeoutMs < RUNTIME_RPC_BOUNDS.minTimeoutMs ||
    value.timeoutMs > RUNTIME_RPC_BOUNDS.maxTimeoutMs
  ) {
    return { ok: false, code: 'invalid_params', message: 'timeoutMs out of range.' };
  }
  let outputSchema: Record<string, unknown> | undefined;
  if (value.outputSchema !== undefined) {
    const schema = checkOutputSchema(value.outputSchema);
    if (!schema.ok) return schema;
    outputSchema = schema.value;
  }
  const correlation = checkCorrelation(value.correlation);
  if (!correlation.ok) return correlation;
  return {
    ok: true,
    value: {
      modelId: model.value,
      prompt: value.prompt,
      maxOutputTokens: value.maxOutputTokens,
      timeoutMs: value.timeoutMs,
      ...(outputSchema !== undefined ? { outputSchema } : {}),
      correlation: correlation.value,
    },
  };
}

/** Strict request validator: closed shapes, unknown fields rejected. */
export function validateRequest(raw: unknown): Validation<RuntimeRpcV1Request> {
  if (!isRecord(raw)) return { ok: false, code: 'invalid_request', message: 'Runtime request must be an object.' };
  const envelopeBad = exactKeys(raw, ['version', 'requestId', 'method', 'params']);
  if (envelopeBad) return { ok: false, code: 'invalid_request', message: `Unknown envelope field: ${envelopeBad}.` };
  if (raw.version !== 1) return { ok: false, code: 'unsupported_version', message: 'Unsupported runtime version.' };
  const id = checkRequestId(raw.requestId);
  if (!id.ok) return id;
  if (typeof raw.method !== 'string' || !(RUNTIME_RPC_METHODS as readonly string[]).includes(raw.method)) {
    return { ok: false, code: 'unsupported_method', message: 'Unsupported runtime method.' };
  }
  const method = raw.method as RuntimeRpcMethod;
  const params = raw.params;
  if (method === 'negotiate') {
    if (!isRecord(params)) return { ok: false, code: 'invalid_params', message: 'negotiate params must be an object.' };
    const bad = exactKeys(params, ['modelId']);
    if (bad) return { ok: false, code: 'invalid_params', message: `Unknown negotiate field: ${bad}.` };
    const model = checkModelId(params.modelId);
    if (!model.ok) return model;
    return { ok: true, value: { version: 1, requestId: id.value, method, params: { modelId: model.value } } };
  }
  if (method === 'start') {
    const start = checkStartParams(params);
    if (!start.ok) return start;
    return { ok: true, value: { version: 1, requestId: id.value, method, params: start.value } };
  }
  if (method === 'status' || method === 'result') {
    if (!isRecord(params)) return { ok: false, code: 'invalid_params', message: `${method} params must be an object.` };
    const bad = exactKeys(params, ['runId']);
    if (bad) return { ok: false, code: 'invalid_params', message: `Unknown ${method} field: ${bad}.` };
    if (typeof params.runId !== 'string' || !RUN_ID.test(params.runId)) {
      return { ok: false, code: 'invalid_params', message: 'runId must be an opaque runtime_ ID.' };
    }
    return { ok: true, value: { version: 1, requestId: id.value, method, params: { runId: params.runId } } };
  }
  // cancelAndSettle
  if (!isRecord(params)) return { ok: false, code: 'invalid_params', message: 'cancelAndSettle params must be an object.' };
  const bad = exactKeys(params, ['runIds', 'settlementWindowMs']);
  if (bad) return { ok: false, code: 'invalid_params', message: `Unknown cancelAndSettle field: ${bad}.` };
  if (
    !Array.isArray(params.runIds) ||
    params.runIds.length === 0 ||
    params.runIds.length > RUNTIME_RPC_BOUNDS.maxCancelRunIds ||
    !params.runIds.every((entry) => typeof entry === 'string' && RUN_ID.test(entry))
  ) {
    return { ok: false, code: 'invalid_params', message: 'runIds must be 1-64 opaque runtime_ IDs.' };
  }
  if (new Set(params.runIds).size !== params.runIds.length) {
    return { ok: false, code: 'invalid_params', message: 'runIds must be duplicate-free.' };
  }
  if (
    typeof params.settlementWindowMs !== 'number' ||
    !Number.isInteger(params.settlementWindowMs) ||
    params.settlementWindowMs < RUNTIME_RPC_BOUNDS.minSettlementWindowMs ||
    params.settlementWindowMs > RUNTIME_RPC_BOUNDS.maxSettlementWindowMs
  ) {
    return { ok: false, code: 'invalid_params', message: 'settlementWindowMs must be 1-10000ms.' };
  }
  return {
    ok: true,
    value: {
      version: 1,
      requestId: id.value,
      method,
      params: { runIds: params.runIds as string[], settlementWindowMs: params.settlementWindowMs },
    },
  };
}

export interface ReplyValidationOk {
  ok: true;
  value: RuntimeRpcReply;
}
export interface ReplyValidationErr {
  ok: false;
  reason: string;
}
export type ReplyValidation = ReplyValidationOk | ReplyValidationErr;

function replyOversize(raw: unknown): boolean {
  try {
    return utf8Bytes(JSON.stringify(raw) ?? '') > RUNTIME_RPC_BOUNDS.maxResultBytes;
  } catch {
    return true;
  }
}

/**
 * Strict reply validator: version, requestId shape/length, method correlation
 * where present, success/data or success/error{code allowlisted, message
 * string}. Rejects unknown error codes, oversize envelopes, unknown fields.
 */
export function validateReply(raw: unknown, expectedRequestId?: string, expectedMethod?: RuntimeRpcMethod): ReplyValidation {
  if (!isRecord(raw)) return { ok: false, reason: 'reply must be an object' };
  const envelopeBad = exactKeys(raw, ['version', 'requestId', 'method', 'success', 'data', 'error']);
  if (envelopeBad) return { ok: false, reason: `unknown reply field: ${envelopeBad}` };
  if (raw.version !== 1) return { ok: false, reason: 'reply version must be 1' };
  if (typeof raw.requestId !== 'string' || !REQUEST_ID.test(raw.requestId)) {
    return { ok: false, reason: 'reply requestId malformed' };
  }
  if (expectedRequestId !== undefined && raw.requestId !== expectedRequestId) {
    return { ok: false, reason: 'reply requestId mismatch' };
  }
  if (raw.method !== undefined) {
    if (typeof raw.method !== 'string' || !(RUNTIME_RPC_METHODS as readonly string[]).includes(raw.method)) {
      return { ok: false, reason: 'reply method unknown' };
    }
    if (expectedMethod !== undefined && raw.method !== expectedMethod) {
      return { ok: false, reason: 'reply method mismatch' };
    }
  } else if (expectedMethod !== undefined) {
    // Method omission is legal only on error replies; checked below.
    if (raw.success !== false) return { ok: false, reason: 'success reply must carry method' };
  }
  if (typeof raw.success !== 'boolean') return { ok: false, reason: 'reply success must be boolean' };
  if (raw.success) {
    if (!('data' in raw)) return { ok: false, reason: 'success reply must carry data' };
    if ('error' in raw) return { ok: false, reason: 'success reply must not carry error' };
    // Success replies must always carry a valid method: never cast undefined
    // to RuntimeRpcMethod. Method omission stays legal only on error replies.
    if (typeof raw.method !== 'string' || !(RUNTIME_RPC_METHODS as readonly string[]).includes(raw.method)) {
      return { ok: false, reason: 'success reply must carry method' };
    }
    if (expectedMethod !== undefined && raw.method !== expectedMethod) {
      return { ok: false, reason: 'reply method mismatch' };
    }
    if (replyOversize(raw)) return { ok: false, reason: 'reply exceeds result byte limit' };
    return {
      ok: true,
      value: {
        version: 1,
        requestId: raw.requestId,
        method: raw.method as RuntimeRpcMethod,
        success: true,
        data: raw.data,
      },
    };
  }
  if (!isRecord(raw.error)) return { ok: false, reason: 'error reply must carry error object' };
  const errorBad = exactKeys(raw.error, ['code', 'message']);
  if (errorBad) return { ok: false, reason: `unknown error field: ${errorBad}` };
  if (typeof raw.error.code !== 'string' || !(RUNTIME_RPC_ERROR_CODES as readonly string[]).includes(raw.error.code as RuntimeRpcErrorCode)) {
    return { ok: false, reason: 'unknown error code' };
  }
  if (typeof raw.error.message !== 'string') return { ok: false, reason: 'error message must be string' };
  if ('data' in raw) return { ok: false, reason: 'error reply must not carry data' };
  if (replyOversize(raw)) return { ok: false, reason: 'reply exceeds result byte limit' };
  return {
    ok: true,
    value: {
      version: 1,
      requestId: raw.requestId,
      ...(raw.method !== undefined ? { method: raw.method as RuntimeRpcMethod } : {}),
      success: false,
      error: { code: raw.error.code as RuntimeRpcErrorCode, message: raw.error.message },
    },
  };
}

export interface ReadyValidationOk {
  ok: true;
  value: RuntimeReadyPayloadV1;
}
export interface ReadyValidationErr {
  ok: false;
  reason: string;
}
export type ReadyValidation = ReadyValidationOk | ReadyValidationErr;

/** Strict ready-payload validator: version 1, exact protocol, exact methods. */
export function validateReadyPayload(raw: unknown): ReadyValidation {
  if (!isRecord(raw)) return { ok: false, reason: 'ready payload must be an object' };
  const bad = exactKeys(raw, ['version', 'protocol', 'methods']);
  if (bad) return { ok: false, reason: `unknown ready field: ${bad}` };
  if (raw.version !== 1) return { ok: false, reason: 'ready version must be 1' };
  if (raw.protocol !== RUNTIME_RPC_PROTOCOL) return { ok: false, reason: 'ready protocol mismatch' };
  if (!Array.isArray(raw.methods)) return { ok: false, reason: 'ready methods must be an array' };
  if (raw.methods.length !== RUNTIME_RPC_METHODS.length) return { ok: false, reason: 'ready methods mismatch' };
  for (let index = 0; index < RUNTIME_RPC_METHODS.length; index += 1) {
    if (raw.methods[index] !== RUNTIME_RPC_METHODS[index]) return { ok: false, reason: 'ready methods mismatch' };
  }
  return { ok: true, value: { version: 1, protocol: RUNTIME_RPC_PROTOCOL, methods: [...RUNTIME_RPC_METHODS] } };
}
