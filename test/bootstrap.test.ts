import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { callSetupTool, ensureFirstStartBootstrap, installAllowed, writeAuthState } from '../src/bootstrap.js';
import { PROVIDER_DESCRIPTORS } from '../src/providers.js';

function textFromResult(result: Record<string, unknown>): string {
  const content = result.content;
  if (Array.isArray(content) && content.length > 0) {
    const first = content[0] as Record<string, unknown>;
    if (typeof first.text === 'string') return first.text;
  }
  return '';
}

test('installAllowed is opt-out', () => {
  assert.equal(installAllowed({}), true);
  assert.equal(installAllowed({ PI_SEARCH_ALLOW_INSTALL: '0' }), false);
  assert.equal(installAllowed({ PI_SEARCH_ALLOW_INSTALL: 'false' }), false);
  assert.equal(installAllowed({ PI_SEARCH_ALLOW_INSTALL: 'no' }), false);
  assert.equal(installAllowed({ PI_SEARCH_ALLOW_INSTALL: ' OFF ' }), false);
  assert.equal(installAllowed({ PI_SEARCH_ALLOW_INSTALL: '1' }), true);
});

test('callSetupTool defaults to local setup automation', async () => {
  const result = await callSetupTool({}, { env: { PI_SEARCH_ALLOW_INSTALL: '0', PI_SEARCH_BROWSER_AUTOMATION: '0' } });
  const text = textFromResult(result);
  const data = JSON.parse(text) as Record<string, unknown>;
  assert.equal(data.action, 'auto');
  assert.match(text, /Install execution disabled/);
  assert.match(text, /Browser cookie import never runs/);
});

