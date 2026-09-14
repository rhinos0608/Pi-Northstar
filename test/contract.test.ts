import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MAX_PUBLIC_TOOLS, assertPublicToolBudget } from '../src/capabilities.js';

const ALWAYS_AVAILABLE_TOOL_NAMES = [
  'web_search',
  'fetch',
  'github',
  'social',
  'agent_poll',
] as const;

// DIFFBOT-gated tools: present only when DIFFBOT_TOKEN is set.
const DIFFBOT_TOOL_NAMES = [
  'kg',
  'graph',
] as const;

const CONFIGURED_TOOL_NAMES = [
  ...ALWAYS_AVAILABLE_TOOL_NAMES,
  ...DIFFBOT_TOOL_NAMES,
  'browser',
  'desktop',
] as const;

const EXPECTED_COMMAND_NAMES = [
  'chrome',
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

test('import.meta.resolve("tsx") is used by CliSearchBackend subprocess', () => {
  const resolved = import.meta.resolve('tsx');
  assert.ok(typeof resolved === 'string');
  assert.ok(resolved.startsWith('file://'), 'cli-backend.ts and bin/pi-northstar.mjs use this path in --import');
});

async function captureRegistration(overrides: Record<string, string> = {}): Promise<{ tools: string[]; commands: string[] }> {
  const tools: string[] = [];
  const commands: string[] = [];
  const values = {
    PI_SEARCH_BOOTSTRAP: 'off',
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
  const withToken = await captureRegistration({ DIFFBOT_TOKEN: 'test-token-for-contract-tests' });
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
  });
  assertToolContract(tools, CONFIGURED_TOOL_NAMES);
  assert.deepEqual([...commands].sort(), [...EXPECTED_COMMAND_NAMES].sort());
});

test('public surface stays within the nine-tool budget', async () => {
  assert.equal(MAX_PUBLIC_TOOLS, 9, 'surface budget is nine tools');
  assert.equal(CONFIGURED_TOOL_NAMES.length, 9, 'full configured surface is exactly nine tools');
  assertPublicToolBudget(CONFIGURED_TOOL_NAMES);
  assert.throws(() => assertPublicToolBudget([...CONFIGURED_TOOL_NAMES, 'tenth']), /budget exceeded/);
  const { tools } = await captureRegistration({
    PI_SEARCH_DESKTOP_AUTOMATION: '1',
    DIFFBOT_TOKEN: 'test-token-for-contract-tests',
  });
  assert.ok(tools.length <= MAX_PUBLIC_TOOLS, `registered ${tools.length} tools, max ${MAX_PUBLIC_TOOLS}`);
  assertPublicToolBudget(tools);
});

test('graph/kg gating is independent: SPARQL-only env registers graph without kg', async (t) => {
  const { tools } = await captureRegistration({
    DIFFBOT_TOKEN: '',
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
