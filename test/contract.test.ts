import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MAX_PUBLIC_TOOLS, assertPublicToolBudget, parsePublicToolAllowlist, PUBLIC_TOOL_ALLOWLIST_ENV_VAR } from '../src/capabilities.js';

const ALWAYS_AVAILABLE_TOOL_NAMES = [] as const;

// DIFFBOT-gated tools: present only when DIFFBOT_TOKEN is set.
const DIFFBOT_TOOL_NAMES = [
  'kg',
  'graph',
] as const;

const CONFIGURED_TOOL_NAMES = [
  'web_search', 'fetch', 'github', 'social', 'kg', 'graph', 'browser', 'desktop', 'agent_poll',
] as const;

const EXPECTED_COMMAND_NAMES = [
  'chrome',
  'chrome-authorize',
  'chrome-install',
  'northstar',
  'reach-status',
  'reach-setup',
] as const;

const DISALLOWED_TOOL_NAMES = [
  'reach_status',
  'reach_setup',
  'browse',
  'semantic_crawl',
  'agentic_browse',
  'media',
  'video',
  'feeds',
  'research_sources',
  'cua',
  'cua_driver',
  'computer_use_click',
  'computer_use_type',
  'computer_use_screenshot',
] as const;

test('compiled CLI worker does not require tsx at runtime', async () => {
  const { readFile } = await import('node:fs/promises');
  const source = await readFile(new URL('../src/cli/cli-backend.ts', import.meta.url), 'utf8');
  assert.match(source, /resolveTsxLoader/);
  assert.match(source, /source CLI fallback requires dev dependency tsx/);
});

async function captureRegistration(overrides: Record<string, string> = {}): Promise<{ tools: string[]; commands: string[] }> {
  const tools: string[] = [];
  const commands: string[] = [];
  const values = {
    PI_SEARCH_BOOTSTRAP: 'off',
    [PUBLIC_TOOL_ALLOWLIST_ENV_VAR]: '',
    PI_SEARCH_DESKTOP_AUTOMATION: '',
    PI_SEARCH_BROWSER_AUTOMATION: '',
    BROWSER_EXECUTABLE_PATH: '',
    DIFFBOT_TOKEN: '',
    ...overrides,
  };
  const previous = new Map(Object.keys(values).map((key) => [key, process.env[key]]));

  Object.assign(process.env, values);
  try {
    const pi = {
      on: () => {},
      registerTool: (def: { name: string }) => tools.push(def.name),
      registerCommand: (name: string) => commands.push(name),
    };
    const mod = await import('../src/index.js');
    const extFn = mod.default as (pi: unknown) => void;
    extFn(pi);
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }

  return { tools, commands };
}

function assertToolContract(tools: string[], expected: readonly string[]): void {
  assert.deepEqual([...tools].sort(), [...expected].sort());
  for (const name of DISALLOWED_TOOL_NAMES) assert.ok(!tools.includes(name), `Disallowed tool present: ${name}`);
}

test('extension registers zero native tools by default, regardless credentials', async () => {
  const { tools } = await captureRegistration({ DIFFBOT_TOKEN: 'token', PI_SEARCH_DESKTOP_AUTOMATION: '1' });
  assert.deepEqual(tools, []);
});

test('extension hides browser and desktop without configuration', async () => {
  const { tools, commands } = await captureRegistration({
    BROWSER_EXECUTABLE_PATH: '/definitely/not/here/agent-browser',
  });
  // Subset assertions: kg/graph presence varies with DIFFBOT_TOKEN sources
  // (explicit env, .env, JSON config, login-shell fallback) — covered exactly
  // by the DIFFBOT-gated test below.
  for (const name of ALWAYS_AVAILABLE_TOOL_NAMES) assert.ok(tools.includes(name), `Tool '${name}' must be registered: ${name}`);
  for (const name of ['browser', 'desktop']) assert.ok(!tools.includes(name), `Tool '${name}' must be hidden: ${name}`);
  assert.deepEqual([...commands].sort(), [...EXPECTED_COMMAND_NAMES].sort());
});

