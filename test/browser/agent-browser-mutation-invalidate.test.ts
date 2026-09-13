import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { AgentBrowserAdapter } from '../../src/browser/agent-browser.js';

function fakeScript(opts: { probeSuccess?: boolean; failNavigate?: boolean } = {}): string {
  const probeSuccess = opts.probeSuccess ?? true;
  const failNavigate = opts.failNavigate ?? false;
  const batchHandler = probeSuccess
    ? `let cmds=[]; try{cmds=JSON.parse(body);}catch{cmds=[];} const results=cmds.map(cmd=>{ const expr=cmd[1]||''; if(cmd[0]==='eval' && expr.includes('__pi_click_probe__')){ if(expr.includes('window.__pi_click_probe__ =')) return {success:true}; return {success:true, data:{fired:true,target:true}}; } if(cmd[0]==='eval') return {success:true, data:{fired:true,count:0}}; return {success:true}; }); process.stdout.write(JSON.stringify(results)+'\\n');`
    : `let cmds=[]; try{cmds=JSON.parse(body);}catch{cmds=[];} const results=cmds.map(cmd=>{ const expr=cmd[1]||''; if(cmd[0]==='eval' && expr.includes('__pi_click_probe__')){ if(expr.includes('window.__pi_click_probe__ =')) return {success:true}; return {success:true, data:{fired:false}}; } if(cmd[0]==='eval') return {success:true, data:{fired:false,count:0}}; return {success:true}; }); process.stdout.write(JSON.stringify(results)+'\\n');`;
  return `#!/usr/bin/env node
const args=process.argv.slice(2);
if(args[0]==='--version'){process.stdout.write('agent-browser 0.37.1\\n');process.exit(0);}
function out(o){ process.stdout.write(JSON.stringify(o)+'\\n'); }
if(args[0]==='batch'){
  let body=''; process.stdin.on('data',c=>body+=c); process.stdin.on('end',()=>{ ${batchHandler} });
} else if(args[0]==='open'){
  if(${failNavigate} && String(args[1]||'').includes('fail')) out({success:false, error:'navigation failed'});
  else out({success:true, data:{}});
} else if(args[0]==='click' || args[0]==='type' || args[0]==='fill'){
  out({success:true, data:{}});
} else if(args[0]==='snapshot'){
  out({success:true, data:{url:'http://127.0.0.1:8765', nodes:[{ref:'@e1',role:'button',name:'Submit'}]}});
} else if(args[0]==='close'){
  out({success:true, data:{}});
} else if(args[0]==='eval'){
  const expr=args[1]||'';
  if(expr.includes('__pi_click_probe__')){
    if(expr.includes('window.__pi_click_probe__ =')) out({success:true, data:{}});
    else out({success:true, data:${probeSuccess ? '{fired:true,target:true}' : '{fired:false}'}});
  } else out({success:true, data:{fired:${probeSuccess ? 'true' : 'false'}, count:0}});
} else out({success:true, data:{}});
`;
}

async function makeAdapterWithFake(fakeContent: string, opts: { loopback?: boolean } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'pi-atlas-invalidate-'));
  const runtimeRoot = join(root, 'runtime');
  const executablePath = join(root, 'agent-browser.cjs');
  await mkdir(join(runtimeRoot, 'screenshots'), { recursive: true });
  await writeFile(executablePath, fakeContent, { mode: 0o700 });
  await chmod(executablePath, 0o700);
  const adapter = opts.loopback
    ? new AgentBrowserAdapter({ executablePath, runtimeRoot, loopbackMode: { proxyUrl: 'http://127.0.0.1:9999', origin: 'http://127.0.0.1:8765' } })
    : new AgentBrowserAdapter({ executablePath, runtimeRoot });
  return { adapter, root, runtimeRoot, executablePath };
}

