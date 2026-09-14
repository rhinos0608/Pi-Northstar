// win32-native end-to-end proof for src/cli-command.ts spawnCliCommand.
//
// Runs ONLY on win32 (skips everywhere else): creates REAL .cmd fixture shims
// in a tmp dir whose path contains spaces, spawns them via spawnCliCommand
// with a stripped env (shim-only PATH, no System32 on PATH, absolute COMSPEC),
// and asserts argv payload integrity through the real cmd.exe transport
// (cmd /d /s /c + pre-quoted args + windowsVerbatimArguments).
//
// The shims forward their argv to an absolute node.exe which prints
// JSON.stringify(process.argv.slice(1))). Forwarding through node avoids
// batch-level %1/%* re-parsing fragility (metacharacters would split naive
// `echo %1` lines); cmd.exe keeps quoted tokens intact when launching node,
// and node applies CommandLineToArgvW — the exact rules quoteCmdArg encodes
// (doubled embedded quotes, doubled trailing backslashes, `%` split as `"%"`
// toggles so cmd cannot match %NAME%).
//
// POSIX twin-builder coverage stays in test/cli-command.test.ts (pure
// cmdTwinBody unit tests, portable). This file is the native counterpart.

import { strict as assert } from 'node:assert';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { spawnCliCommand, windowsCmdExe } from '../../src/process/cli-command.js';

// win32-native tests must skip on POSIX (no cmd.exe, no .cmd semantics).
const requiresWin32Native = process.platform !== 'win32' ? 'requires win32 cmd.exe with real .cmd shims' : false;

const PATHEXT = '.COM;.EXE;.BAT;.CMD';

/** argv-forwarding .cmd shim: node prints its argv as JSON, nothing else. */
function forwardShimBody(nodeExe: string): string {
  return `@echo off\r\n"${nodeExe}" -e "console.log(JSON.stringify(process.argv.slice(1)))" %*\r\n`;
}

interface RunResult {
  stdout: string;
  stderr: string;
  code: number | null;
}

/** Stripped child env: shim-only PATH, absolute COMSPEC, no System32 on PATH. */
function strippedEnv(shimDir: string): Record<string, string> {
  const cmdExe = windowsCmdExe();
  assert.ok(/^(?:[A-Za-z]:\\|\\\\)/.test(cmdExe), `COMSPEC must be absolute, got ${cmdExe}`);
  assert.ok(
    !shimDir.split(';').some((entry) => /system32/i.test(entry)),
    `shim-only PATH must not contain System32, got ${shimDir}`,
  );
  const env: Record<string, string> = { PATH: shimDir, COMSPEC: cmdExe };
  // Regression canary for cmd.exe %VAR% expansion: the token lives in the child
  // env (as OPENCLI_TOKEN does for OpenCLI), so any %OPENCLI_TOKEN% argv payload
  // that cmd expands echoes the canary instead of the literal text.
  env.OPENCLI_TOKEN = 'SECRET_CANARY_X';
  if (typeof process.env.SystemRoot === 'string' && process.env.SystemRoot.length > 0) {
    env.SystemRoot = process.env.SystemRoot;
  }
  return env;
}

function runShim(shimDir: string, name: string, args: readonly string[]): Promise<RunResult> {
  const env = strippedEnv(shimDir);
  return new Promise((resolve, reject) => {
    const child = spawnCliCommand(name, args, {
      pathValue: shimDir,
      pathext: PATHEXT,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on('data', (chunk) => {
      stderr += String(chunk);
    });
    child.on('error', reject);
    child.on('close', (code) => resolve({ stdout, stderr, code }));
  });
}

/** Tmp dir WITH SPACES in its path: proves spaced shim paths stay one argv element. */
async function withSpacedShimDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), 'pi win32 e2e spaces '));
  assert.ok(dir.includes(' '), `fixture dir must contain spaces, got ${dir}`);
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function roundTrip(shimDir: string, args: readonly string[]): Promise<unknown> {
  const result = await runShim(shimDir, 'payload', args);
  assert.equal(result.code, 0, `shim must exit 0, stderr: ${result.stderr}`);
  return JSON.parse(result.stdout.trim());
}

