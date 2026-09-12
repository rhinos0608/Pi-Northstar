import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  CHROME_BRIDGE_HOST,
  CHROME_BRIDGE_PORT,
  CHROME_BRIDGE_PROTOCOL,
  CHROME_LEASE_MAX_MS,
  CHROME_LEASE_RENEW_MS,
  isChromeProfileErrorCode,
  parseChromeBridgeCommand,
  parseChromeBridgeResult,
  parseChromeProfileOperation,
  ChromeProfileContractError,
} from '../src/chrome-profile-contract.js';

test('bridge constants pin loopback host and Atlas port', () => {
  assert.equal(CHROME_BRIDGE_HOST, '127.0.0.1');
  assert.equal(CHROME_BRIDGE_PORT, 17319);
  assert.equal(CHROME_BRIDGE_PROTOCOL, 1);
  assert.equal(CHROME_LEASE_MAX_MS, 60_000);
  assert.equal(CHROME_LEASE_RENEW_MS, 30_000);
});

test('error codes are the closed 11-member union', () => {
  for (const code of ['chrome_locked', 'chrome_revoked', 'chrome_extension_unavailable',
    'chrome_version_mismatch', 'chrome_domain_blocked', 'chrome_no_owned_tab',
    'chrome_timeout', 'chrome_invalid_request', 'chrome_invalid_result',
    'chrome_debugger_conflict', 'chrome_policy_failure']) {
    assert.equal(isChromeProfileErrorCode(code), true, code);
  }
  assert.equal(isChromeProfileErrorCode('chrome_evaluate'), false);
  assert.equal(isChromeProfileErrorCode('ok'), false);
});

test('operation parser accepts closed union and rejects raw escapes', () => {
  assert.deepEqual(parseChromeProfileOperation({ kind: 'text' }), { kind: 'text' });
  assert.deepEqual(
    parseChromeProfileOperation({ kind: 'navigate', url: 'https://example.com', frozenHostname: 'Example.COM' }),
    { kind: 'navigate', url: 'https://example.com', frozenHostname: 'example.com' },
  );
  assert.deepEqual(
    parseChromeProfileOperation({ kind: 'click', selector: '@e12' }),
    { kind: 'click', selector: '@e12' },
  );
  for (const raw of [
    { kind: 'evaluate', expression: '1+1' },
    { kind: 'html' },
    { kind: 'cookies' },
    { kind: 'set_cookies' },
    { kind: 'batch' },
    { kind: 'cdp', method: 'Page.navigate' },
    { kind: 'unknown_op' },
    null,
  ]) {
    assert.throws(() => parseChromeProfileOperation(raw), ChromeProfileContractError);
  }
});

test('bridge command parser enforces protocol 1 and closed kinds', () => {
  const cmd = parseChromeBridgeCommand({
    protocol: 1, id: 'a', sessionKey: 's', grantId: 'g', targetInstanceId: 'i-1', bridgeToken: 't', kind: 'execute', operation: { kind: 'text' },
  });
  assert.equal(cmd.kind, 'execute');
  assert.equal(cmd.targetInstanceId, 'i-1');
  assert.throws(
    () => parseChromeBridgeCommand({ protocol: 1, id: 'a', sessionKey: 's', grantId: 'g', kind: 'revoke' }),
    ChromeProfileContractError,
  );
  assert.throws(
    () => parseChromeBridgeCommand({ protocol: 2, id: 'a', sessionKey: 's', grantId: 'g', kind: 'revoke' }),
    ChromeProfileContractError,
  );
  assert.throws(
    () => parseChromeBridgeCommand({ protocol: 1, id: 'a', sessionKey: 's', grantId: 'g', kind: 'eval' }),
    ChromeProfileContractError,
  );
  assert.throws(
    () => parseChromeBridgeCommand({
      protocol: 1, id: 'a', sessionKey: 's', grantId: 'g', kind: 'execute',
      operation: { kind: 'evaluate', expression: 'x' },
    }),
    ChromeProfileContractError,
  );
});

test('bridge result parser fails closed on protocol and error codes', () => {
  const ok = parseChromeBridgeResult({ protocol: 1, id: 'a', ok: true });
  assert.equal(ok.ok, true);
  const err = parseChromeBridgeResult({
    protocol: 1, id: 'a', ok: false,
    error: { code: 'chrome_locked', message: 'locked', retryable: false },
  });
  assert.equal(err.ok, false);
  assert.throws(
    () => parseChromeBridgeResult({ protocol: 9, id: 'a', ok: true }),
    ChromeProfileContractError,
  );
  assert.throws(
    () => parseChromeBridgeResult({
      protocol: 1, id: 'a', ok: false,
      error: { code: 'chrome_evaluate', message: 'x', retryable: false },
    }),
    ChromeProfileContractError,
  );
});
