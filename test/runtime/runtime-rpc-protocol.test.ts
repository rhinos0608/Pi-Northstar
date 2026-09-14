// Strict validator tests for the v1 wire contract copy.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  RUNTIME_RPC_BOUNDS,
  RUNTIME_RPC_METHODS,
  RUNTIME_RPC_PROTOCOL,
  RUNTIME_RPC_READY_EVENT,
  RUNTIME_RPC_REPLY_EVENT_PREFIX,
  RUNTIME_RPC_REQUEST_EVENT,
  RUNTIME_RPC_VERSION,
  runtimeRpcReplyEvent,
  validateReadyPayload,
  validateReply,
  validateRequest,
} from '../../src/runtime/runtime-rpc-protocol.js';

const CORRELATION = {
  owner: 'northstar',
  correlationId: 'corr-1',
  queryIndex: 0,
  role: 'synthesizer',
  stage: 'leaf-report',
  attempt: 0,
};

test('v1 constants match the wire contract', () => {
  assert.equal(RUNTIME_RPC_VERSION, 1);
  assert.equal(RUNTIME_RPC_PROTOCOL, 'subagents:runtime:v1');
  assert.equal(RUNTIME_RPC_READY_EVENT, 'subagents:runtime:v1:ready');
  assert.equal(RUNTIME_RPC_REQUEST_EVENT, 'subagents:runtime:v1:request');
  assert.equal(RUNTIME_RPC_REPLY_EVENT_PREFIX, 'subagents:runtime:v1:reply:');
  assert.deepEqual([...RUNTIME_RPC_METHODS], ['negotiate', 'start', 'status', 'result', 'cancelAndSettle']);
  assert.equal(RUNTIME_RPC_BOUNDS.maxParallelRuns, 4);
  assert.equal(RUNTIME_RPC_BOUNDS.maxResultBytes, 262_144);
  assert.equal(RUNTIME_RPC_BOUNDS.maxPromptBytes, 262_144);
  assert.equal(RUNTIME_RPC_BOUNDS.maxTimeoutMs, 600_000);
  assert.equal(RUNTIME_RPC_BOUNDS.maxCancelRunIds, 64);
  assert.equal(RUNTIME_RPC_BOUNDS.maxRequestIdLength, 128);
  assert.equal(runtimeRpcReplyEvent('abc'), 'subagents:runtime:v1:reply:abc');
});

test('validateRequest accepts each method; rejects unknown fields', () => {
  const base = { version: 1, requestId: 'req-1' } as const;
  assert.equal(validateRequest({ ...base, method: 'negotiate', params: { modelId: 'prov/model' } }).ok, true);
  assert.equal(
    validateRequest({ ...base, method: 'start', params: { modelId: 'prov/model', prompt: 'hi', maxOutputTokens: 16, timeoutMs: 1000, correlation: CORRELATION } }).ok,
    true,
  );
  assert.equal(validateRequest({ ...base, method: 'status', params: { runId: 'runtime_abc' } }).ok, true);
  assert.equal(validateRequest({ ...base, method: 'result', params: { runId: 'runtime_abc' } }).ok, true);
  assert.equal(
    validateRequest({ ...base, method: 'cancelAndSettle', params: { runIds: ['runtime_abc'], settlementWindowMs: 100 } }).ok,
    true,
  );
  // Unknown envelope/params fields rejected on every method.
  for (const params of [
    { method: 'negotiate', params: { modelId: 'prov/model', extra: 1 } },
    { method: 'status', params: { runId: 'runtime_abc', extra: 1 } },
  ]) {
    assert.equal(validateRequest({ ...base, ...params }).ok, false, JSON.stringify(params));
  }
  assert.equal(validateRequest({ ...base, method: 'negotiate', params: { modelId: 'prov/model' }, extra: 1 }).ok, false);
  assert.equal(validateRequest({ ...base, method: 'negotiate', params: { modelId: 'prov/model' }, version: 2 }).ok, false);
  assert.equal(validateRequest({ ...base, method: 'nope', params: {} }).ok, false);
  assert.equal(validateRequest({ ...base, method: 'start', params: { modelId: 'prov/model', prompt: '', maxOutputTokens: 16, timeoutMs: 1000, correlation: CORRELATION } }).ok, false);
});

