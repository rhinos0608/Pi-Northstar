// Stage 5 GitHub request contract: canonical action validation, strict
// owner/repo/path/ref selectors, reject-not-clamp limits, and request validation.
//
// Extracted from github-contract.ts, which re-exports this API unchanged.
// Reject-on-out-of-range choice: every numeric limit throws invalid_request
// instead of silent clamping. Silent clamping hides caller bugs and makes
// pagination accounting lie; the search API convention (perPage 51+ rejected
// upstream) is mirrored here. Every rejection names the field and cap, with a
// capped (≤32 chars) echo of the offending value where one exists.
//
// Dependency-light by design: SocialError plus the cursor-length cap owned by
// github-contract (used only inside request validation, never at module top
// level, so the facade re-export cycle stays deferred and safe). No
// child_process, no fetch.

import { GITHUB_MAX_CURSOR_LENGTH } from './github-contract.js';
import { SocialError } from '../social/social-contract.js';

// ── Core vocabulary ──

export const GITHUB_ACTIONS = [
  'repo',
  'file',
  'tree',
  'search',
  'trending',
  'issues',
  'pulls',
  'releases',
  'commits',
  'search_repos',
  'workflows',
  'runs',
] as const;

export type GithubAction = (typeof GITHUB_ACTIONS)[number];

export type GithubActionField =
  | 'owner' | 'repo' | 'repository' | 'path' | 'paths' | 'branch' | 'ref'
  | 'recursive' | 'includeReadme' | 'query' | 'language' | 'limit' | 'perPage'
  | 'number' | 'sha' | 'since' | 'state' | 'labels' | 'tag' | 'latest'
  | 'files' | 'author' | 'workflow' | 'status' | 'jobs' | 'cursor';

export interface GithubActionFieldSpec {
  readonly required: readonly GithubActionField[];
  readonly optional: readonly GithubActionField[];
  readonly repoSelector: boolean | 'optional';
}

/** Schema-generation input. validateGithubRequest remains enforcement authority.
 * file carries path/paths as optional here because the selector is XOR
 * (exactly one of path, paths): actionBranch builds the union and the
 * validator rejects neither/both. */
export const GITHUB_ACTION_FIELD_SPECS: Readonly<Record<GithubAction, GithubActionFieldSpec>> = {
  repo: { required: [], optional: ['includeReadme'], repoSelector: true },
  file: { required: [], optional: ['path', 'paths', 'branch', 'ref'], repoSelector: true },
  tree: { required: [], optional: ['path', 'branch', 'ref', 'recursive'], repoSelector: true },
  search: { required: ['query'], optional: ['language', 'limit', 'perPage', 'cursor'], repoSelector: 'optional' },
  trending: { required: [], optional: ['language', 'since', 'limit', 'perPage'], repoSelector: false },
  issues: { required: [], optional: ['number', 'state', 'labels', 'limit', 'perPage', 'cursor'], repoSelector: true },
  pulls: { required: [], optional: ['number', 'state', 'labels', 'files', 'limit', 'perPage', 'cursor'], repoSelector: true },
  releases: { required: [], optional: ['tag', 'latest', 'limit', 'perPage', 'cursor'], repoSelector: true },
  commits: { required: [], optional: ['path', 'branch', 'ref', 'sha', 'since', 'author', 'limit', 'perPage', 'cursor'], repoSelector: true },
  search_repos: { required: ['query'], optional: ['language', 'limit', 'perPage', 'cursor'], repoSelector: false },
  workflows: { required: [], optional: ['workflow', 'limit', 'perPage', 'cursor'], repoSelector: true },
  runs: { required: [], optional: ['workflow', 'status', 'number', 'jobs', 'limit', 'perPage', 'cursor'], repoSelector: true },
};

export function isGithubAction(value: unknown): value is GithubAction {
  return typeof value === 'string' && (GITHUB_ACTIONS as readonly string[]).includes(value);
}

// ── Errors ──
// SocialError is platform-generic; the github channel rides in an untyped slot.

