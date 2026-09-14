import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { AgentBrowserAdapter } from '../../src/browser/agent-browser.js';
import type { DnsLookup } from '../../src/network-policy.js';

/** Hermetic DNS: example.com/example.org resolve to a public IP without external network. */
const stubLookup: DnsLookup = async () => [{ address: '93.184.216.34', family: 4 }];

function fakeScript(): string {
  return `#!/usr/bin/env node
const args=process.argv.slice(2);
if(args[0]==='--version'){process.stdout.write('agent-browser 0.37.1\\n');process.exit(0);}
function out(o){ process.stdout.write(JSON.stringify(o)+'\\n'); }
if(args[0]==='batch'){
  let body=''; process.stdin.on('data',c=>body+=c); process.stdin.on('end',()=>{
    let cmds=[]; try{cmds=JSON.parse(body);}catch{cmds=[];}
    const results=cmds.map(cmd=>{
      if((cmd[0]==='open'||cmd[0]==='navigate') && String(cmd[1]||'').includes('fail-first')) return {success:false, error:'navigation failed: boom'};
      return {success:true, data:{}};
    });
    process.stdout.write(JSON.stringify(results)+'\\n');
  });
} else if(args[0]==='open'){
  if(String(args[1]||'').includes('fail-first')) out({success:false, error:'navigation failed: boom'});
  else out({success:true, data:{}});
} else out({success:true, data:{}});
`;
}

async function makeAdapter() {
  const root = await mkdtemp(join(tmpdir(), 'pi-atlas-host-freeze-'));
  const runtimeRoot = join(root, 'runtime');
  const executablePath = join(root, 'agent-browser.cjs');
  await mkdir(join(runtimeRoot, 'screenshots'), { recursive: true });
  await writeFile(executablePath, fakeScript(), { mode: 0o700 });
  await chmod(executablePath, 0o700);
  const adapter = new AgentBrowserAdapter({ executablePath, runtimeRoot, dnsLookup: stubLookup });
  return { adapter, root };
}

const env = { PATH: process.env.PATH };
const batchEnv = { PATH: process.env.PATH, PI_SEARCH_BROWSER_ALLOW_SENSITIVE: '1' };

test('failed open does not freeze; second navigate to different host succeeds', async () => {
  const { adapter, root } = await makeAdapter();
  try {
    const first = await adapter.execute({ action: 'navigate', url: 'https://example.com/fail-first' }, { env });
    assert.equal((first.details as Record<string, unknown>).ok, false);
    // If the failed open had frozen the session to example.com, this would be
    // rejected by the domain policy. Success proves domainsFrozen=false.
    const second = await adapter.execute({ action: 'navigate', url: 'https://example.org/' }, { env });
    assert.equal((second.details as Record<string, unknown>).ok, true);
  } finally {
    await adapter.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('batch second host blocked by staged containment; rejected batch leaves session unfrozen', async () => {
  const { adapter, root } = await makeAdapter();
  try {
    const batch = await adapter.execute(
      { action: 'batch', batch: { commands: [{ args: ['open', 'https://example.com/'] }, { args: ['open', 'https://example.org/'] }] } },
      { env: batchEnv },
    );
    assert.match(String((batch.details as Record<string, unknown>).error), /command 1/);
    assert.match(String((batch.details as Record<string, unknown>).error), /blocked by domain policy/);
    // Preflight-only rejection must not freeze: a fresh navigate elsewhere succeeds.
    const nav = await adapter.execute({ action: 'navigate', url: 'https://example.org/' }, { env });
    assert.equal((nav.details as Record<string, unknown>).ok, true);
  } finally {
    await adapter.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('successful batch navigation commits freeze for rest of session', async () => {
  const { adapter, root } = await makeAdapter();
  try {
    const batch = await adapter.execute(
      { action: 'batch', batch: { commands: [{ args: ['open', 'https://example.com/'] }] } },
      { env: batchEnv },
    );
    const steps = (batch.details as Record<string, unknown>).steps as Array<{ resultCategory?: string }>;
    assert.equal(steps[0]?.resultCategory, 'success');
    const nav = await adapter.execute({ action: 'navigate', url: 'https://example.org/' }, { env });
    assert.equal((nav.details as Record<string, unknown>).ok, false);
    assert.match(String((nav.details as Record<string, unknown>).error), /blocked by domain policy/);
  } finally {
    await adapter.close();
    await rm(root, { recursive: true, force: true });
  }
});
