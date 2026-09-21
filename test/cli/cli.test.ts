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
    message: 'Usage: northstar <github|research|social|media|kg|graph|fetch|search|domains|capabilities|status|config|version>',
  });
});

test('public call rejects even when the former debug gate is enabled', async () => {
  const result = await runCommand(
    ['call', 'github', '{}'],
    { PI_NORTHSTAR_ALLOW_DEBUG_CALL: '1' },
  );

  assert.equal(result.ok, false);
  assert.equal(result.error?.code, 'unsupported_command');
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

test('CLI help output lists broker serve and jobs status', async () => {
  const result = await runCommand(['--help'], {});
  assert.equal(result.ok, true);
  const commands = (result.data as { commands: string[] }).commands;
  assert.ok(
    commands.some((cmd) => cmd.includes('northstar broker serve')),
    'help commands must list broker serve',
  );
  assert.ok(
    commands.some((cmd) => cmd.includes('northstar jobs status')),
    'help commands must list jobs status',
  );

  const brokerHelp = await runCommand(['broker', '--help'], {});
  assert.equal(brokerHelp.ok, true);
  assert.equal((brokerHelp.data as { commandId: string }).commandId, 'broker.serve');

  const jobsHelp = await runCommand(['jobs', '--help'], {});
  assert.equal(jobsHelp.ok, true);
  assert.equal((jobsHelp.data as { commandId: string }).commandId, 'jobs.status');
});

test('dispatch routes jobs status with bad args to validation failure without spawning', async () => {
  const missingArgs = await runCommand(['jobs', 'status'], {});
  assert.equal(missingArgs.ok, false);
  assert.equal(missingArgs.error?.code, 'invalid_usage');

  const invalidReq = await runCommand(['jobs', 'status', '--project-id', 'p1', '--request-id', 'bad$char', '--json'], {});
  assert.equal(invalidReq.ok, false);
  const parsed = JSON.parse(invalidReq.data as string) as { outcome: string; error?: { code: string } };
  assert.equal(parsed.outcome, 'failed');
  assert.equal(parsed.error?.code, 'invalid_input');
});

test('broker serve with invalid projectId fails without touching the host', async () => {
  const result = await runCommand(['broker', 'serve', '--project-id', '../escape', '--json'], {});
  assert.equal(result.ok, false);
  const parsed = JSON.parse(result.data as string) as { outcome: string; error?: { code: string } };
  assert.equal(parsed.outcome, 'failed');
  assert.equal(parsed.error?.code, 'invalid_input');
});
