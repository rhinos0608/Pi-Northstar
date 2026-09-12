// Worker 2 bridge tests: bind, origin, caps, handshake, queues, revoke.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import http from 'node:http';
import { test } from 'node:test';
import {
  CHROME_BRIDGE_HOST,
  ChromeBridgeClient,
  ChromeBridgeConflictError,
  ChromeBridgeServer,
  extensionOriginForId,
  isExtensionRequestAllowed,
  isLocalCommandAllowed,
  probeBridgeHandshake,
} from '../src/chrome-profile-bridge.js';
import {
  CHROME_BRIDGE_PORT,
  CHROME_BRIDGE_PROTOCOL,
  type ChromeBridgeCommand,
} from '../src/chrome-profile-contract.js';

const EXTENSION_ID = 'abcdefghijklmnopqrstuvwxyzabcdef';
const EXTENSION_ORIGIN = extensionOriginForId(EXTENSION_ID);

const TEST_TARGET = 'inst-test-001';

function testCommand(server: ChromeBridgeServer, id: string, target = TEST_TARGET): ChromeBridgeCommand {
  return { protocol: 1, id, sessionKey: 'sk-test', grantId: 'grant-test', targetInstanceId: target, bridgeToken: server.bridgeToken, kind: 'execute', operation: { kind: 'tabs' } };
}

function registerTestTarget(server: ChromeBridgeServer, target = TEST_TARGET): void {
  server.registerInstance({ instanceId: target, family: 'chrome', version: '1.0.0', caps: '' });
}

async function freePort(): Promise<number> {
  const server = http.createServer();
  await new Promise<void>((resolve) => {
    server.listen(0, CHROME_BRIDGE_HOST, resolve);
  });
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;
  await new Promise<void>((resolve) => {
    server.close(() => {
      resolve();
    });
  });
  return port;
}

function rawRequest(
  port: number,
  path: string,
  options?: { method?: string | undefined; headers?: Record<string, string> | undefined; body?: string | undefined },
): Promise<{ status: number; text: string }> {
  return new Promise((resolve, reject) => {
    const body = options?.body;
    const req = http.request(
      {
        host: CHROME_BRIDGE_HOST,
        port,
        path,
        method: options?.method ?? 'GET',
        headers: {
          ...(body !== undefined ? { 'content-length': Buffer.byteLength(body) } : {}),
          ...options?.headers,
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => {
          chunks.push(chunk);
        });
        res.on('end', () => {
          resolve({ status: res.statusCode ?? 0, text: Buffer.concat(chunks).toString('utf8') });
        });
        res.on('error', reject);
      },
    );
    req.on('error', reject);
    if (body !== undefined) req.end(body);
    else req.end();
  });
}

test('bridge binds literal 127.0.0.1 on the Atlas port and answers health', async () => {
  assert.equal(CHROME_BRIDGE_HOST, '127.0.0.1');
  assert.equal(CHROME_BRIDGE_PORT, 17319);
  const port = await freePort();
  const server = new ChromeBridgeServer({ extensionId: EXTENSION_ID, port });
  try {
    await server.start();
    const bound = server.boundAddress();
    assert.ok(bound !== null);
    assert.equal(bound?.host, '127.0.0.1');
    assert.equal(bound?.port, port);
    const health = await rawRequest(port, '/health');
    assert.equal(health.status, 200);
    const parsed = JSON.parse(health.text) as { protocol: number; ok: boolean };
    assert.equal(parsed.protocol, CHROME_BRIDGE_PROTOCOL);
    assert.equal(parsed.ok, true);
  } finally {
    await server.stop();
  }
});

test('server constructor exposes no bind-host override', () => {
  const server = new ChromeBridgeServer({ extensionId: EXTENSION_ID });
  const keys = Object.keys(server);
  assert.ok(!keys.some((key) => /host/i.test(key)));
  assert.equal(server.pinnedOrigin, EXTENSION_ORIGIN);
});

test('/command rejects browser Origin and Sec-Fetch-Site headers', async () => {
  const port = await freePort();
  const server = new ChromeBridgeServer({ extensionId: EXTENSION_ID, port });
  try {
    await server.start();
    assert.equal(isLocalCommandAllowed({}), true);
    assert.equal(isLocalCommandAllowed({ origin: 'https://example.com' }), false);
    assert.equal(isLocalCommandAllowed({ 'sec-fetch-site': 'same-origin' }), false);
    const body = JSON.stringify(testCommand(server, 'cmd-origin'));
    const withOrigin = await rawRequest(port, '/command', {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: 'https://example.com' },
      body,
    });
    assert.equal(withOrigin.status, 403);
    const withFetchSite = await rawRequest(port, '/command', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'sec-fetch-site': 'same-origin' },
      body,
    });
    assert.equal(withFetchSite.status, 403);
    assert.equal(server.pendingCommandCount, 0);
  } finally {
    await server.stop();
  }
});

