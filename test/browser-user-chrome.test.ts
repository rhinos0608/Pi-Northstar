// User-Chromium runtime wiring: DNR planning, typed purge, renew routing,
// registry selection over bridge instances, isolated fallback.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CHROME_DNR_ALLOW_RULE_ID, CHROME_DNR_DENY_RULE_ID, CHROME_DNR_RULE_BASE } from '../src/chrome-profile-contract.js';
import { ChromeProfileAdapter } from '../src/chrome-profile-adapter.js';
import { ChromeBridgeError } from '../src/chrome-profile-bridge.js';
import type { ChromeBridgeCommand, ChromeBridgeResult } from '../src/chrome-profile-contract.js';
import { selectBridgeCompanion } from '../src/chrome-companion-selection.js';
import {
  browser,
  createUserChromeController,
  getUserChromeController,
  renewUserChromeLeaseIfDue,
  resetUserChromeForTest,
  userChromeStatus,
} from '../src/browser-tools.js';

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
  fail?: Error | undefined;
  handler: (command: ChromeBridgeCommand) => ChromeBridgeResult | Promise<ChromeBridgeResult>;
  send(command: ChromeBridgeCommand): Promise<ChromeBridgeResult>;
  handshake(): Promise<boolean>;
}

function fakeBridge(handler: FakeBridge['handler']): FakeBridge {
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

function typedMemoryOf(adapter: ChromeProfileAdapter): string[] {
  return (adapter as unknown as { typedMemory: string[] }).typedMemory;
}

function detailsOf(result: { details?: unknown }): Record<string, unknown> {
  return (result.details ?? {}) as Record<string, unknown>;
}

async function authorizedController(ttlMs: number | null = 15 * 60 * 1000) {
  const clock = fakeClock();
  const bridge = fakeBridge((command) => okData({}, command.id));
  const controller = createUserChromeController({
    bridge,
    targetInstanceId: 'inst-test-001',
    bridgeToken: 'tok-test-session',
    now: clock.now,
    randomId: ids(),
    dnsLookup: publicDns(),
  });
  const result = await controller.adapter.authorize(ttlMs, true, 'inst-test-001');
  assert.equal(detailsOf(result)['chromeError'], undefined);
  return { controller, bridge, clock };
}

test('DNR rule ids share the companion ruleBase planning', () => {
  assert.equal(CHROME_DNR_RULE_BASE, 1000);
  assert.equal(CHROME_DNR_DENY_RULE_ID, 1000);
  assert.equal(CHROME_DNR_ALLOW_RULE_ID, 1001);
});

test('revoke/shutdown/kill-switch purge typed values', async () => {
  const { controller, bridge } = await authorizedController();
  const typed = await controller.adapter.execute({ action: 'type', selector: '@e1', text: 'purge-me-secret' });
  assert.equal(detailsOf(typed)['chromeError'], undefined);
  assert.ok(typedMemoryOf(controller.adapter).length > 0);

  await controller.adapter.revoke('user');
  assert.equal(typedMemoryOf(controller.adapter).length, 0);
  assert.equal(bridge.sends.some((c) => c.kind === 'revoke'), true);

  const second = await authorizedController();
  await second.controller.adapter.execute({ action: 'type', selector: '@e1', text: 'purge-me-too' });
  assert.ok(typedMemoryOf(second.controller.adapter).length > 0);
  await second.controller.adapter.shutdown();
  assert.equal(typedMemoryOf(second.controller.adapter).length, 0);

  const third = await authorizedController();
  await third.controller.adapter.execute({ action: 'type', selector: '@e1', text: 'purge-three' });
  third.controller.adapter.setAutomationEnabled(false);
  assert.equal(typedMemoryOf(third.controller.adapter).length, 0);
});

test('failed authorize purges typed values and stays locked', async () => {
  const { controller, bridge } = await authorizedController();
  await controller.adapter.execute({ action: 'type', selector: '@e1', text: 'typed-before-failure' });
  assert.ok(typedMemoryOf(controller.adapter).length > 0);
  bridge.fail = new ChromeBridgeError('chrome_extension_unavailable', 'bridge down', true, 503);
  const result = await controller.adapter.authorize(15 * 60 * 1000, true, 'inst-test-001');
  assert.equal((detailsOf(result)['chromeError'] as { code: string }).code, 'chrome_extension_unavailable');
  assert.equal(controller.adapter.status().state, 'locked');
  assert.equal(typedMemoryOf(controller.adapter).length, 0);
});

test('renewLease sends renew first; bridge failure keeps local lease', async () => {
  const { controller, bridge, clock } = await authorizedController();
  const before = controller.auth.currentGrant()!.leaseExpiresAt;
  // Lease max 60s, renewal due when <=30s remain: advancing 35s leaves 25s, inside window.
  clock.advance(35_000);
  const renewed = await controller.adapter.renewLease();
  assert.equal(detailsOf(renewed)['chromeError'], undefined);
  const renewCmd = bridge.sends.find((c) => c.kind === 'renew');
  assert.ok(renewCmd !== undefined && renewCmd.kind === 'renew');
  assert.ok(controller.auth.currentGrant()!.leaseExpiresAt > before);

  // Send-first failure: local lease untouched, no divergence.
  const leaseBeforeFail = controller.auth.currentGrant()!.leaseExpiresAt;
  bridge.fail = new ChromeBridgeError('chrome_extension_unavailable', 'bridge down', true, 503);
  const failed = await controller.adapter.renewLease();
  assert.equal((detailsOf(failed)['chromeError'] as { code: string }).code, 'chrome_extension_unavailable');
  assert.equal(controller.auth.currentGrant()!.leaseExpiresAt, leaseBeforeFail);
});

test('renewLease while locked fails closed with zero sends', async () => {
  const bridge = fakeBridge((command) => okData({}, command.id));
  const controller = createUserChromeController({ bridge, now: fakeClock().now, randomId: ids(), dnsLookup: publicDns() });
  const result = await controller.adapter.renewLease();
  assert.equal((detailsOf(result)['chromeError'] as { code: string }).code, 'chrome_locked');
  assert.equal(bridge.sends.length, 0);
});

test('selectBridgeCompanion: stale and non-chromium dropped, ambiguity fails', () => {
  const now = 5_000_000;
  const live = { instanceId: 'i-1', family: 'chrome', version: '1.0.0', caps: 'tabs', lastSeen: now - 1_000 };
  const stale = { instanceId: 'i-2', family: 'chrome', version: '1.0.0', caps: 'tabs', lastSeen: now - 500_000 };
  const foreign = { instanceId: 'i-3', family: 'safari', version: '1.0.0', caps: 'tabs', lastSeen: now - 1_000 };

  const sole = selectBridgeCompanion({
    instances: [live, stale, foreign],
    osDefault: { family: 'chrome', isChromium: true },
    now,
  });
  assert.equal(sole.ok, true);
  if (sole.ok) assert.equal(sole.selected.instanceId, 'i-1');

  const dup = selectBridgeCompanion({
    instances: [live, { ...live, instanceId: 'i-4' }],
    osDefault: { family: 'chrome', isChromium: true },
    now,
  });
  assert.equal(dup.ok, false);
  if (!dup.ok) assert.equal(dup.kind, 'ambiguous');

  const explicit = selectBridgeCompanion({
    instances: [live],
    osDefault: { family: 'safari', isChromium: false },
    explicitFamily: 'chrome',
    now,
  });
  assert.equal(explicit.ok, true);
});

test('browser routes to user-chrome when authorized, isolated fallback when locked', async () => {
  const { controller } = await authorizedController();
  resetUserChromeForTest(controller);
  try {
    const routed = await browser({ action: 'status' }, { env: {} });
    assert.equal((detailsOf(routed) as Record<string, unknown>)['context'], 'user-chrome');
    assert.equal(userChromeStatus({}).backend, 'user-chrome');
  } finally {
    resetUserChromeForTest(null);
  }
  assert.equal(userChromeStatus({}).backend, 'isolated');
  const fallback = await browser({ action: 'status' }, { env: {} });
  assert.equal((detailsOf(fallback) as Record<string, unknown>)['backend'], 'agent-browser');
});

test('renewUserChromeLeaseIfDue no-ops outside the window', async () => {
  const { controller, bridge } = await authorizedController();
  resetUserChromeForTest(controller);
  try {
    const result = await renewUserChromeLeaseIfDue({});
    const content = result.content as Array<{ text: string }>;
    assert.deepEqual(JSON.parse(content[0]!.text), { ok: true, renewed: false });
    assert.equal(bridge.sends.some((c) => c.kind === 'renew'), false);
  } finally {
    resetUserChromeForTest(null);
  }
});

test('renewUserChromeLeaseIfDue renews past the TTL-30s window', async () => {
  const { controller, bridge, clock } = await authorizedController();
  resetUserChromeForTest(controller);
  try {
    // Past the 30s renewal threshold (60s lease - 35s elapsed = 25s remain): renew sends.
    clock.advance(35_000);
    assert.equal(controller.auth.leaseRenewalDue(), true);
    const before = controller.auth.currentGrant()!.leaseExpiresAt;
    await renewUserChromeLeaseIfDue({});
    assert.equal(bridge.sends.some((c) => c.kind === 'renew'), true);
    assert.ok(controller.auth.currentGrant()!.leaseExpiresAt > before);
  } finally {
    resetUserChromeForTest(null);
  }
});

test('singleton kill-switch sync routes via adapter and purges session secrets', async () => {
  const { controller } = await authorizedController();
  const typed = await controller.adapter.execute({ action: 'type', selector: '@e1', text: 'singleton-secret' });
  assert.equal(detailsOf(typed)['chromeError'], undefined);
  resetUserChromeForTest(controller);
  try {
    assert.ok(typedMemoryOf(controller.adapter).length > 0);
    getUserChromeController({ PI_SEARCH_BROWSER_AUTOMATION: '0' });
    assert.equal(controller.auth.isAutomationEnabled(), false);
    assert.equal(typedMemoryOf(controller.adapter).length, 0);
    assert.equal(controller.auth.status().state, 'locked');
  } finally {
    resetUserChromeForTest(null);
  }
});
