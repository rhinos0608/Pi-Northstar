import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  assertAuthFetchUrl,
  authFetchRedirectGuard,
  hostMatches,
  MAX_AUTH_HOSTS_PER_PROFILE,
  MAX_AUTH_PROFILES,
  normalizeHostname,
  parseWebAccessAuthProfiles,
  PI_FETCH_AUTH_PROFILES_ENV,
  resolveAuthProfileForUrl,
  type WebAccessAuthProfiles,
} from '../../../src/web/access/web-access-auth-contract.js';

function envWith(profiles: unknown): Record<string, string | undefined> {
  return { [PI_FETCH_AUTH_PROFILES_ENV]: JSON.stringify(profiles) };
}

const YOUTUBE = { provider: 'youtube', hosts: ['www.youtube.com'] };

test('absent or blank env is inert (no profiles, no throw)', () => {
  assert.deepEqual(parseWebAccessAuthProfiles({}), {});
  assert.deepEqual(parseWebAccessAuthProfiles({ [PI_FETCH_AUTH_PROFILES_ENV]: '   ' }), {});
});

test('malformed envelope rejects with field-naming messages', () => {
  assert.throws(() => parseWebAccessAuthProfiles({ [PI_FETCH_AUTH_PROFILES_ENV]: '{nope' }), /field "profiles"/);
  assert.throws(() => parseWebAccessAuthProfiles(envWith(['array'])), /field "profiles" must be a JSON object/);
  assert.throws(() => parseWebAccessAuthProfiles(envWith({ p: 'hosts?' })), /field "p" must be an object/);
});

test('unknown profile fields reject (T11: no silent widening)', () => {
  assert.throws(
    () => parseWebAccessAuthProfiles(envWith({ p: { ...YOUTUBE, cookies: true } })),
    /field "p\.cookies" is unknown/,
  );
});

test('redirects and cache validate reject-not-clamp (T11)', () => {
  assert.throws(
    () => parseWebAccessAuthProfiles(envWith({ p: { ...YOUTUBE, redirects: 'follow' } })),
    /field "p\.redirects" must be "same-origin"/,
  );
  assert.throws(
    () => parseWebAccessAuthProfiles(envWith({ p: { ...YOUTUBE, cache: 'disk' } })),
    /field "p\.cache" must be "session" or "off"/,
  );
});

test('defaults are redirects same-origin and cache off (T5 default)', () => {
  const parsed = parseWebAccessAuthProfiles(envWith({ p: YOUTUBE }));
  assert.equal(parsed.p?.redirects, 'same-origin');
  assert.equal(parsed.p?.cache, 'off');
});

test('hostname syntax rejects wildcards and malformed hosts (T11)', () => {
  for (const bad of ['*.youtube.com', '.youtube.com', 'you tube.com', '', 'a/b', 'host:80']) {
    assert.throws(
      () => parseWebAccessAuthProfiles(envWith({ p: { ...YOUTUBE, hosts: [bad] } })),
      /field "p\.hosts" contains an invalid hostname/,
      bad,
    );
  }
  assert.throws(() => parseWebAccessAuthProfiles(envWith({ p: { ...YOUTUBE, hosts: [] } })), /must be a non-empty array/);
  assert.throws(
    () => parseWebAccessAuthProfiles(envWith({ p: { provider: 'youtube' } })),
    /field "p\.hosts" must be a non-empty array/,
  );
});

test('profile and host ceilings reject-not-clamp', () => {
  const many: Record<string, unknown> = {};
  for (let i = 0; i < MAX_AUTH_PROFILES + 1; i++) many[`p${i}`] = YOUTUBE;
  assert.throws(() => parseWebAccessAuthProfiles(envWith(many)), /exceeds the profile limit/);
  const hosts = Array.from({ length: MAX_AUTH_HOSTS_PER_PROFILE + 1 }, (_, i) => `h${i}.youtube.com`);
  assert.throws(
    () => parseWebAccessAuthProfiles(envWith({ p: { provider: 'youtube', hosts } })),
    /field "p\.hosts" exceeds the host limit/,
  );
});

