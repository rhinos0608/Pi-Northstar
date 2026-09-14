// Plan E1 clone backend: `gh`-then-`git` acquisition behind the
// GithubBackendPlan seam.
//
// Safety contract:
// - Fixed argv arrays only, spawned with shell:false. Refs validated by
//   github-clone-policy before they touch argv (option-shape rejected).
// - Child env is buildNativeChildEnvironment() plus a small explicit set of
//   safe GIT_* values. Parent secrets never forward; the token reaches git
//   only through an ephemeral 0700 credential helper inside a random 0700
//   root, unlinked unconditionally.
// - Hooks, filters, LFS smudge, and recursive submodules disabled via fixed
//   -c flags plus env. protocol.file.allow=never blocks local-pathCloneTest.
// - Random 0700 root per clone, removed unconditionally (success, failure,
//   timeout, abort). No anonymous retry after an authenticated failure.

import { spawn } from 'node:child_process';
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  readlink,
  realpath,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import { buildNativeChildEnvironment } from '../process/native-child-env.js';
import { SocialError } from '../social/social-contract.js';
import {
  classifyGithubCloneEntry,
  githubCloneGhAbsentWarning,
  isGithubCloneSymlinkEscape,
  resolveGithubClonePolicy,
  validateGithubCloneEntryPath,
  validateGithubCloneRef,
  type GithubClonePolicy,
} from './github-clone-policy.js';
import {
  validateGithubPage,
  type GithubBackendPlan,
  type GithubEntityV1,
  type GithubExecutionContext,
  type GithubPageV1,
  type GithubRequest,
  type GithubWorker,
} from './github-contract.js';

/** Backend name registered in the GithubBackendPlan seam. */
export const GITHUB_CLONE_BACKEND = 'github-clone';

const CLONE_OWNER_CHARSET = /^[A-Za-z0-9._-]+$/;

function cloneError(
  code: 'invalid_request' | 'authentication_required' | 'upstream_error' | 'malformed_upstream',
  message: string,
): SocialError {
  return new SocialError(code, message, { backend: GITHUB_CLONE_BACKEND });
}

function validateCloneSlugPart(field: string, value: string, max: number): void {
  if (value.length === 0 || value.length > max) {
    throw cloneError('invalid_request', `${field} has invalid length`);
  }
  if (!CLONE_OWNER_CHARSET.test(value)) {
    throw cloneError('invalid_request', `${field} uses forbidden characters`);
  }
  if (value.includes('..') || value.startsWith('-')) {
    throw cloneError('invalid_request', `${field} is not a valid slug`);
  }
}

function validateCloneSlug(owner: string, repo: string): void {
  validateCloneSlugPart('owner', owner, 39);
  validateCloneSlugPart('repo', repo, 100);
}

export interface GithubCloneInput {
  owner: string;
  repo: string;
  ref?: string | undefined;
}

export interface GithubCloneResult {
  stdout: string;
  stderr: string;
  code: number;
}

export interface GithubCloneRunOptions {
  env: Record<string, string>;
  cwd: string;
  timeoutMs: number;
  signal?: AbortSignal | undefined;
}

/** Injected process runner. Implementations must use shell:false. */
export type GithubCloneRunner = (
  command: string,
  argv: readonly string[],
  options: GithubCloneRunOptions,
) => Promise<GithubCloneResult>;

export interface GithubCloneDependencies {
  parentEnv?: Record<string, string | undefined> | undefined;
  /** Explicit token; otherwise read from parentEnv GITHUB_TOKEN ?? GH_TOKEN. */
  token?: string | undefined;
  policy?: Partial<GithubClonePolicy> | undefined;
  runProcess?: GithubCloneRunner | undefined;
}

export interface GithubCloneScanFile {
  path: string;
  size: number;
  text?: string | undefined;
}

