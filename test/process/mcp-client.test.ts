import assert from 'node:assert/strict';
import { test } from 'node:test';
import { resultToText } from '../../src/backend.js';
import { buildServerParameters, DEFAULT_SEARCH_MCP_COMMAND, redactSecrets, SearchMcpClient, SearchMcpToolError, secretValuesFromEnv, withStderr } from '../../src/process/mcp-client.js';

test('buildServerParameters uses search-mcp defaults', () => {
  const params = buildServerParameters({});

  assert.equal(params.command, DEFAULT_SEARCH_MCP_COMMAND);
  assert.deepEqual(params.args, []);
  assert.equal(params.stderr, 'pipe');
});

test('buildServerParameters accepts JSON args and cwd from environment', () => {
  const params = buildServerParameters({
    SEARCH_MCP_COMMAND: 'node',
    SEARCH_MCP_ARGS_JSON: '["dist/index.js", "--json"]',
    SEARCH_MCP_CWD: '/tmp/search-mcp',
  });

  assert.equal(params.command, 'node');
  assert.deepEqual(params.args, ['dist/index.js', '--json']);
  assert.equal(params.cwd, '/tmp/search-mcp');
});

test('buildServerParameters rejects invalid JSON args', () => {
  assert.throws(
    () => buildServerParameters({ SEARCH_MCP_ARGS_JSON: '{"bad": true}' }),
    /SEARCH_MCP_ARGS_JSON must be a JSON string array/,
  );
});

test('buildServerParameters rejects non-string JSON args', () => {
  assert.throws(
    () => buildServerParameters({ SEARCH_MCP_ARGS_JSON: '["ok", 1]' }),
    /SEARCH_MCP_ARGS_JSON must be a JSON string array/,
  );
});

test('buildServerParameters falls back when command is blank', () => {
  const params = buildServerParameters({ SEARCH_MCP_COMMAND: '   ' });

  assert.equal(params.command, DEFAULT_SEARCH_MCP_COMMAND);
});

test('buildServerParameters filters inherited environment', () => {
  const params = buildServerParameters({
    PATH: '/usr/bin',
    DATABASE_URL: 'secret',
    SEARCH_MCP_CWD: '/tmp/search-mcp',
    SEARCH_MCP_FORWARD_ENV_JSON: '["CUSTOM_ALLOWED"]',
    CUSTOM_ALLOWED: 'ok',
  });

  assert.deepEqual(params.env, {
    PATH: '/usr/bin',
    SEARCH_MCP_CWD: '/tmp/search-mcp',
    SEARCH_MCP_FORWARD_ENV_JSON: '["CUSTOM_ALLOWED"]',
    CUSTOM_ALLOWED: 'ok',
  });
});

test('buildServerParameters forwards TAVILY_RESEARCH_MODEL by default', () => {
  const params = buildServerParameters({ TAVILY_RESEARCH_MODEL: 'auto', DATABASE_URL: 'secret' });
  assert.equal(params.env?.TAVILY_RESEARCH_MODEL, 'auto');
  assert.equal(params.env?.DATABASE_URL, undefined);
});

test('buildServerParameters rejects invalid forwarded env list', () => {
  assert.throws(
    () => buildServerParameters({ SEARCH_MCP_FORWARD_ENV_JSON: '[1]' }),
    /SEARCH_MCP_FORWARD_ENV_JSON must be a JSON string array/,
  );
});

test('provider credential keys forward to the MCP server; tuning vars stay blocked', () => {
  const params = buildServerParameters({
    PATH: '/usr/bin',
    DIFFBOT_TOKEN: 'SENTINEL_DIFFBOT_TOKEN_abc123xyz',
    FIRECRAWL_API_KEY: 'SENTINEL_FIRECRAWL_KEY_abc123xyz',
    JINA_API_KEY: 'SENTINEL_JINA_KEY_abc123xyz',
    DIFFBOT_SEARCH_SIZE: '10',
    DIFFBOT_ENHANCE_SIZE: '1',
    DIFFBOT_NLP_MAX_CHARS: '100000',
    DIFFBOT_MAX_PROVIDERS: '3',
    DIFFBOT_FALLBACK_BUDGET: '3',
  });
  assert.equal(params.env?.DIFFBOT_TOKEN, 'SENTINEL_DIFFBOT_TOKEN_abc123xyz');
  assert.equal(params.env?.FIRECRAWL_API_KEY, 'SENTINEL_FIRECRAWL_KEY_abc123xyz');
  assert.equal(params.env?.JINA_API_KEY, 'SENTINEL_JINA_KEY_abc123xyz');
  for (const key of [
    'DIFFBOT_SEARCH_SIZE',
    'DIFFBOT_ENHANCE_SIZE',
    'DIFFBOT_NLP_MAX_CHARS',
    'DIFFBOT_MAX_PROVIDERS',
    'DIFFBOT_FALLBACK_BUDGET',
  ]) {
    assert.equal(params.env?.[key], undefined, `MCP server env must not carry ${key} by default`);
  }
});

