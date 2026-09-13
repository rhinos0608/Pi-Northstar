import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { chmod, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ChildProcess } from 'node:child_process';
import { test } from 'node:test';
import { agentBrowserExecutableConfigured, buildSandboxEnvironment, closeSession, generateNamespace, parseAgentBrowserOutput, runBatchStdin, runCommand, runScreenshot } from '../../src/browser/agent-browser-process.js';

test('sandbox environment strips hostile inherited variables', () => {
  const env = buildSandboxEnvironment({ PATH: '/bin', HOME: '/tmp', AGENT_BROWSER_SESSION: 'evil', NODE_OPTIONS: '--import evil', GITHUB_TOKEN: 'secret' }, { runtimeRoot: '/tmp/pi', namespace: 'owned' });
  assert.equal(env.AGENT_BROWSER_SESSION, 'owned');
  assert.equal(env.NODE_OPTIONS, undefined);
  assert.equal(env.GITHUB_TOKEN, undefined);
  assert.equal(env.AGENT_BROWSER_CONFIG, '/tmp/pi/config/config.json');
});

test('output parser accepts JSON envelopes and ignores diagnostics', () => {
  assert.deepEqual(parseAgentBrowserOutput('diagnostic\n{"success":true,"data":{"ok":1}}\n'), [{ success: true, data: { ok: 1 } }]);
  assert.deepEqual(parseAgentBrowserOutput('[{"success":false,"error":"bad"}]'), [{ success: false, error: 'bad' }]);
});

test('namespace is unique-shaped', () => assert.match(generateNamespace(), /^pi-/));

test('explicit browser executable configuration requires an existing file', () => {
  assert.equal(agentBrowserExecutableConfigured('/definitely/missing/agent-browser'), false);
  assert.equal(agentBrowserExecutableConfigured(process.execPath), true);
});

test('sandbox environment includes proxy vars when loopback active', () => {
  const env = buildSandboxEnvironment(
    { PATH: '/bin' },
    { runtimeRoot: '/tmp/pi', namespace: 'ns1' },
    { AGENT_BROWSER_PROXY: 'http://127.0.0.1:9999', AGENT_BROWSER_PROXY_BYPASS: '<-loopback>' },
  );
  assert.equal(env.AGENT_BROWSER_PROXY, 'http://127.0.0.1:9999');
  assert.equal(env.AGENT_BROWSER_PROXY_BYPASS, '<-loopback>');
});

test('sandbox environment does not include proxy vars in normal mode', () => {
  const env = buildSandboxEnvironment(
    { PATH: '/bin' },
    { runtimeRoot: '/tmp/pi', namespace: 'ns1' },
  );
  assert.equal(env.AGENT_BROWSER_PROXY, undefined);
  assert.equal(env.AGENT_BROWSER_PROXY_BYPASS, undefined);
});

function activeTimeoutCount(): number {
  const handles = (process as unknown as { _getActiveHandles(): unknown[] })._getActiveHandles();
  return handles.filter((h) => (h as { constructor?: { name?: string } })?.constructor?.name === 'Timeout').length;
}

async function writeStubExecutable(body: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'pi-ab-'));
  const path = join(dir, 'fake-agent-browser.sh');
  await writeFile(path, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  await chmod(path, 0o755);
  return path;
}

async function makeRuntimeRoot(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'pi-ab-rt-'));
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// Poll with setImmediate (never setTimeout: these timeout tests mock timers).
// A stub that touches readyPath after installing its SIGTERM trap proves the
// trap is armed before mocked clocks advance. Without this, SIGTERM can win
// the shell-startup race and reap the child, making escalation assertions
// depend on scheduling luck instead of timer behavior.
async function waitForChildReady(readyPath: string): Promise<void> {
  const deadline = Date.now() + 10_000;
  for (;;) {
    if (existsSync(readyPath)) return;
    if (Date.now() > deadline) throw new Error(`stub child never signaled readiness: ${readyPath}`);
    await new Promise((r) => setImmediate(r));
  }
}

test('runCommand success path leaves no pending timers', async () => {
  const exe = await writeStubExecutable(`echo '{"success":true,"data":{"ok":1}}'`);
  const runtimeRoot = await makeRuntimeRoot();
  const before = activeTimeoutCount();
  const result = await runCommand(['snapshot'], { executablePath: exe, runtimeRoot, namespace: 'ns-timer-ok' });
  assert.equal(result.success, true);
  await sleep(50);
  assert.ok(activeTimeoutCount() <= before, `timer leak: before=${before} after=${activeTimeoutCount()}`);
});

