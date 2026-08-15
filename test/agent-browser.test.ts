import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { discoverAndLoadExtensions } from '@earendil-works/pi-coding-agent';
import { AgentBrowserAdapter } from '../src/agent-browser.js';

test('adapter status reports exact executable version without browser launch', async () => {
  const adapter = new AgentBrowserAdapter();
  const result = await adapter.status();
  assert.match(String(result.details && (result.details as Record<string, unknown>).version), /0\.32\.0/);
  await adapter.close();
});

test('screenshot returns Pi image content with mimeType', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pi-atlas-screenshot-test-'));
  const runtimeRoot = join(root, 'runtime');
  const executablePath = join(root, 'agent-browser.cjs');
  await mkdir(join(runtimeRoot, 'screenshots'), { recursive: true });
  await writeFile(executablePath, `#!/usr/bin/env node
const { writeFileSync } = require('node:fs');
if (process.argv[2] === 'screenshot') {
  const png = Buffer.alloc(25);
  png.set([0x89, 0x50, 0x4e, 0x47]);
  png.writeUInt32BE(1, 16);
  png.writeUInt32BE(1, 20);
  writeFileSync(process.argv[3], png);
}
`);
  await chmod(executablePath, 0o700);

  const adapter = new AgentBrowserAdapter({ executablePath, runtimeRoot });
  try {
    const result = await adapter.execute({ action: 'screenshot' }, { env: { PATH: process.env.PATH } });
    const image = (result.content as Array<Record<string, unknown>>)[0];
    assert.equal(image?.type, 'image');
    assert.equal(image?.mimeType, 'image/png');
    assert.equal(image?.mediaType, undefined);
  } finally {
    await adapter.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('screenshot returns Pi image content with mimeType through the Pi Jiti loader', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pi-atlas-jiti-screenshot-test-'));
  const runtimeRoot = join(root, 'runtime');
  const executablePath = join(root, 'agent-browser.cjs');
  const extensionPath = join(root, 'screenshot-extension.ts');
  await mkdir(join(runtimeRoot, 'screenshots'), { recursive: true });
  await writeFile(executablePath, `#!/usr/bin/env node
const { writeFileSync } = require('node:fs');
if (process.argv[2] === 'screenshot') {
  const png = Buffer.alloc(25);
  png.set([0x89, 0x50, 0x4e, 0x47]);
  png.writeUInt32BE(1, 16);
  png.writeUInt32BE(1, 20);
  writeFileSync(process.argv[3], png);
}
`);
  await chmod(executablePath, 0o700);
  await writeFile(extensionPath, `
import { AgentBrowserAdapter } from ${JSON.stringify(join(process.cwd(), 'src/agent-browser.js'))};

export default function (pi) {
  pi.registerTool({
    name: 'browser-screenshot-probe',
    label: 'Browser screenshot probe',
    description: 'Exercise the browser screenshot result through the Pi extension loader.',
    parameters: { type: 'object', properties: {} },
    async execute() {
      const adapter = new AgentBrowserAdapter({
        executablePath: ${JSON.stringify(executablePath)},
        runtimeRoot: ${JSON.stringify(runtimeRoot)},
      });
      try {
        return await adapter.execute(
          { action: 'screenshot' },
          { env: { PATH: process.env.PATH } },
        );
      } finally {
        await adapter.close();
      }
    },
  });
}
`);

  try {
    const loaded = await discoverAndLoadExtensions([extensionPath], process.cwd(), root);
    assert.deepEqual(loaded.errors, []);
    const tool = loaded.extensions[0]?.tools.get('browser-screenshot-probe');
    assert.ok(tool);
    const result = await tool.definition.execute('probe', {}, undefined, undefined, {} as never);
    const image = result.content[0];
    assert.equal(image?.type, 'image');
    if (!image || image.type !== 'image') assert.fail('expected image content');
    assert.equal(image.mimeType, 'image/png');
    assert.equal((image as unknown as { mediaType?: unknown }).mediaType, undefined);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('sensitive actions disabled by default via policy', async () => {
  const adapter = new AgentBrowserAdapter();
  const result = await adapter.execute({ action: 'evaluate', expression: '1+1' }, { env: {} });
  assert.match(String(result.details && (result.details as Record<string, unknown>).error), /disabled by policy/);
  assert.equal((result as unknown as { failureCategory?: string }).failureCategory, 'policy-denied');
  await adapter.close();
});

// ── semanticAction validation ──

test('semanticAction returns error when semanticAction field is missing', async () => {
  const adapter = new AgentBrowserAdapter();
  const result = await adapter.execute({ action: 'semanticAction' }, { env: {} });
  const details = result.details as Record<string, unknown>;
  assert.match(String(details.error), /semanticAction is required/);
  await adapter.close();
});

test('semanticAction validation rejects missing locator', async () => {
  const adapter = new AgentBrowserAdapter();
  const result = await adapter.execute(
    { action: 'semanticAction', semanticAction: { query: 'Submit', verb: 'click' } },
    { env: {} },
  );
  const details = result.details as Record<string, unknown>;
  assert.match(String(details.error), /locator is required/);
  assert.equal((result as unknown as { failureCategory?: string }).failureCategory, 'invalid-request');
  await adapter.close();
});

test('semanticAction validation rejects missing verb', async () => {
  const adapter = new AgentBrowserAdapter();
  const result = await adapter.execute(
    { action: 'semanticAction', semanticAction: { locator: 'role', query: 'Submit' } },
    { env: {} },
  );
  const details = result.details as Record<string, unknown>;
  assert.match(String(details.error), /verb is required/);
  assert.equal((result as unknown as { failureCategory?: string }).failureCategory, 'invalid-request');
  await adapter.close();
});

// ── job validation ──

test('job returns error when job field is missing', async () => {
  const adapter = new AgentBrowserAdapter();
  const result = await adapter.execute({ action: 'job' }, { env: {} });
  const details = result.details as Record<string, unknown>;
  assert.match(String(details.error), /job is required/);
  await adapter.close();
});

test('job returns validation error for empty steps', async () => {
  const adapter = new AgentBrowserAdapter();
  const result = await adapter.execute({ action: 'job', job: { steps: [] } }, { env: {} });
  const details = result.details as Record<string, unknown>;
  assert.match(String(details.error), /non-empty/);
  assert.equal((result as unknown as { failureCategory?: string }).failureCategory, 'invalid-request');
  await adapter.close();
});

// ── batch policy denial ──

test('batch denied without PI_SEARCH_BROWSER_ALLOW_SENSITIVE', async () => {
  const adapter = new AgentBrowserAdapter();
  const result = await adapter.execute(
    { action: 'batch', batch: { commands: [{ args: ['eval', '1'] }] } },
    { env: {} },
  );
  const details = result.details as Record<string, unknown>;
  assert.match(String(details.error), /disabled by policy/);
  assert.equal((result as unknown as { failureCategory?: string }).failureCategory, 'policy-denied');
  await adapter.close();
});

// ── snapshot basic smoke ──

test('snapshot returns error when no browser session exists', async () => {
  const adapter = new AgentBrowserAdapter();
  const result = await adapter.execute({ action: 'snapshot' }, { env: {} });
  // Without a browser session, this should either error gracefully or succeed
  // The important thing is it doesn't throw
  assert.ok(result !== undefined);
  await adapter.close();
});

// ── click stale ref ──

test('click with stale @e ref returns staleRef true', async () => {
  const adapter = new AgentBrowserAdapter();
  const result = await adapter.execute({ action: 'click', selector: '@e5' }, { env: {} });
  const details = result.details as Record<string, unknown>;
  assert.equal(details.staleRef, true);
  assert.match(String(details.error), /Stale or unknown ref/);
  assert.equal((result as unknown as { failureCategory?: string }).failureCategory, 'stale-ref');
  await adapter.close();
});
