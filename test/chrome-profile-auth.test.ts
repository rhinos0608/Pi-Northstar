import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  ChromeProfileAuth,
  parseChromeAuthorizeArg,
  chromeTtlMsForSpec,
  CHROME_AUTH_DEFAULT_TTL_MS,
} from '../src/chrome-profile-auth.js';
import { CHROME_LEASE_MAX_MS } from '../src/chrome-profile-contract.js';

function fakeClock(start = 1_000_000) {
  let t = start;
  return { now: () => t, advance: (ms: number) => { t += ms; } };
}
function ids() {
  let n = 0;
  return () => `id-${(n += 1)}`;
}

test('initial state locked; unconfirmed authorize stays locked', () => {
  const auth = new ChromeProfileAuth({ now: fakeClock().now, randomId: ids() });
  assert.deepEqual(auth.status(), { state: 'locked' });
  assert.equal(auth.canExecute(), false);
  assert.throws(() => auth.authorize(15 * 60 * 1000, false), /chrome_locked/);
  assert.deepEqual(auth.status(), { state: 'locked' });
});

test('TTL args: default 15m, Nm 1-120, indefinite, invalid rejected', () => {
  assert.deepEqual(parseChromeAuthorizeArg(undefined), { kind: 'default' });
  assert.equal(chromeTtlMsForSpec({ kind: 'default' }), CHROME_AUTH_DEFAULT_TTL_MS);
  assert.equal(chromeTtlMsForSpec(parseChromeAuthorizeArg('30m')), 30 * 60 * 1000);
  assert.equal(chromeTtlMsForSpec(parseChromeAuthorizeArg('indefinite')), null);
  assert.throws(() => parseChromeAuthorizeArg('0m'), /integer/);
  assert.throws(() => parseChromeAuthorizeArg('121m'), /integer/);
  assert.throws(() => parseChromeAuthorizeArg('forever'), /invalid authorize/);
});

test('authorize sets Pi expiry; TTL expiry locks under fake clock', () => {
  const clock = fakeClock();
  const auth = new ChromeProfileAuth({ now: clock.now, randomId: ids() });
  auth.authorize(15 * 60 * 1000, true);
  assert.equal(auth.status().state, 'authorized');
  assert.equal(auth.canExecute(), true);
  clock.advance(15 * 60 * 1000 + 1);
  assert.deepEqual(auth.status(), { state: 'locked', reason: 'expired' });
  assert.equal(auth.canExecute(), false);
});

test('indefinite lasts until revoke/shutdown; lease stays bounded at 60s', () => {
  const clock = fakeClock();
  const auth = new ChromeProfileAuth({ now: clock.now, randomId: ids() });
  const grant = auth.authorize(null, true);
  assert.equal(grant.expiresAt, null);
  assert.equal(grant.leaseExpiresAt - clock.now(), CHROME_LEASE_MAX_MS);
  clock.advance(59_000);
  assert.equal(auth.isLeaseLive(), true);
  clock.advance(2_000);
  assert.equal(auth.isLeaseLive(), false);
  // Pi grant still authorized: indefinite changes Pi expiry only.
  assert.equal(auth.status().state, 'authorized');
  const renewed = auth.renewLease();
  assert.equal(renewed - clock.now(), CHROME_LEASE_MAX_MS);
  auth.revoke('user');
  assert.deepEqual(auth.status(), { state: 'locked', reason: 'revoked' });
});

test('commit recomputes companion lease after delayed handshake', () => {
  const clock = fakeClock();
  const auth = new ChromeProfileAuth({ now: clock.now, randomId: ids() });
  const staged = auth.stageAuthorize(15 * 60 * 1000, true);
  clock.advance(61_000);
  auth.commitAuthorize(staged.sessionKey, staged.grantId);
  assert.equal(auth.isLeaseLive(), true);
  assert.equal(auth.msUntilLeaseExpiry(), CHROME_LEASE_MAX_MS);
});