test('runCommand error path leaves no pending timers', async () => {
  const exe = await writeStubExecutable(`echo boom >&2\nexit 1`);
  const runtimeRoot = await makeRuntimeRoot();
  const before = activeTimeoutCount();
  const result = await runCommand(['snapshot'], { executablePath: exe, runtimeRoot, namespace: 'ns-timer-err' });
  assert.equal(result.success, false);
  await sleep(50);
  assert.ok(activeTimeoutCount() <= before, `timer leak: before=${before} after=${activeTimeoutCount()}`);
});

test('runCommand output-cap settle leaves no pending SIGKILL timer', async () => {
  const exe = await writeStubExecutable(`head -c 6000000 /dev/zero | tr '\\0' 'x'\nexit 0`);
  const runtimeRoot = await makeRuntimeRoot();
  const before = activeTimeoutCount();
  const result = await runCommand(['snapshot'], { executablePath: exe, runtimeRoot, namespace: 'ns-timer-cap' });
  assert.equal(result.success, false);
  assert.match(String(result.error ?? ''), /Output limit exceeded/);
  await sleep(50);
  assert.ok(activeTimeoutCount() <= before, `timer leak: before=${before} after=${activeTimeoutCount()}`);
});

test('closeSession returns promptly on abort instead of waiting 10s', async () => {
  const exe = await writeStubExecutable(`sleep 30`);
  const runtimeRoot = await makeRuntimeRoot();
  const controller = new AbortController();
  setTimeout(() => controller.abort(), 100);
  const start = Date.now();
  await closeSession({ runtimeRoot, namespace: 'ns-abort' }, { executablePath: exe, signal: controller.signal });
  const elapsed = Date.now() - start;
  assert.ok(elapsed < 5000, `closeSession ignored abort: took ${elapsed}ms`);
});

test('closeSession honors already-aborted signal', async () => {
  const exe = await writeStubExecutable(`sleep 30`);
  const runtimeRoot = await makeRuntimeRoot();
  const controller = new AbortController();
  controller.abort();
  const start = Date.now();
  await closeSession({ runtimeRoot, namespace: 'ns-abort-pre' }, { executablePath: exe, signal: controller.signal });
  const elapsed = Date.now() - start;
  assert.ok(elapsed < 5000, `closeSession ignored pre-aborted signal: took ${elapsed}ms`);
});

test('runCommand timeout path still fires SIGKILL when child ignores SIGTERM', async (t) => {
  // Stub ignores SIGTERM so only SIGKILL can reap it.
  const runtimeRoot = await makeRuntimeRoot();
  const ready = join(runtimeRoot, 'child-ready');
  const exe = await writeStubExecutable(`trap '' TERM\ntouch ${ready}\nexec sleep 30`);
  const kills: string[] = [];
  const pids: number[] = [];
  const origKill = ChildProcess.prototype.kill;
  ChildProcess.prototype.kill = function (
    ...args: Parameters<ChildProcess['kill']>
  ): ReturnType<ChildProcess['kill']> {
    const sig = args[0] === undefined ? 'SIGTERM' : String(args[0]);
    kills.push(sig);
    if (this.pid !== undefined && !pids.includes(this.pid)) pids.push(this.pid);
    return (origKill as (...a: unknown[]) => ReturnType<ChildProcess['kill']>).apply(this, args);
  };
  t.mock.timers.enable({ apis: ['setTimeout'] });
  try {
    const pending = runCommand(['snapshot'], { executablePath: exe, runtimeRoot, namespace: 'ns-timeout-kill' });
    // Let the async runner reach spawn before advancing mocked clocks.
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    await waitForChildReady(ready);
    t.mock.timers.tick(60_000);
    const result = await pending;
    assert.equal(result.success, false);
    assert.match(String(result.error ?? ''), /Command timed out/);
    assert.ok(kills.includes('SIGTERM'), `expected SIGTERM, got ${JSON.stringify(kills)}`);
    // The SIGKILL grace timer must survive settle so a SIGTERM-ignoring child is reaped.
    t.mock.timers.tick(5_000);
    assert.ok(kills.includes('SIGKILL'), `expected SIGKILL after grace, got ${JSON.stringify(kills)}`);
  } finally {
    ChildProcess.prototype.kill = origKill;
    t.mock.timers.reset();
    for (const pid of pids) {
      try { process.kill(pid, 'SIGKILL'); } catch { /* already reaped */ }
    }
  }
});