test('/next and /result accept only the pinned extension origin', async () => {
  const port = await freePort();
  const server = new ChromeBridgeServer({ extensionId: EXTENSION_ID, port });
  try {
    await server.start();
    assert.equal(isExtensionRequestAllowed({ origin: EXTENSION_ORIGIN }, EXTENSION_ORIGIN), true);
    assert.equal(isExtensionRequestAllowed({ origin: 'https://example.com' }, EXTENSION_ORIGIN), false);
    assert.equal(isExtensionRequestAllowed({}, EXTENSION_ORIGIN), false);
    const denied = await rawRequest(port, '/next?timeoutMs=0', {
      headers: { origin: 'https://example.com' },
    });
    assert.equal(denied.status, 403);
    const deniedResult = await rawRequest(port, '/result', {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: 'https://example.com' },
      body: JSON.stringify({ protocol: 1, id: 'x', ok: true }),
    });
    assert.equal(deniedResult.status, 403);
    const allowed = await rawRequest(port, '/next?timeoutMs=0', {
      headers: { origin: EXTENSION_ORIGIN },
    });
    assert.equal(allowed.status, 204);
  } finally {
    await server.stop();
  }
});

test('unknown protocol fails closed without echoing the body', async () => {
  const port = await freePort();
  const server = new ChromeBridgeServer({ extensionId: EXTENSION_ID, port });
  try {
    await server.start();
    const secret = 'sk-secret-grant-material-zzz';
    const bad = await rawRequest(port, '/command', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ protocol: 999, id: 'bad-1', sessionKey: secret, grantId: secret, kind: 'tabs' }),
    });
    assert.equal(bad.status, 400);
    assert.ok(!bad.text.includes(secret));
    assert.ok(!bad.text.includes('999') || bad.text.includes('invalid bridge command'));
  } finally {
    await server.stop();
  }
});

test('command/result byte caps reject oversize payloads without echo', async () => {
  const port = await freePort();
  const server = new ChromeBridgeServer({
    extensionId: EXTENSION_ID,
    port,
    maxRequestBytes: 64,
    maxResultBytes: 64,
  });
  try {
    await server.start();
    const big = await rawRequest(port, '/command', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(testCommand(server, 'oversize-command-payload-marker-12345'.padEnd(200, 'x'))),
    });
    assert.equal(big.status, 413);
    assert.ok(!big.text.includes('oversize-command-payload-marker'));
    const bigResult = await rawRequest(port, '/result', {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: EXTENSION_ORIGIN },
      body: JSON.stringify({ protocol: 1, id: 'r1', ok: true, data: 'y'.repeat(500) }),
    });
    assert.equal(bigResult.status, 413);
  } finally {
    await server.stop();
  }
});

test('full roundtrip: client command reaches extension poll and resolves', async () => {
  const port = await freePort();
  const server = new ChromeBridgeServer({ extensionId: EXTENSION_ID, port });
  const client = new ChromeBridgeClient({ port });
  try {
    await server.start();
    registerTestTarget(server);
    const send = client.send(testCommand(server, 'roundtrip-1'));
    const next = await rawRequest(port, '/next?timeoutMs=5000&protocol=1&instanceId=inst-test-001&family=chrome&version=1.0.0&caps=', {
      headers: { origin: EXTENSION_ORIGIN },
    });
    assert.equal(next.status, 200);
    const picked = JSON.parse(next.text) as ChromeBridgeCommand;
    assert.equal(picked.id, 'roundtrip-1');
    assert.equal(picked.kind, 'execute');
    const posted = await rawRequest(port, '/result', {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: EXTENSION_ORIGIN },
      body: JSON.stringify({ protocol: 1, id: 'roundtrip-1', ok: true, data: { tabs: 1 } }),
    });
    assert.equal(posted.status, 200);
    const result = await send;
    assert.equal(result.ok, true);
    assert.equal(result.id, 'roundtrip-1');
  } finally {
    await server.stop();
  }
});