function githubError(
  code: 'invalid_request' | 'unsupported_action' | 'cursor_invalid' | 'cursor_mismatch',
  message: string,
  options?: { backend?: string },
): SocialError {
  return new SocialError(code, message, {
    ...(options?.backend !== undefined ? { backend: options.backend } : {}),
  });
}

/** Capped echo: at most 32 chars of an offending value, never the full input. */
function echo(value: unknown): string {
  return String(value).slice(0, 32);
}

// ── Canonical actions ──

export function resolveGithubAction(action: string): GithubAction {
  if (!isGithubAction(action)) {
    throw githubError('unsupported_action', `Unsupported github action: ${echo(action)}`);
  }
  return action;
}

// ── Strict selectors ──

const OWNER_CHARSET = /^[A-Za-z0-9._-]+$/;
const REF_CHARSET = /^[A-Za-z0-9._/-]+$/;
const SHA_PATTERN = /^[0-9a-f]{7,40}$/i;
const PERCENT_ENCODING = /%2f|%2e/i;

export const GITHUB_OWNER_MAX = 39;
export const GITHUB_REPO_MAX = 100;
export const GITHUB_PATH_MAX = 200;
export const GITHUB_REF_MAX = 200;
export const GITHUB_QUERY_MAX = 256;
export const GITHUB_LABELS_MAX = 10;
export const GITHUB_LABEL_MAX = 50;

function validateOwnerRepo(owner: string, repo: string): void {
  for (const [field, value, max] of [
    ['owner', owner, GITHUB_OWNER_MAX],
    ['repo', repo, GITHUB_REPO_MAX],
  ] as const) {
    if (value.length === 0) throw githubError('invalid_request', `${field} must be a non-empty string`);
    if (value.length > max) {
      throw githubError('invalid_request', `${field} exceeds maximum length of ${max}: ${echo(value)}`);
    }
    if (!OWNER_CHARSET.test(value)) {
      throw githubError('invalid_request', `${field} uses forbidden characters: ${echo(value)}`);
    }
    if (value.includes('..')) {
      throw githubError('invalid_request', `${field} must not contain '..': ${echo(value)}`);
    }
    if (value.includes('%') || PERCENT_ENCODING.test(value)) {
      throw githubError('invalid_request', `${field} must not contain percent-encoding: ${echo(value)}`);
    }
  }
}

