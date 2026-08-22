import assert from 'node:assert/strict';
import { test } from 'node:test';

const EXPECTED_TOOL_NAMES = [
  'web_search',
  'fetch',
  'github',
  'social',
  'media',
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

test('extension registers exactly expected tool and command names', async () => {
  const tools: string[] = [];
  const commands: string[] = [];
  const previousBootstrap = process.env.PI_SEARCH_BOOTSTRAP;
  process.env.PI_SEARCH_BOOTSTRAP = 'off';

  // Build a fake ExtensionAPI that records names only
  const pi = {
    on: () => {},
    registerTool: (def: { name: string }) => {
      tools.push(def.name);
    },
    registerCommand: (name: string) => {
      commands.push(name);
    },
  };

  try {
    // Dynamic import to avoid circular issues
    const mod = await import('../src/index.js');
    const extFn = mod.default as (pi: unknown) => void;
    extFn(pi);
  } finally {
    if (previousBootstrap === undefined) delete process.env.PI_SEARCH_BOOTSTRAP;
    else process.env.PI_SEARCH_BOOTSTRAP = previousBootstrap;
  }

  // Assert tool names match expected set
  for (const name of EXPECTED_TOOL_NAMES) {
    assert.ok(tools.includes(name), `Missing required tool: ${name}`);
  }

  // Assert no disallowed tool names
  for (const name of DISALLOWED_TOOL_NAMES) {
    assert.ok(!tools.includes(name), `Disallowed tool present: ${name}`);
  }

  // Assert command names match expected set
  for (const name of EXPECTED_COMMAND_NAMES) {
    assert.ok(commands.includes(name), `Missing required command: ${name}`);
  }

  // No unexpected tools or commands
  assert.equal(tools.length, EXPECTED_TOOL_NAMES.length,
    `Expected ${EXPECTED_TOOL_NAMES.length} tools, got ${tools.length}: ${tools.join(', ')}`);
  assert.equal(commands.length, EXPECTED_COMMAND_NAMES.length,
    `Expected ${EXPECTED_COMMAND_NAMES.length} commands, got ${commands.length}: ${commands.join(', ')}`);
});
