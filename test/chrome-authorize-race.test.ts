// Race regression: grant goes live only after companion authorize ACK.
// While the authorize bridge round-trip hangs, concurrent execute() must
// observe locked and send zero execute commands.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ChromeProfileAdapter } from '../src/chrome/chrome-profile-adapter.js';
import { ChromeProfileAuth } from '../src/chrome/chrome-profile-auth.js';
import type {
  ChromeBridgeCommand,
  ChromeBridgeResult,
} from '../src/chrome/chrome-profile-contract.js';

function ids() {
  let n = 0;
  return () => `id-${(n += 1)}`;
}

function okData(data: unknown, id = 'r-1'): ChromeBridgeResult {
  return { protocol: 1, id, ok: true, data };
}

function errOf(result: { details?: unknown }): string {
  const details = (result.details ?? {}) as { chromeError?: { code?: string } };
  return String(details.chromeError?.code ?? '');
}

function textOf(result: { content?: unknown }): string {
  const content = result.content as Array<{ type: string; text?: string }>;
  return content.map((c) => c.text ?? '').join('\n');
}

const TEST_TARGET = 'inst-race-001';
const TEST_TOKEN = 'tok-race-session';

test('authorize handshake: concurrent execute during hanging ack stays locked with zero execute sends', async () => {
  const sends: ChromeBridgeCommand[] = [];
  let releaseAuthorize!: (result: ChromeBridgeResult) => void;
  const authorizeGate = new Promise<ChromeBridgeResult>((resolve) => {
    releaseAuthorize = resolve;
  });
  const bridge = {
    async send(command: ChromeBridgeCommand): Promise<ChromeBridgeResult> {
      sends.push(command);
      if (command.kind === 'authorize') return authorizeGate;
      return okData({ ok: true }, command.id);
    },
    async handshake(): Promise<boolean> {
      return true;
    },
  };
  const auth = new ChromeProfileAuth({ now: () => 1_000_000, randomId: ids() });
  const adapter = new ChromeProfileAdapter({
    auth,
    bridge,
    targetInstanceId: TEST_TARGET,
    bridgeToken: TEST_TOKEN,
    randomId: ids(),
    dnsLookup: async () => [{ address: '93.184.216.34', family: 4 as const }],
  });

  // Kick off authorize; bridge ACK hangs.
  const authorizePromise = adapter.authorize(15 * 60 * 1000, true, TEST_TARGET);
  // Let the authorize send dispatch before the concurrent execute arrives.
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(auth.status().state, 'locked');
  assert.equal(auth.canExecute(), false);
  assert.equal(auth.currentGrant(), null);

  const raced = await adapter.execute({ action: 'snapshot' });
  assert.equal(errOf(raced), 'chrome_locked');
  assert.deepEqual(
    sends.filter((c) => c.kind === 'execute'),
    [],
    'zero execute sends while authorizing',
  );

  // Companion ACKs: grant goes live exactly once.
  releaseAuthorize(okData({}, 'auth-1'));
  const authorized = await authorizePromise;
  assert.equal(errOf(authorized), '');
  assert.equal(auth.status().state, 'authorized');

  const after = await adapter.execute({ action: 'snapshot' });
  assert.equal(errOf(after), '');
});

test('overlapping authorize rejects second while first commits after ACK', async () => {
  let releaseAuthorize!: (result: ChromeBridgeResult) => void;
  const authorizeGate = new Promise<ChromeBridgeResult>((resolve) => { releaseAuthorize = resolve; });
  const bridge = {
    async send(command: ChromeBridgeCommand): Promise<ChromeBridgeResult> {
      if (command.kind === 'authorize') return authorizeGate;
      return okData({}, command.id);
    },
    async handshake(): Promise<boolean> { return true; },
  };
  const auth = new ChromeProfileAuth({ now: () => 1_000_000, randomId: ids() });
  const adapter = new ChromeProfileAdapter({ auth, bridge, targetInstanceId: TEST_TARGET, bridgeToken: TEST_TOKEN, randomId: ids() });
  const first = adapter.authorize(15 * 60 * 1000, true, TEST_TARGET);
  await new Promise((resolve) => setImmediate(resolve));
  const second = await adapter.authorize(15 * 60 * 1000, true, TEST_TARGET);
  assert.equal(errOf(second), 'chrome_locked');
  releaseAuthorize(okData({}, 'auth-first'));
  assert.equal(errOf(await first), '');
  assert.equal(auth.status().state, 'authorized');
});

test('automation kill switch during hanging authorize prevents late ACK resurrection', async () => {
  let releaseAuthorize!: (result: ChromeBridgeResult) => void;
  const authorizeGate = new Promise<ChromeBridgeResult>((resolve) => { releaseAuthorize = resolve; });
  const bridge = {
    async send(command: ChromeBridgeCommand): Promise<ChromeBridgeResult> {
      if (command.kind === 'authorize') return authorizeGate;
      return okData({}, command.id);
    },
    async handshake(): Promise<boolean> { return true; },
  };
  const auth = new ChromeProfileAuth({ now: () => 1_000_000, randomId: ids() });
  const adapter = new ChromeProfileAdapter({ auth, bridge, targetInstanceId: TEST_TARGET, bridgeToken: TEST_TOKEN, randomId: ids() });
  const pending = adapter.authorize(15 * 60 * 1000, true, TEST_TARGET);
  await new Promise((resolve) => setImmediate(resolve));
  adapter.setAutomationEnabled(false);
  releaseAuthorize(okData({}, 'auth-late'));
  assert.equal(errOf(await pending), 'chrome_revoked');
  assert.deepEqual(auth.status(), { state: 'locked', reason: 'revoked' });
});

