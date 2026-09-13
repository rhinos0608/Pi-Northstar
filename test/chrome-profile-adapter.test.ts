// Worker 4 adapter tests: lock, allowlist, DNS/freeze, envelopes, outputs.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ChromeProfileAdapter } from '../src/chrome-profile-adapter.js';
import { ChromeProfileAuth } from '../src/chrome-profile-auth.js';
import { ChromeBridgeError } from '../src/chrome-profile-bridge.js';
import type {
  ChromeBridgeCommand,
  ChromeBridgeResult,
} from '../src/chrome-profile-contract.js';

function fakeClock(start = 1_000_000) {
  let t = start;
  return { now: () => t, advance: (ms: number) => { t += ms; } };
}

function ids() {
  let n = 0;
  return () => `id-${(n += 1)}`;
}

function publicDns() {
  return async () => [{ address: '93.184.216.34', family: 4 as const }];
}

interface FakeBridge {
  sends: ChromeBridgeCommand[];
  handler: (command: ChromeBridgeCommand) => ChromeBridgeResult | Promise<ChromeBridgeResult>;
  fail?: Error | undefined;
  send(command: ChromeBridgeCommand): Promise<ChromeBridgeResult>;
  handshake(): Promise<boolean>;
}

function fakeBridge(
  handler: (command: ChromeBridgeCommand) => ChromeBridgeResult | Promise<ChromeBridgeResult>,
): FakeBridge {
  const sends: ChromeBridgeCommand[] = [];
  return {
    sends,
    handler,
    fail: undefined,
    async send(command: ChromeBridgeCommand): Promise<ChromeBridgeResult> {
      sends.push(command);
      if (this.fail !== undefined) throw this.fail;
      return this.handler(command);
    },
    async handshake(): Promise<boolean> {
      return true;
    },
  };
}

function okData(data: unknown, id = 'r-1'): ChromeBridgeResult {
  return { protocol: 1, id, ok: true, data };
}

function detailsOf(result: { details?: unknown }): Record<string, unknown> {
  return (result.details ?? {}) as Record<string, unknown>;
}

function textOf(result: { content?: unknown }): string {
  const content = result.content as Array<{ type: string; text?: string }>;
  return content.map((c) => c.text ?? '').join('\n');
}

const TEST_TARGET = 'inst-test-001';
const TEST_TOKEN = 'tok-test-session';

async function authorizedAdapter(
  bridge: FakeBridge,
  ttlMs: number | null = 15 * 60 * 1000,
): Promise<{ adapter: ChromeProfileAdapter; auth: ChromeProfileAuth }> {
  const auth = new ChromeProfileAuth({ now: fakeClock().now, randomId: ids() });
  const adapter = new ChromeProfileAdapter({
    auth,
    bridge,
    targetInstanceId: TEST_TARGET,
    bridgeToken: TEST_TOKEN,
    randomId: ids(),
    dnsLookup: publicDns(),
  });
  const result = await adapter.authorize(ttlMs, true, TEST_TARGET);
  assert.equal(detailsOf(result)['chromeError'], undefined);
  return { adapter, auth };
}

test('pre-auth execute returns chrome_locked with zero bridge sends', async () => {
  const bridge = fakeBridge((command) => okData({}, command.id));
  const adapter = new ChromeProfileAdapter({
    auth: new ChromeProfileAuth({ now: fakeClock().now, randomId: ids() }),
    bridge,
    randomId: ids(),
    dnsLookup: publicDns(),
  });
  const result = await adapter.execute({ action: 'snapshot' });
  assert.equal(bridge.sends.length, 0);
  const chromeError = detailsOf(result)['chromeError'] as { code: string };
  assert.equal(chromeError.code, 'chrome_locked');
});