test('resultToText keeps text content and serializes non-text content', () => {
  const text = resultToText({
    content: [
      { type: 'text', text: 'alpha' },
      { type: 'image', mimeType: 'image/png', data: 'abc' },
    ],
  });

  assert.equal(text, 'alpha\n{"type":"image","mimeType":"image/png","data":"abc"}');
});

test('resultToText serializes non-content results', () => {
  assert.equal(resultToText({ ok: true }), '{\n  "ok": true\n}');
});

test('resultToText handles undefined content items', () => {
  assert.equal(resultToText({ content: [undefined] }), 'undefined');
});

test('withStderr redacts exact forwarded secret values', () => {
  const secret = 'SENTINEL_GITHUB_TOKEN_abc123xyz';
  const secrets = secretValuesFromEnv({ GITHUB_TOKEN: secret, PATH: '/usr/bin' });
  assert.deepEqual(secrets, [secret]);
  const err = withStderr(new Error('boom'), `auth failed for ${secret} retry`, secrets);
  assert.ok(!err.message.includes(secret), 'thrown message must not echo secret');
  assert.ok(err.message.includes('[redacted]'));
});

test('withStderr redacts secrets from the error message itself', () => {
  const secret = 'SENTINEL_EXA_KEY_abc123xyz';
  const err = withStderr(new Error(`call failed ${secret}`), 'tail', [secret]);
  assert.ok(!err.message.includes(secret));
});

test('redactSecrets replaces all occurrences and skips empties', () => {
  assert.equal(redactSecrets('a X b X', ['X']), 'a [redacted] b [redacted]');
  assert.equal(redactSecrets('unchanged', ['', 'zzz']), 'unchanged');
});

test('callTool redacts secret-bearing stderr from transport failures', async () => {
  const secret = 'SENTINEL_BRAVE_KEY_abc123xyz';
  const params = buildServerParameters({ BRAVE_API_KEY: secret });
  const client = new SearchMcpClient(params) as unknown as {
    stderrTail: string;
    connect: () => Promise<{ callTool: () => Promise<unknown> }>;
    callTool: (name: string, args: Record<string, unknown>) => Promise<unknown>;
  };
  client.stderrTail = `server log leaked ${secret} end`;
  client.connect = async () => ({
    callTool: async () => {
      throw new Error('transport boom');
    },
  });
  await assert.rejects(client.callTool('search', {}), (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.ok(!error.message.includes(secret), 'thrown message must not echo secret');
    assert.ok(error.message.includes('[redacted]'));
    return true;
  });
});

test('callTool rejects resolved isError:true results as SearchMcpToolError', async () => {
  const params = buildServerParameters({});
  const client = new SearchMcpClient(params) as unknown as {
    connect: () => Promise<{ callTool: () => Promise<unknown> }>;
    callTool: (name: string, args: Record<string, unknown>) => Promise<unknown>;
  };
  client.connect = async () => ({
    callTool: async () => ({
      content: [{ type: 'text', text: 'tool blew up' }],
      isError: true,
    }),
  });
  await assert.rejects(client.callTool('search', {}), (error: unknown) => {
    assert.ok(error instanceof SearchMcpToolError);
    assert.equal((error as SearchMcpToolError).name, 'SearchMcpToolError');
    assert.equal((error as SearchMcpToolError).code, 'SEARCH_MCP_TOOL_ERROR');
    assert.ok((error as Error).message.includes('tool blew up'));
    return true;
  });
});

test('callTool redacts secrets inside isError:true content', async () => {
  const secret = 'SENTINEL_TAVILY_KEY_abc123xyz';
  const params = buildServerParameters({ TAVILY_API_KEY: secret });
  const client = new SearchMcpClient(params) as unknown as {
    connect: () => Promise<{ callTool: () => Promise<unknown> }>;
    callTool: (name: string, args: Record<string, unknown>) => Promise<unknown>;
  };
  client.connect = async () => ({
    callTool: async () => ({
      content: [{ type: 'text', text: `denied ${secret}` }],
      isError: true,
    }),
  });
  await assert.rejects(client.callTool('search', {}), (error: unknown) => {
    assert.ok(error instanceof SearchMcpToolError);
    assert.ok(!(error as Error).message.includes(secret));
    return true;
  });
});

