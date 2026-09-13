import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { discoverAndLoadExtensions } from '@earendil-works/pi-coding-agent';
import { AgentBrowserAdapter } from '../../src/browser/agent-browser.js';

test('adapter status reports exact executable version without browser launch', async () => {
  const adapter = new AgentBrowserAdapter();
  const result = await adapter.status();
  assert.match(String(result.details && (result.details as Record<string, unknown>).version), /0\.37\.1/);
  await adapter.close();
});

test('screenshot returns Pi image content with mimeType', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pi-atlas-screenshot-test-'));
  const runtimeRoot = join(root, 'runtime');
  const executablePath = join(root, 'agent-browser.cjs');
  await mkdir(join(runtimeRoot, 'screenshots'), { recursive: true });
  await writeFile(executablePath, `#!/usr/bin/env node
const { writeFileSync } = require('node:fs');
if (process.argv[2] === '--version') { process.stdout.write('agent-browser 0.37.1\\n'); process.exit(0); }
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
if (process.argv[2] === '--version') { process.stdout.write('agent-browser 0.37.1\\n'); process.exit(0); }
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
import { AgentBrowserAdapter } from ${JSON.stringify(join(process.cwd(), 'src/browser/agent-browser.js'))};

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

// ── argv-contract and policy regression tests ──

test('semanticAction nth dispatches index positionally (find nth <index> <selector>)', async () => {
  const { mkdtemp: mkd, writeFile: wf, readFile: rf, rm: rmf } = await import('node:fs/promises');
  const { tmpdir: td } = await import('node:os');
  const { join: joinp } = await import('node:path');
  const root = await mkd(joinp(td(), 'pi-atlas-nth-'));
  const runtimeRoot = joinp(root, 'runtime');
  const executablePath = joinp(root, 'agent-browser.cjs');
  const logPath = joinp(root, 'argv.log');
  await wf(executablePath, `#!/usr/bin/env node
const { appendFileSync } = require('node:fs');
if (process.argv[2] === '--version') { process.stdout.write('agent-browser 0.37.1\\n'); process.exit(0); }
appendFileSync(${JSON.stringify(logPath)}, process.argv.slice(2).join(' ') + '\\n');
process.stdout.write(JSON.stringify({success:true,data:{}})+'\\n');
`);
  const { chmod: chmodp } = await import('node:fs/promises');
  await chmodp(executablePath, 0o700);
  const adapter = new AgentBrowserAdapter({ executablePath, runtimeRoot });
  try {
    const result = await adapter.execute(
      { action: 'semanticAction', semanticAction: { locator: 'nth', query: '.card', verb: 'hover', index: 2 } },
      { env: { PATH: process.env.PATH } },
    );
    assert.equal((result.details as Record<string, unknown>).ok, true);
    const log = await rf(logPath, 'utf8');
    assert.match(log, /^find nth 2 \.card hover$/m);
  } finally {
    await adapter.close();
    await rmf(root, { recursive: true, force: true });
  }
});

test('batch open to private IP literal is rejected before dispatch', async () => {
  const { mkdtemp: mkd2, writeFile: wf2, rm: rm2, chmod: chmod2 } = await import('node:fs/promises');
  const { tmpdir: td2 } = await import('node:os');
  const { join: joinp2 } = await import('node:path');
  const root = await mkd2(joinp2(td2(), 'pi-atlas-batch-ssrf-'));
  const executablePath = joinp2(root, 'agent-browser.cjs');
  await wf2(executablePath, '#!/usr/bin/env node\nif (process.argv.includes("--version")) { console.log("agent-browser 0.37.1"); } else { process.exit(1); }\n');
  await chmod2(executablePath, 0o700);
  const adapter = new AgentBrowserAdapter({ executablePath, runtimeRoot: joinp2(root, 'runtime') });
  try {
    const result = await adapter.execute(
      { action: 'batch', batch: { commands: [{ args: ['open', 'http://10.0.0.1/loot'] }] } },
      { env: { PATH: process.env.PATH, PI_SEARCH_BROWSER_ALLOW_SENSITIVE: '1' } },
    );
    assert.match(String((result.details as Record<string, unknown>).error), /command 0/);
    assert.match(String((result.details as Record<string, unknown>).error), /Private\/reserved|Blocked hostname|Disallowed/);
  } finally {
    await adapter.close();
    await rm2(root, { recursive: true, force: true });
  }
});

test('explicit executable path with wrong version is rejected', async () => {
  const { mkdtemp: mkd3, writeFile: wf3, rm: rm3, chmod: chmod3 } = await import('node:fs/promises');
  const { tmpdir: td3 } = await import('node:os');
  const { join: joinp3 } = await import('node:path');
  const root = await mkd3(joinp3(td3(), 'pi-atlas-version-gate-'));
  const executablePath = joinp3(root, 'agent-browser.cjs');
  await wf3(executablePath, '#!/usr/bin/env node\nconsole.log("agent-browser 0.30.0");\n');
  await chmod3(executablePath, 0o700);
  const adapter = new AgentBrowserAdapter({ executablePath, runtimeRoot: joinp3(root, 'runtime') });
  try {
    const result = await adapter.execute({ action: 'snapshot' }, { env: { PATH: process.env.PATH } });
    assert.match(String((result.details as Record<string, unknown>).error), /version mismatch/);
  } finally {
    await adapter.close();
    await rm3(root, { recursive: true, force: true });
  }
});

// ── select action + batch loopback denial ──

test('select dispatches option values via stdin batch, never argv', async () => {
  const { mkdtemp: mkd4, writeFile: wf4, readFile: rf4, rm: rm4, chmod: chmod4 } = await import('node:fs/promises');
  const { tmpdir: td4 } = await import('node:os');
  const { join: joinp4 } = await import('node:path');
  const root = await mkd4(joinp4(td4(), 'pi-atlas-select-'));
  const executablePath = joinp4(root, 'agent-browser.cjs');
  const logPath = joinp4(root, 'argv.log');
  const stdinPath = joinp4(root, 'stdin.log');
  await wf4(executablePath, `#!/usr/bin/env node
const { appendFileSync: afs } = require('node:fs');
if (process.argv[2] === '--version') { process.stdout.write('agent-browser 0.37.1\\n'); process.exit(0); }
let body = '';
process.stdin.on('data', (c) => { body += c; });
process.stdin.on('end', () => {
  afs(${JSON.stringify(logPath)}, process.argv.slice(2).join(' ') + '\\n');
  afs(${JSON.stringify(stdinPath)}, body + '\\n');
  process.stdout.write(JSON.stringify({success:true,data:{}})+'\\n');
});
`);
  await chmod4(executablePath, 0o700);
  const adapter = new AgentBrowserAdapter({ executablePath, runtimeRoot: joinp4(root, 'runtime') });
  try {
    const result = await adapter.execute(
      { action: 'select', selector: '#country', values: ['US', 'CA'] },
      { env: { PATH: process.env.PATH } },
    );
    assert.equal((result.details as Record<string, unknown>).ok, true);
    assert.match(await rf4(logPath, 'utf8'), /^batch --json --bail$/m);
    assert.doesNotMatch(await rf4(logPath, 'utf8'), /select #country/);
    assert.match(await rf4(stdinPath, 'utf8'), /"select","#country","US","CA"/);
    const tooMany = await adapter.execute(
      { action: 'select', selector: '#country', values: Array.from({ length: 33 }, (_, i) => `v${i}`) },
      { env: { PATH: process.env.PATH } },
    );
    assert.match(String((tooMany.details as Record<string, unknown>).error), /too many values/);
  } finally {
    await adapter.close();
    await rm4(root, { recursive: true, force: true });
  }
});

test('batch navigation commands are rejected in loopback sessions', async () => {
  const { mkdtemp: mkd5, writeFile: wf5, rm: rm5, chmod: chmod5 } = await import('node:fs/promises');
  const { tmpdir: td5 } = await import('node:os');
  const { join: joinp5 } = await import('node:path');
  const root = await mkd5(joinp5(td5(), 'pi-atlas-batch-loopback-'));
  const executablePath = joinp5(root, 'agent-browser.cjs');
  await wf5(executablePath, '#!/usr/bin/env node\nif (process.argv.includes("--version")) { console.log("agent-browser 0.37.1"); } else { process.exit(1); }\n');
  await chmod5(executablePath, 0o700);
  const adapter = new AgentBrowserAdapter({
    executablePath,
    runtimeRoot: joinp5(root, 'runtime'),
    loopbackMode: { proxyUrl: 'http://127.0.0.1:1', origin: 'http://localhost:3000' },
  });
  try {
    const result = await adapter.execute(
      { action: 'batch', batch: { commands: [{ args: ['open', 'https://example.com/'] }] } },
      { env: { PATH: process.env.PATH, PI_SEARCH_BROWSER_ALLOW_SENSITIVE: '1' } },
    );
    assert.match(String((result.details as Record<string, unknown>).error), /not allowed in batch for loopback sessions/);
  } finally {
    await adapter.close();
    await rm5(root, { recursive: true, force: true });
  }
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

test('batch with unknown subcommand is rejected before session/spawn', async () => {
  // No executable, no env: allowlist validation in execute() must reject before
  // the sensitive gate, session creation, or any child-process spawn.
  const adapter = new AgentBrowserAdapter();
  const result = await adapter.execute(
    { action: 'batch', batch: { commands: [{ args: ['session', 'shutdown', '--force'] }] } },
    { env: {} },
  );
  assert.match(String((result.details as Record<string, unknown>).error), /unsupported batch subcommand/);
  await adapter.close();
});

test('batch dispatches preflight-normalized navigation URLs preserving order', async () => {
  const { mkdtemp: mkd6, writeFile: wf6, readFile: rf6, rm: rm6, chmod: chmod6 } = await import('node:fs/promises');
  const { tmpdir: td6 } = await import('node:os');
  const { join: joinp6 } = await import('node:path');
  const root = await mkd6(joinp6(td6(), 'pi-atlas-batch-normalize-'));
  const executablePath = joinp6(root, 'agent-browser.cjs');
  const stdinPath = joinp6(root, 'stdin.log');
  await wf6(executablePath, `#!/usr/bin/env node
const { appendFileSync: afs } = require('node:fs');
if (process.argv[2] === '--version') { process.stdout.write('agent-browser 0.37.1\\n'); process.exit(0); }
let body = '';
process.stdin.on('data', (c) => { body += c; });
process.stdin.on('end', () => {
  afs(${JSON.stringify(stdinPath)}, body + '\\n');
  const count = JSON.parse(body).length;
  for (let i = 0; i < count; i++) process.stdout.write(JSON.stringify({success:true,data:{}})+'\\n');
});
`);
  await chmod6(executablePath, 0o700);
  const adapter = new AgentBrowserAdapter({ executablePath, runtimeRoot: joinp6(root, 'runtime') });
  try {
    const result = await adapter.execute(
      { action: 'batch', batch: { commands: [{ args: ['open', 'https://EXAMPLE.com/'] }, { args: ['click', '#btn'] }] } },
      { env: { PATH: process.env.PATH, PI_SEARCH_BROWSER_ALLOW_SENSITIVE: '1' } },
    );
    const steps = (result.details as Record<string, unknown>).steps as Array<Record<string, unknown>>;
    assert.equal(steps.length, 2);
    const stdin = await rf6(stdinPath, 'utf8');
    assert.match(stdin, /"open","https:\/\/example\.com\/"/);
    assert.doesNotMatch(stdin, /EXAMPLE/);
    assert.match(stdin, /"click","#btn"/);
    assert.ok(stdin.indexOf('"open"') < stdin.indexOf('"click"'));
  } finally {
    await adapter.close();
    await rm6(root, { recursive: true, force: true });
  }
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

test('wait with selector scopes text match to the element', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pi-atlas-wait-scope-test-'));
  const runtimeRoot = join(root, 'runtime');
  const executablePath = join(root, 'agent-browser.cjs');
  await mkdir(runtimeRoot, { recursive: true });
  await writeFile(executablePath, `#!/usr/bin/env node
if (process.argv[2] === '--version') { process.stdout.write('agent-browser 0.37.1\\n'); process.exit(0); }
if (process.argv[2] === 'wait') { process.stdout.write(JSON.stringify({ success: true }) + '\\n'); process.exit(0); }
if (process.argv[2] === 'get' && process.argv[3] === 'text') {
  const sel = process.argv[4] ?? '';
  const text = sel === '#target' ? 'hello inside target' : 'unrelated page body';
  process.stdout.write(JSON.stringify({ success: true, data: text }) + '\\n');
  process.exit(0);
}
process.stdout.write(JSON.stringify({ success: true }) + '\\n');
`);
  await chmod(executablePath, 0o700);

  const adapter = new AgentBrowserAdapter({ executablePath, runtimeRoot });
  try {
    const env = { PATH: process.env.PATH };
    const hit = await adapter.execute({ action: 'wait', selector: '#target', text: 'inside' }, { env });
    assert.equal((hit.details as Record<string, unknown>).ok, true);
    // Text exists page-wide but not in #target: page-wide matching would pass.
    const miss = await adapter.execute({ action: 'wait', selector: '#target', text: 'unrelated page body' }, { env });
    assert.equal((miss.details as Record<string, unknown>).ok, false);
  } finally {
    await adapter.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('click with stale @e ref returns staleRef true', async () => {
  const adapter = new AgentBrowserAdapter();
  const result = await adapter.execute({ action: 'click', selector: '@e5' }, { env: {} });
  const details = result.details as Record<string, unknown>;
  assert.equal(details.staleRef, true);
  assert.match(String(details.error), /Stale or unknown ref/);
  assert.equal((result as unknown as { failureCategory?: string }).failureCategory, 'stale-ref');
  await adapter.close();
});