test('runBatchStdin timeout path still fires SIGKILL when child ignores SIGTERM', async (t) => {
  // Stub ignores SIGTERM so only SIGKILL can reap it.
  const runtimeRoot = await makeRuntimeRoot();
  const ready = join(runtimeRoot, 'child-ready');
  const exe = await writeStubExecutable(`trap '' TERM\ntouch ${ready}\nexec sleep 30`);
  const kills: string[] = [];
  const pids: number[] = [];
  const origKill = ChildProcess.prototype.kill;
  ChildProcess.prototype.kill = function (
    ...args: Parameters<ChildProcess['kill']>
  ): ReturnType<ChildProcess['kill']> {
    const sig = args[0] === undefined ? 'SIGTERM' : String(args[0]);
    kills.push(sig);
    if (this.pid !== undefined && !pids.includes(this.pid)) pids.push(this.pid);
    return (origKill as (...a: unknown[]) => ReturnType<ChildProcess['kill']>).apply(this, args);
  };
  t.mock.timers.enable({ apis: ['setTimeout'] });
  try {
    const pending = runBatchStdin([{ args: ['snapshot'] }], { executablePath: exe, runtimeRoot, namespace: 'ns-batch-timeout-kill' });
    // Let the async runner reach spawn before advancing mocked clocks.
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    await waitForChildReady(ready);
    t.mock.timers.tick(120_000);
    const results = await pending;
    assert.equal(results.length, 1);
    assert.equal(results[0]!.success, false);
    assert.match(String(results[0]!.error ?? ''), /Batch command timed out/);
    assert.ok(kills.includes('SIGTERM'), `expected SIGTERM, got ${JSON.stringify(kills)}`);
    // The SIGKILL grace timer must survive settle so a SIGTERM-ignoring child is reaped.
    t.mock.timers.tick(5_000);
    assert.ok(kills.includes('SIGKILL'), `expected SIGKILL after grace, got ${JSON.stringify(kills)}`);
  } finally {
    ChildProcess.prototype.kill = origKill;
    t.mock.timers.reset();
    for (const pid of pids) {
      try { process.kill(pid, 'SIGKILL'); } catch { /* already reaped */ }
    }
  }
});

test('runScreenshot timeout path still fires SIGKILL when child ignores SIGTERM', async (t) => {
  // Stub ignores SIGTERM so only SIGKILL can reap it.
  const runtimeRoot = await makeRuntimeRoot();
  const ready = join(runtimeRoot, 'child-ready');
  const exe = await writeStubExecutable(`trap '' TERM\ntouch ${ready}\nexec sleep 30`);
  const kills: string[] = [];
  const pids: number[] = [];
  const origKill = ChildProcess.prototype.kill;
  ChildProcess.prototype.kill = function (
    ...args: Parameters<ChildProcess['kill']>
  ): ReturnType<ChildProcess['kill']> {
    const sig = args[0] === undefined ? 'SIGTERM' : String(args[0]);
    kills.push(sig);
    if (this.pid !== undefined && !pids.includes(this.pid)) pids.push(this.pid);
    return (origKill as (...a: unknown[]) => ReturnType<ChildProcess['kill']>).apply(this, args);
  };
  t.mock.timers.enable({ apis: ['setTimeout'] });
  try {
    const pending = runScreenshot({ executablePath: exe, runtimeRoot, namespace: 'ns-shot-timeout-kill' });
    // Let the async runner reach spawn before advancing mocked clocks.
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    await waitForChildReady(ready);
    t.mock.timers.tick(60_000);
    const result = await pending;
    assert.ok('error' in result);
    assert.match(String((result as { error: string }).error ?? ''), /Screenshot timed out/);
    assert.ok(kills.includes('SIGTERM'), `expected SIGTERM, got ${JSON.stringify(kills)}`);
    // The SIGKILL grace timer must survive settle so a SIGTERM-ignoring child is reaped.
    t.mock.timers.tick(5_000);
    assert.ok(kills.includes('SIGKILL'), `expected SIGKILL after grace, got ${JSON.stringify(kills)}`);
  } finally {
    ChildProcess.prototype.kill = origKill;
    t.mock.timers.reset();
    for (const pid of pids) {
      try { process.kill(pid, 'SIGKILL'); } catch { /* already reaped */ }
    }
  }
});

