import assert from 'node:assert/strict';
import { join } from 'node:path';
import { test } from 'node:test';
import { nodePackageEntryPath, resolveNodePackageEntry } from '../src/browser/browser-tools.js';

const PKG = join('/fake/root', 'node_modules', 'agent-browser');
const BIN_JS = join('bin', 'agent-browser.js');
const ENTRY = join(PKG, BIN_JS);
const SHIM = join('/fake/root', 'node_modules', '.bin', 'agent-browser');

test('nodePackageEntryPath returns the entry when present', () => {
  assert.equal(nodePackageEntryPath(PKG, BIN_JS, (p) => p === ENTRY), ENTRY);
});

test('nodePackageEntryPath returns undefined when the entry is missing', () => {
  assert.equal(nodePackageEntryPath(PKG, BIN_JS, () => false), undefined);
});

test('resolveNodePackageEntry prefers [node, entryJs, ...args] when the entry exists', () => {
  assert.deepEqual(
    resolveNodePackageEntry(PKG, BIN_JS, ['--version'], { shimPath: SHIM, exists: (p) => p === ENTRY }),
    [process.execPath, ENTRY, '--version'],
  );
});

test('resolveNodePackageEntry falls back to the shim path when the entry is missing', () => {
  assert.deepEqual(
    resolveNodePackageEntry(PKG, BIN_JS, ['snapshot'], { shimPath: SHIM, exists: () => false }),
    [SHIM, 'snapshot'],
  );
});

test('resolveNodePackageEntry defaults args to empty and shim to the unresolved entry', () => {
  assert.deepEqual(resolveNodePackageEntry(PKG, BIN_JS, [], { exists: () => false }), [ENTRY]);
});
