// Plan E2 policy tests: ceilings, operator-lower-only, ref/path/symlink gates.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SocialError } from '../../src/social/social-contract.js';
import {
  GITHUB_CLONE_GH_ABSENT_WARNING,
  GITHUB_CLONE_MAX_FILE_BYTES,
  GITHUB_CLONE_MAX_FILES_SCANNED,
  GITHUB_CLONE_MAX_REPO_BYTES,
  GITHUB_CLONE_MAX_TEXT_BYTES,
  GITHUB_CLONE_MAX_TREE_ENTRIES,
  GITHUB_CLONE_TIMEOUT_MS,
  classifyGithubCloneEntry,
  defaultGithubClonePolicy,
  githubCloneGhAbsentWarning,
  isGithubCloneSymlinkEscape,
  resolveGithubClonePolicy,
  validateGithubCloneEntryPath,
  validateGithubCloneRef,
} from '../../src/github/github-clone-policy.js';

function invalidRequest(run: () => unknown): SocialError {
  try {
    run();
  } catch (error) {
    assert.ok(error instanceof SocialError, `expected SocialError, got ${String(error)}`);
    assert.equal(error.code, 'invalid_request');
    return error;
  }
  throw new Error('expected invalid_request, but nothing threw');
}

test('defaults match plan ceilings', () => {
  assert.equal(GITHUB_CLONE_MAX_REPO_BYTES, 350 * 1024 * 1024);
  assert.equal(GITHUB_CLONE_TIMEOUT_MS, 30_000);
  assert.equal(GITHUB_CLONE_MAX_FILES_SCANNED, 10_000);
  assert.equal(GITHUB_CLONE_MAX_TEXT_BYTES, 64 * 1024 * 1024);
  assert.equal(GITHUB_CLONE_MAX_FILE_BYTES, 1024 * 1024);
  assert.equal(GITHUB_CLONE_MAX_TREE_ENTRIES, 200);
  assert.deepEqual(resolveGithubClonePolicy(), defaultGithubClonePolicy());
});

test('operator overrides accept lower, reject higher (never clamp)', () => {
  const lowered = resolveGithubClonePolicy({ maxTreeEntries: 50, cloneTimeoutMs: 5_000 });
  assert.equal(lowered.maxTreeEntries, 50);
  assert.equal(lowered.cloneTimeoutMs, 5_000);
  assert.equal(lowered.maxRepoBytes, GITHUB_CLONE_MAX_REPO_BYTES);
  invalidRequest(() => resolveGithubClonePolicy({ maxRepoBytes: GITHUB_CLONE_MAX_REPO_BYTES + 1 }));
  invalidRequest(() => resolveGithubClonePolicy({ maxTreeEntries: 201 }));
  invalidRequest(() => resolveGithubClonePolicy({ cloneTimeoutMs: 0 }));
  invalidRequest(() => resolveGithubClonePolicy({ maxFilesScanned: -3 }));
  invalidRequest(() => resolveGithubClonePolicy({ maxTextBytes: 1.5 }));
});

test('ref gate accepts normal refs, rejects option-shape/traversal/encoding', () => {
  assert.equal(validateGithubCloneRef('main'), 'main');
  assert.equal(validateGithubCloneRef('feature/x-1.2'), 'feature/x-1.2');
  for (const bad of [
    '',
    '--upload-pack=id',
    '-u',
    '-c',
    '../escape',
    'a..b',
    'a~b',
    'a^b',
    'a:b',
    'a@{1}',
    'a%2fb',
    '/leading',
    'trailing/',
    'a//b',
  ]) {
    invalidRequest(() => validateGithubCloneRef(bad));
  }
});

test('entry path gate rejects .git, absolute, traversal, encoding', () => {
  assert.equal(validateGithubCloneEntryPath('src/index.ts'), 'src/index.ts');
  for (const bad of ['.git', '.git/config', 'a/.git/b', '/abs', '../x', 'a/../b', 'a\\b', 'a%2eb', '', 'a/']) {
    invalidRequest(() => validateGithubCloneEntryPath(bad));
  }
});

test('symlink escape rejects climbs, absolute targets, .git landings', () => {
  assert.equal(isGithubCloneSymlinkEscape({ root: '/r', path: 'sub/link', target: '../../etc/passwd' }), true);
  assert.equal(isGithubCloneSymlinkEscape({ root: '/r', path: 'link', target: '/etc/passwd' }), true);
  assert.equal(isGithubCloneSymlinkEscape({ root: '/r', path: 'sub/link', target: '../.git/config' }), true);
  assert.equal(isGithubCloneSymlinkEscape({ root: '/r', path: 'top', target: '..' }), true);
  assert.equal(isGithubCloneSymlinkEscape({ root: '/r', path: 'a/link', target: '../b' }), false);
  assert.equal(isGithubCloneSymlinkEscape({ root: '/r', path: 'a/b/link', target: '../../c' }), false);
  assert.equal(isGithubCloneSymlinkEscape({ root: '/r', path: 'a/link', target: './sibling' }), false);
});

test('classification degrades binaries/oversize/symlinks, rejects specials', () => {
  assert.deepEqual(classifyGithubCloneEntry({ path: 'src/a.ts' }).decision, 'include');
  assert.deepEqual(classifyGithubCloneEntry({ path: 'bin/a', binary: true }).decision, 'metadata-only');
  assert.deepEqual(
    classifyGithubCloneEntry({ path: 'big.txt', size: GITHUB_CLONE_MAX_FILE_BYTES + 1 }).decision,
    'metadata-only',
  );
  assert.deepEqual(
    classifyGithubCloneEntry({ path: 'a/link', isSymlink: true, symlinkTarget: '../b' }).decision,
    'metadata-only',
  );
  assert.deepEqual(
    classifyGithubCloneEntry({ path: 'a/link', isSymlink: true, symlinkTarget: '../../etc' }).decision,
    'reject',
  );
  assert.deepEqual(classifyGithubCloneEntry({ path: 'a/link', isSymlink: true }).decision, 'reject');
  assert.deepEqual(classifyGithubCloneEntry({ path: 'dev/x', special: true }).decision, 'reject');
  assert.deepEqual(classifyGithubCloneEntry({ path: '.git/config' }).decision, 'reject');
});

test('gh-absent warning degrades to REST-only', () => {
  assert.ok(githubCloneGhAbsentWarning().includes('REST-only'));
  assert.equal(githubCloneGhAbsentWarning(), GITHUB_CLONE_GH_ABSENT_WARNING);
});