test('callTool passes through successful results without throwing', async () => {
  const params = buildServerParameters({});
  const client = new SearchMcpClient(params) as unknown as {
    connect: () => Promise<{ callTool: () => Promise<unknown> }>;
    callTool: (name: string, args: Record<string, unknown>) => Promise<unknown>;
  };
  const ok = { content: [{ type: 'text', text: 'fine' }] };
  client.connect = async () => ({
    callTool: async () => ok,
  });
  assert.deepEqual(await client.callTool('search', {}), ok);
});

test('withStderr redacts base error message when stderr is empty', () => {
  const secret = 'SENTINEL_EMPTY_STDERR_abc123xyz';
  const err = withStderr(new Error(`transport ${secret} boom`), '', [secret]);
  assert.ok(!err.message.includes(secret), 'empty-stderr path must not echo secret');
  assert.ok(err.message.includes('[redacted]'));
});

test('withStderr redacts non-Error thrown value when stderr is empty', () => {
  const secret = 'SENTINEL_STRING_THROW_abc123xyz';
  const err = withStderr(`string failure ${secret}`, '   ', [secret]);
  assert.ok(!err.message.includes(secret));
  assert.ok(err.message.includes('[redacted]'));
});

test('secretValuesFromEnv is sensitive-by-default: lowercase + CREDENTIAL + custom keys', () => {
  const lower = 'SENTINEL_LOWER_TOKEN_abc123xyz';
  const cred = 'SENTINEL_CRED_abc123xyz';
  const custom = 'SENTINEL_CUSTOM_abc123xyz';
  const secrets = secretValuesFromEnv({
    my_token: lower,
    CREDENTIAL: cred,
    CUSTOM_ALLOWED: custom,
    PATH: '/usr/bin',
    HOME: '/root',
    SEARCH_MCP_COMMAND: 'search-mcp',
  });
  assert.ok(secrets.includes(lower), 'lowercase my_token must be secret-capable');
  assert.ok(secrets.includes(cred), 'CREDENTIAL must be secret-capable');
  assert.ok(secrets.includes(custom), 'custom forwarded key must be secret-capable');
  assert.ok(!secrets.includes('/usr/bin'), 'PATH stays benign');
  assert.ok(!secrets.includes('/root'), 'HOME stays benign');
  assert.ok(!secrets.includes('search-mcp'), 'SEARCH_MCP_* stays benign');
});

test('callTool redacts lowercase forwarded secret from stderr', async () => {
  const secret = 'SENTINEL_LOWER_FWD_abc123xyz';
  const params = buildServerParameters({
    SEARCH_MCP_FORWARD_ENV_JSON: '["my_token"]',
    my_token: secret,
  });
  assert.equal(params.env?.my_token, secret);
  const client = new SearchMcpClient(params) as unknown as {
    stderrTail: string;
    connect: () => Promise<{ callTool: () => Promise<unknown> }>;
    callTool: (name: string, args: Record<string, unknown>) => Promise<unknown>;
  };
  client.stderrTail = `server log leaked ${secret} end`;
  client.connect = async () => ({
    callTool: async () => {
      throw new Error('transport boom');
    },
  });
  await assert.rejects(client.callTool('search', {}), (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.ok(!error.message.includes(secret), 'lowercase forwarded secret must not echo');
    assert.ok(error.message.includes('[redacted]'));
    return true;
  });
});

test('callTool redacts CREDENTIAL-style forwarded secret from stderr', async () => {
  const secret = 'SENTINEL_CRED_FWD_abc123xyz';
  const params = buildServerParameters({
    SEARCH_MCP_FORWARD_ENV_JSON: '["MY_CREDENTIAL"]',
    MY_CREDENTIAL: secret,
  });
  const client = new SearchMcpClient(params) as unknown as {
    stderrTail: string;
    connect: () => Promise<{ callTool: () => Promise<unknown> }>;
    callTool: (name: string, args: Record<string, unknown>) => Promise<unknown>;
  };
  client.stderrTail = `denied ${secret}`;
  client.connect = async () => ({
    callTool: async () => {
      throw new Error('transport boom');
    },
  });
  await assert.rejects(client.callTool('search', {}), (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.ok(!error.message.includes(secret), 'CREDENTIAL secret must not echo');
    return true;
  });
});

