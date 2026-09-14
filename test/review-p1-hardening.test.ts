import assert from 'node:assert/strict';
import { test } from 'node:test';
import http from 'node:http';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import {
  CHROME_BRIDGE_HOST,
  ChromeBridgeClient,
  ChromeBridgeServer,
} from '../src/chrome/chrome-profile-bridge.js';
import {
  parseChromeBridgeCommand,
  type ChromeBridgeCommand,
} from '../src/chrome/chrome-profile-contract.js';
import { ChromeProfileAdapter } from '../src/chrome/chrome-profile-adapter.js';
import { ChromeProfileAuth } from '../src/chrome/chrome-profile-auth.js';
import {
  buildCliEnvironment,
  populateCliCorpus,
  tryServeCliCorpusAction,
} from '../src/cli/cli-backend.js';
import { createWebAccessContentStore } from '../src/web/access/web-access-content-store.js';

const EXTENSION_ID = 'abcdefghijklmnopqrstuvwxyzabcdef';
const TARGET_A = 'inst-target-aaa1';
const TARGET_B = 'inst-target-bbb2';

function cmd(server: ChromeBridgeServer, id: string, target = TARGET_A, token?: string): ChromeBridgeCommand {
  return {
    protocol: 1, id, sessionKey: 'sk', grantId: 'g',
    targetInstanceId: target, bridgeToken: token ?? server.bridgeToken,
    kind: 'execute', operation: { kind: 'tabs' },
  };
}

function freePort(): Promise<number> {
  const s = http.createServer();
  return new Promise((resolve, reject) => {
    s.listen(0, CHROME_BRIDGE_HOST, () => {
      const a = s.address();
      const port = typeof a === 'object' && a !== null ? a.port : 0;
      if (port <= 0) {
        s.close(() => reject(new Error('freePort: ephemeral bind returned no port')));
        return;
      }
      s.close(() => resolve(port));
    });
    s.on('error', reject);
  });
}

function raw(port: number, path: string, body?: string, origin?: string): Promise<{ status: number; text: string }> {
  const extensionOrigin = `chrome-extension://${EXTENSION_ID}`;
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: CHROME_BRIDGE_HOST, port, path, method: body !== undefined ? 'POST' : 'GET', headers: { origin: origin ?? extensionOrigin, ...(body !== undefined ? { 'content-length': Buffer.byteLength(body) } : {}) } },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, text: Buffer.concat(chunks).toString('utf8') }));
        res.on('error', reject);
      },
    );
    req.on('error', reject);
    req.end(body);
  });
}

function claimQuery(id: string): string {
  return `/next?timeoutMs=0&protocol=1&instanceId=${id}&family=chrome&version=1.0.0&caps=`;
}

test('contract rejects commands without target/token', () => {
  assert.throws(
    () => parseChromeBridgeCommand({ protocol: 1, id: 'a', sessionKey: 's', grantId: 'g', kind: 'revoke' }),
    /targetInstanceId/,
  );
});

test('bridge rejects token mismatch without echo; unknown target fails closed', async () => {
  const port = await freePort();
  const server = new ChromeBridgeServer({ extensionId: EXTENSION_ID, port });
  try {
    await server.start();
    server.registerInstance({ instanceId: TARGET_A, family: 'chrome', version: '1.0.0', caps: '' });
    const forged = await raw(port, '/command', JSON.stringify(cmd(server, 'forged-1', TARGET_A, 'wrong-token')), '');
    assert.equal(forged.status, 403);
    assert.ok(!forged.text.includes('wrong-token'));
    const ghost = await raw(port, '/command', JSON.stringify(cmd(server, 'ghost-1', 'inst-ghost-9999')), '');
    assert.equal(ghost.status, 409);
  } finally {
    await server.stop();
  }
});

test('per-instance queues: B never receives A-targeted authorize', async () => {
  const port = await freePort();
  const server = new ChromeBridgeServer({ extensionId: EXTENSION_ID, port, commandTimeoutMs: 5_000 });
  const client = new ChromeBridgeClient({ port, timeoutMs: 5_000 });
  try {
    await server.start();
    server.registerInstance({ instanceId: TARGET_A, family: 'chrome', version: '1.0.0', caps: '' });
    server.registerInstance({ instanceId: TARGET_B, family: 'edge', version: '1.0.0', caps: '' });
    const send = client.send(cmd(server, 'iso-1', TARGET_A));
    const pollB = await raw(port, claimQuery(TARGET_B), undefined);
    assert.equal(pollB.status, 204);
    const pollA = await raw(port, claimQuery(TARGET_A), undefined);
    assert.equal(pollA.status, 200);
    assert.equal((JSON.parse(pollA.text) as { id: string }).id, 'iso-1');
    server.revokeAll();
    await assert.rejects(send, /revoked/);
  } finally {
    await server.stop();
  }
});

test('register response pairs the session token', async () => {
  const port = await freePort();
  const server = new ChromeBridgeServer({ extensionId: EXTENSION_ID, port });
  try {
    await server.start();
    const res = await raw(
      port, '/register',
      JSON.stringify({ instanceId: TARGET_A, family: 'chrome', version: '1.0.0', caps: '' }),
      '',
    );
    // register requires extension origin
    assert.equal(res.status, 403);
    const ok = await raw(
      port,
      '/register',
      JSON.stringify({ instanceId: TARGET_A, family: 'chrome', version: '1.0.0', caps: '' }),
    );
    assert.equal(ok.status, 200);
    assert.equal((JSON.parse(ok.text) as { bridgeToken: string }).bridgeToken, server.bridgeToken);
  } finally {
    await server.stop();
  }
});