test('ensureFirstStartBootstrap with off mode does nothing', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pi-extension-search-state-'));
  try {
    const result = await ensureFirstStartBootstrap({ PI_SEARCH_BOOTSTRAP: 'off', PI_SEARCH_STATE_DIR: dir });
    assert.equal(result, undefined);
    await assert.rejects(() => readFile(join(dir, 'bootstrap.json'), 'utf8'));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('ensureFirstStartBootstrap check writes isolated non-mutating state once', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pi-extension-search-state-'));
  try {
    await ensureFirstStartBootstrap({ PI_SEARCH_BOOTSTRAP: 'check', PI_SEARCH_STATE_DIR: dir });
    const first = JSON.parse(await readFile(join(dir, 'bootstrap.json'), 'utf8')) as Record<string, unknown>;
    assert.equal(first.status, 'ok');
    assert.equal(first.mode, 'check');
    assert.doesNotMatch(String(first.message), /agent-reach|Panniantong/i);

    await ensureFirstStartBootstrap({ PI_SEARCH_BOOTSTRAP: 'check', PI_SEARCH_STATE_DIR: dir });
    const second = JSON.parse(await readFile(join(dir, 'bootstrap.json'), 'utf8')) as Record<string, unknown>;
    assert.equal(second.ranAt, first.ranAt);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('callSetupTool install_all returns execution result when allowed', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pi-extension-search-path-'));
  try {
    const result = await callSetupTool({ action: 'install_all' }, { env: { PATH: dir } });
    const text = textFromResult(result);
    const data = JSON.parse(text) as Record<string, unknown>;
    assert.equal(data.descriptor, false);
    assert.equal(data.installAllowed, true);
    assert.ok(Array.isArray(data.installers));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('callSetupTool import_cookies honors browser automation opt-out', async () => {
  const result = await callSetupTool({ action: 'import_cookies' }, { env: { PI_SEARCH_BROWSER_AUTOMATION: '0' } });
  const text = textFromResult(result);
  const data = JSON.parse(text) as Record<string, unknown>;
  assert.equal(data.ok, false);
  assert.match(data.message as string, /disabled/);
});

test('callSetupTool install_channels validates valid channels', async () => {
  const result = await callSetupTool({ action: 'install_channels', channels: 'github,rss' }, { env: { PI_SEARCH_ALLOW_INSTALL: '0' } });
  const text = textFromResult(result);
  const data = JSON.parse(text) as Record<string, unknown>;
  assert.equal(data.descriptor, true);
  assert.ok(Array.isArray(data.backends));
  const providers = data.backends as Array<Record<string, unknown>>;
  const github = providers.find((p) => p.provider === 'github');
  assert.ok(github, 'github must be in filtered backends');
  const rss = providers.find((p) => p.provider === 'rss');
  assert.ok(rss, 'rss must be in filtered backends');
  const twitter = providers.find((p) => p.provider === 'twitter');
  assert.equal(twitter, undefined, 'twitter must not be in filtered backends');
});

test('callSetupTool install_channels rejects unknown channels', async () => {
  const result = await callSetupTool({ action: 'install_channels', channels: 'unknown_chan' });
  const text = textFromResult(result);
  const data = JSON.parse(text) as Record<string, unknown>;
  assert.equal(data.status, 'error');
  assert.match(data.message as string, /Unknown channels/);
});

test('callSetupTool install_channels rejects empty channels', async () => {
  const result = await callSetupTool({ action: 'install_channels' });
  const text = textFromResult(result);
  const data = JSON.parse(text) as Record<string, unknown>;
  assert.equal(data.status, 'error');
  assert.match(data.message as string, /channels parameter is required/);
});

test('callSetupTool status includes config summary and hides legacy bootstrap messages', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pi-extension-search-state-'));
  const configPath = join(dir, 'config.json');
  try {
    await writeFile(join(dir, 'bootstrap.json'), JSON.stringify({
      version: 1,
      ranAt: '2026-01-01T00:00:00.000Z',
      mode: 'check',
      status: 'warn',
      message: 'agent-reach not installed. Install guide: https://raw.githubusercontent.com/Panniantong/agent-reach/main/docs/install.md',
    }));
    await writeFile(configPath, JSON.stringify({ github: { token: 'ghp_secret_value' } }));

    const result = await callSetupTool({ action: 'status' }, { env: { PI_SEARCH_STATE_DIR: dir, SEARCH_MCP_CONFIG_PATH: configPath } });
    const text = textFromResult(result);
    const data = JSON.parse(text) as Record<string, unknown>;
    const firstStart = data.firstStart as Record<string, unknown>;
    const localConfig = data.localConfig as Record<string, unknown>;

    assert.equal(firstStart.status, 'ok');
    assert.doesNotMatch(String(firstStart.message), /agent-reach|Panniantong/i);
    assert.equal(localConfig.loaded, true);
    assert.deepEqual(localConfig.mappedKeys, ['GITHUB_TOKEN']);
    assert.doesNotMatch(text, /ghp_secret_value/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('callSetupTool status returns auth state without secrets', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pi-extension-search-state-'));
  try {
    await writeAuthState({ GITHUB_TOKEN: 'ghp_dummy', PI_SEARCH_STATE_DIR: dir });

    const result = await callSetupTool({ action: 'status' }, { env: { PI_SEARCH_STATE_DIR: dir } });
    const text = textFromResult(result);
    const data = JSON.parse(text) as Record<string, unknown>;
    assert.ok(data.authState);
    const providers = (data.authState as Record<string, unknown>).providers as Record<string, unknown>;
    assert.ok(providers);
    const github = providers.github as Record<string, unknown>;
    assert.ok(github, 'github provider should be in auth state');
    const keys = github.keys as string[];
    assert.ok(keys.includes('GITHUB_TOKEN'));
    assert.doesNotMatch(text, /ghp_dummy/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('callSetupTool status reports firecrawl/jina configured state without values', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pi-extension-search-firecrawl-jina-'));
  try {
    const result = await callSetupTool({ action: 'status' }, { env: { FIRECRAWL_API_KEY: 'firecrawl_live_secret', JINA_API_KEY: 'jina_live_secret', PI_SEARCH_STATE_DIR: dir } });
    const text = textFromResult(result);
    const data = JSON.parse(text) as Record<string, unknown>;
    const live = data.liveProviders as Record<string, { configured: boolean; keyNames: string[] }>;
    assert.ok(live, 'liveProviders must be present');
    assert.equal(live.firecrawl?.configured, true);
    assert.deepEqual(live.firecrawl?.keyNames, ['FIRECRAWL_API_KEY']);
    assert.equal(live.jina?.configured, true);
    assert.deepEqual(live.jina?.keyNames, ['JINA_API_KEY']);
    assert.doesNotMatch(text, /firecrawl_live_secret/);
    assert.doesNotMatch(text, /jina_live_secret/);

    const unset = await callSetupTool({ action: 'status' }, { env: { PI_SEARCH_STATE_DIR: dir } });
    const unsetData = JSON.parse(textFromResult(unset)) as Record<string, unknown>;
    const unsetLive = unsetData.liveProviders as Record<string, { configured: boolean }>;
    assert.equal(unsetLive.firecrawl?.configured, false);
    assert.equal(unsetLive.jina?.configured, false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('callSetupTool plan includes firecrawl/jina descriptors without values', async () => {
  const result = await callSetupTool({ action: 'plan' }, { env: { FIRECRAWL_API_KEY: 'firecrawl_plan_secret' } });
  const text = textFromResult(result);
  const data = JSON.parse(text) as Record<string, unknown>;
  const providers = data.providers as Array<Record<string, unknown>>;
  const firecrawl = providers.find((p) => p.provider === 'firecrawl');
  assert.ok(firecrawl, 'firecrawl provider must be present in plan');
  assert.equal(firecrawl.configured, true);
  assert.deepEqual(firecrawl.keyNames, ['FIRECRAWL_API_KEY']);
  const jina = providers.find((p) => p.provider === 'jina');
  assert.ok(jina, 'jina provider must be present in plan');
  assert.equal(jina.configured, false);
  assert.doesNotMatch(text, /firecrawl_plan_secret/);
});

test('writeAuthState can be called without crashing', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pi-extension-search-state-'));
  try {
    await writeAuthState({ GITHUB_TOKEN: 'dummy', PI_SEARCH_STATE_DIR: dir });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('callSetupTool status reports live env key names without values', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pi-extension-search-state-'));
  try {
    const result = await callSetupTool({ action: 'status' }, { env: { GITHUB_TOKEN: 'ghp_live', EXA_API_KEY: 'exa_live_secret', PI_SEARCH_STATE_DIR: dir } });
    const text = textFromResult(result);
    const data = JSON.parse(text) as Record<string, unknown>;

    // liveProviders section present
    assert.ok(data.liveProviders, 'liveProviders must be present');
    const live = data.liveProviders as Record<string, unknown>;

    // github provider shows configured and key names
    const github = live.github as Record<string, unknown>;
    assert.ok(github, 'github must be in liveProviders');
    assert.equal(github.configured, true);
    const keys = github.keyNames as string[];
    assert.ok(keys.includes('GITHUB_TOKEN'));

    // No secret values leaked in text output
    assert.doesNotMatch(text, /ghp_live/);
    assert.doesNotMatch(text, /exa_live_secret/);

    // Zero-config providers show configured=false with empty keys
    const v2ex = live.v2ex as Record<string, unknown>;
    assert.ok(v2ex, 'v2ex must be in liveProviders');
    assert.equal(v2ex.configured, true);
    const v2exKeys = v2ex.keyNames as string[];
    assert.equal(v2exKeys.length, 0);

    const facebook = live.facebook as Record<string, unknown>;
    assert.ok(facebook, 'facebook must be in liveProviders');
    assert.equal(facebook.configured, false);

    // authDir is present and no real home state is touched
    assert.equal(data.authDir, dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('callSetupTool plan includes provider auth metadata', async () => {
  const result = await callSetupTool({ action: 'plan' }, { env: { GITHUB_TOKEN: 'tok' } });
  const text = textFromResult(result);
  const data = JSON.parse(text) as Record<string, unknown>;

  // providers array present
  assert.ok(Array.isArray(data.providers), 'providers must be an array');
  const providers = data.providers as Array<Record<string, unknown>>;

  // github shows configured=true with key names only
  const github = providers.find((p) => p.provider === 'github');
  assert.ok(github, 'github provider must be present');
  assert.equal(github.configured, true);
  assert.ok(Array.isArray(github.keyNames));
  assert.ok((github.keyNames as string[]).includes('GITHUB_TOKEN'));

  // twitter has env keys, cookie domains, login flow, risk
  assert.ok(Array.isArray(github.cookieDomains));
  assert.equal(typeof github.loginFlow, 'string');
  assert.equal(typeof github.risk, 'string');
  assert.equal(typeof github.setup, 'string');

  // Zero-config providers have empty keys
  const rss = providers.find((p) => p.provider === 'rss');
  assert.ok(rss, 'rss provider must be present');
  assert.equal(rss.configured, true);
  assert.equal((rss.keyNames as string[]).length, 0);
  assert.equal(rss.loginFlow, 'none');

  const facebook = providers.find((p) => p.provider === 'facebook');
  assert.ok(facebook, 'facebook provider must be present');
  assert.equal(facebook.configured, false);
  assert.equal(facebook.loginFlow, 'browser_cookie');

  // No agent-reach mentions
  assert.doesNotMatch(text, /agent.reach/i);

  // platforms section still present for backward compat
  assert.ok(Array.isArray(data.platforms));

  // v2ex and twitter appear in text output (backward compat)
  assert.match(text, /v2ex/);
  assert.match(text, /twitter/);
});

test('callSetupTool plan includes all provider descriptors when no env given', async () => {
  const result = await callSetupTool({ action: 'plan' }, {});
  const text = textFromResult(result);
  const data = JSON.parse(text) as Record<string, unknown>;
  const providers = data.providers as Array<Record<string, unknown>>;

  // All PROVIDER_DESCRIPTORS should be present
  for (const desc of PROVIDER_DESCRIPTORS) {
    const match = providers.find((p) => p.provider === desc.provider);
    assert.ok(match, `provider ${desc.provider} must be in plan`);
  }
});

test('callSetupTool plan includes cookie domains per provider', async () => {
  const result = await callSetupTool({ action: 'plan' }, {});
  const text = textFromResult(result);
  const data = JSON.parse(text) as Record<string, unknown>;

  assert.ok(Array.isArray(data.providers), 'providers must be an array');
  const cookieProviders = (data.providers as Array<Record<string, unknown>>).filter((provider) => Array.isArray(provider.cookieDomains) && (provider.cookieDomains as string[]).length > 0);

  // Only operational registry providers whose backend consumes the Pi cookie
  // jar may import. Twitter/Xiaohongshu workers use CLI-owned local session
  // stores and OpenCLI Chrome-session providers never collect unused
  // cookies, so twitter, xiaohongshu, facebook, instagram, and linkedin stay
  // out of this list.
  for (const unconsumed of ['twitter', 'xiaohongshu', 'facebook', 'instagram', 'linkedin']) {
    assert.equal(cookieProviders.find((p) => p.provider === unconsumed), undefined, `${unconsumed} must not import unused cookies`);
  }

  const reddit = cookieProviders.find((p) => p.provider === 'reddit');
  assert.ok(reddit, 'reddit must be in cookieProviders');
  assert.ok((reddit.cookieDomains as string[]).includes('reddit.com'));

  const bilibili = cookieProviders.find((p) => p.provider === 'bilibili');
  assert.ok(bilibili, 'bilibili must be in cookieProviders');

  // Each has loginFlow and risk
  for (const cp of cookieProviders) {
    assert.equal(typeof cp.loginFlow, 'string', `loginFlow must be present for ${cp.provider}`);
    assert.equal(typeof cp.risk, 'string', `risk must be present for ${cp.provider}`);
  }

  // No values leaked
  assert.doesNotMatch(text, /ghp_|sk-|secret/);
});


test('callSetupTool install_all returns descriptor even when install opt-out', async () => {
  const result = await callSetupTool({ action: 'install_all' }, { env: { PI_SEARCH_ALLOW_INSTALL: '0' } });
  const text = textFromResult(result);
  const data = JSON.parse(text) as Record<string, unknown>;
  assert.equal(data.descriptor, true);
  assert.match(data.message as string, /Installation disabled/);
});

test('callSetupTool import_cookies with unknown provider returns error', async () => {
  const result = await callSetupTool({ action: 'import_cookies', provider: 'nonexistent' }, { env: {} });
  const text = textFromResult(result);
  const data = JSON.parse(text) as Record<string, unknown>;
  assert.equal(data.status, 'error');
  assert.match(data.message as string, /Unknown provider/);
});

test('callSetupTool import_cookies with non-cookie provider returns error', async () => {
  const result = await callSetupTool({ action: 'import_cookies', provider: 'v2ex' }, { env: {} });
  const text = textFromResult(result);
  const data = JSON.parse(text) as Record<string, unknown>;
  assert.equal(data.status, 'error');
  assert.match(data.message as string, /does not use cookies/);
});

test('callSetupTool import_cookies without provider imports default providers unless disabled', async () => {
  const result = await callSetupTool({ action: 'import_cookies' }, { env: { PI_SEARCH_BROWSER_AUTOMATION: '0' } });
  const text = textFromResult(result);
  const data = JSON.parse(text) as Record<string, unknown>;
  assert.equal(data.ok, false);
  assert.match(data.message as string, /disabled/);
});

test('callSetupTool login without provider returns error', async () => {
  const result = await callSetupTool({ action: 'login' });
  const text = textFromResult(result);
  const data = JSON.parse(text) as Record<string, unknown>;
  assert.equal(data.status, 'error');
  assert.match(data.message as string, /provider parameter is required/);
});

test('callSetupTool login with unknown provider returns error', async () => {
  const result = await callSetupTool({ action: 'login', provider: 'nonexistent' });
  const text = textFromResult(result);
  const data = JSON.parse(text) as Record<string, unknown>;
  assert.equal(data.status, 'error');
  assert.match(data.message as string, /Unknown provider/);
});

test('callSetupTool login with non-cookie provider returns error', async () => {
  const result = await callSetupTool({ action: 'login', provider: 'rss' });
  const text = textFromResult(result);
  const data = JSON.parse(text) as Record<string, unknown>;
  assert.equal(data.status, 'error');
  assert.match(data.message as string, /does not use cookies/);
});

test('callSetupTool login with any cookie provider reaches port validation', async () => {
  const result = await callSetupTool({ action: 'login', provider: 'reddit', port: 80 }, { env: {} });
  const text = textFromResult(result);
  const data = JSON.parse(text) as Record<string, unknown>;
  assert.equal(data.ok, false);
  assert.match(data.message as string, /1024-65535/);
  assert.doesNotMatch(data.message as string, /no configured login URL/);
});

test('callSetupTool import_cookies provider honors browser automation opt-out', async () => {
  const result = await callSetupTool(
    { action: 'import_cookies', provider: 'facebook' },
    { env: { PI_SEARCH_BROWSER_AUTOMATION: '0' } },
  );
  const text = textFromResult(result);
  const data = JSON.parse(text) as Record<string, unknown>;
  assert.equal(data.ok, false);
  assert.match(data.message as string, /disabled/);
});

test('callSetupTool login provider honors browser automation opt-out', async () => {
  const result = await callSetupTool(
    { action: 'login', provider: 'facebook', port: 9222 },
    { env: { PI_SEARCH_BROWSER_AUTOMATION: '0' } },
  );
  const text = textFromResult(result);
  const data = JSON.parse(text) as Record<string, unknown>;
  assert.equal(data.ok, false);
  assert.match(data.message as string, /Browser automation disabled/);
});

test('callSetupTool plan: reddit not configured for incomplete OAuth triple', async () => {
  const partial = await callSetupTool({ action: 'plan' }, { env: { REDDIT_CLIENT_ID: 'id', REDDIT_CLIENT_SECRET: 'sec' } });
  const partialText = (partial.content as Array<{ text?: string }>)[0]?.text ?? '';
  const partialData = JSON.parse(partialText) as { providers: Array<Record<string, unknown>> };
  const partialReddit = partialData.providers.find((p) => p.provider === 'reddit');
  assert.equal(partialReddit?.configured, false, 'incomplete OAuth triple must not claim configured');

  const full = await callSetupTool({ action: 'plan' }, { env: { REDDIT_CLIENT_ID: 'id', REDDIT_CLIENT_SECRET: 'sec', REDDIT_USER_AGENT: 'ua/1' } });
  const fullText = (full.content as Array<{ text?: string }>)[0]?.text ?? '';
  const fullData = JSON.parse(fullText) as { providers: Array<Record<string, unknown>> };
  const fullReddit = fullData.providers.find((p) => p.provider === 'reddit');
  assert.equal(fullReddit?.configured, true, 'complete OAuth triple must claim configured');
  assert.doesNotMatch(partialText, /sec/);
});

// ── Stage 0.3: explicit cookie-import consent ──

test('first start does not import browser cookies without explicit opt-in', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pi-northstar-consent-'));
  try {
    await ensureFirstStartBootstrap({ PI_SEARCH_BOOTSTRAP: 'auto', PI_SEARCH_ALLOW_INSTALL: '0', PI_SEARCH_STATE_DIR: dir });
    const state = JSON.parse(await readFile(join(dir, 'bootstrap.json'), 'utf8')) as Record<string, unknown>;
    assert.equal('cookies' in state, false, 'no cookie import may run without PI_SEARCH_AUTO_COOKIES=1');
    const cookieFiles = await readdir(join(dir, 'cookies')).catch(() => [] as string[]);
    assert.equal(cookieFiles.filter((f) => f.endsWith('.storageState.json')).length, 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('first start never imports browser cookies even with PI_SEARCH_AUTO_COOKIES=1', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pi-northstar-state-'));
  try {
    await ensureFirstStartBootstrap({ PI_SEARCH_BOOTSTRAP: 'auto', PI_SEARCH_ALLOW_INSTALL: '0', PI_SEARCH_AUTO_COOKIES: '1', PI_SEARCH_STATE_DIR: dir });
    const state = JSON.parse(await readFile(join(dir, 'bootstrap.json'), 'utf8')) as Record<string, unknown>;
    assert.equal('cookies' in state, false, 'startup must never import cookies, legacy opt-in flag ignored');
    const cookieFiles = await readdir(join(dir, 'cookies')).catch(() => [] as string[]);
    assert.equal(cookieFiles.filter((f) => f.endsWith('.storageState.json')).length, 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('bare auto setup never imports cookies instead of importing', async () => {
  const result = await callSetupTool({}, { env: { PI_SEARCH_ALLOW_INSTALL: '0' } });
  const data = JSON.parse(textFromResult(result)) as Record<string, unknown>;
  const cookies = data.cookies as Record<string, unknown>;
  assert.equal(cookies.ok, false);
  assert.match(cookies.message as string, /never runs/);
});

test('bare auto never imports cookies even with kill switches set', async () => {
  const result = await callSetupTool({}, { env: { PI_SEARCH_ALLOW_INSTALL: '0', PI_SEARCH_AUTO_COOKIES: '1', PI_SEARCH_BROWSER_AUTOMATION: '0' } });
  const data = JSON.parse(textFromResult(result)) as Record<string, unknown>;
  const cookies = data.cookies as Record<string, unknown>;
  assert.equal(cookies.ok, false);
  assert.match(cookies.message as string, /never runs/);
});

test('import_cookies rejects session-owned providers without cookie-consuming backends', async () => {
  for (const provider of ['twitter', 'xiaohongshu', 'facebook', 'instagram', 'linkedin']) {
    const result = await callSetupTool({ action: 'import_cookies', provider }, { env: {} });
    const data = JSON.parse(textFromResult(result)) as Record<string, unknown>;
    assert.equal(data.status, 'error', `${provider} must not import unused cookies`);
    assert.match(data.message as string, /no working cookie-consuming backend/);
    assert.doesNotMatch(data.message as string, /planned/, `${provider} refusal must not claim planned status`);
  }
});

test('import_cookies with removed providers returns unknown error', async () => {
  for (const provider of ['xueqiu', 'xiaoyuzhou']) {
    const result = await callSetupTool({ action: 'import_cookies', provider }, { env: {} });
    const data = JSON.parse(textFromResult(result)) as Record<string, unknown>;
    assert.equal(data.status, 'error', `${provider} must stay unknown after dead channel purge`);
    assert.match(data.message as string, /Unknown provider/);
  }
});

test('install_channels treats linkedin as operational', async () => {
  const result = await callSetupTool({ action: 'install_channels', channels: 'linkedin' }, { env: { PI_SEARCH_ALLOW_INSTALL: '0' } });
  const data = JSON.parse(textFromResult(result)) as Record<string, unknown>;
  assert.equal(data.descriptor, true);
  assert.equal('plannedChannels' in data, false, 'linkedin is available, never a planned skip');
  const providers = data.backends as Array<Record<string, unknown>>;
  assert.ok(providers.find((p) => p.provider === 'linkedin'), 'linkedin must be in operational backends');
});

test('install_channels rejects removed channels as unknown', async () => {
  const result = await callSetupTool({ action: 'install_channels', channels: 'xueqiu' }, { env: {} });
  const data = JSON.parse(textFromResult(result)) as Record<string, unknown>;
  assert.equal(data.status, 'error');
  assert.match(data.message as string, /Unknown channels: xueqiu/);
});

test('install_channels with available channels reports no planned skips', async () => {
  const result = await callSetupTool({ action: 'install_channels', channels: 'github,linkedin' }, { env: { PI_SEARCH_ALLOW_INSTALL: '0' } });
  const data = JSON.parse(textFromResult(result)) as Record<string, unknown>;
  assert.equal(data.descriptor, true);
  assert.equal('plannedChannels' in data, false, 'no planned channels remain in the registry');
  const providers = data.backends as Array<Record<string, unknown>>;
  assert.equal(providers.length, 2);
});

test('plan reflects canonical registry: linkedin available, dead channels gone', async () => {
  const result = await callSetupTool({ action: 'plan' }, {});
  const text = textFromResult(result);
  const data = JSON.parse(text) as Record<string, unknown>;
  const platforms = data.platforms as Array<Record<string, unknown>>;
  const providers = data.providers as Array<Record<string, unknown>>;

  const linkedinPlatform = platforms.find((p) => p.platform === 'linkedin');
  assert.ok(linkedinPlatform, 'linkedin must remain in plan');
  assert.equal(linkedinPlatform.availability, 'available');
  assert.equal(linkedinPlatform.ready, '—', 'linkedin must not claim ready capability beyond its unlock line');
  assert.doesNotMatch(String(linkedinPlatform.unlock), /planned/);
  assert.match(String(linkedinPlatform.setup), /OpenCLI/);

  const twitterPlatform = platforms.find((p) => p.platform === 'twitter');
  assert.ok(twitterPlatform, 'twitter must remain in plan');
  assert.match(String(twitterPlatform.setup), /twitter-cli/);
  assert.doesNotMatch(String(twitterPlatform.setup), /TWITTER_AUTH_TOKEN|TWITTER_CT0/);

  const linkedinProvider = providers.find((p) => p.provider === 'linkedin');
  assert.ok(linkedinProvider, 'linkedin provider must be present');
  assert.equal(linkedinProvider.availability, 'available');
  // Session readiness is never inferred from binary presence: empty env means
  // unconfigured regardless of which CLIs exist on the machine.
  assert.equal(linkedinProvider.configured, false);

  for (const removed of ['xueqiu', 'xiaoyuzhou']) {
    assert.equal(platforms.find((p) => p.platform === removed), undefined, `${removed} platform must be gone`);
    assert.equal(providers.find((p) => p.provider === removed), undefined, `${removed} provider must be gone`);
  }

  // False capability claims are gone.
  assert.doesNotMatch(text, /Jina Reader/);
  assert.doesNotMatch(text, /xueqiu|xiaoyuzhou/i);
  assert.doesNotMatch(text, /planned/i);
});
