import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { AgentBrowserAdapter } from '../../src/browser/agent-browser.js';

function makeSentinel(prefix: string): string {
  return `${prefix}_` + Math.random().toString(36).slice(2, 8);
}

async function makeAdapterWithFake(fakeContent: string, opts: { loopback?: boolean } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'pi-atlas-boundary-'));
  const runtimeRoot = join(root, 'runtime');
  const executablePath = join(root, 'agent-browser.cjs');
  await mkdir(join(runtimeRoot, 'screenshots'), { recursive: true });
  await writeFile(executablePath, fakeContent, { mode: 0o700 });
  await chmod(executablePath, 0o700);
  const adapter = opts.loopback
    ? new AgentBrowserAdapter({ executablePath, runtimeRoot, loopbackMode: { proxyUrl: 'http://127.0.0.1:9999', origin: 'http://127.0.0.1:8765' } })
    : new AgentBrowserAdapter({ executablePath, runtimeRoot });
  return { adapter, root };
}

// Finding 1: credentialed URL must not leak via execute boundary catch
test('boundary: credentialed navigate does not leak password via execute catch', async () => {
  const sentinel = makeSentinel('SENTINEL_CRED');
  const url = `http://user:${sentinel}@example.com/path`;
  // Minimal fake that would succeed if not rejected; validation should reject before spawn
  const fake = `#!/usr/bin/env node\nif(process.argv.includes('--version')){process.stdout.write('agent-browser 0.37.1\\n');}else{process.stdout.write(JSON.stringify({success:true,data:{}})+'\\n');}\n`;
  const { adapter, root } = await makeAdapterWithFake(fake);
  try {
    const result = await adapter.execute({ action: 'navigate', url }, { env: { PATH: process.env.PATH } });
    const dump = JSON.stringify(result);
    assert.equal(dump.includes(sentinel), false, 'sentinel leaked into tool output');
    // Should be failure category and not contain raw url password
    const details = result.details as Record<string, unknown>;
    const err = typeof details?.error === 'string' ? details.error : '';
    assert.equal(err.includes(sentinel), false);
    const c0 = (result as { content: Array<{ text?: string }> }).content[0];
    const text = c0?.text ?? '';
    assert.equal(text.includes(sentinel), false);
  } finally {
    await adapter.close();
    await rm(root, { recursive: true, force: true });
  }
});

