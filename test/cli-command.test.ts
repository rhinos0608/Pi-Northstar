import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { test } from 'node:test';
import { resolveCliCommand } from '../src/cli-command.js';

const WIN = { platform: 'win32' as const };

test('non-windows returns the command untouched without touching the fs', () => {
  assert.equal(
    resolveCliCommand('bili', { platform: 'linux', pathValue: '', exists: () => { throw new Error('must not consult fs'); } }),
    'bili',
  );
});

test('win32 resolves a bare command to its .cmd twin in PATH order', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pi-cli-resolve-'));
  try {
    await writeFile(join(dir, 'bili.cmd'), '@echo off\r\n');
    const resolved = resolveCliCommand('bili', {
      ...WIN,
      pathValue: dir,
      pathext: '.com;.exe;.bat;.cmd',
      exists: existsSync,
    });
    assert.equal(resolved, join(dir, 'bili.cmd'));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('win32 follows PATH then PATHEXT order (fake fs, case-proof)', () => {
  const exists = (path: string): boolean =>
    path.endsWith('opencli.BAT') || path.endsWith('opencli.CMD');
  // .BAT precedes .CMD in the injected PATHEXT, so the first dir wins
  // with its .BAT spelling even though both spellings "exist" everywhere.
  const resolved = resolveCliCommand('opencli', {
    ...WIN,
    pathValue: ['/fake/first', '/fake/second'].join(delimiter),
    pathext: '.BAT;.CMD',
    exists,
  });
  const expected = ['/fake/first', 'opencli.BAT'].join('/');
  assert.equal(resolved, expected);
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
});