test('unconfirmed authorize stays locked; automation kill switch blocks authorize+execute', async () => {
  const bridge = fakeBridge((command) => okData({}, command.id));
  const adapter = new ChromeProfileAdapter({
    auth: new ChromeProfileAuth({ now: fakeClock().now, randomId: ids() }),
    bridge,
    randomId: ids(),
    dnsLookup: publicDns(),
  });
  const denied = await adapter.authorize(15 * 60 * 1000, false);
  assert.equal((detailsOf(denied)['chromeError'] as { code: string }).code, 'chrome_locked');
  assert.equal(adapter.status().state, 'locked');
  assert.equal(bridge.sends.length, 0);

  adapter.setAutomationEnabled(false);
  const blocked = await adapter.authorize(15 * 60 * 1000, true);
  assert.equal((detailsOf(blocked)['chromeError'] as { code: string }).code, 'chrome_locked');
  const execBlocked = await adapter.execute({ action: 'snapshot' });
  assert.equal((detailsOf(execBlocked)['chromeError'] as { code: string }).code, 'chrome_locked');
});

test('failed handshake leaves state locked', async () => {
  const bridge = fakeBridge((command) => okData({}, command.id));
  bridge.fail = new ChromeBridgeError('chrome_extension_unavailable', 'no ext', true, 503);
  const adapter = new ChromeProfileAdapter({
    auth: new ChromeProfileAuth({ now: fakeClock().now, randomId: ids() }),
    bridge,
    randomId: ids(),
    dnsLookup: publicDns(),
  });
  const result = await adapter.authorize(15 * 60 * 1000, true, TEST_TARGET);
  assert.equal((detailsOf(result)['chromeError'] as { code: string }).code, 'chrome_extension_unavailable');
  assert.equal(adapter.status().state, 'locked');
});

test('denied actions never dispatch, even with ALLOW_SENSITIVE=1', async () => {
  const bridge = fakeBridge((command) => okData({}, command.id));
  const { adapter } = await authorizedAdapter(bridge);
  const before = bridge.sends.length;
  for (const action of ['evaluate', 'html', 'cookies', 'set_cookies', 'batch', 'job']) {
    const result = await adapter.execute({ action, expression: 'x', batch: {}, job: {} });
    const chromeError = detailsOf(result)['chromeError'] as { code: string };
    assert.equal(chromeError.code, 'chrome_invalid_request', action);
  }
  assert.equal(bridge.sends.length, before);
});

test('navigate validates, preflights DNS, and freezes exact hostname', async () => {
  const bridge = fakeBridge((command) => {
    if (command.kind === 'authorize') return okData({}, command.id);
    if (command.kind !== 'execute' || command.operation.kind !== 'navigate') {
      throw new Error('expected navigate');
    }
    return okData({ navigated: true }, command.id);
  });
  const { adapter } = await authorizedAdapter(bridge);
  const sendsBefore = bridge.sends.length;
  const first = await adapter.execute({ action: 'navigate', url: 'https://example.com/a' });
  assert.equal(textOf(first).includes('navigated'), true);
  assert.equal(adapter.frozenHost(), 'example.com');
  const nav = bridge.sends[bridge.sends.length - 1]!;
  assert.equal(nav.kind, 'execute');
  if (nav.kind === 'execute') {
    assert.equal(nav.operation.kind, 'navigate');
    if (nav.operation.kind === 'navigate') assert.equal(nav.operation.frozenHostname, 'example.com');
  }

  // Cross-host blocked pre-dispatch.
  const count = bridge.sends.length;
  const cross = await adapter.execute({ action: 'navigate', url: 'https://other.example/b' });
  assert.equal((detailsOf(cross)['chromeError'] as { code: string }).code, 'chrome_domain_blocked');
  assert.equal(bridge.sends.length, count);
  assert.ok(sendsBefore >= 1);
});