test('TTL lapsing mid-handshake rejects commit and revokes the acked companion grant', async () => {
  const sends: ChromeBridgeCommand[] = [];
  let now = 1_000_000;
  let releaseAuthorize!: (result: ChromeBridgeResult) => void;
  const authorizeGate = new Promise<ChromeBridgeResult>((resolve) => { releaseAuthorize = resolve; });
  const bridge = {
    async send(command: ChromeBridgeCommand): Promise<ChromeBridgeResult> {
      sends.push(command);
      if (command.kind === 'authorize') return authorizeGate;
      return okData({}, command.id);
    },
    async handshake(): Promise<boolean> { return true; },
  };
  const auth = new ChromeProfileAuth({ now: () => now, randomId: ids() });
  const adapter = new ChromeProfileAdapter({ auth, bridge, targetInstanceId: TEST_TARGET, bridgeToken: TEST_TOKEN, randomId: ids() });
  const pending = adapter.authorize(60 * 1000, true, TEST_TARGET);
  await new Promise((resolve) => setImmediate(resolve));
  now += 60 * 1000 + 1;
  releaseAuthorize(okData({}, 'auth-stale'));
  assert.equal(errOf(await pending), 'chrome_revoked');
  assert.equal(auth.status().state, 'locked');
  const authorizeCmd = sends.find((c) => c.kind === 'authorize');
  assert.ok(authorizeCmd !== undefined && authorizeCmd.kind === 'authorize');
  const cleanup = sends.filter((c) => c.kind === 'revoke');
  assert.equal(cleanup.length, 1);
  assert.ok(cleanup[0] !== undefined && cleanup[0].kind === 'revoke');
  if (authorizeCmd.kind === 'authorize' && cleanup[0] !== undefined && cleanup[0].kind === 'revoke') {
    assert.equal(cleanup[0].sessionKey, authorizeCmd.sessionKey);
    assert.equal(cleanup[0].grantId, authorizeCmd.grantId);
  }
});
test('authorize nack leaves state locked; no live grant', async () => {
  const sends: ChromeBridgeCommand[] = [];
  const bridge = {
    async send(command: ChromeBridgeCommand): Promise<ChromeBridgeResult> {
      sends.push(command);
      if (command.kind === 'authorize') {
        return { protocol: 1, id: command.id, ok: false, error: { code: 'chrome_extension_unavailable', message: 'no ext', retryable: true } } as ChromeBridgeResult;
      }
      return okData({}, command.id);
    },
    async handshake(): Promise<boolean> {
      return true;
    },
  };
  const auth = new ChromeProfileAuth({ now: () => 1_000_000, randomId: ids() });
  const adapter = new ChromeProfileAdapter({
    auth,
    bridge,
    targetInstanceId: TEST_TARGET,
    bridgeToken: TEST_TOKEN,
    randomId: ids(),
  });
  const result = await adapter.authorize(15 * 60 * 1000, true, TEST_TARGET);
  assert.equal(errOf(result), 'chrome_extension_unavailable');
  assert.equal(auth.status().state, 'locked');
  assert.equal(textOf(await adapter.execute({ action: 'snapshot' })).includes('locked') || errOf(await adapter.execute({ action: 'snapshot' })) === 'chrome_locked', true);
});

test('revoke during hanging authorize discards staged grant; late ack never resurrects', async () => {
  let releaseAuthorize!: (result: ChromeBridgeResult) => void;
  const authorizeGate = new Promise<ChromeBridgeResult>((resolve) => {
    releaseAuthorize = resolve;
  });
  const bridge = {
    async send(command: ChromeBridgeCommand): Promise<ChromeBridgeResult> {
      if (command.kind === 'authorize') return authorizeGate;
      if (command.kind === 'revoke') return okData({}, command.id);
      return okData({}, command.id);
    },
    async handshake(): Promise<boolean> {
      return true;
    },
  };
  const auth = new ChromeProfileAuth({ now: () => 1_000_000, randomId: ids() });
  const adapter = new ChromeProfileAdapter({
    auth,
    bridge,
    targetInstanceId: TEST_TARGET,
    bridgeToken: TEST_TOKEN,
    randomId: ids(),
  });
  const authorizePromise = adapter.authorize(15 * 60 * 1000, true, TEST_TARGET);
  await new Promise((resolve) => setImmediate(resolve));
  await adapter.revoke('user');
  releaseAuthorize(okData({}, 'auth-late'));
  const late = await authorizePromise;
  assert.equal(errOf(late), 'chrome_revoked');
  assert.equal(auth.status().state, 'locked');
});