test('runCommand honors pre-aborted signal without spawning', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pi-ab-pre-'));
  const marker = join(dir, 'launched');
  const exe = await writeStubExecutable(`touch ${marker}\necho '{"success":true}'`);
  const runtimeRoot = await makeRuntimeRoot();
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    runCommand(['snapshot'], { executablePath: exe, runtimeRoot, namespace: 'ns-pre-abort-cmd', signal: controller.signal }),
    (err: unknown) => err instanceof Error && (err as Error).name === 'AbortError',
  );
  assert.equal(existsSync(marker), false);
});

test('runBatchStdin honors pre-aborted signal without spawning', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pi-ab-pre-'));
  const marker = join(dir, 'launched');
  const exe = await writeStubExecutable(`touch ${marker}\necho '{"success":true}'`);
  const runtimeRoot = await makeRuntimeRoot();
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    runBatchStdin([{ args: ['snapshot'] }], { executablePath: exe, runtimeRoot, namespace: 'ns-pre-abort-batch', signal: controller.signal }),
    (err: unknown) => err instanceof Error && (err as Error).name === 'AbortError',
  );
  assert.equal(existsSync(marker), false);
});

test('runScreenshot honors pre-aborted signal without spawning', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pi-ab-pre-'));
  const marker = join(dir, 'launched');
  const exe = await writeStubExecutable(`touch ${marker}\nexit 0`);
  const runtimeRoot = await makeRuntimeRoot();
  const controller = new AbortController();
  controller.abort();
  const result = await runScreenshot({ executablePath: exe, runtimeRoot, namespace: 'ns-pre-abort-shot', signal: controller.signal });
  assert.deepEqual(result, { error: 'aborted' });
  assert.equal(existsSync(marker), false);
});

test('win32 resolution finds .cmd-shim-only PATH dirs via PATHEXT', () => {
  const present = new Set(['c:\\shim\\agent-browser.cmd']);
  const exists = (p: string) => present.has(p.toLowerCase());
  assert.equal(
    agentBrowserExecutableConfigured(undefined, { PATH: 'C:\\shim' }, { platform: 'win32', pathext: '.COM;.EXE;.BAT;.CMD', exists }),
    true,
  );
  assert.equal(
    agentBrowserExecutableConfigured(undefined, { PATH: 'C:\\empty' }, { platform: 'win32', pathext: '.COM;.EXE;.BAT;.CMD', exists }),
    false,
  );
});

test('win32 resolution finds local .bin .cmd shim without extensionless file', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pi-ab-win32-'));
  const binDir = join(root, 'node_modules', '.bin');
  await (await import('node:fs/promises')).mkdir(binDir, { recursive: true });
  await writeFile(join(binDir, 'agent-browser.cmd'), '@echo off\n', { mode: 0o755 });
  assert.equal(agentBrowserExecutableConfigured(undefined, { PATH: '' }, { platform: 'win32', cwd: root }), true);
  assert.equal(agentBrowserExecutableConfigured(undefined, { PATH: '' }, { platform: 'linux', cwd: root }), false);
});

test('sandbox environment normalizes Windows Path alias to PATH', () => {
  const env = buildSandboxEnvironment({ Path: 'C:\\Windows', HOME: '/tmp' }, { runtimeRoot: '/tmp/pi', namespace: 'ns1' });
  assert.equal(env.PATH, 'C:\\Windows');
  assert.equal(env.Path, undefined);
});

test('win32 executable lookup resolves with Path-only env', () => {
  const present = new Set(['c:\\shim\\agent-browser.cmd']);
  const exists = (p: string) => present.has(p.toLowerCase());
  assert.equal(
    agentBrowserExecutableConfigured(undefined, { Path: 'C:\\shim' }, { platform: 'win32', pathext: '.COM;.EXE;.BAT;.CMD', exists }),
    true,
  );
});

test('hostile parent proxy vars are overridden by adapter-controlled values', () => {
  const env = buildSandboxEnvironment(
    { PATH: '/bin', AGENT_BROWSER_PROXY: 'http://evil.com:8080', HTTP_PROXY: 'http://evil.com:8080' },
    { runtimeRoot: '/tmp/pi', namespace: 'ns1' },
    { AGENT_BROWSER_PROXY: 'http://127.0.0.1:9999', AGENT_BROWSER_PROXY_BYPASS: '<-loopback>' },
  );
  assert.equal(env.AGENT_BROWSER_PROXY, 'http://127.0.0.1:9999');
  assert.equal(env.AGENT_BROWSER_PROXY_BYPASS, '<-loopback>');
  assert.equal(env.HTTP_PROXY, undefined);
  assert.equal(env.HTTPS_PROXY, undefined);
  assert.equal(env.NO_PROXY, undefined);
});
