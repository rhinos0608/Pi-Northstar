import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runCommand } from '../src/cli.js';

test('runCommand status reports native CLI backend configuration', async () => {
  assert.deepEqual(await runCommand(['status'], { SEARCH_MCP_COMMAND: 'node', SEARCH_MCP_ARGS_JSON: '["server.js"]' }), {
    ok: true,
    data: {
      backend: 'native-cli',
      command: 'node',
      args: ['server.js'],
      cwd: null,
      defaultCommand: 'search-mcp',
    },
  });
});

test('runCommand config reports env-facing settings', async () => {
  assert.deepEqual(await runCommand(['config'], { SEARCH_MCP_CWD: '/tmp/search-mcp', SEARCH_MCP_CONFIG_PATH: '/tmp/missing-pi-search-config.json' }), {
    ok: true,
    data: {
      searchBackend: 'native-cli',
      searchMcpCommand: 'search-mcp',
      searchMcpArgsJson: '[]',
      searchMcpCwd: '/tmp/search-mcp',
      localConfig: {
        path: '/tmp/missing-pi-search-config.json',
        loaded: false,
        mappedKeys: [],
      },
    },
  });
});

test('runCommand rejects unknown commands', async () => {
  const result = await runCommand(['unknown'], {});

  assert.equal(result.ok, false);
  assert.deepEqual(result.error, {
    code: 'unknown_command',
    message: 'Usage: pi-northstar <status|config|call TOOL JSON_ARGS>',
  });
});

test('runCommand validates call args', async () => {
  const result = await runCommand(['call', 'web_search', '[]'], {});

  assert.equal(result.ok, false);
  assert.equal(result.error?.code, 'invalid_args');
});

test('runCommand routes call through native tools', async () => {
  const result = await runCommand(['call', 'agentic_browse', '{"action":"read","url":"file:///etc/passwd"}'], {});

  assert.equal(result.ok, false);
  assert.equal(result.error?.code, 'tool_error');
  assert.match(result.error?.message ?? '', /Disallowed URL scheme/);
});

test('runCommand supports public browse tool alias', async () => {
  const result = await runCommand(['call', 'browse', '{"url":"file:///etc/passwd"}'], {});

  assert.equal(result.ok, false);
  assert.equal(result.error?.code, 'tool_error');
  assert.match(result.error?.message ?? '', /Disallowed URL scheme/);
});

test('runCommand supports reach_status family', async () => {
  const result = await runCommand(['call', 'reach_status', '{"family":"media"}'], {});

  assert.equal(result.ok, true);
  assert.match(JSON.stringify(result.data), /native-rss-atom/);
});

test('runCommand supports reach_setup plan', async () => {
  const result = await runCommand(['call', 'reach_setup', '{"action":"plan"}'], {});

  assert.equal(result.ok, true);
  assert.match(JSON.stringify(result.data), /OpenCLI/);
  assert.match(JSON.stringify(result.data), /twitter/);
});

test('runCommand returns descriptor for setup install', async () => {
  const result = await runCommand(['call', 'reach_setup', '{"action":"install_all"}'], { PI_SEARCH_ALLOW_INSTALL: '0' });

  assert.equal(result.ok, true);
  assert.match(JSON.stringify(result.data), /descriptor/);
  assert.match(JSON.stringify(result.data), /Installation disabled/);
});

test('runCommand browser cookie import honors automation opt-out', async () => {
  const result = await runCommand(['call', 'reach_setup', '{"action":"import_cookies"}'], { PI_SEARCH_BROWSER_AUTOMATION: '0' });

  assert.equal(result.ok, true);
  assert.match(JSON.stringify(result.data), /disabled/);
});

test('runCommand import_cookies provider honors browser automation opt-out', async () => {
  const result = await runCommand(
    ['call', 'reach_setup', '{"action":"import_cookies","provider":"facebook"}'],
    { PI_SEARCH_BROWSER_AUTOMATION: '0' },
  );

  assert.equal(result.ok, true);
  assert.match(JSON.stringify(result.data), /disabled/);
});

test('runCommand login provider honors browser automation opt-out', async () => {
  const result = await runCommand(
    ['call', 'reach_setup', '{"action":"login","provider":"facebook","port":9222}'],
    { PI_SEARCH_BROWSER_AUTOMATION: '0' },
  );

  assert.equal(result.ok, true);
  assert.match(JSON.stringify(result.data), /Browser automation disabled/);
});

test('runCommand reach_setup status reports live env presence', async () => {
  const result = await runCommand(['call', 'reach_setup', '{"action":"status"}'], { GITHUB_TOKEN: 'ghp_test_val', EXA_API_KEY: 'exa_test_val' });

  assert.equal(result.ok, true);
  const text = JSON.stringify(result.data);

  // liveProviders section present
  assert.match(text, /liveProviders/);

  // github shows configured with key name
  assert.match(text, /GITHUB_TOKEN/);

  // No values leaked
  assert.doesNotMatch(text, /ghp_test_val/);
  assert.doesNotMatch(text, /exa_test_val/);

  // authDir present
  assert.match(text, /\.pi-northstar/);
});

test('runCommand reach_status includes auth metadata per channel', async () => {
  const result = await runCommand(['call', 'reach_status', '{"family":"media"}'], { GITHUB_TOKEN: 'dummy' });

  assert.equal(result.ok, true);
  const text = JSON.stringify(result.data);

  // auth field present on channel objects
  assert.match(text, /"auth"/);

  // rss channel should have configured=false (zero-config, no env keys)
  // but auth field present with loginFlow, cookieDomains, risk
});