test('adapter authorize without target fails closed; sends stamp target+token', async () => {
  const sends: ChromeBridgeCommand[] = [];
  const bridge = {
    async send(c: ChromeBridgeCommand) {
      sends.push(c);
      return { protocol: 1 as const, id: c.id, ok: true as const, data: {} };
    },
  };
  const adapter = new ChromeProfileAdapter({
    auth: new ChromeProfileAuth({ now: () => 1_000_000, randomId: () => 'rid-1' }),
    bridge, bridgeToken: 'tok-1', randomId: () => 'cid-1',
  });
  const denied = await adapter.authorize(15 * 60 * 1000, true);
  assert.match(JSON.stringify(denied.details), /selected companion instance/);
  assert.equal(sends.length, 0);
  await adapter.authorize(15 * 60 * 1000, true, TARGET_A);
  assert.equal(sends.length, 1);
  assert.equal(sends[0]!.targetInstanceId, TARGET_A);
  assert.equal(sends[0]!.bridgeToken, 'tok-1');
});

test('CLI parent store round-trips web_search into retrieve; unknown id throws', () => {
  const store = createWebAccessContentStore();
  const result = populateCliCorpus(store, 'web_search', {
    content: [{ type: 'text', text: 'hits' }],
    details: { query: 'q', results: [{ title: 't', url: 'https://e.com/', snippet: 's', backend: 'brave' }] },
  });
  const responseId = (result.details as { responseId: string }).responseId;
  assert.ok(typeof responseId === 'string');
  const served = tryServeCliCorpusAction(store, { action: 'retrieve', responseId });
  assert.ok(served !== undefined);
  assert.ok(JSON.stringify(served.details).includes(responseId));
  assert.throws(() => tryServeCliCorpusAction(store, { action: 'retrieve', responseId: 'nope' }), /No stored results/);
  assert.equal(tryServeCliCorpusAction(store, { url: 'https://e.com/' }), undefined);
});

test('CLI parent replaces child-store responseId so surfaced ids resolve locally', () => {
  const store = createWebAccessContentStore();
  const result = populateCliCorpus(store, 'web_search', {
    content: [{ type: 'text', text: 'hits' }],
    details: { query: 'q', results: [{ title: 't', url: 'https://e.com/', snippet: 's', backend: 'brave' }], responseId: 'child-store-id' },
  });
  const responseId = (result.details as { responseId: string }).responseId;
  assert.ok(typeof responseId === 'string');
  assert.notEqual(responseId, 'child-store-id');
  const served = tryServeCliCorpusAction(store, { action: 'retrieve', responseId });
  assert.ok(served !== undefined);
  assert.throws(() => tryServeCliCorpusAction(store, { action: 'retrieve', responseId: 'child-store-id' }), /No stored results/);
});

test('CLI env allowlist forwards the bridge session token', () => {
  const env = buildCliEnvironment({ PATH: '/bin', PI_SEARCH_CHROME_BRIDGE_TOKEN: 'tok-abc' });
  assert.equal(env.PI_SEARCH_CHROME_BRIDGE_TOKEN, 'tok-abc');
  const empty = buildCliEnvironment({ PATH: '/bin' });
  assert.equal(empty.PI_SEARCH_CHROME_BRIDGE_TOKEN, undefined);
});

// Companion-side gates (service_worker under vm).
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const swSrc = readFileSync(join(root, 'chrome-extension', 'service_worker.js'), 'utf8');

function loadCompanion() {
  const sandbox: Record<string, unknown> = {
    console, setTimeout, clearTimeout, Date, Math, JSON, Number, String, Array, Object, Promise,
  };
  sandbox.globalThis = sandbox;
  const vmMod = vm;
  vmMod.createContext(sandbox);
  vmMod.runInContext(swSrc, sandbox, { filename: 'service_worker.js' });
  return sandbox.__atlasCompanion as Record<string, (...args: never[]) => unknown> & {
    _state: { grant: unknown; bridgeToken: string | null };
    _reset: () => void;
  };
}

test('companion rejects foreign token and wrong-target authorize', () => {
  const c = loadCompanion();
  c._reset();
  c._state.bridgeToken = 'paired-tok';
  const onAuth = c.onAuthorize as unknown as (cmd: unknown, inst?: unknown) => unknown;
  assert.throws(
    () => onAuth({ protocol: 1, id: '1', sessionKey: 's', grantId: 'g', targetInstanceId: 'i-1', bridgeToken: 'evil', kind: 'authorize', leaseExpiresAt: Date.now() + 60_000 }, { instanceId: 'i-1' }),
    /bridge token mismatch/,
  );
  assert.throws(
    () => onAuth({ protocol: 1, id: '1', sessionKey: 's', grantId: 'g', targetInstanceId: 'i-9', bridgeToken: 'paired-tok', kind: 'authorize', leaseExpiresAt: Date.now() + 60_000 }, { instanceId: 'i-1' }),
    /another companion/,
  );
  const ok = onAuth({ protocol: 1, id: '1', sessionKey: 's', grantId: 'g', targetInstanceId: 'i-1', bridgeToken: 'paired-tok', kind: 'authorize', leaseExpiresAt: Date.now() + 60_000 }, { instanceId: 'i-1' });
  assert.equal((ok as { ok: boolean }).ok, true);
  const check = c.checkExecute as unknown as (cmd: unknown, at?: unknown, inst?: unknown) => { code: string } | null;
  const gated = check({ protocol: 1, id: '2', sessionKey: 's', grantId: 'g', targetInstanceId: 'i-9', bridgeToken: 'paired-tok', kind: 'execute', operation: { kind: 'text' } }, Date.now(), { instanceId: 'i-1' });
  assert.equal(gated?.code, 'chrome_revoked');
});