export function parseRepositorySlug(repository: string): { owner: string; repo: string } {
  const trimmed = repository.trim().replace(/^https:\/\/github\.com\//, '').replace(/\.git$/, '');
  const segments = trimmed.split('/');
  if (segments.length !== 2 || segments[0]!.length === 0 || segments[1]!.length === 0) {
    throw githubError('invalid_request', `repository must be "owner/repo": ${echo(repository)}`);
  }
  const owner = segments[0]!;
  const repo = segments[1]!;
  validateOwnerRepo(owner, repo);
  return { owner, repo };
}

export function validateGithubPath(path: string): string {
  if (path.length === 0) throw githubError('invalid_request', 'path must be a non-empty string');
  if (path.length > GITHUB_PATH_MAX) {
    throw githubError('invalid_request', `path exceeds maximum length of ${GITHUB_PATH_MAX}: ${echo(path)}`);
  }
  if (path.includes('\\')) throw githubError('invalid_request', `path must not contain backslash: ${echo(path)}`);
  if (path.includes('%') || PERCENT_ENCODING.test(path)) {
    throw githubError('invalid_request', `path must not contain percent-encoding: ${echo(path)}`);
  }
  if (path.startsWith('/') || path.endsWith('/')) {
    throw githubError('invalid_request', `path must not have leading or trailing slash: ${echo(path)}`);
  }
  if (path.split('/').some((segment) => segment === '..' || segment.length === 0)) {
    throw githubError('invalid_request', `path must not contain '..' or empty segments: ${echo(path)}`);
  }
  return path;
}

export function validateGithubRef(ref: string, field = 'ref'): string {
  if (ref.length === 0) throw githubError('invalid_request', `${field} must be a non-empty string`);
  if (ref.length > GITHUB_REF_MAX) {
    throw githubError('invalid_request', `${field} exceeds maximum length of ${GITHUB_REF_MAX}: ${echo(ref)}`);
  }
  if (!REF_CHARSET.test(ref)) {
    throw githubError('invalid_request', `${field} uses forbidden characters: ${echo(ref)}`);
  }
  if (ref.includes('..')) throw githubError('invalid_request', `${field} must not contain '..': ${echo(ref)}`);
  if (ref.startsWith('-')) throw githubError('invalid_request', `${field} must not start with '-': ${echo(ref)}`);
  for (const char of ['~', '^', ':']) {
    if (ref.includes(char)) {
      throw githubError('invalid_request', `${field} must not contain '${char}': ${echo(ref)}`);
    }
  }
  return ref;
}

function validatePositiveInt(raw: unknown, field: string): number {
  if (typeof raw !== 'number' || !Number.isInteger(raw) || raw < 1) {
    throw githubError('invalid_request', `${field} must be a positive integer: ${echo(raw)}`);
  }
  return raw;
}

export function validateGithubSha(sha: string): string {
  if (!SHA_PATTERN.test(sha)) {
    throw githubError('invalid_request', `sha must be 7-40 hex chars: ${echo(sha)}`);
  }
  return sha.toLowerCase();
}

function validateIsoSince(since: string): string {
  if (Number.isNaN(Date.parse(since))) {
    throw githubError('invalid_request', `since must be an ISO date string: ${echo(since)}`);
  }
  return since;
}

const TRENDING_WINDOWS: ReadonlySet<string> = new Set(['daily', 'weekly', 'monthly']);

function validateTrendingSince(since: string): string {
  if (!TRENDING_WINDOWS.has(since)) {
    throw githubError('invalid_request', `trending since must be daily, weekly, or monthly: ${echo(since)}`);
  }
  return since;
}

function validateLabels(raw: unknown): string[] | undefined {
  if (raw === undefined) return undefined;
  if (!Array.isArray(raw)) throw githubError('invalid_request', 'labels must be an array of strings');
  if (raw.length > GITHUB_LABELS_MAX) {
    throw githubError('invalid_request', `labels exceeds maximum of ${GITHUB_LABELS_MAX} entries`);
  }
  for (const entry of raw) {
    if (typeof entry !== 'string' || entry.trim().length === 0) {
      throw githubError('invalid_request', 'labels entries must be non-empty strings');
    }
    if (entry.length > GITHUB_LABEL_MAX) {
      throw githubError('invalid_request', `label exceeds maximum length of ${GITHUB_LABEL_MAX}: ${echo(entry)}`);
    }
  }
  return raw as string[];
}

// ── Limits (reject-not-clamp) ──

export const DEFAULT_GITHUB_LIMIT = 20;
export const DEFAULT_GITHUB_TRENDING_LIMIT = 10;
export const GITHUB_LIST_LIMIT_MAX = 50;
export const GITHUB_SEARCH_PER_PAGE_MAX = 50;
export const GITHUB_TRENDING_LIMIT_MAX = 25;

/**
 * Reject-on-out-of-range bound. Names the field and cap; echoes the offender
 * capped to 32 chars. Never clamps.
 */
export function resolveGithubLimit(raw: unknown, field: string, max: number, fallback: number): number {
  if (raw === undefined || raw === null) return fallback;
  if (typeof raw !== 'number' || !Number.isInteger(raw) || raw < 1 || raw > max) {
    throw githubError('invalid_request', `${field} must be an integer in [1, ${max}]: ${echo(raw)}`);
  }
  return raw;
}

function limitCapFor(action: GithubAction): number {
  return action === 'trending' ? GITHUB_TRENDING_LIMIT_MAX : GITHUB_LIST_LIMIT_MAX;
}

// ── Request validation ──

export interface GithubRequestInput {
  action: string;
  owner?: string;
  repo?: string;
  repository?: string;
  path?: string;
  paths?: string[];
  branch?: string;
  ref?: string;
  query?: string;
  language?: string;
  limit?: number;
  perPage?: number;
  number?: number;
  sha?: string;
  since?: string;
  state?: string;
  labels?: unknown;
  tag?: string;
  latest?: boolean;
  files?: boolean;
  author?: string;
  recursive?: boolean;
  includeReadme?: boolean;
  jobs?: boolean;
  workflow?: string;
  status?: string;
  cursor?: string;
}

export interface GithubRequest {
  action: GithubAction;
  owner?: string;
  repo?: string;
  path?: string;
  paths?: string[];
  ref?: string;
  query?: string;
  language?: string;
  limit: number;
  number?: number;
  sha?: string;
  since?: string;
  state?: string;
  labels?: string[];
  tag?: string;
  latest?: boolean;
  files?: boolean;
  author?: string;
  recursive?: boolean;
  includeReadme?: boolean;
  jobs?: boolean;
  workflow?: string;
  status?: string;
  cursor?: string;
}

const GITHUB_PAGINATED_ACTIONS: ReadonlySet<GithubAction> = new Set([
  'issues',
  'pulls',
  'releases',
  'commits',
  'search',
  'search_repos',
  'workflows',
  'runs',
]);

export function githubPaginationSupported(action: GithubAction): boolean {
  return GITHUB_PAGINATED_ACTIONS.has(action);
}

function cleanField(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

const GITHUB_ISSUE_STATES: ReadonlySet<string> = new Set(['open', 'closed', 'all']);

export const GITHUB_RUN_STATUSES = [
  'completed', 'action_required', 'cancelled', 'failure', 'neutral', 'skipped', 'stale',
  'success', 'timed_out', 'in_progress', 'queued', 'requested', 'waiting', 'pending',
] as const;
const GITHUB_RUN_STATUS_SET: ReadonlySet<string> = new Set(GITHUB_RUN_STATUSES);

/**
 * Parse and validate a raw github request: resolve the canonical action,
 * enforce per-action selector requirements and strict selector charsets, and
 * bound every numeric limit with reject-on-out-of-range. Throws SocialError
 * before any backend dispatch.
 */
export function validateGithubRequest(input: GithubRequestInput): { request: GithubRequest; warnings: string[] } {
  const warnings: string[] = [];
  const action = resolveGithubAction(input.action);

  // Owner/repo: explicit fields win; repository slug fills when both absent.
  let owner = cleanField(input.owner);
  let repo = cleanField(input.repo);
  if ((owner === undefined || repo === undefined) && typeof input.repository === 'string') {
    const slug = cleanField(input.repository);
    if (slug === undefined) throw githubError('invalid_request', 'repository must be a non-empty string when provided');
    const parsed = parseRepositorySlug(slug);
    owner ??= parsed.owner;
    repo ??= parsed.repo;
  }
  const needsRepo = action !== 'trending' && action !== 'search_repos' && action !== 'search';
  const scopedSearch = action === 'search' && (owner !== undefined || repo !== undefined);
  if (needsRepo || scopedSearch) {
    if (owner === undefined || repo === undefined) {
      throw githubError('invalid_request', `github ${action} requires selector: owner, repo`);
    }
    validateOwnerRepo(owner, repo);
  } else if (owner !== undefined && repo !== undefined) {
    validateOwnerRepo(owner, repo);
  }

  const rawPath = cleanField(input.path);
  if ((action === 'file' || action === 'commits') && typeof input.path === 'string' && rawPath === undefined) {
    throw githubError('invalid_request', 'path must be a non-empty string when provided');
  }
  const path = rawPath !== undefined ? validateGithubPath(rawPath) : undefined;

  let paths: string[] | undefined;
  if (input.paths !== undefined) {
    if (action !== 'file') throw githubError('invalid_request', 'paths is only supported for github file');
    if (rawPath !== undefined) throw githubError('invalid_request', 'path and paths are mutually exclusive');
    if (!Array.isArray(input.paths) || input.paths.length === 0) {
      throw githubError('invalid_request', 'paths must be a non-empty array of strings');
    }
    if (input.paths.length > 10) throw githubError('invalid_request', 'paths exceeds maximum of 10 entries');
    paths = input.paths.map((entry) => {
      if (typeof entry !== 'string' || entry.trim().length === 0) {
        throw githubError('invalid_request', 'paths entries must be non-empty strings');
      }
      return validateGithubPath(entry.replace(/^\/+/, ''));
    });
  }

  // branch and ref are one selector; both present must agree.
  const branch = cleanField(input.branch);
  const refField = cleanField(input.ref);
  if (branch !== undefined) validateGithubRef(branch, 'branch');
  if (refField !== undefined) validateGithubRef(refField, 'ref');
  if (branch !== undefined && refField !== undefined && branch !== refField) {
    throw githubError('invalid_request', 'branch and ref must agree when both are provided');
  }
  const ref = branch ?? refField;

  const query = cleanField(input.query);
  if (typeof input.query === 'string' && query === undefined) {
    throw githubError('invalid_request', 'query must be a non-empty string when provided');
  }
  if (query !== undefined && query.length > GITHUB_QUERY_MAX) {
    throw githubError('invalid_request', `query exceeds maximum length of ${GITHUB_QUERY_MAX}: ${echo(query)}`);
  }
  if ((action === 'search' || action === 'search_repos') && query === undefined) {
    throw githubError('invalid_request', `github ${action} requires selector: query`);
  }

  const language = cleanField(input.language);
  if (typeof input.language === 'string' && language === undefined) {
    throw githubError('invalid_request', 'language must be a non-empty string when provided');
  }
  if (language !== undefined && language.length > GITHUB_LABEL_MAX) {
    throw githubError('invalid_request', `language exceeds maximum length of ${GITHUB_LABEL_MAX}: ${echo(language)}`);
  }

  const number = input.number !== undefined ? validatePositiveInt(input.number, 'number') : undefined;
  const shaRaw = cleanField(input.sha);
  if (typeof input.sha === 'string' && shaRaw === undefined) {
    throw githubError('invalid_request', 'sha must be a non-empty string when provided');
  }
  const sha = shaRaw !== undefined ? validateGithubSha(shaRaw) : undefined;

  const sinceRaw = cleanField(input.since);
  if (typeof input.since === 'string' && sinceRaw === undefined) {
    throw githubError('invalid_request', 'since must be a non-empty string when provided');
  }
  const since =
    sinceRaw !== undefined
      ? action === 'trending'
        ? validateTrendingSince(sinceRaw)
        : validateIsoSince(sinceRaw)
      : undefined;

  const state = cleanField(input.state);
  if (typeof input.state === 'string' && state === undefined) {
    throw githubError('invalid_request', 'state must be a non-empty string when provided');
  }
  if (state !== undefined && (action === 'issues' || action === 'pulls') && !GITHUB_ISSUE_STATES.has(state)) {
    throw githubError('invalid_request', `state must be open, closed, or all: ${echo(state)}`);
  }

  const labels = validateLabels(input.labels);

  const tag = cleanField(input.tag);
  if (typeof input.tag === 'string' && tag === undefined) {
    throw githubError('invalid_request', 'tag must be a non-empty string when provided');
  }
  const validatedTag = tag === undefined ? undefined : validateGithubRef(tag, 'tag');

  function validateBooleanFlag(raw: unknown, flag: string): boolean | undefined {
    if (raw === undefined) return undefined;
    if (typeof raw !== 'boolean') throw githubError('invalid_request', `${flag} must be a boolean: ${echo(raw)}`);
    return raw;
  }
  const latest = validateBooleanFlag(input.latest, 'latest');
  if (latest !== undefined && action !== 'releases') throw githubError('invalid_request', 'latest is only supported for github releases');
  const files = validateBooleanFlag(input.files, 'files');
  if (files !== undefined && action !== 'pulls') throw githubError('invalid_request', 'files is only supported for github pulls');
  const recursive = validateBooleanFlag(input.recursive, 'recursive');
  if (recursive !== undefined && action !== 'tree') throw githubError('invalid_request', 'recursive is only supported for github tree');
  const includeReadme = validateBooleanFlag(input.includeReadme, 'includeReadme');
  if (includeReadme !== undefined && action !== 'repo') throw githubError('invalid_request', 'includeReadme is only supported for github repo');
  const jobs = validateBooleanFlag(input.jobs, 'jobs');
  if (jobs !== undefined && action !== 'runs') throw githubError('invalid_request', 'jobs is only supported for github runs');

  const author = cleanField(input.author);
  if (typeof input.author === 'string' && author === undefined) {
    throw githubError('invalid_request', 'author must be a non-empty string when provided');
  }
  if (author !== undefined && action !== 'commits' && action !== 'runs') {
    throw githubError('invalid_request', 'author is only supported for github commits and runs');
  }

  const workflowRaw = cleanField(input.workflow);
  if (typeof input.workflow === 'string' && workflowRaw === undefined) {
    throw githubError('invalid_request', 'workflow must be a non-empty string when provided');
  }
  const workflow = workflowRaw !== undefined ? validateGithubPath(workflowRaw) : undefined;

  if (workflowRaw !== undefined && action !== 'workflows' && action !== 'runs') {
    throw githubError('invalid_request', `workflow is only supported for github workflows and runs: ${echo(workflowRaw)}`);
  }
  const status = cleanField(input.status);
  if (typeof input.status === 'string' && status === undefined) {
    throw githubError('invalid_request', 'status must be a non-empty string when provided');
  }
  if (status !== undefined && action !== 'runs') {
    throw githubError('invalid_request', `status is only supported for github runs: ${echo(status)}`);
  }
  if (status !== undefined && !GITHUB_RUN_STATUS_SET.has(status)) {
    throw githubError('invalid_request', `status must be one of ${GITHUB_RUN_STATUSES.join(', ')}: ${echo(status)}`);
  }

  // Limit: perPage alias wins when both are present.
  const limitField = input.perPage !== undefined ? 'perPage' : 'limit';
  const limitRaw = input.perPage ?? input.limit;
  const cap = limitCapFor(action);
  const fallback = action === 'trending' ? DEFAULT_GITHUB_TRENDING_LIMIT : DEFAULT_GITHUB_LIMIT;
  const limit = resolveGithubLimit(limitRaw, limitField, cap, fallback);

  const cursor = cleanField(input.cursor);
  if (typeof input.cursor === 'string' && cursor === undefined) {
    throw githubError('invalid_request', 'cursor must be a non-empty string when provided');
  }
  if (cursor !== undefined) {
    if (!githubPaginationSupported(action)) {
      throw githubError('cursor_invalid', `cursors are not supported for github ${action}`);
    }
    if (cursor.length > GITHUB_MAX_CURSOR_LENGTH) {
      throw githubError('cursor_invalid', `cursor exceeds maximum length of ${GITHUB_MAX_CURSOR_LENGTH}`);
    }
  }

  if (action === 'file' && path === undefined && paths === undefined) {
    throw githubError('invalid_request', 'github file requires selector: path or paths');
  }

  const request: GithubRequest = { action, limit };
  if (owner !== undefined) request.owner = owner;
  if (repo !== undefined) request.repo = repo;
  if (path !== undefined) request.path = path;
  if (ref !== undefined) request.ref = ref;
  if (query !== undefined) request.query = query;
  if (language !== undefined) request.language = language;
  if (number !== undefined) request.number = number;
  if (sha !== undefined) request.sha = sha;
  if (since !== undefined) request.since = since;
  if (state !== undefined) request.state = state;
  if (labels !== undefined) request.labels = labels;
  if (validatedTag !== undefined) request.tag = validatedTag;
  if (latest !== undefined) request.latest = latest;
  if (files !== undefined) request.files = files;
  if (author !== undefined) request.author = author;
  if (recursive !== undefined) request.recursive = recursive;
  if (includeReadme !== undefined) request.includeReadme = includeReadme;
  if (jobs !== undefined) request.jobs = jobs;
  if (paths !== undefined) request.paths = paths;
  if (workflow !== undefined) request.workflow = workflow;
  if (status !== undefined) request.status = status;
  if (cursor !== undefined) request.cursor = cursor;
  return { request, warnings };
}