test('command times out with chrome_timeout when the extension never answers', async () => {
  const port = await freePort();
  const server = new ChromeBridgeServer({ extensionId: EXTENSION_ID, port, commandTimeoutMs: 50 });
  const client = new ChromeBridgeClient({ port, timeoutMs: 5_000 });
  try {
    await server.start();
    registerTestTarget(server);
    await assert.rejects(client.send(testCommand(server, 'timeout-1')), /timed out/);
  } finally {
    await server.stop();
  }
});

test('abort cancels the in-flight command and purges the queue', async () => {
  const port = await freePort();
  const server = new ChromeBridgeServer({ extensionId: EXTENSION_ID, port, commandTimeoutMs: 5_000 });
  const client = new ChromeBridgeClient({ port, timeoutMs: 5_000 });
  try {
    await server.start();
    const controller = new AbortController();
    registerTestTarget(server);
    const send = client.send(testCommand(server, 'abort-1'), { signal: controller.signal });
    controller.abort();
    await assert.rejects(send, /aborted/);
    assert.equal(server.pendingResultCount, 0);
  } finally {
    await server.stop();
  }
});

test('revoke purges the queue and withholds late results (never success-after-revoke)', async () => {
  const port = await freePort();
  const server = new ChromeBridgeServer({ extensionId: EXTENSION_ID, port, commandTimeoutMs: 5_000 });
  const client = new ChromeBridgeClient({ port, timeoutMs: 5_000 });
  try {
    await server.start();
    registerTestTarget(server);
    const send = client.send(testCommand(server, 'revoke-1'));
    // Wait until the server registered the command, then revoke before pickup.
    for (let i = 0; i < 100 && server.pendingResultCount === 0; i++) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(server.pendingResultCount, 1);
    server.revokeAll();
    await assert.rejects(send, /revoked/);
    assert.equal(server.pendingCommandCount, 0);
    // Late extension result is acknowledged but withheld, never delivered.
    const late = await rawRequest(port, '/result', {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: EXTENSION_ORIGIN },
      body: JSON.stringify({ protocol: 1, id: 'revoke-1', ok: true, data: 'late' }),
    });
    assert.equal(late.status, 200);
    const ack = JSON.parse(late.text) as { withheld: boolean };
    assert.equal(ack.withheld, true);
    assert.equal(server.isWithheld('revoke-1'), true);
  } finally {
    await server.stop();
  }
});

test('foreign-protocol port occupant reports conflict and never forwards', async () => {
  const port = await freePort();
  const foreign = http.createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ hello: 'foreign' }));
  });
  await new Promise<void>((resolve) => {
    foreign.listen(port, CHROME_BRIDGE_HOST, resolve);
  });
  try {
    assert.equal(await probeBridgeHandshake(port, { timeoutMs: 1_000 }), false);
    const server = new ChromeBridgeServer({ extensionId: EXTENSION_ID, port });
    await assert.rejects(server.start(), ChromeBridgeConflictError);
  } finally {
    await new Promise<void>((resolve) => {
      foreign.close(() => {
        resolve();
      });
    });
  }
});

test('EADDRINUSE sharing allowed only after our handshake answers', async () => {
  const port = await freePort();
  const first = new ChromeBridgeServer({ extensionId: EXTENSION_ID, port });
  try {
    await first.start();
    assert.equal(await probeBridgeHandshake(port, { timeoutMs: 1_000 }), true);
    const second = new ChromeBridgeServer({ extensionId: EXTENSION_ID, port });
    await second.start();
    assert.equal(second.isShared, true);
    await second.stop();
    assert.equal(first.isShared, false);
  } finally {
    await first.stop();
  }
});

test('duplicate command ids rejected; unknown paths 404', async () => {
  const port = await freePort();
  const server = new ChromeBridgeServer({ extensionId: EXTENSION_ID, port, commandTimeoutMs: 5_000 });
  const client = new ChromeBridgeClient({ port, timeoutMs: 5_000 });
  try {
    await server.start();
    registerTestTarget(server);
    const first = client.send(testCommand(server, 'dup-1'));
    const dup = await rawRequest(port, '/command', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(testCommand(server, 'dup-1')),
    });
    assert.equal(dup.status, 409);
    server.revokeAll();
    await assert.rejects(first, /revoked/);
    const unknown = await rawRequest(port, '/nope');
    assert.equal(unknown.status, 404);
  } finally {
    await server.stop();
  }
});

