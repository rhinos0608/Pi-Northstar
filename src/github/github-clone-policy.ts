// Plan E2 clone policy: ceilings, ref safety, entry classification.
//
// Pure policy (no child_process, no fetch, no fs). The clone executor
// (github-clone.ts) enforces these ceilings; this module only decides them.
// Every ceiling is operator-lower-only: an operator override at or below the
// default is accepted, anything above the default throws invalid_request.
// Ceilings never clamp silently.
//
// Defaults (plan-specified): 350MiB repo, 30s clone, 10k files scanned,
// 64MiB eligible text, 1MiB/file, 200 tree entries.

import { posix } from 'node:path';
import { SocialError } from '../social/social-contract.js';

/** Total on-disk bytes (working tree + .git) a clone may occupy. */
export const GITHUB_CLONE_MAX_REPO_BYTES = 350 * 1024 * 1024;
/** Wall-clock budget for one clone child process. */
export const GITHUB_CLONE_TIMEOUT_MS = 30_000;
/** Files examined during a clone scan before the scan rejects. */
export const GITHUB_CLONE_MAX_FILES_SCANNED = 10_000;
/** Total text bytes admitted across all included files. */
export const GITHUB_CLONE_MAX_TEXT_BYTES = 64 * 1024 * 1024;
/** Per-file text admission cap; larger/binary files are metadata-only. */
export const GITHUB_CLONE_MAX_FILE_BYTES = 1024 * 1024;
/** Tree entries carried into the normalized page. */
export const GITHUB_CLONE_MAX_TREE_ENTRIES = 200;

/** Warning surfaced when `gh` is absent: clone degrades to REST-only. */
export const GITHUB_CLONE_GH_ABSENT_WARNING = 'gh absent, clone unavailable, results degrade to REST-only';

export interface GithubClonePolicy {
  maxRepoBytes: number;
  cloneTimeoutMs: number;
  maxFilesScanned: number;
  maxTextBytes: number;
  maxFileBytes: number;
  maxTreeEntries: number;
}

export function defaultGithubClonePolicy(): GithubClonePolicy {
  return {
    maxRepoBytes: GITHUB_CLONE_MAX_REPO_BYTES,
    cloneTimeoutMs: GITHUB_CLONE_TIMEOUT_MS,
    maxFilesScanned: GITHUB_CLONE_MAX_FILES_SCANNED,
    maxTextBytes: GITHUB_CLONE_MAX_TEXT_BYTES,
    maxFileBytes: GITHUB_CLONE_MAX_FILE_BYTES,
    maxTreeEntries: GITHUB_CLONE_MAX_TREE_ENTRIES,
  };
}

const POLICY_DEFAULTS: Readonly<Record<keyof GithubClonePolicy, number>> = {
  maxRepoBytes: GITHUB_CLONE_MAX_REPO_BYTES,
  cloneTimeoutMs: GITHUB_CLONE_TIMEOUT_MS,
  maxFilesScanned: GITHUB_CLONE_MAX_FILES_SCANNED,
  maxTextBytes: GITHUB_CLONE_MAX_TEXT_BYTES,
  maxFileBytes: GITHUB_CLONE_MAX_FILE_BYTES,
  maxTreeEntries: GITHUB_CLONE_MAX_TREE_ENTRIES,
};

function clonePolicyError(message: string): SocialError {
  return new SocialError('invalid_request', message, { backend: 'github-clone' });
}

/**
 * Resolve operator overrides against plan ceilings. Each override must be a
 * positive integer at or below its default (operator-lower-only). Anything
 * above the default, non-integer, or < 1 throws invalid_request.
 */
export function resolveGithubClonePolicy(overrides?: Partial<GithubClonePolicy>): GithubClonePolicy {
  if (overrides === undefined) return defaultGithubClonePolicy();
  const out: GithubClonePolicy = defaultGithubClonePolicy();
  for (const key of Object.keys(POLICY_DEFAULTS) as (keyof GithubClonePolicy)[]) {
    const raw = overrides[key];
    if (raw === undefined) continue;
    const ceiling = POLICY_DEFAULTS[key];
    if (typeof raw !== 'number' || !Number.isSafeInteger(raw) || raw < 1) {
      throw clonePolicyError(`${key} must be a positive integer`);
    }
    if (raw > ceiling) {
      throw clonePolicyError(`${key} exceeds operator ceiling of ${ceiling} (operator-lower-only)`);
    }
    out[key] = raw;
  }
  return out;
}

// ── Safe ref handling ──
// git-check-ref-format semantics, reject-first: ambiguous, traversal,
// encoding, or option-shaped refs never reach argv.

const CLONE_REF_CHARSET = /^[A-Za-z0-9._/-]+$/;
const CLONE_REF_MAX = 200;

