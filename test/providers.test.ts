import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CHANNEL_CAPABILITIES, cookieImportProviders } from '../src/capabilities.js';
import { PROVIDER_DESCRIPTORS, authForChannel, findProvider, liveAuthSnapshot, providerChannels, providerSummary } from '../src/providers.js';

test('descriptor availability derives from the canonical registry', () => {
  for (const desc of PROVIDER_DESCRIPTORS) {
    const expected = CHANNEL_CAPABILITIES.find((channel) => channel.id === desc.channel)?.availability ?? 'available';
    assert.equal(desc.availability, expected, `provider ${desc.provider} availability must match registry channel ${desc.channel}`);
  }
});

test('every registry channel provider has a matching descriptor', () => {
  for (const channel of CHANNEL_CAPABILITIES) {
    if (!channel.provider) continue;
    const desc = findProvider(channel.provider.provider);
    assert.ok(desc, `registry provider ${channel.provider.provider} must have a descriptor`);
    assert.deepEqual([...desc.envKeys], [...channel.provider.envKeys]);
    // Cookie domains derive from the registry through the session rule:
    // only cookie-consuming backends declare domains.
    const expectedDomains = channel.provider.consumesCookie ? [...channel.provider.cookieDomains] : [];
    assert.deepEqual([...desc.cookieDomains], expectedDomains);
    assert.equal(desc.loginFlow, channel.provider.loginFlow);
    assert.equal(desc.risk, channel.provider.risk);
    assert.equal(desc.setup, channel.provider.setup);
  }
});

test('dead channels have no descriptors', () => {
  assert.equal(findProvider('xueqiu'), undefined);
  assert.equal(findProvider('xiaoyuzhou'), undefined);
});

test('planned providers make no ready-capability claims', () => {
  const planned = PROVIDER_DESCRIPTORS.filter((desc) => desc.availability === 'planned');
  assert.deepEqual(planned.map((desc) => desc.provider).sort(), []);
  for (const desc of planned) {
    assert.match(desc.description, /\(planned\)/, `${desc.provider} description must say planned`);
    assert.match(desc.setup, /planned/i, `${desc.provider} setup must say planned`);
  }
});

test('cookie-import set contains only operational cookie-consuming providers', () => {
  const importable = cookieImportProviders();
  // Planned providers never import cookies.
  for (const desc of PROVIDER_DESCRIPTORS.filter((d) => d.availability === 'planned')) {
    assert.equal(importable.includes(desc.provider), false, `planned provider ${desc.provider} must not import cookies`);
  }
  // Every importable provider is operational, consumes cookies, and declares domains.
  for (const provider of importable) {
    const desc = findProvider(provider);
    assert.ok(desc, `importable provider ${provider} must have a descriptor`);
    assert.equal(desc.availability, 'available');
    assert.ok(desc.cookieDomains.length > 0);
    const channel = CHANNEL_CAPABILITIES.find((c) => c.provider?.provider === provider);
    assert.ok(channel?.provider?.consumesCookie, `${provider} must declare consumesCookie`);
  }
  // Twitter/Xiaohongshu workers authenticate through CLI-owned local session
  // stores and Facebook/Instagram/LinkedIn backends cannot consume stored
  // cookies (OpenCLI uses its own Chrome session), so none of them may ever
  // be imported by default.
  for (const nonImporting of ['twitter', 'xiaohongshu', 'facebook', 'instagram', 'linkedin']) {
    assert.equal(importable.includes(nonImporting), false, `${nonImporting} is session-owned and must not import cookies`);
  }
  assert.deepEqual([...importable].sort(), ['bilibili', 'reddit', 'youtube']);
});

test('youtube descriptor consumes cookies for consent-gated transcripts', () => {
  const desc = findProvider('youtube');
  assert.ok(desc, 'youtube descriptor must exist');
  assert.deepEqual([...desc.envKeys], ['YOUTUBE_API_KEY']);
  assert.deepEqual([...desc.cookieDomains], ['youtube.com']);
  assert.equal(desc.loginFlow, 'browser_cookie');
  assert.equal(desc.loginUrl, 'https://www.youtube.com/');
});

test('twitter and xiaohongshu descriptors expose no dead env keys or import domains', () => {
  for (const name of ['twitter', 'xiaohongshu'] as const) {
    const desc = findProvider(name);
    assert.ok(desc, `${name} descriptor must exist`);
    assert.deepEqual(desc.envKeys, [], `${name} must expose no dead env keys`);
    assert.deepEqual(desc.cookieDomains, [], `${name} must expose no import cookie domains`);
    assert.equal(desc.loginFlow, 'cli_login', `${name} must read as a CLI-owned authenticated session`);
  }
  const twitter = findProvider('twitter');
  assert.ok(twitter?.loginUrl, 'twitter keeps a useful loginUrl');
  assert.match(String(twitter?.setup), /twitter-cli/);
  const xiaohongshu = findProvider('xiaohongshu');
  assert.ok(xiaohongshu?.loginUrl, 'xiaohongshu keeps a useful loginUrl');
});

test('cookie domains only where the backend consumes sessions', () => {
  for (const desc of PROVIDER_DESCRIPTORS) {
    const channel = CHANNEL_CAPABILITIES.find((c) => c.provider?.provider === desc.provider);
    const consumes = channel?.provider?.consumesCookie === true;
    if (!consumes) {
      assert.deepEqual(desc.cookieDomains, [], `provider ${desc.provider} declares no cookie domains without a consuming backend`);
    } else {
      assert.ok(desc.cookieDomains.length > 0, `provider ${desc.provider} consumes sessions so must declare cookie domains`);
    }
  }
});