test('withStderr redacts secret carried on Error cause', () => {
  const secret = 'SENTINEL_CAUSE_abc123xyz';
  const inner = new Error(`inner ${secret} detail`);
  const outer = new Error('outer boom', { cause: inner });
  const err = withStderr(outer, '', [secret]);
  assert.ok(!err.message.includes(secret));
  const causeText = err.cause instanceof Error ? err.cause.message : String(err.cause ?? '');
  assert.ok(!causeText.includes(secret), 'cause must be redacted or dropped');
  assert.ok(!JSON.stringify(err).includes(secret));
});

test('withStderr redacts string cause carrying secret', () => {
  const secret = 'SENTINEL_STR_CAUSE_abc123xyz';
  const outer = new Error('outer boom', { cause: `raw ${secret}` });
  const err = withStderr(outer, `tail ${secret}`, [secret]);
  assert.ok(!err.message.includes(secret));
  assert.ok(!String((err as { cause?: unknown }).cause ?? '').includes(secret));
});

test('callTool redacts unknown SEARCH_MCP_* secret from stderr canary', async () => {
  const canary = 'SENTINEL_CANARY_SEARCH_MCP_TOKEN_abc123xyz';
  const custom = 'SENTINEL_CANARY_CUSTOM_SECRET_abc123xyz';
  const params = buildServerParameters({
    SEARCH_MCP_TOKEN: canary,
    SEARCH_MCP_FORWARD_ENV_JSON: '["MY_CUSTOM_SECRET"]',
    MY_CUSTOM_SECRET: custom,
  });
  assert.equal(params.env?.SEARCH_MCP_TOKEN, canary);
  const secrets = secretValuesFromEnv(params.env as Record<string, string>);
  assert.ok(secrets.includes(canary), 'unknown SEARCH_MCP_* must be secret-capable');
  assert.ok(secrets.includes(custom), 'custom SECRET-ish key must be secret-capable');
  assert.ok(!secrets.includes('search-mcp'));
  const client = new SearchMcpClient(params) as unknown as {
    stderrTail: string;
    connect: () => Promise<{ callTool: () => Promise<unknown> }>;
    callTool: (name: string, args: Record<string, unknown>) => Promise<unknown>;
  };
  client.stderrTail = `server log leaked ${canary} and ${custom} end`;
  client.connect = async () => ({
    callTool: async () => {
      throw new Error('transport boom');
    },
  });
  await assert.rejects(client.callTool('search', {}), (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.ok(!error.message.includes(canary), 'thrown message must not echo SEARCH_MCP_TOKEN canary');
    assert.ok(!error.message.includes(custom), 'thrown message must not echo custom secret canary');
    assert.ok(error.message.includes('[redacted]'));
    return true;
  });
});

test('secretValuesFromEnv keeps known-benign SEARCH_MCP_* config benign', () => {
  const secrets = secretValuesFromEnv({
    SEARCH_MCP_COMMAND: 'search-mcp',
    SEARCH_MCP_ARGS_JSON: '["dist/index.js"]',
    SEARCH_MCP_CWD: '/tmp/search-mcp',
    SEARCH_MCP_FORWARD_ENV_JSON: '["CUSTOM_ALLOWED"]',
  });
  assert.deepEqual(secrets, []);
});
test('callTool redacts custom forwarded secret inside isError:true content', async () => {
  const secret = 'SENTINEL_CUSTOM_ISERROR_abc123xyz';
  const params = buildServerParameters({
    SEARCH_MCP_FORWARD_ENV_JSON: '["my_token"]',
    my_token: secret,
  });
  const client = new SearchMcpClient(params) as unknown as {
    connect: () => Promise<{ callTool: () => Promise<unknown> }>;
    callTool: (name: string, args: Record<string, unknown>) => Promise<unknown>;
  };
  client.connect = async () => ({
    callTool: async () => ({
      content: [{ type: 'text', text: `denied ${secret}` }],
      isError: true,
    }),
  });
  await assert.rejects(client.callTool('search', {}), (error: unknown) => {
    assert.ok(error instanceof SearchMcpToolError);
    assert.ok(!(error as Error).message.includes(secret), 'isError content must be redacted');
    assert.ok((error as Error).message.includes('[redacted]'));
    return true;
  });
});
