import test from 'node:test';
import assert from 'node:assert/strict';
import { createBrokerAuth, issueBrokerWelcome, verifyBrokerToken } from '../../src/runtime/broker-auth.js';
import { BROKER_TOKEN_TTL_MS } from '../../src/runtime/broker-protocol.js';
import { defaultBrokerAuthorize } from '../../src/runtime/broker-server.js';
import type { RuntimeRpcV1Request } from '../../src/runtime/runtime-rpc-protocol.js';

const statusRequest: RuntimeRpcV1Request = { version: 1, requestId: 'request', method: 'status', params: { runId: 'runtime_run' } };

test('broker token binds epoch, project, and capability', () => {
  const auth = createBrokerAuth(); const welcome = issueBrokerWelcome(auth, { clientId: 'client', projectId: 'project', requestedCapabilities: ['runtime:status'] });
  assert.doesNotThrow(() => verifyBrokerToken(auth, welcome.token, { epoch: auth.epoch, clientId: 'client', sessionId: welcome.sessionId, projectId: 'project', capability: 'runtime:status' }));
  assert.throws(() => verifyBrokerToken(auth, welcome.token, { epoch: auth.epoch, clientId: 'client', sessionId: welcome.sessionId, projectId: 'other', capability: 'runtime:status' }));
  assert.throws(() => verifyBrokerToken(createBrokerAuth(auth.rootSecret), welcome.token, { epoch: 'new', clientId: 'client', sessionId: welcome.sessionId, projectId: 'project', capability: 'runtime:status' }));
  assert.throws(() => verifyBrokerToken(auth, welcome.token, { epoch: auth.epoch, clientId: 'client', sessionId: welcome.sessionId, projectId: 'project', capability: 'runtime:start' }));
});

test('expired broker token rejects deterministically', () => {
  const originalNow = Date.now; const issuedAt = 1_700_000_000_000; Date.now = () => issuedAt;
  try {
    const auth = createBrokerAuth(); const welcome = issueBrokerWelcome(auth, { clientId: 'client', projectId: 'project', requestedCapabilities: ['runtime:status'] });
    Date.now = () => issuedAt + BROKER_TOKEN_TTL_MS + 1;
    assert.throws(() => verifyBrokerToken(auth, welcome.token, { epoch: auth.epoch, clientId: 'client', sessionId: welcome.sessionId, projectId: 'project', capability: 'runtime:status' }), error => (error as { code?: string }).code === 'expired_token');
  } finally { Date.now = originalNow; }
});

test('stolen broker token rejects for different client and session', () => {
  const auth = createBrokerAuth(); const welcome = issueBrokerWelcome(auth, { clientId: 'client-a', projectId: 'project', requestedCapabilities: ['runtime:status'] });
  assert.throws(() => verifyBrokerToken(auth, welcome.token, { epoch: auth.epoch, clientId: 'client-b', sessionId: 'session-b', projectId: 'project', capability: 'runtime:status' }), error => (error as { code?: string }).code === 'unauthorized');
});

test('default broker policy denies unauthorized requests', async () => {
  assert.equal(await defaultBrokerAuthorize(statusRequest, { clientId: 'client', sessionId: 'session', projectId: 'project' }), false);
});