test('linkedin promises only verified model-facing reads', () => {
  const linkedin = findProvider('linkedin');
  assert.ok(linkedin);
  assert.equal(linkedin.availability, 'available');
  // Verified reads per registry: search, get_profile, get_user_posts, get_feed.
  // Companies/jobs are unverified and unpromised.
  assert.match(linkedin.description, /search/i);
  assert.doesNotMatch(linkedin.description, /compan/i);
  assert.doesNotMatch(linkedin.description, /jobs/i);
  assert.doesNotMatch(linkedin.description, /planned/i);
  assert.doesNotMatch(linkedin.description, /linkedin-scraper-mcp/i);
  assert.deepEqual(linkedin.cookieDomains, []);
  assert.equal(linkedin.loginFlow, 'cli_login');
  assert.equal(linkedin.setup, 'Install OpenCLI and login in Chrome');
});

test('instagram promises no post-detail, read, or download', () => {
  const instagram = findProvider('instagram');
  assert.ok(instagram);
  assert.doesNotMatch(instagram.description, /get_post/);
  assert.match(instagram.description, /no post-detail/i);
  assert.match(instagram.description, /download disabled/i);
});

test('providerSummary exposes availability without values', () => {
  const summary = providerSummary({ GITHUB_TOKEN: 'ghp_dummy' });
  const linkedin = summary.find((p) => p.provider === 'linkedin');
  assert.equal(linkedin?.availability, 'available');
  const twitter = summary.find((p) => p.provider === 'twitter');
  assert.equal(twitter?.availability, 'available');
  assert.ok(Array.isArray(twitter?.keyNames));
});

test('diffbot descriptor is additive with legacy singular channel intact', () => {
  const desc = findProvider('diffbot');
  assert.ok(desc, 'diffbot descriptor must exist');
  assert.equal(desc.channel, 'diffbot');
  assert.deepEqual([...providerChannels(desc)], ['diffbot', 'web', 'research', 'graph']);
  assert.equal(providerChannels(desc)[0], desc.channel, 'legacy singular channel stays first');
  assert.equal(desc.family, 'research');
  assert.deepEqual([...desc.envKeys], ['DIFFBOT_TOKEN']);
  assert.deepEqual([...desc.cookieDomains], []);
  assert.equal(desc.loginFlow, 'env_var');
  assert.equal(desc.risk, 'low');
  assert.equal(desc.availability, 'available');
  assert.match(desc.setup, /DIFFBOT_TOKEN/);
});

test('firecrawl/jina descriptors are additive with legacy singular channel intact', () => {
  for (const [name, key, members] of [
    ['firecrawl', 'FIRECRAWL_API_KEY', ['firecrawl', 'web']],
    ['jina', 'JINA_API_KEY', ['jina', 'web']],
  ] as const) {
    const desc = findProvider(name);
    assert.ok(desc, `${name} descriptor must exist`);
    assert.equal(desc.channel, name);
    assert.deepEqual([...providerChannels(desc)], members);
    assert.equal(providerChannels(desc)[0], desc.channel, 'legacy singular channel stays first');
    assert.equal(desc.family, 'research');
    assert.deepEqual([...desc.envKeys], [key]);
    assert.deepEqual([...desc.cookieDomains], []);
    assert.equal(desc.loginFlow, 'env_var');
    assert.equal(desc.risk, 'low');
    assert.equal(desc.availability, 'available');
    assert.match(desc.setup, new RegExp(key));
    assert.doesNotMatch(desc.setup, /planned/i);
  }
});

test('providerChannels preserves legacy singular behavior', () => {
  for (const name of ['github', 'web', 'youtube'] as const) {
    const desc = findProvider(name);
    assert.ok(desc, `${name} descriptor must exist`);
    assert.deepEqual([...providerChannels(desc)], [desc.channel]);
  }
});

test('authForChannel keeps legacy resolution with multi-channel fallback', () => {
  const sentinel = 'SENTINEL_DIFFBOT_TOKEN_abc123xyz';
  const configured = authForChannel('diffbot', { DIFFBOT_TOKEN: sentinel });
  assert.ok(configured);
  assert.equal(configured.configured, true);
  assert.deepEqual(configured.keyNames, ['DIFFBOT_TOKEN']);
  assert.equal(authForChannel('diffbot', {})?.configured, false);
  const web = authForChannel('web', {});
  assert.ok(web);
  assert.equal(web.loginFlow, 'none', 'legacy web provider wins over multi-channel fallback');
  const snapshot = liveAuthSnapshot({ DIFFBOT_TOKEN: sentinel });
  assert.equal(snapshot.diffbot?.configured, true);
  assert.deepEqual(snapshot.diffbot?.keyNames, ['DIFFBOT_TOKEN']);
  assert.equal(liveAuthSnapshot({}).diffbot?.configured, false);
});

test('github descriptor reads both token spellings with no cookie domains', () => {
  const desc = findProvider('github');
  assert.ok(desc, 'github descriptor must exist');
  assert.deepEqual([...desc.envKeys], ['GITHUB_TOKEN', 'GH_TOKEN']);
  assert.deepEqual([...desc.cookieDomains], []);
  assert.equal(desc.loginFlow, 'env_var');
  assert.match(String(desc.setup), /GH_TOKEN/);
  assert.match(String(desc.setup), /optional for public data/);
});
