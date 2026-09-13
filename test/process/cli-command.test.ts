// Platform-injected unit tests for src/cli-command.ts and the win32 .cmd
// shim twin builder. These cover win32-only spawn paths that cannot run on
// POSIX CI: quoting, PATHEXT resolution, and the cmd.exe transport argv.

import { strict as assert } from 'node:assert';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  buildCmdArgv,
  quoteCmdArg,
  resolveCliCommand,
  windowsCmdExe,
  windowsPathValue,
} from '../../src/process/cli-command.js';
import { cmdTwinBody } from '../shim-cmd.js';

const WIN = { platform: 'win32' as const };

// ── quoteCmdArg (always double-quoted so cmd metacharacters stay literal) ──

test('quoteCmdArg always quotes so cmd metacharacters stay literal', () => {
  assert.equal(quoteCmdArg('a&b'), '"a&b"');
  assert.equal(quoteCmdArg('C:\\tools\\opencli.cmd'), '"C:\\tools\\opencli.cmd"');
  assert.equal(quoteCmdArg('say "hi"'), '"say ""hi"""');
  assert.equal(quoteCmdArg('trail\\'), '"trail\\\\"');
  assert.equal(quoteCmdArg(''), '""');
});

test('quoteCmdArg wraps args with spaces and passes %VAR% through unexpanded by node', () => {
  assert.equal(quoteCmdArg('hello world'), '"hello world"');
  // cmd.exe expands %NAME% even inside quotes: every literal % is doubled so
  // cmd/batch parsing collapses %% back to a literal % (child-visible text
  // unchanged, no env leak into the /c line).
  assert.equal(quoteCmdArg('%SystemRoot%'), '"%%SystemRoot%%"');
});

test('quoteCmdArg doubles % so a %OPENCLI_TOKEN% payload survives literally', () => {
  // Win32-capable (pure quoting, runs on any host): the transport spelling
  // doubles %, and emulating cmd's %% -> % collapse recovers the input.
  const payload = 'search %OPENCLI_TOKEN% leaked?';
  const quoted = quoteCmdArg(payload);
  assert.equal(quoted, '"search %%OPENCLI_TOKEN%% leaked?"');
  assert.equal(quoted.slice(1, -1).replace(/%%/g, '%'), payload);
  assert.equal(quoteCmdArg('100%'), '"100%%"');
  assert.equal(quoteCmdArg('a%b'), '"a%%b"');
  const argv = buildCmdArgv('C:\\shims\\opencli.cmd', ['search', payload]);
  assert.ok((argv[3] ?? '').includes('"search %%OPENCLI_TOKEN%% leaked?"'));
});

test('quoteCmdArg doubles embedded quotes and trailing backslashes per CommandLineToArgvW', () => {
  assert.equal(quoteCmdArg('a"b c\\'), '"a""b c\\\\"');
});

test('quoteCmdArg doubles backslash runs preceding an embedded quote', () => {
  assert.equal(quoteCmdArg('a\\"b'), '"a\\\\""b"');
  assert.equal(quoteCmdArg('a\\\\"b'), '"a\\\\\\\\""b"');
  assert.equal(quoteCmdArg('\\\\"'), '"\\\\\\\\"""');
});

// ── resolveCliCommand ──

test('non-windows returns the command untouched without touching the fs', () => {
  assert.equal(
    resolveCliCommand('bili', { platform: 'linux', pathValue: '', exists: () => { throw new Error('must not consult fs'); } }),
    'bili',
  );
  assert.equal(resolveCliCommand('bili-cli', { platform: 'darwin' }), 'bili-cli');
});

