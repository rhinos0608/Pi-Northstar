import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cliToolError, runCommand } from '../../src/cli/cli.js';
import { buildCliEnvironment } from '../../src/cli/cli-backend.js';
import { SocialError, type SocialErrorCode } from '../../src/social/social-contract.js';

test('buildCliEnvironment scopes research API keys to the research child', () => {
  const research = buildCliEnvironment({
    SEMANTIC_SCHOLAR_API_KEY: 's2-key',
    OPENALEX_API_KEY: 'openalex-key',
    NCBI_API_KEY: 'ncbi-key',
    NCBI_EMAIL: 'research@example.com',
    STACKEXCHANGE_KEY: 'se-key',
    UNRELATED_SECRET: 'never-forwarded',
  }, 'research');
  assert.equal(research.SEMANTIC_SCHOLAR_API_KEY, 's2-key');
  assert.equal(research.OPENALEX_API_KEY, 'openalex-key');
  assert.equal(research.NCBI_API_KEY, 'ncbi-key');
  assert.equal(research.NCBI_EMAIL, 'research@example.com');
  assert.equal(research.STACKEXCHANGE_KEY, 'se-key');
  assert.equal(research.UNRELATED_SECRET, undefined);
});

test('buildCliEnvironment keeps research keys out of unrelated children', () => {
  const web = buildCliEnvironment({
    SEMANTIC_SCHOLAR_API_KEY: 'SENTINEL_S2_abc123xyz',
    TAVILY_API_KEY: 'SENTINEL_TAVILY_abc123xyz',
    GITHUB_TOKEN: 'SENTINEL_GITHUB_abc123xyz',
    REDDIT_CLIENT_SECRET: 'SENTINEL_REDDIT_abc123xyz',
  }, 'web_search');
  assert.equal(web.TAVILY_API_KEY, 'SENTINEL_TAVILY_abc123xyz');
  assert.equal(web.SEMANTIC_SCHOLAR_API_KEY, undefined);
  assert.equal(web.GITHUB_TOKEN, undefined);
  assert.equal(web.REDDIT_CLIENT_SECRET, undefined);

  const github = buildCliEnvironment({
    GITHUB_TOKEN: 'SENTINEL_GITHUB_abc123xyz',
    TAVILY_API_KEY: 'SENTINEL_TAVILY_abc123xyz',
    DIFFBOT_TOKEN: 'SENTINEL_DIFFBOT_abc123xyz',
  }, 'github');
  assert.equal(github.GITHUB_TOKEN, 'SENTINEL_GITHUB_abc123xyz');
  assert.equal(github.TAVILY_API_KEY, undefined);
  assert.equal(github.DIFFBOT_TOKEN, undefined);

  const graph = buildCliEnvironment({
    GRAPH_SPARQL_ENDPOINT: 'https://sparql.example.org/',
    GRAPH_SPARQL_TOKEN: 'SENTINEL_SPARQL_abc123xyz',
    GITHUB_TOKEN: 'SENTINEL_GITHUB_abc123xyz',
  }, 'graph');
  assert.equal(graph.GRAPH_SPARQL_ENDPOINT, 'https://sparql.example.org/');
  assert.equal(graph.GRAPH_SPARQL_TOKEN, 'SENTINEL_SPARQL_abc123xyz');
  assert.equal(graph.GITHUB_TOKEN, undefined);

  const fetchEnv = buildCliEnvironment({
    JINA_API_KEY: 'SENTINEL_JINA_abc123xyz',
    GITHUB_TOKEN: 'SENTINEL_GITHUB_abc123xyz',
    REDDIT_COOKIE: 'SENTINEL_REDDIT_abc123xyz',
  }, 'fetch');
  assert.equal(fetchEnv.JINA_API_KEY, 'SENTINEL_JINA_abc123xyz');
  assert.equal(fetchEnv.GITHUB_TOKEN, undefined);
  assert.equal(fetchEnv.REDDIT_COOKIE, undefined);
});

test('buildCliEnvironment gives unknown tools base config only', () => {
  const env = buildCliEnvironment({
    PATH: '/usr/bin',
    PI_SEARCH_WEB_PROVIDER_TIMEOUT_MS: '5000',
    GITHUB_TOKEN: 'SENTINEL_GITHUB_abc123xyz',
    TAVILY_API_KEY: 'SENTINEL_TAVILY_abc123xyz',
  });
  assert.equal(env.PATH, '/usr/bin');
  assert.equal(env.PI_SEARCH_WEB_PROVIDER_TIMEOUT_MS, '5000');
  assert.equal(env.GITHUB_TOKEN, undefined);
  assert.equal(env.TAVILY_API_KEY, undefined);
});

test('buildCliEnvironment omits unset research keys', () => {
  const env = buildCliEnvironment({ PATH: '/usr/bin' }, 'research');
  assert.equal(env.SEMANTIC_SCHOLAR_API_KEY, undefined);
  assert.equal(env.NCBI_EMAIL, undefined);
});

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
  const result = await runCommand(['call', 'browse', '{"action":"read","url":"file:///etc/passwd"}'], {});

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

test('cliToolError passes every SocialError code through with context', () => {
  const codes: SocialErrorCode[] = [
    'invalid_request',
    'unsupported_action',
    'not_found',
    'backend_unavailable',
    'authentication_required',
    'permission_denied',
    'rate_limited',
    'upstream_error',
    'malformed_upstream',
    'cursor_invalid',
    'cursor_mismatch',
  ];
  assert.equal(codes.length, 11);
  for (const code of codes) {
    const result = cliToolError(new SocialError(code, `probe ${code}`, { platform: 'reddit', backend: 'reddit-api' }));
    assert.equal(result.ok, false);
    assert.deepEqual(result.error, {
      code,
      message: `probe ${code}`,
      platform: 'reddit',
      backend: 'reddit-api',
    });
  }
});

test('cliToolError omits absent platform/backend and keeps plain Error as tool_error', () => {
  const bare = cliToolError(new SocialError('rate_limited', 'slow down', { backend: 'github-api' }));
  assert.deepEqual(bare.error, { code: 'rate_limited', message: 'slow down', backend: 'github-api' });

  const plain = cliToolError(new Error('boom'));
  assert.deepEqual(plain.error, { code: 'tool_error', message: 'boom' });

  const payload = JSON.stringify(cliToolError(new SocialError('not_found', 'missing', {})));
  assert.doesNotMatch(payload, /http/);
});

test('runCommand surfaces SocialError codes instead of collapsing to tool_error', async () => {
  const result = await runCommand(['call', 'github', '{"action":"bogus"}'], {});
  assert.equal(result.ok, false);
  assert.equal(result.error?.code, 'unsupported_action');
});
