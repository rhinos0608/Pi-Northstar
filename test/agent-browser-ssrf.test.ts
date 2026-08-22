import assert from 'node:assert/strict';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { AgentBrowserAdapter } from '../src/agent-browser.js';

test('loopback adapter accepts configured origin without public validator', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pi-atlas-loopback-'));
  const executablePath = join(root, 'agent-browser.cjs');
  await writeFile(executablePath, '#!/usr/bin/env node\nconsole.log(JSON.stringify({ success: true, data: {} }));\n');
  await chmod(executablePath, 0o700);
  const adapter = new AgentBrowserAdapter({
    executablePath,
    loopbackMode: { proxyUrl: 'http://127.0.0.1:1', origin: 'http://localhost:3000' },
  });
  try {
    const result = await adapter.execute({ action: 'navigate', url: 'http://localhost:3000/path' }, { env: { PATH: process.env.PATH } });
    assert.match(String((result.content as Array<{ text?: string }>)[0]?.text), /"ok": true/);
    const rejected = await adapter.execute({ action: 'navigate', url: 'http://localhost:3001/' }, { env: { PATH: process.env.PATH } });
    assert.match(String((rejected.details as { error?: string }).error), /Different loopback origin/);
  } finally {
    await adapter.close();
    await rm(root, { recursive: true, force: true });
  }
});
