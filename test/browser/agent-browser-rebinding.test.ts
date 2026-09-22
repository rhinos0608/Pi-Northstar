import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { AgentBrowserAdapter } from '../../src/browser/agent-browser.js';
import type { DnsLookup } from '../../src/network-policy.js';

function fakeScript(): string {
  return `#!/usr/bin/env node
const args=process.argv.slice(2);
if(args[0]==='--version'){process.stdout.write('agent-browser 0.37.1\\n');process.exit(0);}
function out(o){ process.stdout.write(JSON.stringify(o)+'\\n'); }
if(args[0]==='batch'){
  let body=''; process.stdin.on('data',c=>body+=c); process.stdin.on('end',()=>{
    let cmds=[]; try{cmds=JSON.parse(body);}catch{cmds=[];}
    const results=cmds.some((c) => c[0]==='tab')
      ? [{success:true, data:{}}]
      : cmds.map((c) => (c[0]==='eval' ? {success:false, error:'eval-executed'} : {success:true, data:{}}));
    process.stdout.write(JSON.stringify(results)+'\\n');
  });
} else if(args[0]==='open'){ out({success:true, data:{}}); }
else out({success:true, data:{}});
`;
}

async function makeAdapter(dnsLookup: DnsLookup) {
  const root = await mkdtemp(join(tmpdir(), 'pi-atlas-rebind-'));
  const runtimeRoot = join(root, 'runtime');
  const executablePath = join(root, 'agent-browser.cjs');
  await mkdir(join(runtimeRoot, 'screenshots'), { recursive: true });
  await writeFile(executablePath, fakeScript(), { mode: 0o700 });
  await chmod(executablePath, 0o700);
  const adapter = new AgentBrowserAdapter({ executablePath, runtimeRoot, dnsLookup });
  return { adapter, root };
}

const env = { PATH: process.env.PATH };
const batchEnv = { PATH: process.env.PATH, PI_SEARCH_BROWSER_ALLOW_SENSITIVE: '1' };

test('preflight docs admit DNS-rebinding TOCTOU in user-Chrome path', () => {
  const policy = readFileSync('src/browser/browser-policy.ts', 'utf8');
  assert.match(policy, /Strongly filtered, DNS-rebinding TOCTOU remains in user-Chrome path/);
  assert.match(policy, /hostname-only/);
});

test('DNR comment admits hostname-only confinement', () => {
  const sw = readFileSync('chrome-extension/service_worker.js', 'utf8');
  assert.match(sw, /Hostname-only confinement/);
  assert.match(sw, /DNS-rebinding TOCTOU remains in user-Chrome path/);
});

test('post-nav re-check triggers on stub DNS flipping public->private', async () => {
  // First navigation consumes two pre-open lookups (dnsPreflight +
  // validateAllowedDomainsDns); the post-open re-resolution is call 3+.
  let calls = 0;
  const flipping: DnsLookup = async () => {
    calls += 1;
    if (calls <= 2) return [{ address: '93.184.216.34', family: 4 }];
    return [{ address: '192.168.1.10', family: 4 }];
  };
  const { adapter, root } = await makeAdapter(flipping);
  try {
    const result = await adapter.execute({ action: 'navigate', url: 'https://example.com/' }, { env });
    assert.equal((result.details as Record<string, unknown>).ok, false);
    assert.match(String((result.details as Record<string, unknown>).error), /DNS rebinding suspected/);
    assert.match(String((result.details as Record<string, unknown>).error), /TOCTOU remains/);
  } finally {
    await adapter.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('post-nav re-check keeps success when re-resolution fails (no proof)', async () => {
  let calls = 0;
  const flaky: DnsLookup = async () => {
    calls += 1;
    if (calls <= 2) return [{ address: '93.184.216.34', family: 4 }];
    throw new Error('getaddrinfo EAI_AGAIN example.com');
  };
  const { adapter, root } = await makeAdapter(flaky);
  try {
    const result = await adapter.execute({ action: 'navigate', url: 'https://example.com/' }, { env });
    assert.equal((result.details as Record<string, unknown>).ok, true);
  } finally {
    await adapter.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('batch aborts before post-navigation commands on DNS flip (eval never dispatched)', async () => {
  let calls = 0;
  const flipping: DnsLookup = async () => {
    calls += 1;
    if (calls <= 2) return [{ address: '93.184.216.34', family: 4 }];
    return [{ address: '10.0.0.5', family: 4 }];
  };
  const { adapter, root } = await makeAdapter(flipping);
  try {
    const result = await adapter.execute(
      { action: 'batch', batch: { commands: [{ args: ['open', 'https://example.com/'] }, { args: ['eval', '1+1'] }] } },
      { env: batchEnv },
    );
    const details = result.details as Record<string, unknown>;
    assert.equal(details.ok, false);
    assert.match(String(details.error), /DNS rebinding suspected/);
    // The eval segment never reached the CLI: the fake CLI fails any eval it
    // sees, so an aborted (not eval-executed) second step proves dispatch order.
    const steps = details.steps as Array<Record<string, unknown>>;
    assert.equal(steps.length, 2);
    assert.equal(steps[0]!.resultCategory, 'success');
    assert.equal(steps[1]!.resultCategory, 'failure');
    assert.match(String(steps[1]!.error), /aborted/);
    assert.doesNotMatch(String(steps[1]!.error), /eval-executed/);
  } finally {
    await adapter.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('batch aborts on incomplete segment results (fail closed)', async () => {
  const alwaysPublic: DnsLookup = async () => [{ address: '93.184.216.34', family: 4 }];
  const { adapter, root } = await makeAdapter(alwaysPublic);
  try {
    // 'tab' makes the fake CLI return one result for a two-command segment:
    // execution state is unknown, so the batch must abort, not continue.
    const result = await adapter.execute(
      { action: 'batch', batch: { commands: [{ args: ['tab', 'list'] }, { args: ['open', 'https://example.com/'] }] } },
      { env: batchEnv },
    );
    const details = result.details as Record<string, unknown>;
    assert.equal(details.ok, false);
    assert.match(String(details.error), /incomplete results/);
    const steps = details.steps as Array<Record<string, unknown>>;
    assert.equal(steps.length, 2);
  } finally {
    await adapter.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('batch post-nav re-check triggers on stub DNS flipping public->private', async () => {
  let calls = 0;
  const flipping: DnsLookup = async () => {
    calls += 1;
    if (calls <= 2) return [{ address: '93.184.216.34', family: 4 }];
    return [{ address: '10.0.0.5', family: 4 }];
  };
  const { adapter, root } = await makeAdapter(flipping);
  try {
    const result = await adapter.execute(
      { action: 'batch', batch: { commands: [{ args: ['open', 'https://example.com/'] }] } },
      { env: batchEnv },
    );
    assert.equal((result.details as Record<string, unknown>).ok, false);
    assert.match(String((result.details as Record<string, unknown>).error), /DNS rebinding suspected/);
  } finally {
    await adapter.close();
    await rm(root, { recursive: true, force: true });
  }
});