test('provider must exist with cookie domains; hosts must sit inside them (T2, D6)', () => {
  assert.throws(() => parseWebAccessAuthProfiles(envWith({ p: { hosts: ['x.com'] } })), /field "p\.provider" is required/);
  assert.throws(
    () => parseWebAccessAuthProfiles(envWith({ p: { provider: 'nope', hosts: ['x.com'] } })),
    /field "p\.provider" names an unknown provider/,
  );
  assert.throws(
    () => parseWebAccessAuthProfiles(envWith({ p: { provider: 'web', hosts: ['x.com'] } })),
    /field "p\.provider" has no cookie domains/,
  );
  assert.throws(
    () => parseWebAccessAuthProfiles(envWith({ p: { ...YOUTUBE, hosts: ['paywalled.example'] } })),
    /field "p\.hosts" is outside the provider cookie domains/,
  );
  const ok = parseWebAccessAuthProfiles(envWith({
    yt: { provider: 'youtube', hosts: ['youtube.com', 'music.youtube.com'] },
    rd: { provider: 'reddit', hosts: ['old.reddit.com'], cache: 'session' },
  }));
  assert.deepEqual(ok.yt?.hosts, ['youtube.com', 'music.youtube.com']);
  assert.equal(ok.rd?.cache, 'session');
});

test('profile names match the strict pattern', () => {
  for (const bad of ['1bad', '-x', 'has space', '']) {
    assert.throws(() => parseWebAccessAuthProfiles(envWith({ [bad]: YOUTUBE })), /invalid profile name/, bad);
  }
});

test('resolve matches exact, subdomain, trailing dot; declines others', () => {
  const profiles = parseWebAccessAuthProfiles(envWith({
    yt: { provider: 'youtube', hosts: ['www.youtube.com'] },
    rd: { provider: 'reddit', hosts: ['reddit.com'] },
  }));
  assert.equal(resolveAuthProfileForUrl('https://www.youtube.com/watch', profiles)?.name, 'yt');
  assert.equal(resolveAuthProfileForUrl('https://deep.www.youtube.com/x', profiles)?.name, 'yt');
  assert.equal(resolveAuthProfileForUrl('https://www.youtube.com./x', profiles)?.name, 'yt');
  assert.equal(resolveAuthProfileForUrl('https://notyoutube.com/', profiles), undefined);
  assert.equal(resolveAuthProfileForUrl('https://www.youtube.com.evil.com/', profiles), undefined);
  assert.equal(resolveAuthProfileForUrl('https://www.reddit.com/r/x', profiles)?.name, 'rd');
  assert.equal(resolveAuthProfileForUrl('not a url', profiles), undefined);
  assert.deepEqual(resolveAuthProfileForUrl('https://x.com/', {} as WebAccessAuthProfiles), undefined);
});

test('assertAuthFetchUrl enforces HTTPS and profile scope (T3, T2)', () => {
  const profiles = parseWebAccessAuthProfiles(envWith({ yt: YOUTUBE }));
  const profile = profiles.yt!;
  assert.throws(() => assertAuthFetchUrl(profile, 'http://www.youtube.com/x'), /requires an HTTPS URL/);
  assert.throws(() => assertAuthFetchUrl(profile, 'https://evil.com/x'), /not allowed by the auth profile/);
  assert.equal(assertAuthFetchUrl(profile, 'https://www.youtube.com/x').hostname, 'www.youtube.com');
});

test('redirect guard refuses cross-origin hops only (T1)', () => {
  const profiles = parseWebAccessAuthProfiles(envWith({ yt: YOUTUBE }));
  const profile = profiles.yt!;
  assert.throws(
    () => authFetchRedirectGuard(profile, new URL('https://www.youtube.com/a'), new URL('https://music.youtube.com/b')),
    /refused a cross-origin redirect/,
  );
  assert.throws(
    () => authFetchRedirectGuard(profile, new URL('https://www.youtube.com/a'), new URL('http://www.youtube.com/a')),
    /refused a cross-origin redirect/,
  );
  authFetchRedirectGuard(profile, new URL('https://www.youtube.com/a'), new URL('https://www.youtube.com/b?x=1'));
});

test('hostname helpers normalize and dot-boundary match', () => {
  assert.equal(normalizeHostname('WWW.YouTube.COM.'), 'www.youtube.com');
  assert.ok(hostMatches('a.youtube.com', 'youtube.com'));
  assert.ok(!hostMatches('fakeyoutube.com', 'youtube.com'));
});
