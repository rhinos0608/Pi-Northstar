import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
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
  assert.match(text, /Browser cookie import disabled/);
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

  // At least some cookie-backed providers
  const facebook = cookieProviders.find((p) => p.provider === 'facebook');
  assert.ok(facebook, 'facebook must be in cookieProviders');
  assert.ok(Array.isArray(facebook.cookieDomains));
  assert.ok((facebook.cookieDomains as string[]).includes('facebook.com'));

  const twitter = cookieProviders.find((p) => p.provider === 'twitter');
  assert.ok(twitter, 'twitter must be in cookieProviders');
  assert.ok(Array.isArray(twitter.cookieDomains));
  assert.ok((twitter.cookieDomains as string[]).includes('twitter.com'));

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
  const result = await callSetupTool({ action: 'login', provider: 'github', port: 80 }, { env: {} });
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