// Finding 2: raw stdout envelope bypass must not leak via getUrl/getTitle
test('boundary: getUrl with raw stdout sentinel is rejected, sentinel absent', async () => {
  const sentinel = makeSentinel('SENTINEL_RAW');
  const fake = `#!/usr/bin/env node
const args=process.argv.slice(2);
if(args[0]==='--version'){process.stdout.write('agent-browser 0.37.1\\n');process.exit(0);}
if(args[0]==='get' && args[1]==='url'){
  process.stdout.write('${sentinel} NOT_JSON\\n');
  process.exit(0);
}
if(args[0]==='snapshot'){
  process.stdout.write(JSON.stringify({success:true,data:{url:'http://example.com',nodes:[]}})+'\\n');
} else {
  process.stdout.write(JSON.stringify({success:true,data:{}})+'\\n');
}
`;
  const { adapter, root } = await makeAdapterWithFake(fake);
  try {
    const result = await adapter.execute({ action: 'get_url' }, { env: { PATH: process.env.PATH } });
    const dump = JSON.stringify(result);
    assert.equal(dump.includes(sentinel), false, 'raw sentinel leaked via getUrl');
    const enriched = result as unknown as { resultCategory?: string; failureCategory?: string };
    assert.equal(enriched.resultCategory, 'failure', 'malformed stdout must map to failure, not success empty');
    assert.ok(enriched.failureCategory, 'failureCategory must be set');
  } finally {
    await adapter.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('boundary: getTitle with raw stdout sentinel is rejected, sentinel absent', async () => {
  const sentinel = makeSentinel('SENTINEL_RAW2');
  const fake = `#!/usr/bin/env node
const args=process.argv.slice(2);
if(args[0]==='--version'){process.stdout.write('agent-browser 0.37.1\\n');process.exit(0);}
if(args[0]==='get' && args[1]==='title'){
  process.stdout.write('${sentinel} NOT_JSON_TITLE\\n');
  process.exit(0);
}
process.stdout.write(JSON.stringify({success:true,data:{}})+'\\n');
`;
  const { adapter, root } = await makeAdapterWithFake(fake);
  try {
    const result = await adapter.execute({ action: 'get_title' }, { env: { PATH: process.env.PATH } });
    const dump = JSON.stringify(result);
    assert.equal(dump.includes(sentinel), false);
    const enriched = result as unknown as { resultCategory?: string; failureCategory?: string };
    assert.equal(enriched.resultCategory, 'failure');
    assert.ok(enriched.failureCategory);
  } finally {
    await adapter.close();
    await rm(root, { recursive: true, force: true });
  }
});

// Cheap invalidation coverage
test('invalidation: no-URL navigate success invalidates stale refs', async () => {
  const fake = `#!/usr/bin/env node
const args=process.argv.slice(2);
if(args[0]==='--version'){process.stdout.write('agent-browser 0.37.1\\n');process.exit(0);}
function out(o){process.stdout.write(JSON.stringify(o)+'\\n');}
if(args[0]==='snapshot'){out({success:true,data:{url:'http://example.com',nodes:[{ref:'@e1',role:'button',name:'Submit'}]}});}
else if(args[0]==='open'){out({success:true,data:{}});}
else if(args[0]==='click'){out({success:true,data:{}});}
else if(args[0]==='close'){out({success:true,data:{}});}
else out({success:true,data:{}});
`;
  const { adapter, root } = await makeAdapterWithFake(fake);
  try {
    await adapter.execute({ action: 'snapshot' }, { env: { PATH: process.env.PATH } });
    const nav = await adapter.execute({ action: 'navigate' } as unknown as Record<string, unknown>, { env: { PATH: process.env.PATH } });
    assert.equal((nav.details as { ok?: boolean })?.ok, true);
    const click = await adapter.execute({ action: 'click', selector: '@e1' }, { env: { PATH: process.env.PATH } });
    assert.equal((click.details as Record<string, unknown>).staleRef, true);
  } finally {
    await adapter.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('invalidation: semanticAction success invalidates stale refs', async () => {
  const fake = `#!/usr/bin/env node
const args=process.argv.slice(2);
if(args[0]==='--version'){process.stdout.write('agent-browser 0.37.1\\n');process.exit(0);}
function out(o){process.stdout.write(JSON.stringify(o)+'\\n');}
if(args[0]==='batch'){
  let body='';process.stdin.on('data',c=>body+=c);process.stdin.on('end',()=>{
    let cmds=[]; try{cmds=JSON.parse(body);}catch{cmds=[];}
    const res=cmds.map(cmd=>{const expr=cmd[1]||''; if(cmd[0]==='eval' && expr.includes('__pi_click_probe__')){ if(expr.includes('window.__pi_click_probe__ =')) return {success:true}; return {success:true,data:{fired:true,target:true}};} if(cmd[0]==='eval') return {success:true,data:{fired:true,count:0}}; return {success:true};});
    process.stdout.write(JSON.stringify(res)+'\\n');
  });
}
else if(args[0]==='snapshot'){out({success:true,data:{url:'http://example.com',nodes:[{ref:'@e1',role:'button',name:'Submit'}]}});}
else if(args[0]==='find'){out({success:true,data:{}});}
else if(args[0]==='click'){out({success:true,data:{}});}
else if(args[0]==='eval'){
  const expr=args[1]||'';
  if(expr.includes('__pi_click_probe__')){ if(expr.includes('window.__pi_click_probe__ =')) out({success:true,data:{}}); else out({success:true,data:{fired:true,target:true}});} else out({success:true,data:{fired:true,count:0}});
}
else out({success:true,data:{}});
`;
  const { adapter, root } = await makeAdapterWithFake(fake);
  try {
    await adapter.execute({ action: 'snapshot' }, { env: { PATH: process.env.PATH } });
    const sa = await adapter.execute({ action: 'semanticAction', semanticAction: { locator: 'role', query: 'button', verb: 'click' } } as unknown as Record<string, unknown>, { env: { PATH: process.env.PATH } });
    assert.equal((sa.details as { ok?: boolean })?.ok, true);
    const click = await adapter.execute({ action: 'click', selector: '@e1' }, { env: { PATH: process.env.PATH } });
    assert.equal((click.details as Record<string, unknown>).staleRef, true);
  } finally {
    await adapter.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('invalidation: batch success invalidates stale refs', async () => {
  const fake = `#!/usr/bin/env node
const args=process.argv.slice(2);
if(args[0]==='--version'){process.stdout.write('agent-browser 0.37.1\\n');process.exit(0);}
function out(o){process.stdout.write(JSON.stringify(o)+'\\n');}
if(args[0]==='snapshot'){out({success:true,data:{url:'http://example.com',nodes:[{ref:'@e1',role:'button',name:'Submit'}]}});}
else if(args[0]==='batch'){
  let body='';process.stdin.on('data',c=>body+=c);process.stdin.on('end',()=>{const cmds=JSON.parse(body);const res=cmds.map(()=>({success:true}));process.stdout.write(JSON.stringify(res)+'\\n');});
}
else out({success:true,data:{}});
`;
  const { adapter, root } = await makeAdapterWithFake(fake);
  try {
    await adapter.execute({ action: 'snapshot' }, { env: { PATH: process.env.PATH } });
    const batch = await adapter.execute({ action: 'batch', batch: { commands: [{ args: ['click', '#a'] }] } } as unknown as Record<string, unknown>, { env: { PI_SEARCH_BROWSER_ALLOW_SENSITIVE: '1', PATH: process.env.PATH } });
    // batch should succeed
    const dump = JSON.stringify(batch);
    assert.equal(dump.includes('staleRef'), false);
    const click = await adapter.execute({ action: 'click', selector: '@e1' }, { env: { PATH: process.env.PATH } });
    assert.equal((click.details as Record<string, unknown>).staleRef, true);
  } finally {
    await adapter.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('sanitize: evaluate error with credential does not leak', async () => {
  const sentinel = makeSentinel('EVAL_SENTINEL');
  const cred = `token=${sentinel}`;
  const fake = `#!/usr/bin/env node
const args=process.argv.slice(2);
if(args[0]==='--version'){process.stdout.write('agent-browser 0.37.1\\n');process.exit(0);}
function out(o){process.stdout.write(JSON.stringify(o)+'\\n');}
if(args[0]==='batch'){let b='';process.stdin.on('data',c=>b+=c);process.stdin.on('end',()=>{process.stdout.write(JSON.stringify([{success:false,error:'${cred}'}])+'\\n');});} else out({success:true,data:{}});
`;
  const { adapter, root } = await makeAdapterWithFake(fake);
  try {
    const res = await adapter.execute({ action: 'evaluate', expression: '1+1' }, { env: { PI_SEARCH_BROWSER_ALLOW_SENSITIVE: '1', PATH: process.env.PATH } });
    const dump = JSON.stringify(res);
    assert.equal(dump.includes(sentinel), false, 'evaluate sentinel leaked');
    assert.match(dump, /\*\*\*/);
  } finally { await adapter.close(); await rm(root, { recursive: true, force: true }); }
});

test('sanitize: scroll error with password does not leak', async () => {
  const sentinel = makeSentinel('SCROLL_SENTINEL');
  const cred = `password=${sentinel}`;
  const fake = `#!/usr/bin/env node
const a=process.argv.slice(2);
if(a[0]==='--version'){process.stdout.write('agent-browser 0.37.1\\n');process.exit(0);}function o(x){process.stdout.write(JSON.stringify(x)+'\\n');}
if(a[0]==='scroll')o({success:false,error:'${cred}'}); else o({success:true,data:{}});
`;
  const { adapter, root } = await makeAdapterWithFake(fake);
  try {
    const res = await adapter.execute({ action: 'scroll', x: 0, y: 100 }, { env: { PATH: process.env.PATH } });
    const dump = JSON.stringify(res);
    assert.equal(dump.includes(sentinel), false);
    assert.match(dump, /\*\*\*/);
  } finally { await adapter.close(); await rm(root, { recursive: true, force: true }); }
});

test('sanitize: tabs error with token does not leak', async () => {
  const sentinel = makeSentinel('TABS_SENTINEL');
  const cred = `token=${sentinel}`;
  const fake = `#!/usr/bin/env node
const a=process.argv.slice(2);
if(a[0]==='--version'){process.stdout.write('agent-browser 0.37.1\\n');process.exit(0);}function o(x){process.stdout.write(JSON.stringify(x)+'\\n');}
if(a[0]==='tab')o({success:false,error:'${cred}'}); else o({success:true,data:{}});
`;
  const { adapter, root } = await makeAdapterWithFake(fake);
  try {
    const res = await adapter.execute({ action: 'tabs' }, { env: { PATH: process.env.PATH } });
    const dump = JSON.stringify(res);
    assert.equal(dump.includes(sentinel), false);
  } finally { await adapter.close(); await rm(root, { recursive: true, force: true }); }
});

test('sanitize: screenshot child spawn error with credential does not leak', async () => {
  const sentinel = makeSentinel('SCREEN_SPAWN');
  const adapter2 = new AgentBrowserAdapter({ executablePath: `/nonexistent/token=${sentinel}/agent-browser`, runtimeRoot: await mkdtemp(join(tmpdir(), 'pi-atlas-screenshot-')) });
  const r = await adapter2.execute({ action: 'screenshot' }, { env: { PATH: process.env.PATH } });
  const dump = JSON.stringify(r);
  assert.equal(dump.includes(sentinel), false, 'screenshot spawn sentinel leaked');
  await adapter2.close();
});

test('sanitize: process spawn error with bearer token does not leak', async () => {
  const sentinel = makeSentinel('SPAWN_SENTINEL');
  const cred = `Bearer ${sentinel}`;
  const fakePath = `/nonexistent/${cred}/agent-browser`;
  const adapter2 = new AgentBrowserAdapter({ executablePath: fakePath, runtimeRoot: await mkdtemp(join(tmpdir(), 'pi-atlas-spawn-')) });
  try {
    const res = await adapter2.execute({ action: 'navigate', url: 'http://example.com/' }, { env: { PATH: process.env.PATH } });
    const dump = JSON.stringify(res);
    assert.equal(dump.includes(sentinel), false, 'spawn sentinel leaked');
  } finally { await adapter2.close(); }
});
