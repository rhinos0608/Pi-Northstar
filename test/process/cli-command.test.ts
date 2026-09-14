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
  childPathValue,
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

test('quoteCmdArg splits % as "%" toggles so cmd cannot expand %NAME%', () => {
  // cmd.exe expands %NAME% on the /c line even inside quotes, and `%%` does
  // not collapse in command-line context — so neither leaving % alone nor
  // doubling survives. The inserted quotes poison cmd's %NAME% match while
  // CommandLineToArgvW strips them (native round-trip in
  // test/process/cli-command-win32-native.test.ts).
  assert.equal(quoteCmdArg('hello world'), '"hello world"');
  assert.equal(quoteCmdArg('%SystemRoot%'), '""%"SystemRoot"%""');
  assert.equal(quoteCmdArg('100%'), '"100"%""');
  assert.equal(quoteCmdArg('a%b'), '"a"%"b"');
  assert.equal(quoteCmdArg('%'), '""%""');
  assert.equal(quoteCmdArg('%%'), '""%""%""');
});

/** Minimal model of cmd.exe's /c percent phase: %NAME% expands (even inside
 *  quotes) when NAME is defined (case-insensitive); single pass, undefined
 *  names stay literal. Test-only contract of the escaping quoteCmdArg must
 *  defeat. */
function expandCmdPercent(line: string, env: Record<string, string>): string {
  const lowerEnv = new Map(Object.entries(env).map(([key, value]) => [key.toLowerCase(), value]));
  let out = '';
  let index = 0;
  while (index < line.length) {
    const open = line.indexOf('%', index);
    if (open === -1) return out + line.slice(index);
    const close = line.indexOf('%', open + 1);
    if (close === -1) return out + line.slice(index);
    const value = lowerEnv.get(line.slice(open + 1, close).toLowerCase());
    if (value === undefined) {
      out += line.slice(index, close + 1);
    } else {
      out += line.slice(index, open) + value;
    }
    index = close + 1;
  }
  return out;
}

test('quoted % payloads are a fixpoint of cmd expansion (token stays hidden)', () => {
  // Win32-capable (pure quoting, runs on any host): the old quoting left %
  // untouched, so cmd expanded the child-env token into argv — the leak.
  const env = { OPENCLI_TOKEN: 'SECRET_CANARY_X', PATH: 'C:\\shims' };
  const payload = 'search %OPENCLI_TOKEN% leaked?';
  assert.ok(expandCmdPercent(`"${payload}"`, env).includes('SECRET_CANARY_X'));
  // New quoting: every % is split as `"%"`, so no quoteless %NAME% span
  // survives for cmd to match — quoted output expands to itself.
  for (const value of [
    payload,
    '%OPENCLI_TOKEN%',
    'pre %OPENCLI_TOKEN% post',
    '100%',
    'a%b',
    '%',
    '%%',
    '%PATH%',
    '%UNDEFINED_PI_VAR_XYZ%',
  ]) {
    const quoted = quoteCmdArg(value);
    assert.equal(expandCmdPercent(quoted, env), quoted, `cmd must not rewrite ${quoted}`);
    assert.ok(!expandCmdPercent(quoted, env).includes('SECRET_CANARY_X'));
  }
  const argv = buildCmdArgv('C:\\shims\\opencli.cmd', ['search', payload]);
  assert.ok((argv[3] ?? '').includes('"search "%"OPENCLI_TOKEN"%" leaked?"'));
});

test('quoteCmdArg doubles backslash runs before an inserted % toggle', () => {
  // `\` before `"%"` must stay a delimiter per CommandLineToArgvW (2n
  // backslashes + quote), otherwise the backslash would escape the toggle.
  assert.equal(quoteCmdArg('a\\%b'), '"a\\\\"%"b"');
});

test('quoteCmdArg keeps % literal next to embedded quotes', () => {
  assert.equal(quoteCmdArg('"%A%"'), '""""%"A"%""""');
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
  assert.ok(inner.includes('"a&b|c<d>e^f"%"g"'), 'metacharacters stay inside quotes (% split as "%" toggles)');
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

test('childPathValue reads the spawn env PATH for win32 resolution', () => {
  // Win32 shim lookup must use the child env (often shim-only PATH), not the
  // parent process.env: bare commands otherwise miss with ENOENT even though
  // the shim is on the child PATH (reach-tools twitter shims on Windows).
  assert.equal(childPathValue({ PATH: 'C:\\shims' }), 'C:\\shims');
  assert.equal(childPathValue({ Path: 'C:\\a' }), 'C:\\a');
  assert.equal(childPathValue({}), undefined);
  assert.equal(childPathValue(undefined), undefined);
  assert.equal(childPathValue({ PATH: 42 } as unknown as Record<string, string>), undefined);
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