test('win32 resolves a bare command to its .cmd twin in PATH order', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pi-cli-resolve-'));
  try {
    await writeFile(join(dir, 'bili.cmd'), '@echo off\r\n');
    // win32.join emits backslashes on posix hosts; normalize for existsSync
    // so this still exercises the real fs.
    const resolved = resolveCliCommand('bili', {
      ...WIN,
      pathValue: dir,
      pathext: '.com;.exe;.bat;.cmd',
      exists: (path) => existsSync(path.replace(/\\/g, '/')),
    });
    assert.ok(resolved.toLowerCase().endsWith('bili.cmd'), `expected a bili.cmd twin, got ${resolved}`);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('win32 follows PATH then PATHEXT order (fake fs, case-proof)', () => {
  const exists = (path: string): boolean =>
    path.endsWith('opencli.BAT') || path.endsWith('opencli.CMD');
  // .BAT precedes .CMD in the injected PATHEXT, so the first dir wins
  // with its .BAT spelling even though both spellings "exist" everywhere.
  // (PATH entries are ';'-separated on win32 even when the host is posix.)
  const resolved = resolveCliCommand('opencli', {
    ...WIN,
    pathValue: ['/fake/first', '/fake/second'].join(';'),
    pathext: '.BAT;.CMD',
    exists,
  });
  assert.ok(resolved.endsWith('opencli.BAT'), `expected first-dir .BAT win, got ${resolved}`);
  assert.ok(resolved.includes('first'), `expected first dir, got ${resolved}`);
  assert.ok(!resolved.includes('second'), `expected first dir, got ${resolved}`);
});

function win32Exists(files: readonly string[]): (path: string) => boolean {
  const lower = new Set(files.map((file) => file.toLowerCase()));
  return (path: string) => lower.has(path.toLowerCase());
}

test('win32 finds .cmd twins in PATH order via PATHEXT', () => {
  const exists = win32Exists(['C:\\shims\\bili-cli.cmd']);
  assert.equal(
    resolveCliCommand('bili-cli', {
      ...WIN,
      pathValue: 'C:\\shims;C:\\tools',
      pathext: '.com;.exe;.bat;.cmd',
      exists,
    }),
    'C:\\shims\\bili-cli.cmd',
  );
});

test('win32 honors PATH order over PATHEXT order across dirs', () => {
  const exists = win32Exists(['C:\\first\\opencli.bat', 'C:\\second\\opencli.cmd']);
  assert.equal(
    resolveCliCommand('opencli', {
      ...WIN,
      pathValue: 'C:\\first;C:\\second',
      pathext: '.com;.exe;.bat;.cmd',
      exists,
    }),
    'C:\\first\\opencli.bat',
  );
});

test('win32 strips quoted PATH dirs', () => {
  const exists = win32Exists(['C:\\Program Files\\tool\\rdt.exe']);
  const resolved = resolveCliCommand('rdt', {
    ...WIN,
    pathValue: '"C:\\Program Files\\tool";C:\\other',
    pathext: '.COM;.EXE;.BAT;.CMD',
    exists,
  });
  assert.equal(resolved.toLowerCase(), 'c:\\program files\\tool\\rdt.exe');
});

test('win32 misses and explicit paths return the command unchanged', () => {
  assert.equal(resolveCliCommand('missing-cli', { ...WIN, pathValue: tmpdir(), exists: existsSync }), 'missing-cli');
  assert.equal(
    resolveCliCommand('C:\\tools\\bili', { ...WIN, exists: () => { throw new Error('must not consult fs'); } }),
    'C:\\tools\\bili',
  );
  assert.equal(
    resolveCliCommand('./local/bili', { ...WIN, exists: () => { throw new Error('must not consult fs'); } }),
    './local/bili',
  );
  assert.equal(resolveCliCommand('', { ...WIN, pathValue: 'C:\\x', exists: win32Exists([]) }), '');
});

// ── cmd.exe transport argv (cmd /s /c outer-quote strip rules) ──

test('buildCmdArgv wraps the pre-quoted line in the single outer pair cmd /s strips', () => {
  assert.deepEqual(buildCmdArgv('C:\\shims\\bili-cli.cmd', ['search', 'a b']), [
    '/d',
    '/s',
    '/c',
    '"\"C:\\shims\\bili-cli.cmd\" \"search\" \"a b\""',
  ]);
});

test('buildCmdArgv quotes a resolved path with spaces and keeps metachar args literal', () => {
  const argv = buildCmdArgv('C:\\Program Files\\tool\\opencli.cmd', [
    'bilibili',
    'subtitle',
    'a&b|c<d>e^f%g',
    'say "hi"',
    '',
  ]);
  assert.deepEqual(argv.slice(0, 3), ['/d', '/s', '/c']);
  const commandLine = argv[3] ?? '';
  // Outer pair: cmd /s strips exactly these two quotes, then executes the rest.
  assert.ok(commandLine.startsWith('"') && commandLine.endsWith('"'), 'outer quote pair present');
  const inner = commandLine.slice(1, -1);
  assert.ok(inner.startsWith('"C:\\Program Files\\tool\\opencli.cmd"'), 'spaced path stays one argv element');
  assert.ok(inner.includes('"a&b|c<d>e^f%%g"'), 'metacharacters stay inside quotes (% doubled for cmd)');
  assert.ok(inner.includes('"say ""hi"""'), 'embedded quotes doubled');
  assert.ok(inner.endsWith('""'), 'empty arg keeps its position as ""');
});

// ── env lookups ──

test('windowsPathValue reads PATH/Path/path in order', () => {
  assert.equal(windowsPathValue({ Path: 'C:\\a', PATH: 'C:\\b' }), 'C:\\b');
  assert.equal(windowsPathValue({ Path: 'C:\\a' }), 'C:\\a');
  assert.equal(windowsPathValue({ path: 'C:\\c' }), 'C:\\c');
  assert.equal(windowsPathValue({}), '');
});

test('windowsCmdExe prefers COMSPEC, then SystemRoot, then the default', () => {
  assert.equal(windowsCmdExe({ COMSPEC: 'C:\\custom\\cmd.exe' }), 'C:\\custom\\cmd.exe');
  assert.equal(windowsCmdExe({ SystemRoot: 'D:\\Win' }), 'D:\\Win\\System32\\cmd.exe');
  assert.equal(windowsCmdExe({}), 'C:\\Windows\\System32\\cmd.exe');
});

// ── .cmd twin builder ──

test('cmdTwinBody maps env-dump shims to set dumps with the same exit code', () => {
  const body = cmdTwinBody('#!/bin/sh\n/usr/bin/env | /usr/bin/sort > /tmp/d/twitter.env\n');
  assert.ok(body.startsWith('@echo off\r\n'), 'starts with @echo off');
  assert.ok(body.includes('set > "/tmp/d/twitter.env"'), 'dumps env to the file');
  assert.ok(body.endsWith('exit /b 0\r\n'), 'defaults to exit 0');
});

test('cmdTwinBody maps echo payloads and keeps nonzero exits', () => {
  const body = cmdTwinBody("#!/bin/sh\necho '[{\"id\":\"1\"}]'\nexit 127\n");
  assert.ok(body.includes('echo [{"id":"1"}]'), 'prints payload without sh quotes');
  assert.ok(body.includes('exit /b 127'), 'keeps the exit code');
});
