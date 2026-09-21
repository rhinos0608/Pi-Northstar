import test from 'node:test';
import assert from 'node:assert/strict';
import { decodeBrokerFrame, encodeBrokerFrame, BROKER_MAX_FRAME_BYTES } from '../../src/runtime/broker-protocol.js';
import { BrokerError } from '../../src/runtime/broker-errors.js';

test('broker frames round-trip and reject oversized payloads', () => {
  const message = { version: 2 as const, kind: 'hello' as const, clientId: 'c', projectId: 'p', requestedCapabilities: [] as never[] };
  assert.deepEqual(decodeBrokerFrame(encodeBrokerFrame(message)), message);
  assert.throws(() => encodeBrokerFrame({ ...message, clientId: 'x'.repeat(BROKER_MAX_FRAME_BYTES) }), (error: unknown) => error instanceof BrokerError && error.code === 'frame_too_large');
  assert.throws(() => decodeBrokerFrame(Buffer.from([0, 0, 0, 2, 0])), (error: unknown) => error instanceof BrokerError && error.code === 'invalid_frame');
});

test('broker decoder rejects unknown methods and fields before forwarding', () => {
  const raw = Buffer.from(JSON.stringify({ version: 2, kind: 'request', token: 't', epoch: 'e', sessionId: 's', sequence: 1, projectId: 'p', request: { version: 1, requestId: 'r', method: 'admin', params: {} } }));
  const frame = Buffer.alloc(4 + raw.length); frame.writeUInt32BE(raw.length); raw.copy(frame, 4);
  assert.throws(() => decodeBrokerFrame(frame), (error: unknown) => error instanceof BrokerError && error.code === 'invalid_frame');
});