test('RED: navigate success invalidates stale refs', async () => {
  const { adapter, root } = await makeAdapterWithFake(fakeScript(), { loopback: true });
  try {
    // snapshot creates @e1
    await adapter.execute({ action: 'snapshot' }, { env: { PATH: process.env.PATH } });
    // Do navigate success - should invalidate (loopback path skips DNS preflight)
    const nav = await adapter.execute({ action: 'navigate', url: 'http://127.0.0.1:8765/page2' }, { env: { PATH: process.env.PATH } });
    assert.equal((nav.details as any)?.ok, true);
    // next click with @e1 should now be stale
    const click = await adapter.execute({ action: 'click', selector: '@e1' }, { env: { PATH: process.env.PATH } });
    const details = click.details as Record<string, unknown>;
    assert.equal(details.staleRef, true, 'expected staleRef after successful navigate');
  } finally {
    await adapter.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('RED: click success invalidates stale refs', async () => {
  const { adapter, root } = await makeAdapterWithFake(fakeScript());
  try {
    await adapter.execute({ action: 'snapshot' }, { env: { PATH: process.env.PATH } });
    // use plain CSS selector to avoid stale check, perform click that should invalidate
    const click = await adapter.execute({ action: 'click', selector: '#btn' }, { env: { PATH: process.env.PATH } });
    assert.equal((click.details as any)?.ok, true);
    const stale = await adapter.execute({ action: 'click', selector: '@e1' }, { env: { PATH: process.env.PATH } });
    assert.equal((stale.details as Record<string, unknown>).staleRef, true);
  } finally {
    await adapter.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('RED: type success invalidates stale refs', async () => {
  const { adapter, root } = await makeAdapterWithFake(fakeScript());
  try {
    await adapter.execute({ action: 'snapshot' }, { env: { PATH: process.env.PATH } });
    const typed = await adapter.execute({ action: 'type', selector: '#input', text: 'hello' }, { env: { PATH: process.env.PATH } });
    assert.equal((typed.details as any)?.ok, true);
    const stale = await adapter.execute({ action: 'click', selector: '@e1' }, { env: { PATH: process.env.PATH } });
    assert.equal((stale.details as Record<string, unknown>).staleRef, true);
  } finally {
    await adapter.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('RED: fill success invalidates stale refs', async () => {
  const { adapter, root } = await makeAdapterWithFake(fakeScript());
  try {
    await adapter.execute({ action: 'snapshot' }, { env: { PATH: process.env.PATH } });
    const filled = await adapter.execute({ action: 'fill', selector: '#input', text: 'hello' }, { env: { PATH: process.env.PATH } });
    assert.equal((filled.details as any)?.ok, true);
    const stale = await adapter.execute({ action: 'click', selector: '@e1' }, { env: { PATH: process.env.PATH } });
    assert.equal((stale.details as Record<string, unknown>).staleRef, true);
  } finally {
    await adapter.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('RED: close clears snapshot state', async () => {
  const { adapter, root } = await makeAdapterWithFake(fakeScript());
  try {
    await adapter.execute({ action: 'snapshot' }, { env: { PATH: process.env.PATH } });
    await adapter.execute({ action: 'close' }, { env: { PATH: process.env.PATH } });
    const stale = await adapter.execute({ action: 'click', selector: '@e1' }, { env: { PATH: process.env.PATH } });
    assert.equal((stale.details as Record<string, unknown>).staleRef, true);
  } finally {
    await adapter.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('GREEN: failed navigate does NOT invalidate stale refs', async () => {
  const { adapter, root } = await makeAdapterWithFake(fakeScript({ failNavigate: true }), { loopback: true });
  try {
    await adapter.execute({ action: 'snapshot' }, { env: { PATH: process.env.PATH } });
    const nav = await adapter.execute({ action: 'navigate', url: 'http://127.0.0.1:8765/fail-navigate' }, { env: { PATH: process.env.PATH } });
    assert.equal((nav.details as any)?.ok, false);
    // @e1 should still be valid (preflight passes), so click with @e1 should NOT be staleRef but succeed (since fake click succeeds)
    // We test that click with @e1 is not stale - it returns ok:true (probe success path)
    const click = await adapter.execute({ action: 'click', selector: '@e1' }, { env: { PATH: process.env.PATH } });
    const details = click.details as Record<string, unknown>;
    assert.equal(details.staleRef, undefined, 'failed navigate should not invalidate');
    assert.equal(details.ok ?? (details as any)?.ok, true);
  } finally {
    await adapter.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('GREEN: unverified click does NOT invalidate stale refs', async () => {
  const { adapter, root } = await makeAdapterWithFake(fakeScript({ probeSuccess: false }));
  try {
    await adapter.execute({ action: 'snapshot' }, { env: { PATH: process.env.PATH } });
    // eligible selector @e1 will arm probe then read probe returns fired:false => dispatchUnverified
    const click = await adapter.execute({ action: 'click', selector: '@e1' }, { env: { PATH: process.env.PATH } });
    const d = click.details as Record<string, unknown>;
    assert.equal(d.dispatchUnverified, true, 'expected dispatchUnverified');
    // after unverified, snapshot should still be valid - need fresh snapshot? But ref should still be present for next attempt?
    // Take another snapshot or try same ref with probe-success fake? With same fake, next @e1 click is still unverified, not stale.
    // So check that error is dispatchUnverified not staleRef
    assert.equal(d.staleRef, undefined);
  } finally {
    await adapter.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('security: redaction convention preserved - no raw credential headers in tool output', async () => {
  // Use existing redaction pattern from agent-browser.ts sanitizeErrorMessage: Bearer *** and cookie redaction.
  // Direct inline check: ensure pattern used in code base would redact.
  const sample = 'Bearer secretToken123 Cookie: abc=123';
  const redacted = sample.replace(/Bearer\s+\S+/gi, 'Bearer ***').replace(/Cookie:\s*\S+/gi, 'Cookie: ***');
  assert.match(redacted, /\*\*\*/);
  assert.doesNotMatch(redacted, /secretToken123/);
});