export interface GithubClonePayload {
  owner: string;
  repo: string;
  ref: string;
  files: GithubCloneScanFile[];
  /** Entries degraded to metadata-only (binary/oversize/symlink). */
  metadataOnly: string[];
  warnings: string[];
}

// ── Auth-failure detection (no anonymous retry) ──

const AUTH_FAILURE_PATTERNS = [
  /authentication failed/i,
  /permission denied/i,
  /invalid credentials/i,
  /could not authenticate/i,
  /repository not found/i,
  /401/,
  /403/,
];

export function isGithubCloneAuthFailure(stderr: string, code: number): boolean {
  if (code === 0) return false;
  return AUTH_FAILURE_PATTERNS.some((pattern) => pattern.test(stderr));
}

// ── Fixed argv ──

export interface GithubCloneCommand {
  command: string;
  argv: string[];
}

function cloneEnvBase(parentEnv: Record<string, string | undefined>): Record<string, string> {
  return {
    ...buildNativeChildEnvironment(parentEnv),
    GIT_TERMINAL_PROMPT: '0',
    GIT_LFS_SKIP_SMUDGE: '1',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_SYSTEM: '/dev/null',
  };
}

function cloneUrl(owner: string, repo: string): string {
  return `https://github.com/${owner}/${repo}.git`;
}

/**
 * Fixed git clone argv. Hooks point at an empty dir inside the clone root,
 * filters/LFS smudge are blanked, submodules never recurse, file protocol
 * refused. The credential helper path is the only per-clone variable.
 */
export function buildGithubGitCloneArgv(input: {
  owner: string;
  repo: string;
  ref?: string | undefined;
  destDir: string;
  credentialHelper: string;
  emptyHooksDir: string;
}): GithubCloneCommand {
  validateCloneSlug(input.owner, input.repo);
  const ref = input.ref !== undefined ? validateGithubCloneRef(input.ref) : undefined;
  const argv: string[] = [
    'clone',
    '--no-recurse-submodules',
    '--no-replace-objects',
    '--no-hardlinks',
    '--depth',
    '1',
    '--single-branch',
    '--no-tags',
    '-c',
    `credential.helper=!${input.credentialHelper}`,
    '-c',
    `core.hooksPath=${input.emptyHooksDir}`,
    '-c',
    'core.fsmonitor=false',
    '-c',
    'submodule.recurse=false',
    '-c',
    'filter.lfs.smudge=',
    '-c',
    'filter.lfs.process=',
    '-c',
    'protocol.file.allow=never',
  ];
  if (ref !== undefined) argv.push('--branch', ref);
  argv.push(cloneUrl(input.owner, input.repo), input.destDir);
  return { command: 'git', argv };
}

/** Fixed gh clone argv; hardening flags pass through to git after --. */
export function buildGithubGhCloneArgv(input: {
  owner: string;
  repo: string;
  ref?: string | undefined;
  destDir: string;
  credentialHelper?: string | undefined;
  emptyHooksDir?: string | undefined;
}): GithubCloneCommand {
  validateCloneSlug(input.owner, input.repo);
  const ref = input.ref !== undefined ? validateGithubCloneRef(input.ref) : undefined;
  const slug = `${input.owner}/${input.repo}`;
  const argv: string[] = ['repo', 'clone', slug, input.destDir, '--'];
  if (input.credentialHelper !== undefined) argv.push('-c', `credential.helper=!${input.credentialHelper}`);
  if (input.emptyHooksDir !== undefined) argv.push('-c', `core.hooksPath=${input.emptyHooksDir}`);
  argv.push(
    '--no-recurse-submodules',
    '--no-replace-objects',
    '--no-hardlinks',
    '--depth',
    '1',
    '--single-branch',
    '--no-tags',
    '-c',
    'core.fsmonitor=false',
    '-c',
    'submodule.recurse=false',
    '-c',
    'filter.lfs.smudge=',
    '-c',
    'filter.lfs.process=',
    '-c',
    'protocol.file.allow=never',
  );
  if (ref !== undefined) argv.push('--branch', ref);
  return { command: 'gh', argv };
}