test('snapshot/text/screenshot convert safely; typed values never echo', async () => {
  const bridge = fakeBridge((command) => {
    if (command.kind === 'authorize') return okData({}, command.id);
    if (command.kind !== 'execute') throw new Error('expected execute');
    const op = command.operation;
    switch (op.kind) {
      case 'snapshot':
        return okData({ snapshot: `root ${command.sessionKey} tail` }, command.id);
      case 'text':
        return okData({ text: `hello ${command.grantId}` }, command.id);
      case 'screenshot':
        return okData({ screenshotBase64: 'aGVsbG8=' }, command.id);
      case 'type':
      case 'fill':
        return okData({ typed: true }, command.id);
      default:
        return okData({ ok: true }, command.id);
    }
  });
  const { adapter } = await authorizedAdapter(bridge);
  const secret = bridge.sends[0]!.sessionKey;

  const snap = await adapter.execute({ action: 'snapshot' });
  assert.ok(!textOf(snap).includes(secret));

  const text = await adapter.execute({ action: 'text' });
  const textCommand = bridge.sends.find((command) => command.kind === 'execute' && command.operation.kind === 'text');
  assert.ok(textCommand?.kind === 'execute');
  assert.equal(textCommand.grantId, bridge.sends[0]!.grantId);
  assert.ok(!textOf(text).includes(textCommand.grantId));

  const typedSecret = 's3cr3t-typed-value';
  const typed = await adapter.execute({ action: 'type', selector: '@e1', text: typedSecret });
  assert.ok(!textOf(typed).includes(typedSecret));
  assert.ok(!JSON.stringify(detailsOf(typed)).includes(typedSecret));

  const shot = await adapter.execute({ action: 'screenshot' });
  const content = shot.content as Array<{ type: string; mimeType?: string; data?: string }>;
  assert.equal(content[0]!.type, 'image');
  assert.equal(content[0]!.mimeType, 'image/png');
  assert.equal(content[0]!.data, 'aGVsbG8=', 'image carries base64');
  const nonImageText = content.filter((c) => c.type !== 'image').map((c) => JSON.stringify(c)).join('\n');
  assert.ok(!nonImageText.includes('aGVsbG8='), 'no text content carries base64');
  assert.ok(!JSON.stringify(detailsOf(shot)).includes('aGVsbG8='));
});

test('revoke locks sync then best-effort remote cleanup; shutdown clears freeze', async () => {
  const bridge = fakeBridge((command) => okData({ revoked: true }, command.id));
  const { adapter } = await authorizedAdapter(bridge);
  await adapter.execute({ action: 'navigate', url: 'https://example.com/' });
  assert.equal(adapter.frozenHost(), 'example.com');
  const revoked = await adapter.revoke('user');
  assert.equal(textOf(revoked).includes('revoked'), true);
  assert.equal(adapter.status().state, 'locked');
  assert.equal(adapter.frozenHost(), null);
  assert.ok(bridge.sends.some((c) => c.kind === 'revoke'));
  // Post-revoke execute locked with no further execute sends.
  const count = bridge.sends.length;
  const after = await adapter.execute({ action: 'snapshot' });
  assert.equal((detailsOf(after)['chromeError'] as { code: string }).code, 'chrome_locked');
  assert.equal(bridge.sends.length, count);

  const bridge2 = fakeBridge((command) => okData({}, command.id));
  const second = await authorizedAdapter(bridge2);
  await second.adapter.execute({ action: 'navigate', url: 'https://example.com/' });
  await second.adapter.shutdown();
  assert.deepEqual(second.adapter.status(), { state: 'locked', reason: 'shutdown' });
});

test('failed navigate does not strand the hostname freeze', async () => {
  const bridge = fakeBridge((command) => {
    if (command.kind === 'execute') throw new ChromeBridgeError('chrome_extension_unavailable', 'companion gone', true, 503);
    return okData({}, command.id);
  });
  const { adapter } = await authorizedAdapter(bridge);
  const failed = await adapter.execute({ action: 'navigate', url: 'https://example.com/' });
  assert.equal((detailsOf(failed)['chromeError'] as { code: string }).code, 'chrome_extension_unavailable');
  assert.equal(adapter.frozenHost(), null);
  bridge.handler = (command) => okData({}, command.id);
  const retried = await adapter.execute({ action: 'navigate', url: 'https://wikipedia.org/' });
  assert.equal(detailsOf(retried)['chromeError'], undefined);
  assert.equal(adapter.frozenHost(), 'wikipedia.org');
});

test('doctor reveals reachability/auth/latency only, never tab URL/title', async () => {
  const bridge = fakeBridge((command) => okData({}, command.id));
  const { adapter } = await authorizedAdapter(bridge);
  const result = await adapter.doctor();
  assert.equal(result.protocol, 1);
  assert.equal(result.bridgeReachable, true);
  assert.equal(result.authorized, true);
  assert.ok(typeof result.latencyMs === 'number');
  assert.ok(!JSON.stringify(result).includes('http'));
});