test('validateReply enforces correlation, allowlisted codes, and size', () => {
  const okReply = { version: 1, requestId: 'req-1', method: 'negotiate', success: true, data: { compatible: true } };
  assert.equal(validateReply(okReply, 'req-1', 'negotiate').ok, true);
  assert.equal(validateReply(okReply, 'other', 'negotiate').ok, false);
  assert.equal(validateReply(okReply, 'req-1', 'start').ok, false);
  const errReply = { version: 1, requestId: 'req-1', method: 'negotiate', success: false, error: { code: 'runtime_unavailable', message: 'x' } };
  assert.equal(validateReply(errReply, 'req-1', 'negotiate').ok, true);
  assert.equal(
    validateReply({ ...errReply, error: { code: 'evil_code', message: 'x' } }, 'req-1', 'negotiate').ok,
    false,
  );
  assert.equal(validateReply({ version: 2, requestId: 'req-1', method: 'negotiate', success: true, data: {} }, 'req-1').ok, false);
  assert.equal(validateReply({ version: 1, requestId: 'req-1!!!', method: 'negotiate', success: true, data: {} }, 'req-1!!!').ok, false);
  const oversize = { version: 1, requestId: 'req-1', method: 'negotiate', success: true, data: { blob: 'x'.repeat(RUNTIME_RPC_BOUNDS.maxResultBytes) } };
  assert.equal(validateReply(oversize, 'req-1', 'negotiate').ok, false);
});

test('validateReadyPayload requires exact version, protocol, methods', () => {
  const good = { version: 1, protocol: 'subagents:runtime:v1', methods: ['negotiate', 'start', 'status', 'result', 'cancelAndSettle'] };
  assert.equal(validateReadyPayload(good).ok, true);
  assert.equal(validateReadyPayload({ ...good, protocol: 'subagents:rpc:v1' }).ok, false);
  assert.equal(validateReadyPayload({ ...good, methods: ['negotiate'] }).ok, false);
  assert.equal(validateReadyPayload({ ...good, version: 2 }).ok, false);
  assert.equal(validateReadyPayload({ ...good, extra: 1 }).ok, false);
});

test('outputSchema bounds reject oversize/deep/wide schemas, never clamp', () => {
  const startWith = (outputSchema: unknown): boolean =>
    validateRequest({
      version: 1,
      requestId: 'req-1',
      method: 'start',
      params: { modelId: 'prov/model', prompt: 'hi', maxOutputTokens: 16, timeoutMs: 1000, outputSchema, correlation: CORRELATION },
    }).ok;
  assert.equal(startWith({ type: 'object' }), true);
  assert.equal(startWith('nope'), false);
  assert.equal(startWith({ blob: 'x'.repeat(RUNTIME_RPC_BOUNDS.maxPromptBytes) }), false);
  let deep: Record<string, unknown> = { v: 1 };
  for (let index = 0; index < 12; index += 1) deep = { nested: deep };
  assert.equal(startWith(deep), false);
  const wide: Record<string, unknown> = {};
  for (let index = 0; index < 300; index += 1) wide[`k${index}`] = index;
  assert.equal(startWith(wide), false);
});

test('validateReply requires method on success; error may omit it', () => {
  const noMethodSuccess = { version: 1, requestId: 'req-1', success: true, data: {} };
  assert.equal(validateReply(noMethodSuccess, 'req-1', 'negotiate').ok, false);
  assert.equal(validateReply(noMethodSuccess, 'req-1').ok, false);
  const badMethod = { version: 1, requestId: 'req-1', method: 'eval', success: true, data: {} };
  assert.equal(validateReply(badMethod, 'req-1').ok, false);
  const goodNoExpected = { version: 1, requestId: 'req-1', method: 'negotiate', success: true, data: {} };
  const checked = validateReply(goodNoExpected, 'req-1');
  assert.equal(checked.ok, true);
  if (checked.ok && checked.value.success) {
    assert.equal(typeof checked.value.method, 'string');
  }
  const errNoMethod = { version: 1, requestId: 'req-1', success: false, error: { code: 'timeout', message: 'anything' } };
  assert.equal(validateReply(errNoMethod, 'req-1', 'negotiate').ok, true);
});
