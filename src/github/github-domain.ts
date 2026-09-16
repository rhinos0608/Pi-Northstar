// Stage 5 GitHub domain: thin REST v3 integrator behind github-contract.
//
// Owns all GitHub HTTP + normalization. native-tools.ts delegates here.
// Contract validates first (canonical actions, selectors, reject-on-out-of-range
// limits); legacy 'list_dir'/'code_search' reject as unsupported_action with no
// alias mapping. Every list/get path normalizes to contract entities, validates
// the page fail-closed, and returns a northstar envelope. No raw passthrough.
//
// Auth truthful: token reads GITHUB_TOKEN ?? GH_TOKEN; anonymous otherwise.
// HTTP errors never echo URL or body: 401→authentication_required,
// 403/429→rate_limited, 404→not_found, else upstream_error.
// Trending scrape failures degrade to an empty page with a warning.

import type { BackendCallResult } from '../backend.js';
import { fetchInit, isRedirectStatus, safeResponseText } from '../core/http.js';
import { AssetBudgetLedger } from '../assets/budget-ledger.js';
import { mayTransferPrivateGithubToVision, PRIVATE_GITHUB_VISION_TRANSFER_ENV_VAR } from '../media-vision/transfer-policy.js';
import { buildNorthstarResult, type NorthstarEntityV1 } from '../result-contract.js';
import { northstarTextResult } from '../core/tool-output.js';
import { SocialError } from '../social/social-contract.js';
import { createGithubCloneWorker, GITHUB_CLONE_BACKEND, type GithubCloneRunner } from './github-clone.js';
import { GITHUB_CLONE_GH_ABSENT_WARNING } from './github-clone-policy.js';
import {
  decodeGithubCursor,
  encodeGithubCursor,
  GITHUB_BACKEND_PREFERENCE,
  GITHUB_ENTITY_CONTENT_MAX,
  githubCursorFingerprint,
  githubPaginationSupported,
  validateGithubPage,
  validateGithubPath,
  validateGithubRequest,
  type GithubAction,
  type GithubEntityV1,
  type GithubPageV1,
  type GithubRequest,
} from './github-contract.js';

const BACKEND = 'github-api';
const API_BASE = 'https://api.github.com';
const USER_AGENT = 'pi-northstar';
const MULTI_FILE_MAX = 10;

export interface GithubDomainOptions {
  env?: Record<string, string | undefined>;
  signal?: AbortSignal;
  /** Test seam: overrides the clone child spawn. Production omits it. */
  cloneRunner?: GithubCloneRunner | undefined;
}

function githubError(
  code: 'invalid_request' | 'not_found' | 'authentication_required' | 'rate_limited' | 'upstream_error' | 'malformed_upstream' | 'cursor_invalid',
  message: string,
  options?: { cause?: unknown },
): SocialError {
  return new SocialError(code, message, {
    backend: BACKEND,
    ...(options?.cause !== undefined ? { cause: options.cause } : {}),
  });
}

const RETRY_AFTER_MIN = 1;
const RETRY_AFTER_MAX = 300;

/** Parse a Retry-After header (delay seconds or HTTP-date) to seconds,
 * clamped to [1, 300]. Returns undefined when absent/invalid. Never echoes
 * request material: output is a bare number. */
export function parseGithubRetryAfter(raw: string | null): number | undefined {
  if (raw === null) return undefined;
  const value = raw.trim();
  if (value.length === 0) return undefined;
  if (/^\d+$/.test(value)) {
    const seconds = Number(value);
    if (!Number.isSafeInteger(seconds)) return undefined;
    return Math.min(RETRY_AFTER_MAX, Math.max(RETRY_AFTER_MIN, seconds));
  }
  const at = Date.parse(value);
  if (Number.isNaN(at)) return undefined;
  const diff = Math.round((at - Date.now()) / 1000);
  if (!Number.isFinite(diff)) return undefined;
  return Math.min(RETRY_AFTER_MAX, Math.max(RETRY_AFTER_MIN, diff));
}

function optionalString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

// Plan E4 truncation-to-reject: upstream text over the per-entity byte cap
// rejects instead of silently slicing. UTF-8 byte accounting (multibyte
// text rejects earlier than its char count suggests). The message names the
// field and cap only — never the content, URL, or token.
function requireBoundedText(text: string, field: string): string {
  if (Buffer.byteLength(text, 'utf8') > GITHUB_ENTITY_CONTENT_MAX) rejectOversizeGithubContent(field);
  return text;
}

/** Oversize rejection naming field + cap only — never content, URL, or token. */
function rejectOversizeGithubContent(field: string): never {
  throw githubError('upstream_error', `GitHub ${field} exceeds maximum of ${GITHUB_ENTITY_CONTENT_MAX} bytes`);
}