test('commit rejects a grant whose TTL lapsed mid-handshake', () => {
  const clock = fakeClock();
  const auth = new ChromeProfileAuth({ now: clock.now, randomId: ids() });
  const expired = auth.stageAuthorize(60 * 1000, true);
  clock.advance(60 * 1000 + 1);
  assert.throws(() => auth.commitAuthorize(expired.sessionKey, expired.grantId), /grant expired before activation/);
  assert.equal(auth.status().state, 'locked');
  assert.equal(auth.currentGrant(), null);
  // Staged grant discarded: a retry stages fresh instead of committing stale.
  assert.throws(() => auth.commitAuthorize(expired.sessionKey, expired.grantId), /superseded/);
  // Stale identity never activates or clears another handshake's grant.
  const live = auth.stageAuthorize(15 * 60 * 1000, true);
  assert.throws(() => auth.commitAuthorize('wrong-session', live.grantId), /staged grant mismatch/);
  assert.throws(() => auth.abortAuthorize(live.sessionKey, 'wrong-grant'), /staged grant mismatch/);
  auth.commitAuthorize(live.sessionKey, live.grantId);
  assert.equal(auth.status().state, 'authorized');
});
test('revoke and shutdown lock synchronously for every reason', () => {
  const auth = new ChromeProfileAuth({ now: fakeClock().now, randomId: ids() });
  auth.authorize(15 * 60 * 1000, true);
  auth.revoke('user');
  assert.deepEqual(auth.status(), { state: 'locked', reason: 'revoked' });
  auth.authorize(15 * 60 * 1000, true);
  auth.shutdown();
  assert.deepEqual(auth.status(), { state: 'locked', reason: 'shutdown' });
  assert.equal(auth.canExecute(), false);
  assert.equal(auth.currentGrant(), null);
});

test('automation kill switch blocks authorize and execution', () => {
  const auth = new ChromeProfileAuth({ now: fakeClock().now, randomId: ids(), automationEnabled: false });
  assert.throws(() => auth.authorize(15 * 60 * 1000, true), /disabled/);
  assert.equal(auth.canExecute(), false);
  const open = new ChromeProfileAuth({ now: fakeClock().now, randomId: ids() });
  open.authorize(15 * 60 * 1000, true);
  open.setAutomationEnabled(false);
  assert.deepEqual(open.status(), { state: 'locked', reason: 'revoked' });
});

test('dual grant: both sessionKey and grantId must match', () => {
  const clock = fakeClock();
  const auth = new ChromeProfileAuth({ now: clock.now, randomId: ids() });
  assert.equal(auth.matchesGrant('a', 'b'), false);
  const grant = auth.authorize(15 * 60 * 1000, true);
  assert.equal(auth.matchesGrant(grant.sessionKey, grant.grantId), true);
  assert.equal(auth.matchesGrant('wrong', grant.grantId), false);
  assert.equal(auth.matchesGrant(grant.sessionKey, 'wrong'), false);
  auth.revoke('user');
  assert.equal(auth.matchesGrant(grant.sessionKey, grant.grantId), false);
});

test('60s lease with 30s renewal window interface', () => {
  const clock = fakeClock();
  const auth = new ChromeProfileAuth({ now: clock.now, randomId: ids() });
  assert.equal(auth.leaseRenewalDue(), false);
  auth.authorize(null, true);
  assert.equal(auth.msUntilLeaseExpiry(), CHROME_LEASE_MAX_MS);
  assert.equal(auth.leaseRenewalDue(), false);
  clock.advance(31_000);
  assert.equal(auth.msUntilLeaseExpiry(), 29_000);
  assert.equal(auth.leaseRenewalDue(), true);
  const renewed = auth.renewLease();
  assert.equal(renewed - clock.now(), CHROME_LEASE_MAX_MS);
  assert.equal(auth.leaseRenewalDue(), false);
});