test('spaced shim path resolves and plain args round-trip', { skip: requiresWin32Native }, async () => {
  await withSpacedShimDir(async (dir) => {
    await writeFile(join(dir, 'payload.cmd'), forwardShimBody(process.execPath));
    assert.deepEqual(await roundTrip(dir, ['search', 'hello world', 'plain']), ['search', 'hello world', 'plain']);
  });
});

test('cmd metacharacters & | < > ^ % stay literal', { skip: requiresWin32Native }, async () => {
  await withSpacedShimDir(async (dir) => {
    await writeFile(join(dir, 'payload.cmd'), forwardShimBody(process.execPath));
    // quoteCmdArg splits every `%` as `"%"` toggles: the inserted quotes poison
    // cmd's %NAME% match on the /c line (a name containing `"` never resolves),
    // while CommandLineToArgvW strips the toggles — so %NAME% sequences
    // (including token-shaped payloads) survive literally end-to-end even when
    // the name is defined in the child env (see strippedEnv canary).
    const args = ['a&b|c<d>e^f%g', '100%', 'a%b', 'search %OPENCLI_TOKEN% done'];
    assert.deepEqual(await roundTrip(dir, args), args);
  });
});

test('defined %VAR% payloads echo literally (child-env canary never leaks)', { skip: requiresWin32Native }, async () => {
  await withSpacedShimDir(async (dir) => {
    await writeFile(join(dir, 'payload.cmd'), forwardShimBody(process.execPath));
    // OPENCLI_TOKEN, PATH, and COMSPEC are all defined in the stripped child
    // env: without the `"%"` split, cmd.exe would expand these on the /c line
    // (even inside quotes) and the shim would echo the secret, not the text.
    const args = [
      'search %OPENCLI_TOKEN% done',
      '%OPENCLI_TOKEN%',
      'pre %OPENCLI_TOKEN% post',
      '%PATH%',
      '%COMSPEC%',
      '%UNDEFINED_PI_VAR_XYZ%',
      '100%',
      'a%b',
      '%',
      '%%',
    ];
    const echoed = await roundTrip(dir, args);
    assert.deepEqual(echoed, args);
    assert.ok(
      !JSON.stringify(echoed).includes('SECRET_CANARY_X'),
      'canary value must not leak into argv',
    );
  });
});

test('embedded quotes survive the doubled-quote transport', { skip: requiresWin32Native }, async () => {
  await withSpacedShimDir(async (dir) => {
    await writeFile(join(dir, 'payload.cmd'), forwardShimBody(process.execPath));
    const args = ['say "hi"', 'a"b c'];
    assert.deepEqual(await roundTrip(dir, args), args);
  });
});

test('trailing backslashes survive per CommandLineToArgvW', { skip: requiresWin32Native }, async () => {
  await withSpacedShimDir(async (dir) => {
    await writeFile(join(dir, 'payload.cmd'), forwardShimBody(process.execPath));
    const args = ['trail\\', 'C:\\path\\with\\trailing\\'];
    assert.deepEqual(await roundTrip(dir, args), args);
  });
});

test('shim-only PATH with absolute COMSPEC spawns (no System32 on PATH)', { skip: requiresWin32Native }, async () => {
  await withSpacedShimDir(async (dir) => {
    await writeFile(join(dir, 'payload.cmd'), forwardShimBody(process.execPath));
    const env = strippedEnv(dir);
    assert.equal(env.PATH, dir, 'child PATH carries only the shim dir');
    assert.deepEqual(await roundTrip(dir, ['probe']), ['probe']);
  });
});

test('nonzero .cmd exit propagates', { skip: requiresWin32Native }, async () => {
  await withSpacedShimDir(async (dir) => {
    await writeFile(join(dir, 'fail.cmd'), '@echo off\r\nexit /b 3\r\n');
    const result = await runShim(dir, 'fail', ['ignored']);
    assert.equal(result.code, 3, `expected exit 3, got ${result.code}, stderr: ${result.stderr}`);
  });
});