test('DIFFBOT-gated tools: kg/graph hidden without token, registered with token', async (t) => {
  const withToken = await captureRegistration({ DIFFBOT_TOKEN: 'test-token-for-contract-tests', [PUBLIC_TOOL_ALLOWLIST_ENV_VAR]: 'kg,graph' });
  for (const name of DIFFBOT_TOOL_NAMES) assert.ok(withToken.tools.includes(name), `DIFFBOT tool missing with token: ${name}`);
  // Login-shell fallback can supply a real token on dev machines; only assert
  // absence when the merged env truly lacks one.
  const { loadSearchMcpEnvironment } = await import('../src/setup/local-config.js');
  const { diffbotConfigured } = await import('../src/diffbot/diffbot-search.js');
  const merged = loadSearchMcpEnvironment({ ...process.env, DIFFBOT_TOKEN: '' }, { allowLoginShellFallback: true });
  if (diffbotConfigured(merged)) {
    t.skip('login-shell fallback supplied a real DIFFBOT_TOKEN on this machine');
    return;
  }
  const without = await captureRegistration({});
  for (const name of DIFFBOT_TOOL_NAMES) assert.ok(!without.tools.includes(name), `DIFFBOT tool present without token: ${name}`);
});

test('extension registers browser and desktop when configured', async () => {
  const { tools, commands } = await captureRegistration({
    PI_SEARCH_DESKTOP_AUTOMATION: '1',
    DIFFBOT_TOKEN: 'test-token-for-contract-tests',
    [PUBLIC_TOOL_ALLOWLIST_ENV_VAR]: CONFIGURED_TOOL_NAMES.join(','),
  });
  assertToolContract(tools, CONFIGURED_TOOL_NAMES);
  assert.deepEqual([...commands].sort(), [...EXPECTED_COMMAND_NAMES].sort());
});

test('native tool allowlist rejects malformed, duplicate, legacy, and internal names', () => {
  assert.deepEqual(parsePublicToolAllowlist({}), []);
  assert.deepEqual(parsePublicToolAllowlist({ [PUBLIC_TOOL_ALLOWLIST_ENV_VAR]: 'web_search,fetch' }), ['web_search', 'fetch']);
  for (const value of ['web_search,', 'web_search,fetch ', 'web_search,web_search', 'browse', 'internal-acquisition', 'web-search']) {
    assert.throws(() => parsePublicToolAllowlist({ [PUBLIC_TOOL_ALLOWLIST_ENV_VAR]: value }), /PI_SEARCH_NATIVE_TOOLS/);
  }
});

test('public surface stays within the nine-tool budget', async () => {
  assert.equal(MAX_PUBLIC_TOOLS, 9, 'surface budget is nine tools');
  assert.equal(CONFIGURED_TOOL_NAMES.length, 9, 'full configured surface is exactly nine tools');
  assertPublicToolBudget(CONFIGURED_TOOL_NAMES);
  assert.throws(() => assertPublicToolBudget([...CONFIGURED_TOOL_NAMES, 'tenth']), /budget exceeded/);
  const { tools } = await captureRegistration({
    PI_SEARCH_DESKTOP_AUTOMATION: '1',
    DIFFBOT_TOKEN: 'test-token-for-contract-tests',
    [PUBLIC_TOOL_ALLOWLIST_ENV_VAR]: CONFIGURED_TOOL_NAMES.join(','),
  });
  assert.ok(tools.length <= MAX_PUBLIC_TOOLS, `registered ${tools.length} tools, max ${MAX_PUBLIC_TOOLS}`);
  assertPublicToolBudget(tools);
});

test('graph/kg gating is independent: SPARQL-only env registers graph without kg', async (t) => {
  const { tools } = await captureRegistration({
    DIFFBOT_TOKEN: '',
    [PUBLIC_TOOL_ALLOWLIST_ENV_VAR]: 'graph',
    GRAPH_SPARQL_ENDPOINT: 'http://127.0.0.1:9/sparql',
    GRAPH_SPARQL_TOKEN: '',
  });
  assert.ok(tools.includes('graph'), 'graph must register with only GRAPH_SPARQL_ENDPOINT set');
  // Login-shell fallback can supply a real DIFFBOT_TOKEN on dev machines; only
  // assert kg absence when the merged env truly lacks one.
  const { loadSearchMcpEnvironment } = await import('../src/setup/local-config.js');
  const { diffbotConfigured } = await import('../src/diffbot/diffbot-search.js');
  const merged = loadSearchMcpEnvironment(
    { ...process.env, DIFFBOT_TOKEN: '', GRAPH_SPARQL_ENDPOINT: 'http://127.0.0.1:9/sparql' },
    { allowLoginShellFallback: true },
  );
  if (diffbotConfigured(merged)) {
    t.skip('login-shell fallback supplied a real DIFFBOT_TOKEN on this machine');
    return;
  }
  assert.ok(!tools.includes('kg'), 'kg stays Diffbot-only and must be hidden without a token');
});