test('bridge module never logs request bodies', async () => {
  const source = await readFile(new URL('../src/chrome-profile-bridge.ts', import.meta.url), 'utf8');
  assert.ok(!source.includes('127.0.0.2'));
  assert.ok(!source.includes('0.0.0.0'));
  assert.equal(/console\.(log|info|debug|warn)\(/.test(source), false, 'no console log/info/debug/warn in bridge');
  const bodyUses = source.match(/body\.text/g) ?? [];
  const parsedUses = source.match(/JSON\.parse\(body\.text\)/g) ?? [];
  assert.ok(bodyUses.length > 0, 'bridge reads request bodies');
  assert.equal(bodyUses.length, parsedUses.length, 'body.text only parsed, never echoed or logged');
  assert.ok(source.includes("CHROME_BRIDGE_HOST = '127.0.0.1'"));
});

test('POST /next rejected: canonical poll is GET /next (mismatch resolved)', async () => {
  const port = await freePort();
  const server = new ChromeBridgeServer({ extensionId: EXTENSION_ID, port });
  try {
    await server.start();
    const bad = await rawRequest(port, '/next', {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: EXTENSION_ORIGIN },
      body: JSON.stringify({ protocol: 1 }),
    });
    assert.equal(bad.status, 405);
  } finally {
    await server.stop();
  }
});

test('GET /next upserts instance registry and heartbeats; strict version/caps', async () => {
  const port = await freePort();
  const server = new ChromeBridgeServer({ extensionId: EXTENSION_ID, port });
  try {
    await server.start();
    const poll = await rawRequest(
      port,
      '/next?timeoutMs=0&protocol=1&instanceId=inst-reg-001&family=chromium&version=1.0.0&caps=closed-union-v1',
      { headers: { origin: EXTENSION_ORIGIN } },
    );
    assert.equal(poll.status, 204);
    assert.equal(server.liveInstanceCount, 1);
    const listed = server.listInstances();
    assert.equal(listed[0]?.instanceId, 'inst-reg-001');
    assert.equal(listed[0]?.family, 'chromium');
    assert.equal(listed[0]?.version, '1.0.0');
    const badVersion = await rawRequest(
      port,
      '/next?timeoutMs=0&protocol=9&instanceId=inst-reg-002&family=chromium&version=1.0.0',
      { headers: { origin: EXTENSION_ORIGIN } },
    );
    assert.equal(badVersion.status, 400);
    assert.ok(badVersion.text.includes('chrome_version_mismatch'));
    const badClaim = await rawRequest(port, '/next?timeoutMs=0&protocol=1&instanceId=x&family=chromium&version=1.0.0', {
      headers: { origin: EXTENSION_ORIGIN },
    });
    assert.equal(badClaim.status, 400);
  } finally {
    await server.stop();
  }
});

test('POST /register pins extension origin and validates claims strictly', async () => {
  const port = await freePort();
  const server = new ChromeBridgeServer({ extensionId: EXTENSION_ID, port });
  try {
    await server.start();
    const denied = await rawRequest(port, '/register', {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: 'https://example.com' },
      body: JSON.stringify({ protocol: 1, instanceId: 'inst-reg-010', family: 'chromium', version: '1.0.0' }),
    });
    assert.equal(denied.status, 403);
    const ok = await rawRequest(port, '/register', {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: EXTENSION_ORIGIN },
      body: JSON.stringify({ protocol: 1, instanceId: 'inst-reg-010', family: 'chromium', version: '1.0.0', caps: '' }),
    });
    assert.equal(ok.status, 200);
    assert.equal(server.liveInstanceCount, 1);
    const bad = await rawRequest(port, '/register', {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: EXTENSION_ORIGIN },
      body: JSON.stringify({ protocol: 1, instanceId: 'inst-reg-011', family: 'chromium', version: 'bogus' }),
    });
    assert.equal(bad.status, 400);
  } finally {
    await server.stop();
  }
});

test('multi-instance same-family conflict fails closed via hasFamilyConflict; stale purged', async () => {
  const port = await freePort();
  let at = 1_000_000;
  const server = new ChromeBridgeServer({ extensionId: EXTENSION_ID, port, now: () => at });
  try {
    await server.start();
    server.registerInstance({ instanceId: 'inst-conf-001', family: 'chromium', version: '1.0.0', caps: '' });
    assert.equal(server.hasFamilyConflict('chromium'), false);
    server.registerInstance({ instanceId: 'inst-conf-002', family: 'chromium', version: '1.0.0', caps: '' });
    assert.equal(server.hasFamilyConflict('chromium'), true);
    assert.equal(server.hasFamilyConflict('firefox'), false);
    at += 91_000;
    assert.deepEqual(server.purgeStaleInstances().sort(), ['inst-conf-001', 'inst-conf-002']);
    assert.equal(server.liveInstanceCount, 0);
  } finally {
    await server.stop();
  }
});