export function validateGithubCloneRef(ref: string, field = 'ref'): string {
  if (typeof ref !== 'string' || ref.length === 0) {
    throw clonePolicyError(`${field} must be a non-empty string`);
  }
  if (ref.length > CLONE_REF_MAX) {
    throw clonePolicyError(`${field} exceeds maximum length of ${CLONE_REF_MAX}`);
  }
  if (!CLONE_REF_CHARSET.test(ref)) {
    throw clonePolicyError(`${field} uses forbidden characters`);
  }
  if (ref.includes('..')) throw clonePolicyError(`${field} must not contain '..'`);
  if (ref.startsWith('-') || ref.startsWith('/')) {
    throw clonePolicyError(`${field} must not start with '-' or '/' (option-shape)`);
  }
  if (ref.endsWith('/') || ref.includes('//')) {
    throw clonePolicyError(`${field} must not have empty segments`);
  }
  if (ref.includes('@{')) throw clonePolicyError(`${field} must not contain '@{' (reflog)`);
  for (const char of ['~', '^', ':']) {
    if (ref.includes(char)) throw clonePolicyError(`${field} must not contain '${char}'`);
  }
  if (ref.includes('%') || /%2f|%2e/i.test(ref)) {
    throw clonePolicyError(`${field} must not contain percent-encoding`);
  }
  return ref;
}

// ── Entry paths ──
// Reject .git (any segment), absolute paths, traversal, backslashes,
// percent-encoding. Special files (fifo/socket/device) are rejected by the
// executor via lstat, not by name; this gate owns the path shape.

const CLONE_PATH_MAX = 200;

export function validateGithubCloneEntryPath(path: string): string {
  if (typeof path !== 'string' || path.length === 0) {
    throw clonePolicyError('entry path must be a non-empty string');
  }
  if (path.length > CLONE_PATH_MAX) {
    throw clonePolicyError(`entry path exceeds maximum length of ${CLONE_PATH_MAX}`);
  }
  if (path.startsWith('/')) throw clonePolicyError('entry path must be relative');
  if (path.includes('\\')) throw clonePolicyError('entry path must not contain backslash');
  if (path.includes('%') || /%2f|%2e/i.test(path)) {
    throw clonePolicyError('entry path must not contain percent-encoding');
  }
  const segments = path.split('/');
  if (segments.some((segment) => segment.length === 0 || segment === '..')) {
    throw clonePolicyError('entry path must not contain traversal or empty segments');
  }
  if (segments.some((segment) => segment === '.git')) {
    throw clonePolicyError('entry path must not touch .git');
  }
  return path;
}

// ── Symlink escape ──
// Pure lexical check: the symlink target resolved against its containing
// directory must stay inside the clone root. The executor additionally
// verifies with realpath (TOCTOU race) and rejects escapes there.

export function isGithubCloneSymlinkEscape(input: { root: string; path: string; target: string }): boolean {
  void input.root;
  const target = input.target;
  if (target.length === 0) return true;
  // Absolute targets pin system paths, never the clone root: escape.
  if (posix.isAbsolute(target)) return true;
  // Walk relative targets against the entry's directory depth. Climbing
  // past the root anchor escapes; posix.normalize alone would silently
  // collapse those '..' away, so track depth explicitly.
  const stack = posix
    .dirname(input.path)
    .split('/')
    .filter((part) => part.length > 0 && part !== '.');
  for (const segment of target.split('/')) {
    if (segment.length === 0 || segment === '.') continue;
    if (segment === '..') {
      if (stack.length === 0) return true;
      stack.pop();
    } else {
      stack.push(segment);
    }
  }
  if (stack.length === 0) return true;
  if (stack[0] === '.git') return true;
  return false;
}

// ── Entry classification ──

export type GithubCloneEntryDecision = 'include' | 'metadata-only' | 'reject';

export interface GithubCloneEntryInput {
  path: string;
  /** Byte size from lstat; undefined when unknown. */
  size?: number | undefined;
  isSymlink?: boolean | undefined;
  /** Raw readlink target; required when isSymlink is true. */
  symlinkTarget?: string | undefined;
  /** True when content sniffing found binary material (NUL byte). */
  binary?: boolean | undefined;
  /** True when lstat reports fifo/socket/device (special file). */
  special?: boolean | undefined;
}

export interface GithubCloneEntryVerdict {
  decision: GithubCloneEntryDecision;
  reason: string;
}

/**
 * Classify one scanned entry. Reject-first: bad paths, specials, dangling
 * symlinks, and symlink escapes reject. Binaries and over-cap files degrade
 * to metadata-only (path/type/size, never content).
 */
export function classifyGithubCloneEntry(
  entry: GithubCloneEntryInput,
  policy: GithubClonePolicy = defaultGithubClonePolicy(),
): GithubCloneEntryVerdict {
  try {
    validateGithubCloneEntryPath(entry.path);
  } catch {
    return { decision: 'reject', reason: 'rejected path' };
  }
  if (entry.special === true) return { decision: 'reject', reason: 'special file' };
  if (entry.isSymlink === true) {
    if (entry.symlinkTarget === undefined || entry.symlinkTarget.length === 0) {
      return { decision: 'reject', reason: 'dangling symlink' };
    }
    if (isGithubCloneSymlinkEscape({ root: '', path: entry.path, target: entry.symlinkTarget })) {
      return { decision: 'reject', reason: 'symlink escape' };
    }
    return { decision: 'metadata-only', reason: 'symlink' };
  }
  if (entry.binary === true) return { decision: 'metadata-only', reason: 'binary' };
  if (entry.size !== undefined && entry.size > policy.maxFileBytes) {
    return { decision: 'metadata-only', reason: 'over per-file cap' };
  }
  return { decision: 'include', reason: 'text' };
}

export function githubCloneGhAbsentWarning(): string {
  return GITHUB_CLONE_GH_ABSENT_WARNING;
}