test('extension env resolution probes credentials only for valid non-empty allowlist', async () => {
  const { resolveExtensionEnv } = await import('../src/index.js');
  const dotEnv = { PI_SEARCH_NATIVE_TOOLS: 'web_search' };
  const calls: boolean[] = [];
  const fakeLoad = (env: Record<string, string | undefined>, options?: { allowLoginShellFallback?: boolean }) => {
    const probe = options?.allowLoginShellFallback === true;
    calls.push(probe);
    // Mimic merged config/env: explicit process blanks override .env values.
    const merged: Record<string, string | undefined> = { ...dotEnv, ...env };
    if (probe && merged.PI_SEARCH_NATIVE_TOOLS === 'web_search') merged.DIFFBOT_TOKEN = 'probed-token';
    return merged;
  };
  calls.length = 0;
  const blanked = resolveExtensionEnv({ PI_SEARCH_NATIVE_TOOLS: '' }, fakeLoad);
  assert.deepEqual([...blanked.allowedTools], []);
  assert.deepEqual(calls, [false], 'blank allowlist (explicit override of .env) must cause zero probes');
  assert.equal(blanked.env.DIFFBOT_TOKEN, undefined);
  calls.length = 0;
  assert.throws(() => resolveExtensionEnv({ PI_SEARCH_NATIVE_TOOLS: 'web_search,' }, fakeLoad), /PI_SEARCH_NATIVE_TOOLS/);
  assert.deepEqual(calls, [false], 'malformed allowlist must reject before any credential probe');
  calls.length = 0;
  const valid = resolveExtensionEnv({ PI_SEARCH_NATIVE_TOOLS: 'web_search' }, fakeLoad);
  assert.deepEqual([...valid.allowedTools], ['web_search']);
  assert.deepEqual(calls, [false, true], 'valid non-empty allowlist alone enables the login-shell fallback');
  assert.equal(valid.env.DIFFBOT_TOKEN, 'probed-token');
});

test('zero-tool backend init: malformed rejects, empty skips factory, nonempty calls once', async () => {
  const { resolveExtensionEnv, resolveSearchBackend } = await import('../src/index.js');
  const inertLoad = (env: Record<string, string | undefined>) => ({ ...env });
  let factoryCalls = 0;
  const fakeBackend = {
    calls: 0,
    async callTool() { this.calls += 1; return { content: [], details: {} }; },
    async close() {},
  };
  const factory = () => { factoryCalls += 1; return fakeBackend; };
  assert.throws(
    () => resolveExtensionEnv({ PI_SEARCH_NATIVE_TOOLS: 'web_search,' }, inertLoad),
    /PI_SEARCH_NATIVE_TOOLS/,
  );
  assert.equal(factoryCalls, 0, 'malformed allowlist rejects before any backend factory call');
  const empty = resolveExtensionEnv({}, inertLoad);
  assert.deepEqual([...empty.allowedTools], []);
  const inert = resolveSearchBackend(empty.env, empty.allowedTools, factory);
  assert.equal(factoryCalls, 0, 'empty allowlist must not construct a corpus/process/service backend');
  await assert.rejects(() => inert.callTool('search', {}), /no native tools authorized/);
  await inert.close();
  const valid = resolveExtensionEnv({ PI_SEARCH_NATIVE_TOOLS: 'web_search' }, inertLoad);
  const live = resolveSearchBackend(valid.env, valid.allowedTools, factory);
  assert.equal(factoryCalls, 1, 'valid non-empty allowlist calls the factory exactly once');
  assert.equal(live, fakeBackend);
});
