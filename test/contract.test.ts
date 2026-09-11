import assert from 'node:assert/strict';
import { test } from 'node:test';

const ALWAYS_AVAILABLE_TOOL_NAMES = [
  'web_search',
  'fetch',
  'github',
  'social',
  'media',
  'kg',
] as const;

const CONFIGURED_TOOL_NAMES = [
  ...ALWAYS_AVAILABLE_TOOL_NAMES,
  'browser',
  'desktop',
] as const;

const EXPECTED_COMMAND_NAMES = [
  'reach-status',
  'reach-setup',
] as const;

const DISALLOWED_TOOL_NAMES = [
  'reach_status',
  'reach_setup',
  'browse',
  'semantic_crawl',
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
  assertToolContract(tools, ALWAYS_AVAILABLE_TOOL_NAMES);
  assert.deepEqual([...commands].sort(), [...EXPECTED_COMMAND_NAMES].sort());
});

test('extension registers browser and desktop when configured', async () => {
  const { tools, commands } = await captureRegistration({
    PI_SEARCH_DESKTOP_AUTOMATION: '1',
  });
  assertToolContract(tools, CONFIGURED_TOOL_NAMES);
  assert.deepEqual([...commands].sort(), [...EXPECTED_COMMAND_NAMES].sort());
});