// ── Default runner (shell:false, timeout, abort) ──

export function defaultGithubCloneRunner(
  command: string,
  argv: readonly string[],
  options: GithubCloneRunOptions,
): Promise<GithubCloneResult> {
  return new Promise<GithubCloneResult>((resolve, reject) => {
    const child = spawn(command, [...argv], {
      shell: false,
      env: options.env,
      cwd: options.cwd,
      timeout: options.timeoutMs,
      signal: options.signal,
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });
    child.on('error', (error: Error) => {
      reject(error);
    });
    child.on('close', (code: number | null, signal: string | null) => {
      if (options.signal?.aborted) {
        reject(new Error('Aborted'));
        return;
      }
      resolve({ stdout, stderr, code: code ?? (signal === null ? 1 : 128) });
    });
  });
}

// ── Clone root lifecycle (random 0700, unconditional cleanup) ──

async function acquireCloneRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'pi-gh-clone-'));
  await chmod(root, 0o700);
  return root;
}

async function releaseCloneRoot(root: string): Promise<void> {
  await rm(root, { recursive: true, force: true, maxRetries: 2 });
}

async function writeCredentialHelper(root: string, token: string | undefined): Promise<string> {
  const helper = join(root, 'askpass.sh');
  const body =
    token === undefined
      ? '#!/bin/sh\nexit 1\n'
      : `#!/bin/sh\nprintf '%s' '${token.replace(/'/g, `'\\''`)}'\n`;
  await writeFile(helper, body, { mode: 0o700 });
  await chmod(helper, 0o700);
  return helper;
}

function childEnvForClone(
  parentEnv: Record<string, string | undefined>,
  helper: string,
): Record<string, string> {
  return { ...cloneEnvBase(parentEnv), GIT_ASKPASS: helper };
}

// ── Filesystem scan under ceilings ──

const SNIFF_BYTES = 8192;

function isBinarySample(sample: Buffer): boolean {
  return sample.includes(0);
}

async function realpathWithinRoot(abs: string, workdir: string): Promise<boolean> {
  try {
    const resolved = await realpath(abs);
    return resolved === workdir || resolved.startsWith(`${workdir}${sep}`);
  } catch {
    return false;
  }
}

interface CloneScanState {
  workdir: string;
  policy: GithubClonePolicy;
  files: GithubCloneScanFile[];
  metadataOnly: string[];
  warnings: string[];
  scanned: number;
  textBytes: number;
  repoBytes: number;
  queue: string[];
}

function warn(state: CloneScanState, message: string, rel: string): void {
  state.warnings.push(`${message}: ${rel.slice(0, 64)}`);
}

async function scanSymlinkEntry(state: CloneScanState, rel: string, abs: string): Promise<void> {
  const target = await readlink(abs);
  const escaped =
    isGithubCloneSymlinkEscape({ root: state.workdir, path: rel, target }) ||
    !(await realpathWithinRoot(abs, state.workdir));
  if (escaped) warn(state, 'symlink escape rejected', rel);
  else {
    const verdict = classifyGithubCloneEntry({ path: rel, isSymlink: true, symlinkTarget: target });
    if (verdict.decision === 'reject') warn(state, 'symlink rejected', rel);
    else state.metadataOnly.push(rel);
  }
}

async function scanFileEntry(state: CloneScanState, rel: string, abs: string, size: number): Promise<void> {
  try {
    validateGithubCloneEntryPath(rel);
  } catch {
    warn(state, 'path rejected', rel);
    return;
  }
  if (size > state.policy.maxFileBytes) {
    state.metadataOnly.push(rel);
    return;
  }
  const sample = await readFile(abs);
  if (sample.length > state.policy.maxFileBytes) {
    state.metadataOnly.push(rel);
    return;
  }
  if (isBinarySample(sample.subarray(0, SNIFF_BYTES))) {
    state.metadataOnly.push(rel);
    return;
  }
  const text = sample.toString('utf8');
  if (state.textBytes + text.length > state.policy.maxTextBytes) {
    state.warnings.push('text budget exhausted, remaining files metadata-only');
    state.metadataOnly.push(rel);
    return;
  }
  state.textBytes += text.length;
  state.files.push({ path: rel, size, text });
}

async function scanOneEntry(state: CloneScanState, rel: string): Promise<void> {
  const abs = join(state.workdir, rel);
  const st = await lstat(abs);
  if (st.isDirectory() && !st.isSymbolicLink()) {
    state.queue.push(rel);
    return;
  }
  if (st.isSymbolicLink()) {
    await scanSymlinkEntry(state, rel, abs);
    return;
  }
  if (!st.isFile()) {
    warn(state, 'special file rejected', rel);
    return;
  }
  state.scanned += 1;
  if (state.scanned > state.policy.maxFilesScanned) {
    throw cloneError('upstream_error', `clone exceeds file scan ceiling of ${state.policy.maxFilesScanned}`);
  }
  state.repoBytes += st.size;
  if (state.repoBytes > state.policy.maxRepoBytes) {
    throw cloneError('upstream_error', `clone exceeds repo ceiling of ${state.policy.maxRepoBytes} bytes`);
  }
  await scanFileEntry(state, rel, abs, st.size);
}

async function scanCloneTree(workdir: string, policy: GithubClonePolicy): Promise<GithubClonePayload & { repoBytes: number }> {
  const state: CloneScanState = {
    workdir,
    policy,
    files: [],
    metadataOnly: [],
    warnings: [],
    scanned: 0,
    textBytes: 0,
    repoBytes: 0,
    queue: [''],
  };
  while (state.queue.length > 0) {
    const relative = state.queue.pop() as string;
    const absolute = relative.length === 0 ? workdir : join(workdir, relative);
    const entries = await readdir(absolute, { withFileTypes: true });
    for (const entry of entries) {
      const rel = relative.length === 0 ? entry.name : `${relative}/${entry.name}`;
      if (rel.split('/').includes('.git')) continue;
      await scanOneEntry(state, rel);
    }
  }
  const { files, metadataOnly, warnings, repoBytes } = state;
  return { owner: '', repo: '', ref: '', files, metadataOnly, warnings, repoBytes };
}

// ── Public clone entrypoint ──

export interface GithubCloneOutcome {
  payload: GithubClonePayload;
  /** True when gh was missing and git carried the clone. */
  ghAbsent: boolean;
  warnings: string[];
}

function resolveCloneToken(deps: GithubCloneDependencies): string | undefined {
  if (deps.token !== undefined && deps.token.length > 0) return deps.token;
  const env = deps.parentEnv ?? process.env;
  const token = env.GITHUB_TOKEN ?? env.GH_TOKEN;
  return token !== undefined && token.length > 0 ? token : undefined;
}

function isMissingBinary(error: unknown): boolean {
  return error instanceof Error && 'code' in error && (error as { code?: string }).code === 'ENOENT';
}

/**
 * Clone owner/repo at ref into an ephemeral root, scan under policy
 * ceilings, then remove the root unconditionally. Tries `gh` first, then
 * `git`. An authenticated failure never retries anonymously: when a token
 * was configured and the failure looks like auth, the error propagates.
 */
export async function cloneGithubRepo(
  input: GithubCloneInput,
  deps: GithubCloneDependencies = {},
  execution?: GithubExecutionContext,
): Promise<GithubCloneOutcome> {
  validateCloneSlug(input.owner, input.repo);
  const ref = input.ref !== undefined ? validateGithubCloneRef(input.ref) : 'HEAD';
  const policy = resolveGithubClonePolicy(deps.policy);
  const parentEnv = deps.parentEnv ?? process.env;
  const token = resolveCloneToken(deps);
  const run = deps.runProcess ?? defaultGithubCloneRunner;
  const signal = execution?.signal;
  if (signal?.aborted) throw new Error('Aborted');

  const root = await acquireCloneRoot();
  const warnings: string[] = [];
  try {
    const workdir = join(root, 'work');
    const hooksDir = join(root, 'no-hooks');
    await mkdir(hooksDir, { recursive: true, mode: 0o700 });
    const helper = await writeCredentialHelper(root, token);
    const env = childEnvForClone(parentEnv, helper);
    const ghArgv = buildGithubGhCloneArgv({ owner: input.owner, repo: input.repo, ...(input.ref !== undefined ? { ref } : {}), destDir: workdir, credentialHelper: helper, emptyHooksDir: hooksDir });

    let ghAbsent = false;
    let cloned = false;
    let authenticatedFailure = false;
    try {
      const ghResult = await run(ghArgv.command, ghArgv.argv, { env, cwd: root, timeoutMs: policy.cloneTimeoutMs, ...(signal !== undefined ? { signal } : {}) });
      if (ghResult.code === 0) {
        cloned = true;
      } else if (token !== undefined && isGithubCloneAuthFailure(ghResult.stderr, ghResult.code)) {
        authenticatedFailure = true;
        throw cloneError('authentication_required', 'GitHub clone authentication_required: invalid or missing token');
      } else {
        warnings.push(`gh clone failed (code ${ghResult.code}), falling back to git`);
      }
    } catch (error) {
      if (error instanceof SocialError) throw error;
      if (signal?.aborted) throw error;
      if (isMissingBinary(error)) {
        ghAbsent = true;
        warnings.push(githubCloneGhAbsentWarning());
      } else {
        warnings.push('gh clone unavailable, falling back to git');
      }
    }

    if (!cloned) {
      if (authenticatedFailure) {
        throw cloneError('authentication_required', 'GitHub clone authentication_required: invalid or missing token');
      }
      const gitArgv = buildGithubGitCloneArgv({
        owner: input.owner,
        repo: input.repo,
        ...(input.ref !== undefined ? { ref } : {}),
        destDir: workdir,
        credentialHelper: helper,
        emptyHooksDir: hooksDir,
      });
      let gitResult: GithubCloneResult;
      try {
        gitResult = await run(gitArgv.command, gitArgv.argv, { env, cwd: root, timeoutMs: policy.cloneTimeoutMs, ...(signal !== undefined ? { signal } : {}) });
      } catch (error) {
        if (signal?.aborted) throw error;
        if (isMissingBinary(error)) throw cloneError('upstream_error', 'GitHub clone upstream_error: no git binary available');
        throw cloneError('upstream_error', 'GitHub clone upstream_error: clone process failed');
      }
      if (gitResult.code !== 0) {
        if (isGithubCloneAuthFailure(gitResult.stderr, gitResult.code)) {
          throw cloneError('authentication_required', 'GitHub clone authentication_required: invalid or missing token');
        }
        throw cloneError('upstream_error', `GitHub clone upstream_error: clone failed with code ${gitResult.code}`);
      }
    }

    const scanned = await scanCloneTree(workdir, policy);
    const payload: GithubClonePayload = {
      owner: input.owner,
      repo: input.repo,
      ref,
      files: scanned.files.slice(0, policy.maxTreeEntries),
      metadataOnly: scanned.metadataOnly.slice(0, policy.maxTreeEntries),
      warnings: [...warnings, ...scanned.warnings],
    };
    if (scanned.files.length > policy.maxTreeEntries || scanned.metadataOnly.length > policy.maxTreeEntries) {
      payload.warnings.push(`tree entries capped at ${policy.maxTreeEntries}`);
    }
    return { payload, ghAbsent, warnings: payload.warnings };
  } finally {
    await releaseCloneRoot(root);
  }
}

// ── GithubBackendPlan seam ──

function checkClonePage(page: GithubPageV1): GithubPageV1 {
  const check = validateGithubPage(page);
  if (!check.ok || check.page === undefined) {
    throw cloneError('malformed_upstream', `clone page failed validation: ${check.issues.join('; ')}`);
  }
  return check.page;
}

export function normalizeGithubClonePayload(
  request: GithubRequest,
  payload: GithubClonePayload,
  policy?: Partial<GithubClonePolicy> | undefined,
): GithubPageV1 {
  const owner = request.owner ?? payload.owner;
  const repo = request.repo ?? payload.repo;
  const ref = request.ref ?? payload.ref;
  const maxTreeEntries = resolveGithubClonePolicy(policy).maxTreeEntries;
  const entries = [
    ...payload.files.map((file) => ({ path: file.path, type: 'blob' as const })),
    ...payload.metadataOnly.map((path) => ({ path, type: 'blob' as const })),
  ].slice(0, maxTreeEntries);
  return checkClonePage({
    entities: [
      {
        version: 1,
        kind: 'tree',
        id: `github:tree:${owner}/${repo}@${ref}`,
        backend: GITHUB_CLONE_BACKEND,
        entries,
      } as GithubEntityV1,
    ],
    pagination: { supported: false, limit: request.limit, returned: 1, hasMore: false },
    partial: payload.warnings.length > 0,
    warnings: payload.warnings,
  });
}

function cloneSupportedAction(action: string): boolean {
  return action === 'repo' || action === 'tree';
}

/**
 * Clone-first worker for repo/tree actions behind the GithubWorker seam.
 * Domain routing (E3, other owner) decides clone-first vs REST-first; this
 * worker only declares clone plans and normalizes clone payloads.
 */
export function createGithubCloneWorker(deps: GithubCloneDependencies = {}): GithubWorker {
  return {
    backends: [GITHUB_CLONE_BACKEND],
    async plans(request: GithubRequest, context: GithubExecutionContext): Promise<readonly GithubBackendPlan[]> {
      if (!cloneSupportedAction(request.action)) return [];
      if (request.owner === undefined || request.repo === undefined) return [];
      const authTier = resolveCloneToken(deps) !== undefined ? 'env_var' : 'anonymous';
      // Validate operator overrides eagerly so bad ceilings reject at plan time.
      resolveGithubClonePolicy(deps.policy);
      return [
        {
          backend: GITHUB_CLONE_BACKEND,
          authTier,
          pagination: 'unsupported',
          degraded: false,
          quality: 'full',
          async execute(signal?: AbortSignal): Promise<unknown> {
            const outcome = await cloneGithubRepo(
              {
                owner: request.owner as string,
                repo: request.repo as string,
                ...(request.ref !== undefined ? { ref: request.ref } : {}),
              },
              deps,
              { ...(signal ?? context.signal !== undefined ? { signal: (signal ?? context.signal) as AbortSignal } : {}) },
            );
            return outcome.payload;
          },
        },
      ];
    },
    normalize(request: GithubRequest, plan: GithubBackendPlan, payload: unknown): GithubPageV1 {
      if (plan.backend !== GITHUB_CLONE_BACKEND) {
        throw cloneError('invalid_request', `clone worker cannot normalize backend ${plan.backend}`);
      }
      const typed = payload as GithubClonePayload;
      if (typeof typed !== 'object' || typed === null || !Array.isArray((typed as { files?: unknown }).files)) {
        throw cloneError('malformed_upstream', 'clone payload is not a clone result');
      }
      return normalizeGithubClonePayload(request, typed, deps.policy);
    },
  };
}

/** Re-export for seam discoverability without widening scope. */
export type { GithubClonePolicy as GithubClonePolicyReexport };
