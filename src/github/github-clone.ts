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
  GITHUB_CLONE_GH_ABSENT_USING_GIT_NOTICE,
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
  options?: { cause?: unknown },
): SocialError {
  return new SocialError(code, message, {
    backend: GITHUB_CLONE_BACKEND,
    ...(options?.cause !== undefined ? { cause: options.cause } : {}),
  });
}

/** Control/newline bytes that would break credential-helper protocol lines. */
const CLONE_TOKEN_FORBIDDEN_CHARS = /[\x00-\x1f\x7f]/;

/** Fail closed before any spawn: the token is embedded in shell-quoted helper
 * lines, so control characters would break protocol framing or inject lines. */
function validateCloneToken(token: string | undefined): void {
  if (token !== undefined && CLONE_TOKEN_FORBIDDEN_CHARS.test(token)) {
    throw cloneError('invalid_request', 'GitHub clone token contains forbidden control characters');
  }
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

// ── Kill escalation (abort → SIGTERM → SIGKILL, own process group) ──

/** Grace after SIGTERM before escalating to SIGKILL. */
export const CLONE_KILL_TERM_GRACE_MS = 1000;

export interface CloneKillTarget {
  pid?: number | undefined;
  kill(signal: NodeJS.Signals): boolean;
}

export interface CloneKillOptions {
  groupKill?: (pid: number, signal: NodeJS.Signals) => void;
  directKill?: (target: CloneKillTarget, signal: NodeJS.Signals) => boolean;
  sleep?: (ms: number) => Promise<void>;
  exited?: () => boolean;
  termGraceMs?: number;
}

/**
 * Escalate abort → SIGTERM → SIGKILL. Kills target the whole process group
 * (negative pid) so orphaned git-remote-https grandchildren stop too; falls
 * back to a direct kill when group-kill is unavailable (win32, ESRCH).
 * Returns the signals fired in order. Never throws: a gone child is success.
 */
export async function terminateCloneChild(
  target: CloneKillTarget,
  options: CloneKillOptions = {},
): Promise<readonly NodeJS.Signals[]> {
  const groupKill = options.groupKill ?? ((pid, signal) => process.kill(pid, signal));
  const directKill = options.directKill ?? ((child, signal) => child.kill(signal));
  const sleep = options.sleep ?? ((ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const exited = options.exited ?? (() => false);
  const grace = options.termGraceMs ?? CLONE_KILL_TERM_GRACE_MS;
  const fired: NodeJS.Signals[] = [];
  const fire = (signal: NodeJS.Signals): void => {
    fired.push(signal);
    if (target.pid !== undefined && process.platform !== 'win32') {
      try {
        groupKill(-target.pid, signal);
        return;
      } catch {
        // Group gone or denied: fall through to a direct kill.
      }
    }
    try {
      directKill(target, signal);
    } catch {
      // Child already gone.
    }
  };
  fire('SIGTERM');
  await sleep(grace);
  if (!exited()) fire('SIGKILL');
  return fired;
}

// ── Default runner (shell:false, detached group, timeout, abort) ──

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
      // Own process group: ceiling/abort escalation kills
      // git-remote-https grandchildren, not just the direct child.
      detached: process.platform !== 'win32',
    });
    let stdout = '';
    let stderr = '';
    let settled = false;
    let exited = false;
    const timer = setTimeout(
      () => killAndReject(new Error(`clone timed out after ${options.timeoutMs}ms`)),
      options.timeoutMs,
    );
    const cleanup = (): void => {
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', onAbort);
    };
    const settleReject = (error: Error): void => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    };
    const killAndReject = (error: Error): void => {
      if (settled) return;
      void terminateCloneChild(child, { exited: () => exited }).finally(() => settleReject(error));
    };
    const onAbort = (): void => killAndReject(new Error('Aborted'));
    if (options.signal?.aborted) onAbort();
    else options.signal?.addEventListener('abort', onAbort, { once: true });
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });
    child.on('error', (error: Error) => {
      exited = true;
      settleReject(error);
    });
    child.on('close', (code: number | null, signal: string | null) => {
      if (settled) return;
      settled = true;
      exited = true;
      cleanup();
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

function sanitizeCloneOutput(text: string, token: string | undefined): string {
  if (token === undefined || token.length === 0) return text;
  return text.split(token).join('[redacted]');
}

function sanitizeCloneResult(result: GithubCloneResult, token: string | undefined): GithubCloneResult {
  if (token === undefined || token.length === 0) return result;
  return {
    ...result,
    stdout: sanitizeCloneOutput(result.stdout, token),
    stderr: sanitizeCloneOutput(result.stderr, token),
  };
}

async function writeCredentialHelper(root: string, token: string | undefined): Promise<string> {
  const helper = join(root, 'askpass.sh');
  const quoted = token === undefined ? undefined : token.replace(/'/g, `'\\''`);
  // Dual-role helper: git credential-helper protocol on `get` (username= /
  // password= lines plus trailing blank line), bare token for GIT_ASKPASS.
  const body =
    quoted === undefined
      ? '#!/bin/sh\nexit 1\n'
      : `#!/bin/sh\nif [ "$1" = "get" ]; then\nprintf 'username=%s\\npassword=%s\\n\\n' 'x-access-token' '${quoted}'\nelse\nprintf '%s' '${quoted}'\nfi\n`;
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

/** Isolated env for the `gh` attempt: HOME and GH_CONFIG_DIR point at an
 * empty dir inside the clone root, so ambient ~/.config/gh/hosts.yml
 * credentials can never authenticate it; no GIT_ASKPASS and no credential
 * helper in argv (git owns the helper). Token env vars never reach any
 * child via the native allowlist; deleted explicitly here as defense. */
function childEnvForGh(
  parentEnv: Record<string, string | undefined>,
  emptyConfigDir: string,
): Record<string, string> {
  const env: Record<string, string> = {
    ...cloneEnvBase(parentEnv),
    HOME: emptyConfigDir,
    GH_CONFIG_DIR: emptyConfigDir,
  };
  delete env.GITHUB_TOKEN;
  delete env.GH_TOKEN;
  delete env.GIT_ASKPASS;
  return env;
}

// ── Filesystem scan under ceilings ──

const SNIFF_BYTES = 8192;

function isBinarySample(sample: Buffer): boolean {
  return sample.includes(0);
}

async function realpathWithinRoot(abs: string, workdir: string): Promise<boolean> {
  try {
    const [resolved, resolvedRoot] = await Promise.all([realpath(abs), realpath(workdir)]);
    return resolved === resolvedRoot || resolved.startsWith(`${resolvedRoot}${sep}`);
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

function pushWarning(state: CloneScanState, formatted: string): void {
  if (state.warnings.includes(formatted)) return;
  if (state.warnings.length >= state.policy.maxTreeEntries) return;
  state.warnings.push(formatted);
}

function warn(state: CloneScanState, message: string, rel: string): void {
  pushWarning(state, `${message}: ${rel.slice(0, 64)}`);
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
  const bytes = Buffer.byteLength(text, 'utf8');
  if (state.textBytes + bytes > state.policy.maxTextBytes) {
    pushWarning(state, 'text budget exhausted, remaining files metadata-only');
    state.metadataOnly.push(rel);
    return;
  }
  state.textBytes += bytes;
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

// ── Live repo-size enforcement (during the child run) ──

/** Bounded poll interval for live clone-size enforcement. No new deps. */
const CLONE_SIZE_POLL_MS = 250;

async function cloneRootSizeBytes(root: string): Promise<number> {
  let total = 0;
  const queue: string[] = [root];
  while (queue.length > 0) {
    const current = queue.pop() as string;
    let entries;
    try {
      entries = await readdir(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = join(current, entry.name);
      try {
        if (entry.isDirectory() && !entry.isSymbolicLink()) queue.push(full);
        else if (entry.isFile() || entry.isSymbolicLink()) total += (await lstat(full)).size;
      } catch {
        // Races with the live child: ignore and keep measuring.
      }
    }
  }
  return total;
}

function cloneCeilingError(policy: GithubClonePolicy): SocialError {
  return cloneError('upstream_error', `clone exceeds repo ceiling of ${policy.maxRepoBytes} bytes`);
}

/**
 * Run one clone child under a live repo-size ceiling. Polls the clone root
 * (including .git) on a bounded interval and aborts the child as soon as
 * the ceiling is exceeded; the abort escalates SIGTERM → SIGKILL against
 * the child's process group (see terminateCloneChild).
 * Residual overshoot window: up to one poll interval plus the directory-walk
 * time can elapse before the abort lands, plus the SIGTERM grace — a clone
 * can exceed the ceiling briefly. The post-clone scan stays as final
 * safeguard, so an overshooting clone still rejects before serving.
 * Caller abort wins if it arrived first: the caller's signal state is
 * checked before converting to a ceiling error (deterministic precedence).
 */
async function runCloneChild(
  run: GithubCloneRunner,
  command: string,
  argv: readonly string[],
  options: GithubCloneRunOptions,
  root: string,
  policy: GithubClonePolicy,
): Promise<GithubCloneResult> {
  const controller = new AbortController();
  const onCallerAbort = (): void => controller.abort();
  if (options.signal?.aborted) controller.abort();
  else options.signal?.addEventListener('abort', onCallerAbort, { once: true });
  let exceeded = false;
  let inFlight = false;
  const timer = setInterval(() => {
    if (inFlight || exceeded || controller.signal.aborted) return;
    inFlight = true;
    void cloneRootSizeBytes(root).then(
      (size) => {
        inFlight = false;
        if (size > policy.maxRepoBytes && !controller.signal.aborted) {
          exceeded = true;
          controller.abort();
        }
      },
      () => {
        inFlight = false;
      },
    );
  }, CLONE_SIZE_POLL_MS);
  try {
    const result = await run(command, argv, { ...options, signal: controller.signal });
    if (options.signal?.aborted) throw new Error('Aborted');
    if (exceeded) throw cloneCeilingError(policy);
    return result;
  } catch (error) {
    if (options.signal?.aborted) throw error;
    if (exceeded) throw cloneCeilingError(policy);
    throw error;
  } finally {
    clearInterval(timer);
    options.signal?.removeEventListener('abort', onCallerAbort);
  }
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
  validateCloneToken(token);
  const run = deps.runProcess ?? defaultGithubCloneRunner;
  const signal = execution?.signal;
  if (signal?.aborted) throw new Error('Aborted');

  const root = await acquireCloneRoot();
  const warnings: string[] = [];
  let failed = false;
  try {
    const workdir = join(root, 'work');
    const hooksDir = join(root, 'no-hooks');
    const ghHome = join(root, 'gh-home');
    await mkdir(hooksDir, { recursive: true, mode: 0o700 });
    await mkdir(ghHome, { recursive: true, mode: 0o700 });
    const helper = await writeCredentialHelper(root, token);
    const env = childEnvForClone(parentEnv, helper);
    // gh attempt is ambient-identity-free: empty HOME/GH_CONFIG_DIR inside
    // the clone root (never ~/.config/gh/hosts.yml), no credential helper,
    // no GIT_ASKPASS — it can only succeed anonymously or fail. Only git
    // owns the credential helper.
    const ghEnv = childEnvForGh(parentEnv, ghHome);
    const ghArgv = buildGithubGhCloneArgv({ owner: input.owner, repo: input.repo, ...(input.ref !== undefined ? { ref } : {}), destDir: workdir, emptyHooksDir: hooksDir });

    let ghAbsent = false;
    let cloned = false;
    try {
      // gh runs isolated (empty HOME/GH_CONFIG_DIR, no helper): it never
      // carries our token, so its auth-pattern failure must not arm
      // no-anonymous-retry. Fall back to git, which owns the helper.
      const ghResult = sanitizeCloneResult(
        await runCloneChild(run, ghArgv.command, ghArgv.argv, { env: ghEnv, cwd: root, timeoutMs: policy.cloneTimeoutMs, ...(signal !== undefined ? { signal } : {}) }, root, policy),
        token,
      );
      if (ghResult.code === 0) {
        cloned = true;
      } else {
        warnings.push(`gh clone failed (code ${ghResult.code}), falling back to git`);
      }
    } catch (error) {
      if (signal?.aborted) throw error;
      if (isMissingBinary(error)) {
        // Defer the notice: the REST-only warning belongs to the
        // both-absent/fallback path; on git success only the using-git
        // notice applies (informational, never partial).
        ghAbsent = true;
      } else {
        warnings.push('gh clone unavailable, falling back to git');
      }
    }

    if (!cloned) {
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
        gitResult = sanitizeCloneResult(
          await runCloneChild(run, gitArgv.command, gitArgv.argv, { env, cwd: root, timeoutMs: policy.cloneTimeoutMs, ...(signal !== undefined ? { signal } : {}) }, root, policy),
          token,
        );
      } catch (error) {
        if (signal?.aborted) throw error;
        if (isMissingBinary(error)) {
          if (ghAbsent) {
            throw cloneError('upstream_error', 'GitHub clone upstream_error: no gh or git binary available', {
              cause: { ghAbsent: true },
            });
          }
          throw cloneError('upstream_error', 'GitHub clone upstream_error: no git binary available');
        }
        throw cloneError('upstream_error', 'GitHub clone upstream_error: clone process failed');
      }
      if (gitResult.code !== 0) {
        // No-anonymous-retry applies only when the failed attempt actually
        // carried the token (git owns the credential helper).
        if (token !== undefined && isGithubCloneAuthFailure(gitResult.stderr, gitResult.code)) {
          throw cloneError('authentication_required', 'GitHub clone authentication_required: invalid or missing token');
        }
        throw cloneError('upstream_error', `GitHub clone upstream_error: clone failed with code ${gitResult.code}`);
      }
      if (ghAbsent) warnings.push(GITHUB_CLONE_GH_ABSENT_USING_GIT_NOTICE);
    }

    let scanned;
    try {
      scanned = await scanCloneTree(workdir, policy);
    } catch (error) {
      if (error instanceof SocialError) throw error;
      if (signal?.aborted) throw error;
      throw cloneError('upstream_error', `GitHub clone upstream_error: scan failed: ${error instanceof Error ? error.message : String(error)}`);
    }
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
  } catch (error) {
    failed = true;
    throw error;
  } finally {
    // Cleanup failure only propagates when no earlier error exists: it must
    // never replace the original clone error/SocialError code.
    try {
      await releaseCloneRoot(root);
    } catch (cleanupError) {
      if (!failed) throw cleanupError;
    }
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
    // The gh-absent using-git notice is informational (clone served fully),
    // so it never marks the page partial; real degradations still do.
    partial: payload.warnings.some((warning) => warning !== GITHUB_CLONE_GH_ABSENT_USING_GIT_NOTICE),
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