/** Decoded-byte estimate from base64 length, before allocating the buffer. */
function base64EstimatedBytes(stripped: string): number {
  const padding = stripped.endsWith('==') ? 2 : stripped.endsWith('=') ? 1 : 0;
  return Math.floor((stripped.length * 3) / 4) - padding;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stringField(row: Record<string, unknown>, key: string): string | undefined {
  const value = row[key];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function numberField(row: Record<string, unknown>, key: string): number | undefined {
  const value = row[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function safePositiveIntField(row: Record<string, unknown>, key: string): number | undefined {
  const value = row[key];
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 1 ? value : undefined;
}

function labelNameFromRecord(entry: Record<string, unknown>): string | undefined {
  return typeof entry.name === 'string' && entry.name.length > 0 ? entry.name : undefined;
}

function labelNameOf(entry: unknown): string | undefined {
  if (typeof entry === 'string' && entry.length > 0) return entry;
  if (isRecord(entry)) return labelNameFromRecord(entry);
  return undefined;
}

function isAuthorScopedAction(action: string): boolean {
  return action === 'commits' || action === 'runs';
}

function isCursorMismatchError(error: unknown): boolean {
  return error instanceof SocialError && (error.code === 'cursor_mismatch' || error.code === 'cursor_invalid');
}

// GitHub REST Issues endpoints return pull requests too; callers must check
// the pull_request key (present as an object, even empty) to discriminate.
function isPullRequestRow(row: Record<string, unknown>): boolean {
  return 'pull_request' in row && isRecord(row.pull_request);
}

function loginOf(value: unknown): string | undefined {
  if (!isRecord(value)) return undefined;
  const login = value.login;
  return typeof login === 'string' && login.length > 0 ? login : undefined;
}

function labelNames(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const names = value.flatMap((entry) => {
    const name = labelNameOf(entry);
    return name !== undefined ? [name] : [];
  });
  return names.length > 0 ? names : undefined;
}

export function githubToken(env: Record<string, string | undefined>): string | undefined {
  const token = env.GITHUB_TOKEN ?? env.GH_TOKEN;
  return token !== undefined && token.length > 0 ? token : undefined;
}

interface Fetched {
  data: unknown;
  link: string | null;
}

function githubAuthHeaders(env: Record<string, string | undefined>): Record<string, string> {
  const headers: Record<string, string> = {
    Accept: 'application/vnd.github+json',
    'User-Agent': USER_AGENT,
  };
  const token = githubToken(env);
  if (token !== undefined) headers.Authorization = `Bearer ${token}`;
  return headers;
}

function throwForRateLimited(headers: Headers): never {
  // Single-attempt: no automatic retry loop. The Retry-After hint is
  // surfaced on the error cause as a bare clamped number for the caller.
  const retryAfter = parseGithubRetryAfter(headers.get('retry-after'));
  throw githubError('rate_limited', 'GitHub rate_limited: quota exhausted, retry later', {
    ...(retryAfter !== undefined ? { cause: { retryAfter } } : {}),
  });
}

function throwForGithubStatus(status: number, headers: Headers): never {
  // Plan E3 redirect reject: githubFetch uses manual redirects, so a 3xx
  // here means upstream tried to reroute us — never follow with credentials.
  if (isRedirectStatus(status)) {
    throw githubError('upstream_error', 'GitHub redirect rejected: credentials are never forwarded off the fixed host');
  }
  if (status === 401) throw githubError('authentication_required', 'GitHub authentication_required: invalid or missing token');
  if (status === 403 || status === 429) throwForRateLimited(headers);
  if (status === 404) throw githubError('not_found', 'GitHub not_found: resource does not exist');
  throw githubError('upstream_error', `GitHub upstream_error: request failed with status ${status}`);
}

function parseGithubBody(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw githubError('malformed_upstream', 'GitHub response was not valid JSON');
  }
}

async function githubFetch(url: string, env: Record<string, string | undefined>, signal?: AbortSignal): Promise<Fetched> {
  const headers = githubAuthHeaders(env);
  let response: Response;
  try {
    // Manual redirect handling (Plan E3): authenticated API responses must
    // never be followed — a redirect target would otherwise receive the
    // bearer token. Rejected below with a redacted label, never the URL.
    response = await fetch(url, fetchInit(headers, signal, undefined, 'manual'));
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') throw error;
    throw githubError('upstream_error', 'GitHub request failed before any response was received');
  }
  if (!response.ok) throwForGithubStatus(response.status, response.headers);
  // Redacted label instead of the URL: size-limit errors must not echo the URL.
  const text = await safeResponseText(response, BACKEND);
  return { data: parseGithubBody(text), link: response.headers.get('link') };
}

function repoUrl(owner: string, repo: string): string {
  return `${API_BASE}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;
}

export interface GithubCursorSelectors {
  author?: string;
  jobs?: boolean;
}

function fingerprintFor(request: GithubRequest, extra?: GithubCursorSelectors): string {
  return githubCursorFingerprint({
    action: request.action,
    ...(request.owner !== undefined ? { owner: request.owner } : {}),
    ...(request.repo !== undefined ? { repo: request.repo } : {}),
    limit: request.limit,
    ...(request.workflow !== undefined ? { workflow: request.workflow } : {}),
    ...(request.ref !== undefined ? { ref: request.ref } : {}),
    ...(request.status !== undefined ? { status: request.status } : {}),
    ...(request.number !== undefined ? { number: request.number } : {}),
    ...(extra?.author !== undefined ? { author: extra.author } : {}),
    ...(extra?.jobs === true ? { jobs: true as const } : {}),
  });
}

function pageNumber(request: GithubRequest, extra?: GithubCursorSelectors): number {
  if (request.cursor === undefined) return 1;
  let decoded: { state: Record<string, string | number | boolean> };
  try {
    decoded = decodeGithubCursor(request.cursor, {
      action: request.action,
      backend: BACKEND,
      fingerprint: fingerprintFor(request, extra),
    });
  } catch (error) {
    // Contract distinguishes malformed vs mismatched cursors; the domain
    // surfaces both as cursor_invalid per the Stage 5 contract.
    if (isCursorMismatchError(error)) {
      throw githubError('cursor_invalid', (error as SocialError).message);
    }
    throw error;
  }
  const page = decoded.state.page;
  return typeof page === 'number' && Number.isInteger(page) && page >= 1 ? page : 1;
}

function nextCursor(request: GithubRequest, link: string | null, page: number, extra?: GithubCursorSelectors): string | undefined {
  if (!githubPaginationSupported(request.action)) return undefined;
  if (link === null || !/rel="next"/.test(link)) return undefined;
  return encodeGithubCursor({
    action: request.action,
    backend: BACKEND,
    fingerprint: fingerprintFor(request, extra),
    state: { page: page + 1 },
  });
}

function checkPage(page: GithubPageV1): GithubPageV1 {
  const check = validateGithubPage(page);
  if (!check.ok || check.page === undefined) {
    throw githubError('malformed_upstream', `normalized page failed validation: ${check.issues.join('; ')}`);
  }
  return check.page;
}

// ── Normalizers (sparse rows, capped text, stable ids) ──

function normalizeRepo(row: Record<string, unknown>, readme?: string): GithubEntityV1 {
  const fullName = stringField(row, 'full_name') ?? '';
  const [owner = 'unknown', repo = 'unknown'] = fullName.split('/');
  const entity: GithubEntityV1 = {
    version: 1,
    kind: 'repo',
    id: `github:repo:${owner}/${repo}`,
    backend: BACKEND,
    url: stringField(row, 'html_url') ?? `https://github.com/${owner}/${repo}`,
  };
  const name = stringField(row, 'name');
  if (name !== undefined) entity.name = name;
  if (fullName.length > 0) entity.full_name = fullName;
  const description = stringField(row, 'description');
  if (description !== undefined) entity.description = requireBoundedText(description, 'repo description');
  const stars = numberField(row, 'stargazers_count');
  if (stars !== undefined) entity.stars = stars;
  const forks = numberField(row, 'forks_count') ?? numberField(row, 'forks');
  if (forks !== undefined) entity.forks = forks;
  const language = stringField(row, 'language');
  if (language !== undefined) entity.language = language;
  const branch = stringField(row, 'default_branch');
  if (branch !== undefined) entity.default_branch = branch;
  if (readme !== undefined) entity.readme = requireBoundedText(readme, 'repo readme');
  return entity;
}

interface FileContentInput {
  path: string;
  row: Record<string, unknown>;
  owner: string;
  repo: string;
  ref?: string | undefined;
}

/** Shared base64 text decoder for GitHub payloads (file content + repo readme).
 * Validates charset, applies the pre-decode byte gate before Buffer alloc,
 * re-checks post-decode length, and applies the NUL binary gate.
 * Returns undefined for invalid/binary payloads (caller keeps metadata only);
 * throws oversize (caller decides: file rejects, optional readme degrades). */
function decodeBase64GithubText(raw: string, field: string): string | undefined {
  const stripped = raw.replace(/\s/g, '');
  if (!/^[A-Za-z0-9+/=]*$/.test(stripped) || stripped.length === 0) return undefined;
  // Pre-decode byte gate (Plan E3): estimate decoded bytes from the
  // base64 length and reject before allocating the decoded buffer.
  if (base64EstimatedBytes(stripped) > GITHUB_ENTITY_CONTENT_MAX) rejectOversizeGithubContent(field);
  const bytes = Buffer.from(stripped, 'base64');
  if (bytes.length > GITHUB_ENTITY_CONTENT_MAX) rejectOversizeGithubContent(field);
  // Binary gate: a NUL byte means a binary payload — metadata only,
  // never decoded text.
  if (bytes.includes(0)) return undefined;
  return requireBoundedText(bytes.toString('utf8'), field);
}

function decodeFilePayload(row: Record<string, unknown>): { content: string; encoding?: string } | undefined {
  const content = stringField(row, 'content');
  if (content === undefined) return undefined;
  const encoding = stringField(row, 'encoding');
  if (encoding === 'base64') {
    // Binary or undecodable payloads omit content and keep metadata.
    const decoded = decodeBase64GithubText(content, 'file content');
    if (decoded === undefined) return undefined;
    return { content: decoded, encoding: 'utf8' };
  }
  return { content: requireBoundedText(content, 'file content'), ...(encoding !== undefined ? { encoding } : {}) };
}

function normalizeFileContent(input: FileContentInput): GithubEntityV1 {
  const { path, row, owner, repo, ref } = input;
  const entity: GithubEntityV1 = {
    version: 1,
    kind: 'file',
    id: `github:file:${owner}/${repo}@${ref ?? 'HEAD'}:${path}`,
    backend: BACKEND,
    path,
  };
  const url = stringField(row, 'html_url');
  if (url !== undefined) entity.url = url;
  const size = numberField(row, 'size');
  if (size !== undefined) entity.size = size;
  const decoded = decodeFilePayload(row);
  if (decoded !== undefined) {
    entity.content = decoded.content;
    if (decoded.encoding !== undefined) entity.encoding = decoded.encoding;
  }
  return entity;
}

function normalizeIssue(row: Record<string, unknown>, owner: string, repo: string): GithubEntityV1 {
  const number = numberField(row, 'number') ?? 0;
  const entity: GithubEntityV1 = {
    version: 1,
    kind: 'issue',
    id: `github:issue:${owner}/${repo}#${number}`,
    backend: BACKEND,
    number,
    title: stringField(row, 'title') ?? '(untitled)',
    state: stringField(row, 'state') ?? 'unknown',
  };
  const author = loginOf(row.user);
  if (author !== undefined) entity.author = author;
  const url = stringField(row, 'html_url');
  if (url !== undefined) entity.url = url;
  const body = stringField(row, 'body');
  if (body !== undefined) entity.body = requireBoundedText(body, 'issue body');
  const labels = labelNames(row.labels);
  if (labels !== undefined) entity.labels = labels;
  const created = stringField(row, 'created_at');
  if (created !== undefined) entity.created_at = created;
  return entity;
}

function normalizePull(row: Record<string, unknown>, owner: string, repo: string): GithubEntityV1 {
  const base = normalizeIssue(row, owner, repo);
  if (base.kind !== 'issue') throw new Error('unreachable pull base');
  return { ...base, kind: 'pull', id: `github:pull:${owner}/${repo}#${base.number}` };
}

function normalizeRelease(row: Record<string, unknown>, owner: string, repo: string): GithubEntityV1 {
  const tag = stringField(row, 'tag_name') ?? '(untagged)';
  const entity: GithubEntityV1 = {
    version: 1,
    kind: 'release',
    id: `github:release:${owner}/${repo}@${tag}`,
    backend: BACKEND,
    tag,
  };
  const name = stringField(row, 'name');
  if (name !== undefined) entity.name = name;
  const published = stringField(row, 'published_at');
  if (published !== undefined) entity.published_at = published;
  const url = stringField(row, 'html_url');
  if (url !== undefined) entity.url = url;
  const body = stringField(row, 'body');
  if (body !== undefined) entity.body = requireBoundedText(body, 'release body');
  return entity;
}

function normalizeCommit(row: Record<string, unknown>, owner: string, repo: string): GithubEntityV1 {
  const sha = (stringField(row, 'sha') ?? 'unknown').toLowerCase();
  const entity: GithubEntityV1 = {
    version: 1,
    kind: 'commit',
    id: `github:commit:${owner}/${repo}@${sha}`,
    backend: BACKEND,
    sha,
  };
  const inner = isRecord(row.commit) ? row.commit : undefined;
  const message = inner !== undefined ? stringField(inner, 'message') : undefined;
  if (message !== undefined) entity.message = requireBoundedText(message, 'commit message');
  const innerAuthor = inner !== undefined && isRecord(inner.author) ? stringField(inner.author, 'name') : undefined;
  const topAuthor = loginOf(row.author);
  if (topAuthor !== undefined) entity.author = topAuthor;
  else if (innerAuthor !== undefined) entity.author = innerAuthor;
  const date = inner !== undefined && isRecord(inner.author) ? stringField(inner.author, 'date') : undefined;
  if (date !== undefined) entity.date = date;
  const url = stringField(row, 'html_url');
  if (url !== undefined) entity.url = url;
  return entity;
}

function normalizeWorkflow(row: Record<string, unknown>, owner: string, repo: string): GithubEntityV1 | null {
  const workflowId = safePositiveIntField(row, 'id');
  if (workflowId === undefined) return null;
  const entity: GithubEntityV1 = {
    version: 1,
    kind: 'workflow',
    id: `github:workflow:${owner}/${repo}#${workflowId}`,
    backend: BACKEND,
    workflow_id: workflowId,
  };
  const name = stringField(row, 'name');
  if (name !== undefined) entity.name = name;
  const path = stringField(row, 'path');
  if (path !== undefined) entity.path = path;
  const state = stringField(row, 'state');
  if (state !== undefined) entity.state = state;
  const url = stringField(row, 'html_url');
  if (url !== undefined) entity.url = url;
  const badgeUrl = stringField(row, 'badge_url');
  if (badgeUrl !== undefined) entity.badge_url = badgeUrl;
  return entity;
}

function normalizeWorkflowRun(row: Record<string, unknown>, owner: string, repo: string): GithubEntityV1 | null {
  const runId = safePositiveIntField(row, 'id');
  if (runId === undefined) return null;
  const entity: GithubEntityV1 = {
    version: 1,
    kind: 'workflow_run',
    id: `github:workflow_run:${owner}/${repo}@${runId}`,
    backend: BACKEND,
    run_id: runId,
  };
  const runNumber = safePositiveIntField(row, 'run_number');
  if (runNumber !== undefined) entity.run_number = runNumber;
  const name = stringField(row, 'name') ?? stringField(row, 'display_title');
  if (name !== undefined) entity.name = name;
  const status = stringField(row, 'status');
  if (status !== undefined) entity.status = status;
  const conclusion = stringField(row, 'conclusion');
  if (conclusion !== undefined) entity.conclusion = conclusion;
  const headBranch = stringField(row, 'head_branch');
  if (headBranch !== undefined) entity.head_branch = headBranch;
  const headSha = stringField(row, 'head_sha');
  if (headSha !== undefined) entity.head_sha = headSha;
  const event = stringField(row, 'event');
  if (event !== undefined) entity.event = event;
  const url = stringField(row, 'html_url');
  if (url !== undefined) entity.url = url;
  const createdAt = stringField(row, 'created_at');
  if (createdAt !== undefined) entity.created_at = createdAt;
  const actor = loginOf(row.actor);
  if (actor !== undefined) entity.actor = actor;
  return entity;
}

function normalizeWorkflowJob(row: Record<string, unknown>, owner: string, repo: string, runId: number): GithubEntityV1 | null {
  const jobId = safePositiveIntField(row, 'id');
  if (jobId === undefined) return null;
  const entity: GithubEntityV1 = {
    version: 1,
    kind: 'workflow_job',
    id: `github:workflow_job:${owner}/${repo}@${jobId}`,
    backend: BACKEND,
    job_id: jobId,
    run_id: runId,
    name: stringField(row, 'name') ?? '(unnamed job)',
  };
  const status = stringField(row, 'status');
  if (status !== undefined) entity.status = status;
  const conclusion = stringField(row, 'conclusion');
  if (conclusion !== undefined) entity.conclusion = conclusion;
  const startedAt = stringField(row, 'started_at');
  if (startedAt !== undefined) entity.started_at = startedAt;
  const completedAt = stringField(row, 'completed_at');
  if (completedAt !== undefined) entity.completed_at = completedAt;
  const url = stringField(row, 'html_url');
  if (url !== undefined) entity.url = url;
  return entity;
}

function normalizeCodeItem(row: Record<string, unknown>): GithubEntityV1 {
  const repository = isRecord(row.repository) ? stringField(row.repository, 'full_name') : undefined;
  const path = stringField(row, 'path') ?? stringField(row, 'name') ?? 'unknown';
  const entity: GithubEntityV1 = {
    version: 1,
    kind: 'search_result',
    id: `github:code:${repository ?? 'unknown'}:${path}`,
    backend: BACKEND,
    url: stringField(row, 'html_url') ?? 'https://github.com/',
  };
  entity.path = path;
  if (repository !== undefined) entity.repository = repository;
  const name = stringField(row, 'name');
  if (name !== undefined) entity.title = name;
  return entity;
}

// ── Backend routing + cross-plan gates (Plan E3/E4) ──
// Backend preference per action lives in GITHUB_BACKEND_PREFERENCE
// (github-contract.ts): repo/tree clone-first with REST fallback, blob/file
// REST-first. The 'github-clone' executor is owned by github-clone.ts (W-E1)
// behind the GithubBackendPlan seam; until it registers, the domain filters
// it as unavailable and serves REST.

/** Clone-executor availability. The W-E1 executor is registered
 * (github-clone.ts lands createGithubCloneWorker); binary-level readiness
 * (gh/git present) resolves at execution time with REST fallback. */
export function isGithubCloneBackendAvailable(): boolean {
  return typeof createGithubCloneWorker === 'function';
}

/**
 * Ordered backend chain for an action, filtered by availability.
 * `available` is injectable so tests can mock the W-E1 seam without
 * importing the clone module. Unknown names are dropped, never executed.
 */
export function resolveGithubBackendChain(action: GithubAction, available: readonly string[] = [BACKEND]): string[] {
  const preference = GITHUB_BACKEND_PREFERENCE[action] ?? [BACKEND];
  const rank = new Map(preference.map((backend, index) => [backend, index]));
  return available
    .filter((backend) => rank.has(backend))
    .sort((a, b) => rank.get(a)! - rank.get(b)!);
}

/**
 * Serve repo/tree through the clone executor when the backend chain selects
 * it. Throws when the executor is unavailable or fails: the caller falls back
 * to REST per the defined fallback policy. Abort always propagates.
 */
/** True only for the double-absent path: gh AND git missing (cause flag
 * set by the clone backend). Scopes GITHUB_CLONE_GH_ABSENT_WARNING. */
function isCloneDoubleAbsent(error: unknown): boolean {
  if (!(error instanceof SocialError) || error.code !== 'upstream_error') return false;
  const cause = (error as unknown as { cause?: unknown }).cause;
  return typeof cause === 'object' && cause !== null && (cause as { ghAbsent?: unknown }).ghAbsent === true;
}

async function serveGithubCloneBackend(
  request: GithubRequest,
  env: Record<string, string | undefined>,
  signal?: AbortSignal,
  runProcess?: GithubCloneRunner | undefined,
): Promise<{ page: GithubPageV1; degraded: boolean }> {
  const worker = createGithubCloneWorker({
    parentEnv: env,
    ...(runProcess !== undefined ? { runProcess } : {}),
  });
  const plans = await worker.plans(request, { ...(signal !== undefined ? { signal } : {}) });
  const plan = plans.find((entry) => entry.backend === GITHUB_CLONE_BACKEND);
  if (plan === undefined) throw githubError('upstream_error', 'github-clone backend unavailable, using REST fallback');
  const payload = await plan.execute(signal);
  return { page: worker.normalize(request, plan, payload), degraded: false };
}

/**
 * Cross-plan gate (E4): a private-capable clone acquisition must not flow
 * to cloud vision without the Plan D operator opt-in
 * (PI_VISION_PRIVATE_GITHUB_TRANSFER=1). Throws authentication_required
 * naming the env var — never a secret, URL, or body.
 */
export function assertPrivateGithubVisionTransfer(env: Record<string, string | undefined>): void {
  if (!mayTransferPrivateGithubToVision(env as NodeJS.ProcessEnv)) {
    throw githubError(
      'authentication_required',
      `GitHub private transfer denied: set ${PRIVATE_GITHUB_VISION_TRANSFER_ENV_VAR}=1 to allow private GitHub content in cloud vision`,
    );
  }
}

/**
 * Cross-plan gate (E4): clone acquisition reserves against the Plan B
 * per-fetch aggregate ledger (512MiB default). Exhaustion maps to
 * upstream_error without echoing request material; the BudgetLedgerError
 * rides as cause for operator diagnosis.
 */
export function reserveGithubAcquisitionBudget(ledger: AssetBudgetLedger, bytes: number): void {
  try {
    ledger.reserve(bytes);
  } catch (error) {
    throw githubError('upstream_error', 'GitHub aggregate budget exceeded: acquisition would exceed the 512MiB fetch budget', {
      cause: error,
    });
  }
}

// ── Action handlers ──

async function handleRepo(request: GithubRequest, args: Record<string, unknown>, env: Record<string, string | undefined>, signal?: AbortSignal): Promise<{ page: GithubPageV1; degraded: boolean }> {
  const owner = request.owner!;
  const repo = request.repo!;
  const { data } = await githubFetch(repoUrl(owner, repo), env, signal);
  if (!isRecord(data)) throw githubError('malformed_upstream', 'GitHub repo response was not an object');
  let readme: string | undefined;
  if (args.includeReadme !== false) {
    try {
      const raw = await githubFetch(`${repoUrl(owner, repo)}/readme`, env, signal);
      if (isRecord(raw.data)) {
        const content = stringField(raw.data, 'content');
        if (content !== undefined && stringField(raw.data, 'encoding') === 'base64') {
          // Shared base64 gate (Plan E3): pre-decode estimate, charset
          // validation, NUL binary gate. Oversize rejects inside and
          // degrades to absent below: optional enrichment omits rather
          // than truncates. Invalid/binary decodes to undefined (absent).
          const decoded = decodeBase64GithubText(content, 'repo readme');
          if (decoded !== undefined) readme = decoded;
        }
      }
    } catch (error) {
      // Abort is caller intent: re-throw, degrade only ordinary README failures.
      if (error instanceof Error && error.name === 'AbortError') throw error;
      if (signal?.aborted) throw error;
      readme = undefined;
    }
  }
  const entity = normalizeRepo(data, readme);
  const page = checkPage({
    entities: [entity],
    pagination: { supported: false, limit: request.limit, returned: 1, hasMore: false },
    partial: false,
    warnings: [],
  });
  return { page, degraded: false };
}

async function fetchFileEntity(path: string, request: GithubRequest, env: Record<string, string | undefined>, signal?: AbortSignal): Promise<GithubEntityV1[]> {
  const owner = request.owner!;
  const repo = request.repo!;
  const url = new URL(`${repoUrl(owner, repo)}/contents/${path.split('/').map(encodeURIComponent).join('/')}`);
  if (request.ref !== undefined) url.searchParams.set('ref', request.ref);
  const { data } = await githubFetch(url.href, env, signal);
  if (Array.isArray(data)) {
    // Directory listing through the file action: normalize rows as tree entries.
    const entries = data.flatMap((entry) => {
      if (!isRecord(entry)) return [];
      const entryPath = stringField(entry, 'path') ?? stringField(entry, 'name');
      if (entryPath === undefined) return [];
      const row: { path: string; type?: string; sha?: string } = { path: entryPath };
      const type = stringField(entry, 'type');
      if (type !== undefined) row.type = type;
      const sha = stringField(entry, 'sha');
      if (sha !== undefined && /^[0-9a-f]{7,40}$/i.test(sha)) row.sha = sha.toLowerCase();
      return [row];
    });
    const tree: GithubEntityV1 = {
      version: 1,
      kind: 'tree',
      id: `github:tree:${owner}/${repo}@${request.ref ?? 'HEAD'}:${path}`,
      backend: BACKEND,
      entries: entries.slice(0, request.limit),
    };
    return [tree];
  }
  if (!isRecord(data)) throw githubError('malformed_upstream', 'GitHub file response was not an object');
  return [normalizeFileContent({ path, row: data, owner, repo, ...(request.ref !== undefined ? { ref: request.ref } : {}) })];
}

async function handleFile(request: GithubRequest, paths: string[], env: Record<string, string | undefined>, signal?: AbortSignal): Promise<{ page: GithubPageV1; degraded: boolean }> {
  const entities: GithubEntityV1[] = [];
  for (const path of paths.length > 0 ? paths : [request.path ?? '']) {
    if (path.length === 0) throw githubError('invalid_request', 'path must be a non-empty string');
    entities.push(...await fetchFileEntity(path, request, env, signal));
  }
  const sliced = entities.slice(0, request.limit);
  const page = checkPage({
    entities: sliced,
    pagination: { supported: false, limit: request.limit, returned: sliced.length, hasMore: false },
    partial: false,
    warnings: [],
  });
  return { page, degraded: false };
}

async function handleTree(request: GithubRequest, args: Record<string, unknown>, env: Record<string, string | undefined>, signal?: AbortSignal): Promise<{ page: GithubPageV1; degraded: boolean }> {
  const owner = request.owner!;
  const repo = request.repo!;
  const ref = request.ref ?? 'HEAD';
  const url = new URL(`${repoUrl(owner, repo)}/git/trees/${encodeURIComponent(ref)}`);
  if (args.recursive === true) url.searchParams.set('recursive', '1');
  const { data } = await githubFetch(url.href, env, signal);
  if (!isRecord(data) || !Array.isArray(data.tree)) throw githubError('malformed_upstream', 'GitHub tree response was not an object');
  const warnings: string[] = [];
  if (data.truncated === true) warnings.push('tree is truncated upstream');
  const entries = (data.tree as unknown[]).flatMap((entry) => {
    if (!isRecord(entry)) return [];
    const path = stringField(entry, 'path');
    if (path === undefined) return [];
    const row: { path: string; type?: string; sha?: string } = { path };
    const type = stringField(entry, 'type');
    if (type !== undefined) row.type = type;
    const sha = stringField(entry, 'sha');
    if (sha !== undefined && /^[0-9a-f]{7,40}$/i.test(sha)) row.sha = sha.toLowerCase();
    return [row];
  }).slice(0, request.limit);
  const page = checkPage({
    entities: [{
      version: 1,
      kind: 'tree',
      id: `github:tree:${owner}/${repo}@${ref}`,
      backend: BACKEND,
      entries,
    }],
    pagination: { supported: false, limit: request.limit, returned: 1, hasMore: false },
    partial: warnings.length > 0,
    warnings,
  });
  return { page, degraded: false };
}

function searchUrl(base: string, query: string, limit: number, page: number): string {
  const url = new URL(base);
  url.searchParams.set('q', query);
  url.searchParams.set('per_page', String(limit));
  url.searchParams.set('page', String(page));
  return url.href;
}

async function handleSearch(request: GithubRequest, env: Record<string, string | undefined>, signal?: AbortSignal): Promise<{ page: GithubPageV1; degraded: boolean }> {
  const pageNum = pageNumber(request);
  let q = request.query!;
  if (request.owner !== undefined && request.repo !== undefined) q += ` repo:${request.owner}/${request.repo}`;
  if (request.language !== undefined) q += ` language:${request.language}`;
  const { rows, link } = await fetchKeyedList({ url: searchUrl(`${API_BASE}/search/code`, q, request.limit, pageNum), key: 'items', env, signal, message: 'GitHub search response was not an object' });
  const entities = rows.flatMap((item): GithubEntityV1[] => {
    if (!isRecord(item)) return [];
    try {
      return [normalizeCodeItem(item)];
    } catch {
      return [];
    }
  }).slice(0, request.limit);
  return pagedListResult({ request, entities, link, pageNum });
}

function normalizeListEntities(
  items: unknown[],
  normalize: (row: Record<string, unknown>) => GithubEntityV1 | null,
  limit: number,
): GithubEntityV1[] {
  return items.flatMap((item): GithubEntityV1[] => {
    if (!isRecord(item)) return [];
    const entity = normalize(item);
    return entity === null ? [] : [entity];
  }).slice(0, limit);
}

async function fetchRecord(
  url: string,
  env: Record<string, string | undefined>,
  signal: AbortSignal | undefined,
  message: string,
): Promise<Record<string, unknown>> {
  const { data } = await githubFetch(url, env, signal);
  if (!isRecord(data)) throw githubError('malformed_upstream', message);
  return data;
}

async function fetchList(
  url: string,
  env: Record<string, string | undefined>,
  signal: AbortSignal | undefined,
  message: string,
): Promise<{ rows: unknown[]; link: string | null }> {
  const { data, link } = await githubFetch(url, env, signal);
  if (!Array.isArray(data)) throw githubError('malformed_upstream', message);
  return { rows: data, link };
}

function keyedRows(data: Record<string, unknown>, key: string, message: string): unknown[] {
  const rows = data[key];
  if (!Array.isArray(rows)) throw githubError('malformed_upstream', message);
  return rows;
}

interface FetchInput {
  url: string;
  env: Record<string, string | undefined>;
  signal: AbortSignal | undefined;
  message: string;
}

interface KeyedFetchInput extends FetchInput {
  key: string;
}

interface PagedResultInput {
  request: GithubRequest;
  entities: GithubEntityV1[];
  link: string | null;
  pageNum: number;
  warnings?: string[];
  selectors?: GithubCursorSelectors | undefined;
}

async function fetchKeyedList(input: KeyedFetchInput): Promise<{ rows: unknown[]; link: string | null }> {
  const { url, key, env, signal, message } = input;
  const { data, link } = await githubFetch(url, env, signal);
  if (!isRecord(data)) throw githubError('malformed_upstream', message);
  return { rows: keyedRows(data, key, message), link };
}

function singleEntityResult(request: GithubRequest, entities: GithubEntityV1[], supported = true, warnings: string[] = []): { page: GithubPageV1; degraded: boolean } {
  const page = checkPage({
    entities,
    pagination: { supported, limit: request.limit, returned: entities.length, hasMore: false },
    partial: warnings.length > 0,
    warnings,
  });
  return { page, degraded: false };
}

function pagedListResult(input: PagedResultInput): { page: GithubPageV1; degraded: boolean } {
  const { request, entities, link, pageNum, warnings = [], selectors } = input;
  const cursor = nextCursor(request, link, pageNum, selectors);
  const page = checkPage({
    entities,
    pagination: {
      supported: true,
      limit: request.limit,
      returned: entities.length,
      hasMore: cursor !== undefined,
      ...(cursor !== undefined ? { nextCursor: cursor } : {}),
    },
    partial: warnings.length > 0,
    warnings,
  });
  return { page, degraded: false };
}

async function handleSearchRepos(request: GithubRequest, env: Record<string, string | undefined>, signal?: AbortSignal): Promise<{ page: GithubPageV1; degraded: boolean }> {
  const pageNum = pageNumber(request);
  let q = request.query!;
  if (request.language !== undefined) q += ` language:${request.language}`;
  const { rows, link } = await fetchKeyedList({ url: searchUrl(`${API_BASE}/search/repositories`, q, request.limit, pageNum), key: 'items', env, signal, message: 'GitHub repository search response was not an object' });
  const entities = normalizeListEntities(rows, normalizeRepo, request.limit);
  return pagedListResult({ request, entities, link, pageNum });
}

function isJobsForRunRequest(args: Record<string, unknown>, request: GithubRequest): boolean {
  return args.jobs === true && request.number === undefined;
}

function isPullFilesRequest(args: Record<string, unknown>, action: string): boolean {
  return action === 'pulls' && args.files === true;
}

/**
 * Top-level comment threads for single issue/pull fetches (D2 v1). One
 * bounded REST call per fetch: per_page=50, first page only, no cursor
 * follow-up. The issue-comments endpoint serves pull conversation comments
 * too; review-inline comments, checks, changed-files, and commits rendering
 * stay deferred. Errors are fixed safe strings (never URL/body echo); a
 * failed comments call degrades to a warning while the entity text stands.
 */
export const GITHUB_ISSUE_COMMENTS_MAX = 50;
/** Per-comment excerpt bound inside the appended section. */
export const GITHUB_ISSUE_COMMENT_CHARS = 700;

interface TopIssueComment {
  author: string;
  body: string;
}

async function fetchTopIssueComments(
  owner: string,
  repo: string,
  number: number,
  env: Record<string, string | undefined>,
  signal: AbortSignal | undefined,
): Promise<TopIssueComment[]> {
  const url = new URL(`${repoUrl(owner, repo)}/issues/${number}/comments`);
  url.searchParams.set('per_page', String(GITHUB_ISSUE_COMMENTS_MAX));
  const { rows } = await fetchList(url.href, env, signal, 'GitHub comments response was not a list');
  return rows.flatMap((item): TopIssueComment[] => {
    if (!isRecord(item)) return [];
    const body = stringField(item, 'body');
    if (body === undefined || body.trim().length === 0) return [];
    return [{ author: loginOf(item.user) ?? 'unknown', body }];
  }).slice(0, GITHUB_ISSUE_COMMENTS_MAX);
}

/** UTF-8 byte-bound slice that never splits a code point. */
function sliceUtf8Bytes(text: string, maxBytes: number): string {
  const bytes = Buffer.from(text, 'utf8');
  if (bytes.length <= maxBytes) return text;
  let end = maxBytes;
  while (end > 0 && (bytes[end]! & 0xc0) === 0x80) end -= 1;
  return bytes.subarray(0, end).toString('utf8');
}

/**
 * Append the capped top-level comment section to an issue/pull entity body.
 * The entity contract gains no field: rendering, snippets, and details flow
 * through the existing body text. The section fits the remaining entity byte
 * budget (truncate with marker, omit with warning when the body is at cap).
 */
function appendTopCommentsSection(
  body: string | undefined,
  comments: TopIssueComment[],
  total: number | undefined,
): { body: string | undefined; capped: boolean } {
  if (comments.length === 0) return { body, capped: false };
  const shown = total ?? comments.length;
  const lines = comments.map((comment) => `- @${comment.author}: ${[...comment.body].slice(0, GITHUB_ISSUE_COMMENT_CHARS).join('')}`);
  let section = `\n\nTop comments (showing ${comments.length} of ${shown}):\n${lines.join('\n')}`;
  let capped = shown > comments.length;
  if (capped) section += `\n[comment list capped at ${GITHUB_ISSUE_COMMENTS_MAX}]`;
  const base = body ?? '';
  const remaining = GITHUB_ENTITY_CONTENT_MAX - Buffer.byteLength(base, 'utf8');
  if (remaining <= 0) return { body, capped: true };
  if (Buffer.byteLength(section, 'utf8') > remaining) {
    const truncatedMarker = ' [comments truncated at content cap]';
    const markerBytes = Buffer.byteLength(truncatedMarker, 'utf8');
    const budget = remaining - markerBytes;
    section = budget <= 0
      ? sliceUtf8Bytes(truncatedMarker, remaining)
      : `${sliceUtf8Bytes(section, budget)}${truncatedMarker}`;
    capped = true;
  }
  return { body: `${base}${section}`, capped };
}

function commentsFailureWarning(error: unknown): string {
  const code = error instanceof SocialError ? error.code : 'upstream_error';
  return `top comments unavailable (${code})`;
}

/**
 * Fetch top-level comments for a single issue/pull and append them to the
 * entity body. Never throws: comments failure degrades to a warning while
 * the entity text stands. Abort propagates (caller intent, not degradation).
 */
async function attachTopIssueComments(
  entity: GithubEntityV1,
  owner: string,
  repo: string,
  number: number,
  row: Record<string, unknown>,
  env: Record<string, string | undefined>,
  signal: AbortSignal | undefined,
): Promise<{ warnings: string[] }> {
  if (entity.kind !== 'issue' && entity.kind !== 'pull') return { warnings: [] };
  let comments: TopIssueComment[];
  try {
    comments = await fetchTopIssueComments(owner, repo, number, env, signal);
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') throw error;
    if (signal?.aborted) throw error;
    return { warnings: [commentsFailureWarning(error)] };
  }
  const total = numberField(row, 'comments');
  const appended = appendTopCommentsSection(entity.body, comments, total);
  if (appended.body !== undefined) entity.body = appended.body;
  const warnings: string[] = [];
  if (appended.capped) warnings.push(`top comments capped at ${GITHUB_ISSUE_COMMENTS_MAX}`);
  return { warnings };
}

async function handleIssues(request: GithubRequest, env: Record<string, string | undefined>, signal?: AbortSignal): Promise<{ page: GithubPageV1; degraded: boolean }> {
  const owner = request.owner!;
  const repo = request.repo!;
  if (request.number !== undefined) {
    const data = await fetchRecord(`${repoUrl(owner, repo)}/issues/${request.number}`, env, signal, 'GitHub issue response was not an object');
    if (isPullRequestRow(data)) {
      throw githubError('invalid_request', `number ${request.number} is a pull request, use pulls action`);
    }
    const entity = normalizeIssue(data, owner, repo);
    const comments = await attachTopIssueComments(entity, owner, repo, request.number, data, env, signal);
    return singleEntityResult(request, [entity], true, comments.warnings);
  }
  const pageNum = pageNumber(request);
  const url = new URL(`${repoUrl(owner, repo)}/issues`);
  url.searchParams.set('state', request.state ?? 'open');
  if (request.labels !== undefined) url.searchParams.set('labels', request.labels.join(','));
  url.searchParams.set('per_page', String(request.limit));
  url.searchParams.set('page', String(pageNum));
  const { rows, link } = await fetchList(url.href, env, signal, 'GitHub issues response was not a list');
  let excluded = 0;
  const entities = rows.flatMap((item): GithubEntityV1[] => {
    if (!isRecord(item)) return [];
    if (isPullRequestRow(item)) {
      excluded += 1;
      return [];
    }
    return [normalizeIssue(item, owner, repo)];
  }).slice(0, request.limit);
  const warnings: string[] = excluded > 0 ? [`${excluded} pull request${excluded === 1 ? '' : 's'} excluded from issues list`] : [];
  return pagedListResult({ request, entities, link, pageNum, warnings });
}

async function handlePulls(request: GithubRequest, args: Record<string, unknown>, env: Record<string, string | undefined>, signal?: AbortSignal): Promise<{ page: GithubPageV1; degraded: boolean }> {
  const owner = request.owner!;
  const repo = request.repo!;
  if (request.number !== undefined && isPullFilesRequest(args, request.action)) {
    const { rows } = await fetchList(`${repoUrl(owner, repo)}/pulls/${request.number}/files`, env, signal, 'GitHub pull files response was not a list');
    const entities = rows.flatMap((item): GithubEntityV1[] => {
      if (!isRecord(item)) return [];
      const path = stringField(item, 'filename');
      if (path === undefined) return [];
      const entity: GithubEntityV1 = {
        version: 1,
        kind: 'file',
        id: `github:pull-file:${owner}/${repo}#${request.number}:${path}`,
        backend: BACKEND,
        path,
      };
      const patch = stringField(item, 'patch');
      if (patch !== undefined) entity.content = requireBoundedText(patch, 'pull patch');
      return [entity];
    }).slice(0, request.limit);
    return singleEntityResult(request, entities);
  }
  if (request.number !== undefined) {
    const data = await fetchRecord(`${repoUrl(owner, repo)}/pulls/${request.number}`, env, signal, 'GitHub pull response was not an object');
    const entity = normalizePull(data, owner, repo);
    const comments = await attachTopIssueComments(entity, owner, repo, request.number, data, env, signal);
    return singleEntityResult(request, [entity], true, comments.warnings);
  }
  const pageNum = pageNumber(request);
  const url = new URL(`${repoUrl(owner, repo)}/pulls`);
  url.searchParams.set('state', request.state ?? 'open');
  url.searchParams.set('per_page', String(request.limit));
  url.searchParams.set('page', String(pageNum));
  const { rows, link } = await fetchList(url.href, env, signal, 'GitHub pulls response was not a list');
  const entities = normalizeListEntities(rows, (row) => normalizePull(row, owner, repo), request.limit);
  return pagedListResult({ request, entities, link, pageNum });
}

async function handleReleases(request: GithubRequest, args: Record<string, unknown>, env: Record<string, string | undefined>, signal?: AbortSignal): Promise<{ page: GithubPageV1; degraded: boolean }> {
  const owner = request.owner!;
  const repo = request.repo!;
  if (request.tag !== undefined) {
    const data = await fetchRecord(`${repoUrl(owner, repo)}/releases/tags/${encodeURIComponent(request.tag)}`, env, signal, 'GitHub release response was not an object');
    return singleEntityResult(request, [normalizeRelease(data, owner, repo)]);
  }
  if (args.latest === true) {
    const data = await fetchRecord(`${repoUrl(owner, repo)}/releases/latest`, env, signal, 'GitHub release response was not an object');
    return singleEntityResult(request, [normalizeRelease(data, owner, repo)]);
  }
  const pageNum = pageNumber(request);
  const url = new URL(`${repoUrl(owner, repo)}/releases`);
  url.searchParams.set('per_page', String(request.limit));
  url.searchParams.set('page', String(pageNum));
  const { rows, link } = await fetchList(url.href, env, signal, 'GitHub releases response was not a list');
  const entities = normalizeListEntities(rows, (row) => normalizeRelease(row, owner, repo), request.limit);
  return pagedListResult({ request, entities, link, pageNum });
}

interface RepoScope {
  owner: string;
  repo: string;
}

interface CommitsQuery {
  request: GithubRequest;
  author: string | undefined;
  pageNum: number;
}

interface FetchIo {
  env: Record<string, string | undefined>;
  signal: AbortSignal | undefined;
}

function buildCommitsUrl(scope: RepoScope, query: CommitsQuery): string {
  const { owner, repo } = scope;
  const { request, author, pageNum } = query;
  const url = new URL(`${repoUrl(owner, repo)}/commits`);
  if (request.path !== undefined) url.searchParams.set('path', request.path);
  if (author !== undefined) url.searchParams.set('author', author);
  if (request.since !== undefined) url.searchParams.set('since', request.since);
  if (request.ref !== undefined) url.searchParams.set('sha', request.ref);
  url.searchParams.set('per_page', String(request.limit));
  url.searchParams.set('page', String(pageNum));
  return url.href;
}

async function fetchCommitsList(scope: RepoScope, query: CommitsQuery, io: FetchIo): Promise<{ entities: GithubEntityV1[]; link: string | null }> {
  const { rows, link } = await fetchList(buildCommitsUrl(scope, query), io.env, io.signal, 'GitHub commits response was not a list');
  return { entities: normalizeListEntities(rows, (row) => normalizeCommit(row, scope.owner, scope.repo), query.request.limit), link };
}

async function handleCommits(request: GithubRequest, args: Record<string, unknown>, env: Record<string, string | undefined>, signal?: AbortSignal): Promise<{ page: GithubPageV1; degraded: boolean }> {
  const owner = request.owner!;
  const repo = request.repo!;
  if (request.sha !== undefined) {
    const data = await fetchRecord(`${repoUrl(owner, repo)}/commits/${request.sha}`, env, signal, 'GitHub commit response was not an object');
    return singleEntityResult(request, [normalizeCommit(data, owner, repo)]);
  }
  const author = optionalString(args.author);
  const commitSelectors: GithubCursorSelectors | undefined = author !== undefined ? { author } : undefined;
  const pageNum = pageNumber(request, commitSelectors);
  const { entities, link } = await fetchCommitsList({ owner, repo }, { request, author, pageNum }, { env, signal });
  const cursor = nextCursor(request, link, pageNum, commitSelectors);
  const page = checkPage({
    entities,
    pagination: {
      supported: true,
      limit: request.limit,
      returned: entities.length,
      hasMore: cursor !== undefined,
      ...(cursor !== undefined ? { nextCursor: cursor } : {}),
    },
    partial: false,
    warnings: [],
  });
  return { page, degraded: false };
}

async function handleTrending(request: GithubRequest, signal?: AbortSignal): Promise<{ page: GithubPageV1; degraded: boolean }> {
  const since = request.since ?? 'daily';
  try {
    const headers: Record<string, string> = { 'User-Agent': USER_AGENT };
    const response = await fetch(`https://github.com/trending?since=${encodeURIComponent(since)}`, fetchInit(headers, signal, undefined, 'follow'));
    // Follow-intentional: unauthenticated scrape, no bearer/cookie rides, so
    // redirect-following is safe here (unlike credentialed githubFetch).
    if (!response.ok) throw new Error(`trending status ${response.status}`);
    const html = await safeResponseText(response, BACKEND);
    const entities = [...html.matchAll(/<h2[^>]*>\s*<a[^>]*href="\/([^"]+)"[^>]*>/g)]
      .slice(0, request.limit)
      .flatMap((match): GithubEntityV1[] => {
        const slug = match[1]?.replace(/\s/g, '');
        if (slug === undefined || !/^[^/]+\/[^/]+$/.test(slug)) return [];
        return [{
          version: 1,
          kind: 'repo',
          id: `github:repo:${slug}`,
          backend: BACKEND,
          url: `https://github.com/${slug}`,
          full_name: slug,
        }];
      });
    const page = checkPage({
      entities,
      pagination: { supported: false, limit: request.limit, returned: entities.length, hasMore: false },
      partial: false,
      warnings: [],
    });
    return { page, degraded: false };
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') throw error;
    // Scrape is best-effort: degrade to an empty page, never throw.
    const page = checkPage({
      entities: [],
      pagination: { supported: false, limit: request.limit, returned: 0, hasMore: false },
      partial: true,
      warnings: ['trending source unavailable, results degraded'],
    });
    return { page, degraded: true };
  }
}

async function handleWorkflows(request: GithubRequest, env: Record<string, string | undefined>, signal?: AbortSignal): Promise<{ page: GithubPageV1; degraded: boolean }> {
  const owner = request.owner!;
  const repo = request.repo!;
  if (request.workflow !== undefined) {
    const data = await fetchRecord(`${repoUrl(owner, repo)}/actions/workflows/${encodeURIComponent(request.workflow)}`, env, signal, 'GitHub workflow response was not an object');
    const workflow = normalizeWorkflow(data, owner, repo);
    if (workflow === null) throw githubError('malformed_upstream', 'GitHub workflow response was missing its id');
    return singleEntityResult(request, [workflow], false);
  }
  const pageNum = pageNumber(request);
  const url = new URL(`${repoUrl(owner, repo)}/actions/workflows`);
  url.searchParams.set('per_page', String(request.limit));
  url.searchParams.set('page', String(pageNum));
  const { rows, link } = await fetchKeyedList({ url: url.href, key: 'workflows', env, signal, message: 'GitHub workflows response was not an object' });
  const entities = normalizeListEntities(rows, (row) => normalizeWorkflow(row, owner, repo), request.limit);
  return pagedListResult({ request, entities, link, pageNum });
}

interface RunsQuery {
  request: GithubRequest;
  runAuthor: string | undefined;
  pageNum: number;
}

async function fetchRunJobs(scope: RepoScope, runId: number, request: GithubRequest, io: FetchIo): Promise<{ page: GithubPageV1; degraded: boolean }> {
  const { owner, repo } = scope;
  const { env, signal } = io;
  const pageNum = pageNumber(request, { jobs: true });
  const jobsUrl = new URL(`${repoUrl(owner, repo)}/actions/runs/${runId}/jobs`);
  jobsUrl.searchParams.set('per_page', String(request.limit));
  jobsUrl.searchParams.set('page', String(pageNum));
  const { rows, link } = await fetchKeyedList({ url: jobsUrl.href, key: 'jobs', env, signal, message: 'GitHub jobs response was not an object' });
  const entities = normalizeListEntities(rows, (row) => normalizeWorkflowJob(row, owner, repo, runId), request.limit);
  return pagedListResult({ request, entities, link, pageNum, selectors: { jobs: true } });
}

async function fetchSingleRun(scope: RepoScope, runId: number, request: GithubRequest, io: FetchIo): Promise<{ page: GithubPageV1; degraded: boolean }> {
  const data = await fetchRecord(`${repoUrl(scope.owner, scope.repo)}/actions/runs/${runId}`, io.env, io.signal, 'GitHub run response was not an object');
  const run = normalizeWorkflowRun(data, scope.owner, scope.repo);
  if (run === null) throw githubError('malformed_upstream', 'GitHub run response was missing its id');
  return singleEntityResult(request, [run]);
}

function buildRunsUrl(scope: RepoScope, query: RunsQuery): string {
  const { owner, repo } = scope;
  const { request, runAuthor, pageNum } = query;
  const base = request.workflow !== undefined
    ? `${repoUrl(owner, repo)}/actions/workflows/${encodeURIComponent(request.workflow)}/runs`
    : `${repoUrl(owner, repo)}/actions/runs`;
  const url = new URL(base);
  if (request.ref !== undefined) url.searchParams.set('branch', request.ref);
  if (request.status !== undefined) url.searchParams.set('status', request.status);
  if (runAuthor !== undefined) url.searchParams.set('actor', runAuthor);
  url.searchParams.set('per_page', String(request.limit));
  url.searchParams.set('page', String(pageNum));
  return url.href;
}

async function handleRuns(request: GithubRequest, args: Record<string, unknown>, env: Record<string, string | undefined>, signal?: AbortSignal): Promise<{ page: GithubPageV1; degraded: boolean }> {
  const owner = request.owner!;
  const repo = request.repo!;
  if (isJobsForRunRequest(args, request)) {
    throw githubError('invalid_request', 'jobs requires selector: number');
  }
  if (request.number !== undefined) {
    if (args.jobs === true) return fetchRunJobs({ owner, repo }, request.number, request, { env, signal });
    return fetchSingleRun({ owner, repo }, request.number, request, { env, signal });
  }
  const runAuthor = optionalString(args.author);
  const runSelectors: GithubCursorSelectors | undefined = runAuthor !== undefined ? { author: runAuthor } : undefined;
  const pageNum = pageNumber(request, runSelectors);
  const { rows, link } = await fetchKeyedList({ url: buildRunsUrl({ owner, repo }, { request, runAuthor, pageNum }), key: 'workflow_runs', env, signal, message: 'GitHub runs response was not an object' });
  const entities = normalizeListEntities(rows, (row) => normalizeWorkflowRun(row, owner, repo), request.limit);
  return pagedListResult({ request, entities, link, pageNum, selectors: runSelectors });
}

// ── Entrypoint ──

function validatePathsEntry(entry: unknown): string {
  if (typeof entry !== 'string' || entry.trim().length === 0) throw githubError('invalid_request', 'paths entries must be non-empty strings');
  return validateGithubPath(entry.replace(/^\/+/, ''));
}

function resolveMultiPaths(rawPaths: unknown, action: string): string[] {
  if (action !== 'file') throw githubError('invalid_request', 'paths is only supported for github file');
  if (!Array.isArray(rawPaths) || rawPaths.length === 0) throw githubError('invalid_request', 'paths must be a non-empty array of strings');
  if (rawPaths.length > MULTI_FILE_MAX) {
    throw githubError('invalid_request', `paths exceeds maximum of ${MULTI_FILE_MAX} entries`);
  }
  return rawPaths.map(validatePathsEntry);
}

function resolvePaths(args: Record<string, unknown>, action: string): string[] {
  const rawPaths = args.paths;
  const rawPath = args.path;
  if (rawPaths !== undefined && rawPath !== undefined) {
    throw githubError('invalid_request', 'path and paths are mutually exclusive');
  }
  if (rawPaths !== undefined) return resolveMultiPaths(rawPaths, action);
  if (typeof rawPath === 'string') {
    return [validateGithubPath(rawPath.replace(/^\/+/, ''))];
  }
  return [];
}

const MISPLACED_SINGLE_OWNER_FLAGS: Record<string, string> = {
  latest: 'releases',
  recursive: 'tree',
  includeReadme: 'repo',
  jobs: 'runs',
};

function rejectSingleOwnerFlag(args: Record<string, unknown>, action: string, flag: string, owner: string): void {
  if (args[flag] !== undefined && action !== owner) {
    throw githubError('invalid_request', `${flag} is only supported for github ${owner}`);
  }
}

function rejectMisplacedSingleOwnerFlags(args: Record<string, unknown>, action: string): void {
  for (const [flag, owner] of Object.entries(MISPLACED_SINGLE_OWNER_FLAGS)) {
    rejectSingleOwnerFlag(args, action, flag, owner);
  }
}

function rejectMisplacedFlags(args: Record<string, unknown>, action: string): void {
  if (args.files !== undefined && action !== 'pulls') {
    throw githubError('invalid_request', 'files is only supported for github pulls');
  }
  rejectMisplacedSingleOwnerFlags(args, action);
  if (args.author !== undefined && !isAuthorScopedAction(action)) {
    throw githubError('invalid_request', 'author is only supported for github commits and runs');
  }
}

function titleForRepoContent(entity: GithubEntityV1): string | undefined {
  switch (entity.kind) {
    case 'repo': return entity.full_name ?? entity.name ?? entity.id;
    case 'file': return entity.path;
    case 'tree': return entity.id;
    case 'search_result': return entity.title ?? entity.path ?? entity.id;
    default: return undefined;
  }
}

function titleForDiscussion(entity: GithubEntityV1): string | undefined {
  switch (entity.kind) {
    case 'issue': return `#${entity.number} ${entity.title}`;
    case 'pull': return `#${entity.number} ${entity.title}`;
    case 'release': return entity.name ?? entity.tag;
    case 'commit': return entity.message?.split('\n')[0] ?? entity.sha;
    default: return undefined;
  }
}

function titleForWorkflow(entity: GithubEntityV1): string | undefined {
  switch (entity.kind) {
    case 'workflow': return entity.name ?? entity.path ?? entity.id;
    case 'workflow_run': return `#${entity.run_number ?? entity.run_id} ${entity.status ?? 'unknown'}${entity.conclusion !== undefined ? ` (${entity.conclusion})` : ''}`;
    case 'workflow_job': return entity.name;
    default: return undefined;
  }
}

function entityTitle(entity: GithubEntityV1): string {
  return titleForRepoContent(entity) ?? titleForDiscussion(entity) ?? titleForWorkflow(entity) ?? entity.id;
}

function snippetForRepoContent(entity: GithubEntityV1): string | undefined {
  switch (entity.kind) {
    case 'repo': return entity.description;
    case 'file': return entity.content?.slice(0, 2000);
    case 'tree': return undefined;
    case 'search_result': return entity.snippet;
    default: return undefined;
  }
}

function bodyExcerpt(entity: { body?: string }): string | undefined {
  return entity.body?.slice(0, 2000);
}

function snippetForDiscussion(entity: GithubEntityV1): string | undefined {
  switch (entity.kind) {
    case 'issue':
    case 'pull':
    case 'release': return bodyExcerpt(entity);
    case 'commit': return entity.message?.slice(0, 2000);
    default: return undefined;
  }
}

function snippetForWorkflow(entity: GithubEntityV1): string | undefined {
  switch (entity.kind) {
    case 'workflow': return entity.state;
    case 'workflow_run': return [entity.event, entity.head_branch].filter((part): part is string => part !== undefined).join(' on ') || undefined;
    case 'workflow_job': return entity.status !== undefined ? `${entity.status}${entity.conclusion !== undefined ? `/${entity.conclusion}` : ''}` : undefined;
    default: return undefined;
  }
}

const REPO_CONTENT_KINDS = new Set(['repo', 'file', 'tree', 'search_result']);
const DISCUSSION_KINDS = new Set(['issue', 'pull', 'release', 'commit']);

function entitySnippet(entity: GithubEntityV1): string | undefined {
  if (REPO_CONTENT_KINDS.has(entity.kind)) {
    return snippetForRepoContent(entity);
  }
  if (DISCUSSION_KINDS.has(entity.kind)) {
    return snippetForDiscussion(entity);
  }
  return snippetForWorkflow(entity);
}

function toNorthstarEntity(entity: GithubEntityV1): NorthstarEntityV1 {
  const url = 'url' in entity && typeof entity.url === 'string' ? entity.url : 'https://github.com/';
  const snippet = entitySnippet(entity);
  const out: NorthstarEntityV1 = {
    entityVersion: 1,
    kind: 'article',
    id: entity.id,
    source: 'github',
    title: entityTitle(entity),
    url,
  };
  if (snippet !== undefined) out.snippet = snippet;
  return out;
}

function renderPage(page: GithubPageV1, request: GithubRequest): string {
  if (page.entities.length === 0) {
    return page.partial
      ? `GitHub ${request.action}: no results (degraded). ${page.warnings.join('; ')}`
      : `GitHub ${request.action}: no results.`;
  }
  const lines = page.entities.map((entity, index) => {
    const url = 'url' in entity && typeof entity.url === 'string' ? `\n${entity.url}` : '';
    const snippet = entitySnippet(entity);
    return `## ${index + 1}. ${entityTitle(entity)}${url}${snippet !== undefined ? `\n${snippet.slice(0, 500)}` : ''}`;
  });
  return lines.join('\n\n');
}

export async function callGithubTool(
  args: Record<string, unknown>,
  options: GithubDomainOptions = {},
): Promise<BackendCallResult> {
  const env = options.env ?? process.env;
  const action = typeof args.action === 'string' ? args.action : '';
  // Domain-only flags validate before contract dispatch; everything else
  // flows through validateGithubRequest (selectors, limits, cursors).
  rejectMisplacedFlags(args, action);
  const paths = resolvePaths(args, action);
  const { request, warnings: validationWarnings } = validateGithubRequest({
    action,
    ...(typeof args.owner === 'string' ? { owner: args.owner } : {}),
    ...(typeof args.repo === 'string' ? { repo: args.repo } : {}),
    ...(typeof args.repository === 'string' ? { repository: args.repository } : {}),
    ...(typeof args.path === 'string' ? { path: args.path.replace(/^\/+/, '') } : {}),
    ...(typeof args.branch === 'string' ? { branch: args.branch } : {}),
    ...(typeof args.ref === 'string' ? { ref: args.ref } : {}),
    ...(typeof args.query === 'string' ? { query: args.query } : {}),
    ...(typeof args.language === 'string' ? { language: args.language } : {}),
    ...(typeof args.limit === 'number' ? { limit: args.limit } : {}),
    ...(typeof args.perPage === 'number' ? { perPage: args.perPage } : {}),
    ...(typeof args.number === 'number' ? { number: args.number } : {}),
    ...(typeof args.sha === 'string' ? { sha: args.sha } : {}),
    ...(typeof args.since === 'string' ? { since: args.since } : {}),
    ...(typeof args.state === 'string' ? { state: args.state } : {}),
    ...(args.labels !== undefined ? { labels: args.labels } : {}),
    ...(typeof args.tag === 'string' ? { tag: args.tag } : {}),
    ...(args.latest !== undefined ? { latest: args.latest as boolean } : {}),
    ...(args.files !== undefined ? { files: args.files as boolean } : {}),
    ...(typeof args.author === 'string' ? { author: args.author } : {}),
    ...(args.recursive !== undefined ? { recursive: args.recursive as boolean } : {}),
    ...(args.includeReadme !== undefined ? { includeReadme: args.includeReadme as boolean } : {}),
    ...(args.jobs !== undefined ? { jobs: args.jobs as boolean } : {}),
    ...(Array.isArray(args.paths) ? { paths: args.paths as string[] } : {}),
    ...(typeof args.workflow === 'string' ? { workflow: args.workflow } : {}),
    ...(typeof args.status === 'string' ? { status: args.status } : {}),
    ...(typeof args.cursor === 'string' ? { cursor: args.cursor } : {}),
  });

  const signal = options.signal;
  // Plan E3 routing: resolve the ordered backend chain and serve the first
  // available entry. Repo/tree prefer clone with REST fallback; blob/file
  // stay REST-first. Clone dispatch runs the W-E1 executor; REST fallback
  // (with warning) applies only when clone execution is unavailable or fails.
  const availableBackends = isGithubCloneBackendAvailable() ? ['github-clone', BACKEND] : [BACKEND];
  const backendChain = resolveGithubBackendChain(request.action, availableBackends);
  const backendWarnings: string[] = [];
  let servingBackend = BACKEND;
  let result: { page: GithubPageV1; degraded: boolean } | undefined;
  if (backendChain[0] === GITHUB_CLONE_BACKEND) {
    try {
      result = await serveGithubCloneBackend(request, env, signal, options.cloneRunner);
      servingBackend = GITHUB_CLONE_BACKEND;
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') throw error;
      if (signal?.aborted) throw error;
      // Fallback boundary: invalid_request (bad slug/token) and
      // authentication_required (token-carrying git auth failure) surface
      // directly; REST fallback only for upstream_error/malformed_upstream.
      if (error instanceof SocialError && (error.code === 'invalid_request' || error.code === 'authentication_required')) {
        throw error;
      }
      const code = error instanceof SocialError ? error.code : 'upstream_error';
      backendWarnings.push(`github-clone execution failed (${code}), using REST fallback`);
      if (isCloneDoubleAbsent(error)) backendWarnings.push(GITHUB_CLONE_GH_ABSENT_WARNING);
    }
  }
  if (result === undefined) {
  switch (request.action) {
    case 'repo': result = await handleRepo(request, args, env, signal); break;
    case 'file': result = await handleFile(request, paths, env, signal); break;
    case 'tree': result = await handleTree(request, args, env, signal); break;
    case 'search': result = await handleSearch(request, env, signal); break;
    case 'search_repos': result = await handleSearchRepos(request, env, signal); break;
    case 'issues': result = await handleIssues(request, env, signal); break;
    case 'pulls': result = await handlePulls(request, args, env, signal); break;
    case 'releases': result = await handleReleases(request, args, env, signal); break;
    case 'commits': result = await handleCommits(request, args, env, signal); break;
    case 'trending': result = await handleTrending(request, signal); break;
    case 'workflows': result = await handleWorkflows(request, env, signal); break;
    case 'runs': result = await handleRuns(request, args, env, signal); break;
  }
  }

  const { page, degraded } = result as { page: GithubPageV1; degraded: boolean };
  const allWarnings = [...validationWarnings, ...backendWarnings, ...page.warnings];
  const notes = [...allWarnings];
  if (page.partial) notes.push('partial: some upstream rows were dropped or truncated');
  if (degraded) notes.push('degraded: github-api is a limited fallback backend');
  const envelope = buildNorthstarResult({
    request: { tool: 'github', channel: 'github', action: request.action, source: servingBackend },
    outcomes: [{
      source: 'github',
      backend: servingBackend,
      ...(page.entities.length > 0 ? { entities: page.entities.map(toNorthstarEntity) } : {}),
      ...(degraded ? { degraded: true } : {}),
    }],
    pagination: {
      supported: page.pagination.supported,
      limit: page.pagination.limit,
      hasMore: page.pagination.hasMore,
      ...(page.pagination.nextCursor !== undefined ? { nextCursor: page.pagination.nextCursor } : {}),
    },
    notes,
  });
  const legacyDetails: Record<string, unknown> = {
    action: request.action,
    canonicalAction: request.action,
    backend: servingBackend,
    entities: page.entities,
    pagination: page.pagination,
    partial: page.partial,
    warnings: allWarnings,
  };
  return northstarTextResult(renderPage(page, request), legacyDetails, envelope);
}
