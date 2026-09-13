// Worker 4 security negatives: loopback/private/creds/mixed-DNS, sentinel
// absence, revoke race, screenshot image-only, unknown-action compatibility.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ChromeProfileAdapter } from '../src/chrome/chrome-profile-adapter.js';
import { ChromeProfileAuth } from '../src/chrome/chrome-profile-auth.js';
import type {
  ChromeBridgeCommand,
  ChromeBridgeResult,
} from '../src/chrome/chrome-profile-contract.js';

function fakeClock(start = 2_000_000) {
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

function mixedDns() {
  return async () => [
    { address: '93.184.216.34', family: 4 as const },
    { address: '10.0.0.5', family: 4 as const },
  ];
}

function sendsOf(result: { content?: unknown }): string {
  return JSON.stringify(result);
}

async function authorizedAdapter(
  sends: ChromeBridgeCommand[],
  dnsLookup?: (hostname: string) => Promise<Array<{ address: string; family: number }>>,
): Promise<ChromeProfileAdapter> {
  const auth = new ChromeProfileAuth({ now: fakeClock().now, randomId: ids() });
  const adapter = new ChromeProfileAdapter({
    auth,
    bridge: {
      async send(command: ChromeBridgeCommand): Promise<ChromeBridgeResult> {
        sends.push(command);
        return { protocol: 1, id: command.id, ok: true, data: { ok: true } };
      },
      async handshake(): Promise<boolean> {
        return true;
      },
    },
    targetInstanceId: 'inst-test-001',
    bridgeToken: 'tok-test-session',
    randomId: ids(),
    dnsLookup: (dnsLookup ?? publicDns()) as never,
  });
  const authorized = await adapter.authorize(15 * 60 * 1000, true, 'inst-test-001');
  assert.ok(!sendsOf(authorized).includes('chromeError'));
  sends.length = 0;
  return adapter;
}

test('loopback/metadata/private/credentialed targets rejected pre-bridge', async () => {
  const sends: ChromeBridgeCommand[] = [];
  const adapter = await authorizedAdapter(sends);
  const targets = [
    'http://127.0.0.1/',
    'http://localhost:3000/',
    'http://[::1]/',
    'http://169.254.169.254/latest/meta-data/',
    'http://10.0.0.5/',
    'https://user:pass@example.com/',
    'ftp://example.com/file',
  ];
  for (const url of targets) {
    const result = await adapter.execute({ action: 'navigate', url });
    const body = sendsOf(result);
    assert.ok(body.includes('chrome_domain_blocked') || body.includes('chrome_invalid_request'), url);
  }
  assert.equal(sends.length, 0);
});

test('mixed-DNS answers rejected pre-bridge', async () => {
  const sends: ChromeBridgeCommand[] = [];
  const adapter = await authorizedAdapter(sends, mixedDns());
  const result = await adapter.execute({ action: 'navigate', url: 'https://example.com/' });
  assert.ok(sendsOf(result).includes('chrome_domain_blocked'));
  assert.equal(sends.length, 0);
});

test('DNR-model freeze blocks cross-host redirect targets after first nav', async () => {
  const sends: ChromeBridgeCommand[] = [];
  const adapter = await authorizedAdapter(sends);
  const first = await adapter.execute({ action: 'navigate', url: 'https://example.com/' });
  assert.ok(!sendsOf(first).includes('chromeError'));
  assert.equal(adapter.frozenHost(), 'example.com');
  const before = sends.length;
  const second = await adapter.execute({ action: 'navigate', url: 'https://evil.example.com/' });
  assert.ok(sendsOf(second).includes('chrome_domain_blocked'));
  assert.equal(sends.length, before);
});

test('sentinels absent from results, errors, and snapshot output', async () => {
  const sends: ChromeBridgeCommand[] = [];
  const sessionSentinel = 'SESSIONKEY-SENTINEL-AAA';
  const grantSentinel = 'GRANT-SENTINEL-BBB';
  const typedSentinel = 'TYPED-SENTINEL-CCC';
  const failure: ChromeBridgeResult = {
    protocol: 1,
    id: 'x',
    ok: false,
    error: { code: 'chrome_timeout', message: `boom ${sessionSentinel}`, retryable: true },
  };
  const auth = new ChromeProfileAuth({ now: fakeClock().now, randomId: (() => {
    let n = 0;
    const values = [sessionSentinel, grantSentinel, 'nonce-sentinel'];
    return () => values[n++ % values.length]!;
  })() });
  const adapter = new ChromeProfileAdapter({
    auth,
    bridge: {
      async send(command: ChromeBridgeCommand): Promise<ChromeBridgeResult> {
        sends.push(command);
        if (command.kind === 'execute' && command.operation.kind === 'snapshot') {
          return {
            protocol: 1,
            id: command.id,
            ok: true,
            data: { snapshot: `node ${sessionSentinel} ${grantSentinel} cookie: abc` },
          };
        }
        if (command.kind === 'execute' && (command.operation.kind === 'type' || command.operation.kind === 'fill')) {
          return { protocol: 1, id: command.id, ok: true, data: { typed: true, echo: typedSentinel } };
        }
        if (command.kind === 'authorize') return { protocol: 1, id: command.id, ok: true, data: {} };
        if (command.kind === 'execute' && command.operation.kind === 'tabs') return failure;
        return { protocol: 1, id: command.id, ok: true, data: { ok: true } };
      },
    },
    targetInstanceId: 'inst-test-001',
    bridgeToken: 'tok-test-session',
    randomId: ids(),
    dnsLookup: publicDns() as never,
  });
  await adapter.authorize(15 * 60 * 1000, true, 'inst-test-001');
  const snap = await adapter.execute({ action: 'snapshot' });
  assert.ok(!sendsOf(snap).includes(sessionSentinel));
  assert.ok(!sendsOf(snap).includes(grantSentinel));
  assert.ok(!sendsOf(snap).includes(typedSentinel));

  const typed = await adapter.execute({ action: 'type', selector: '@e1', text: typedSentinel });
  assert.ok(!sendsOf(typed).includes(typedSentinel));

  const errResult = await adapter.execute({ action: 'tabs' });
  const errText = sendsOf(errResult);
  assert.ok(errText.includes('chrome_timeout'), 'failure surfaces error code');
  assert.ok(!errText.includes(sessionSentinel), 'bridge error message carries no sentinel');
});

test('revoke race never surfaces success-after-revoke', async () => {
  const sends: ChromeBridgeCommand[] = [];
  let release!: (value: ChromeBridgeResult) => void;
  const pending = new Promise<ChromeBridgeResult>((resolve) => {
    release = resolve;
  });
  const auth = new ChromeProfileAuth({ now: fakeClock().now, randomId: ids() });
  const adapter = new ChromeProfileAdapter({
    auth,
    bridge: {
      async send(command: ChromeBridgeCommand): Promise<ChromeBridgeResult> {
        sends.push(command);
        if (command.kind === 'execute') return pending;
        return { protocol: 1, id: command.id, ok: true, data: {} };
      },
    },
    targetInstanceId: 'inst-test-001',
    bridgeToken: 'tok-test-session',
    randomId: ids(),
    dnsLookup: publicDns() as never,
    revokeTimeoutMs: 50,
  });
  await adapter.authorize(15 * 60 * 1000, true, 'inst-test-001');
  const flight = adapter.execute({ action: 'snapshot' });
  await adapter.revoke('user');
  release({ protocol: 1, id: 'late', ok: true, data: { snapshot: 'late-success' } });
  const result = await flight;
  assert.ok(sendsOf(result).includes('chrome_revoked'));
  assert.ok(!sendsOf(result).includes('late-success'));
});

test('empty screenshot fails closed; unknown action fails closed without dispatch', async () => {
  const sends: ChromeBridgeCommand[] = [];
  const adapter = await authorizedAdapter(sends);
  // Bridge data carries no screenshotBase64: adapter fails closed, no image emitted.
  const shot = await adapter.execute({ action: 'screenshot' });
  assert.ok(sendsOf(shot).includes('chrome_invalid_result'));
  const dispatched = sends.length;
  // Unknown action fails closed without dispatch.
  const unknown = await adapter.execute({ action: 'nope' });
  assert.ok(sendsOf(unknown).includes('chrome_invalid_request'));
  assert.equal(sends.length, dispatched);
});
