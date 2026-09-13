// Stage 5 GitHub contract: shared GitHub vocabulary, fail-closed entity
// validators, Link-header cursor support for list actions, and the github-api
// backend plan seam. Canonical action validation, strict owner/repo/path/ref
// selectors, reject-not-clamp limits, and request validation live in
// github-request-contract.ts and are re-exported here unchanged.
//
// This module owns vocabulary and validation only. Backend selection lives in
// the native github integrator (src/native-tools.ts). Canonical capability
// data stays in the capability registry (src/capabilities.ts).
//
// Canonical-only contract: legacy 'list_dir' and 'code_search' spellings are
// rejected as unsupported_action before any backend dispatch; there is no
// alias path — no pass-through, no mapping onto 'file' or 'search'.
//
// Reject-on-out-of-range choice: every numeric limit throws invalid_request
// instead of silent clamping. Silent clamping hides caller bugs and makes
// pagination accounting lie; the search API convention (perPage 51+ rejected
// upstream) is mirrored here. Every rejection names the field and cap, with a
// capped (≤32 chars) echo of the offending value where one exists.
//
// Dependency-light by design: node:crypto plus the shared SocialError only.
// No child_process, no fetch.

import { createHash } from 'node:crypto';
import { SocialError } from '../social/social-contract.js';
import { isGithubAction, type GithubAction } from './github-request-contract.js';
import type { GithubRequest } from './github-request-contract.js';

// Request validation (canonical actions, selectors, limits) lives in
// github-request-contract.ts; this facade re-exports that API unchanged.
export {
  DEFAULT_GITHUB_LIMIT,
  DEFAULT_GITHUB_TRENDING_LIMIT,
  GITHUB_ACTIONS,
  GITHUB_LABEL_MAX,
  GITHUB_LABELS_MAX,
  GITHUB_LIST_LIMIT_MAX,
  GITHUB_OWNER_MAX,
  GITHUB_PATH_MAX,
  GITHUB_QUERY_MAX,
  GITHUB_REF_MAX,
  GITHUB_REPO_MAX,
  GITHUB_RUN_STATUSES,
  GITHUB_SEARCH_PER_PAGE_MAX,
  GITHUB_TRENDING_LIMIT_MAX,
  githubPaginationSupported,
  isGithubAction,
  parseRepositorySlug,
  resolveGithubAction,
  resolveGithubLimit,
  validateGithubPath,
  validateGithubRef,
  validateGithubRequest,
  validateGithubSha,
} from './github-request-contract.js';
export type { GithubAction, GithubRequest, GithubRequestInput } from './github-request-contract.js';

// ── Core vocabulary ──

export type GithubAuthTier = 'anonymous' | 'env_var';

export type GithubPaginationMode = 'cursor' | 'unsupported';

export type GithubBackendQuality = 'full' | 'degraded';

export type GithubEntityKind =
  | 'repo'
  | 'file'
  | 'tree'
  | 'search_result'
  | 'issue'
  | 'pull'
  | 'release'
  | 'commit'
  | 'workflow'
  | 'workflow_run'
  | 'workflow_job';

export const GITHUB_ENTITY_KINDS: ReadonlySet<string> = new Set([
  'repo',
  'file',
  'tree',
  'search_result',
  'issue',
  'pull',
  'release',
  'commit',
  'workflow',
  'workflow_run',
  'workflow_job',
]);

function isGithubEntityKind(value: unknown): value is GithubEntityKind {
  return typeof value === 'string' && GITHUB_ENTITY_KINDS.has(value);
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

// ── Normalized entities (fail-closed) ──
// Sparse rows: only fields present upstream are set. Never synthesize metrics,
// dates, or identifiers. backend_text-shaped payloads are rejected as
// unknown-shape. Per-entity text excerpts cap at 8000 chars.

export interface GithubRepoV1 {
  version: 1;
  kind: 'repo';
  id: string;
  backend: string;
  url: string;
  name?: string;
  full_name?: string;
  description?: string;
  stars?: number;
  forks?: number;
  language?: string;
  default_branch?: string;
  readme?: string;
}

export interface GithubFileV1 {
  version: 1;
  kind: 'file';
  id: string;
  backend: string;
  path: string;
  url?: string;
  size?: number;
  content?: string;
  encoding?: string;
}

export interface GithubTreeEntryV1 {
  path: string;
  type?: string;
  sha?: string;
}

export interface GithubTreeV1 {
  version: 1;
  kind: 'tree';
  id: string;
  backend: string;
  entries: GithubTreeEntryV1[];
}

export interface GithubSearchResultV1 {
  version: 1;
  kind: 'search_result';
  id: string;
  backend: string;
  url: string;
  path?: string;
  repository?: string;
  title?: string;
  snippet?: string;
}

export interface GithubIssueV1 {
  version: 1;
  kind: 'issue';
  id: string;
  backend: string;
  number: number;
  title: string;
  state: string;
  author?: string;
  url?: string;
  body?: string;
  labels?: string[];
  created_at?: string;
}

export interface GithubPullV1 {
  version: 1;
  kind: 'pull';
  id: string;
  backend: string;
  number: number;
  title: string;
  state: string;
  author?: string;
  url?: string;
  body?: string;
  labels?: string[];
  created_at?: string;
}

export interface GithubReleaseV1 {
  version: 1;
  kind: 'release';
  id: string;
  backend: string;
  tag: string;
  name?: string;
  published_at?: string;
  url?: string;
  body?: string;
}

export interface GithubCommitV1 {
  version: 1;
  kind: 'commit';
  id: string;
  backend: string;
  sha: string;
  message?: string;
  author?: string;
  date?: string;
  url?: string;
}

export interface GithubWorkflowV1 {
  version: 1;
  kind: 'workflow';
  id: string;
  backend: string;
  workflow_id: number;
  name?: string;
  path?: string;
  state?: string;
  url?: string;
  badge_url?: string;
}

export interface GithubWorkflowRunV1 {
  version: 1;
  kind: 'workflow_run';
  id: string;
  backend: string;
  run_id: number;
  run_number?: number;
  name?: string;
  status?: string;
  conclusion?: string;
  head_branch?: string;
  head_sha?: string;
  event?: string;
  url?: string;
  created_at?: string;
  actor?: string;
}

export interface GithubWorkflowJobV1 {
  version: 1;
  kind: 'workflow_job';
  id: string;
  backend: string;
  job_id: number;
  run_id: number;
  name: string;
  status?: string;
  conclusion?: string;
  started_at?: string;
  completed_at?: string;
  url?: string;
}

export type GithubEntityV1 =
  | GithubRepoV1
  | GithubFileV1
  | GithubTreeV1
  | GithubSearchResultV1
  | GithubIssueV1
  | GithubPullV1
  | GithubReleaseV1
  | GithubCommitV1
  | GithubWorkflowV1
  | GithubWorkflowRunV1
  | GithubWorkflowJobV1;

export const GITHUB_ENTITY_CONTENT_MAX = 8000;
export const GITHUB_PAGE_CONTENT_MAX = 60000;

const GITHUB_BASE_FIELDS: ReadonlySet<string> = new Set(['version', 'kind', 'id', 'backend']);

const GITHUB_KIND_FIELDS: Readonly<Record<GithubEntityKind, ReadonlySet<string>>> = {
  repo: new Set([
    'version', 'kind', 'id', 'backend', 'url', 'name', 'full_name', 'description',
    'stars', 'forks', 'language', 'default_branch', 'readme',
  ]),
  file: new Set(['version', 'kind', 'id', 'backend', 'path', 'url', 'size', 'content', 'encoding']),
  tree: new Set(['version', 'kind', 'id', 'backend', 'entries']),
  search_result: new Set(['version', 'kind', 'id', 'backend', 'url', 'path', 'repository', 'title', 'snippet']),
  issue: new Set([
    'version', 'kind', 'id', 'backend', 'number', 'title', 'state', 'author',
    'url', 'body', 'labels', 'created_at',
  ]),
  pull: new Set([
    'version', 'kind', 'id', 'backend', 'number', 'title', 'state', 'author',
    'url', 'body', 'labels', 'created_at',
  ]),
  release: new Set(['version', 'kind', 'id', 'backend', 'tag', 'name', 'published_at', 'url', 'body']),
  commit: new Set(['version', 'kind', 'id', 'backend', 'sha', 'message', 'author', 'date', 'url']),
  workflow: new Set(['version', 'kind', 'id', 'backend', 'workflow_id', 'name', 'path', 'state', 'url', 'badge_url']),
  workflow_run: new Set([
    'version', 'kind', 'id', 'backend', 'run_id', 'run_number', 'name', 'status', 'conclusion',
    'head_branch', 'head_sha', 'event', 'url', 'created_at', 'actor',
  ]),
  workflow_job: new Set([
    'version', 'kind', 'id', 'backend', 'job_id', 'run_id', 'name', 'status', 'conclusion',
    'started_at', 'completed_at', 'url',
  ]),
};

function isValidHttpUrl(value: string): boolean {
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

function checkOptionalUrl(entity: Record<string, unknown>, issues: string[]): void {
  if (entity.url !== undefined && (typeof entity.url !== 'string' || !isValidHttpUrl(entity.url))) {
    issues.push('url is not a valid http(s) URL');
  }
}

function checkBoundedText(entity: Record<string, unknown>, field: string, issues: string[]): void {
  const value = entity[field];
  if (value === undefined) return;
  if (typeof value !== 'string') {
    issues.push(`${field} must be a string`);
  } else if (value.length > GITHUB_ENTITY_CONTENT_MAX) {
    issues.push(`${field} exceeds maximum length of ${GITHUB_ENTITY_CONTENT_MAX}`);
  }
}

function checkSafePositiveInt(entity: Record<string, unknown>, field: string, issues: string[]): void {
  const value = entity[field];
  if (value === undefined) return;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) {
    issues.push(`${field} must be a safe positive integer`);
  }
}

function checkFiniteNumber(entity: Record<string, unknown>, field: string, issues: string[]): void {
  const value = entity[field];
  if (value === undefined) return;
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    issues.push(`${field} must be a finite number`);
  }
}

function checkStringField(entity: Record<string, unknown>, field: string, issues: string[]): void {
  const value = entity[field];
  if (value === undefined) return;
  if (typeof value !== 'string') issues.push(`${field} must be a string`);
}

function checkStringList(entity: Record<string, unknown>, field: string, issues: string[]): void {
  const value = entity[field];
  if (value === undefined) return;
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string')) {
    issues.push(`${field} must be an array of strings`);
  }
}

// Entity/commit sha shape. Mirrors the selector charset in
// github-request-contract.ts; kept local so entity validation stays free of
// the request module. Entity checks report issues, never throw, so no echo helper.
const SHA_PATTERN = /^[0-9a-f]{7,40}$/i;

function validateTreeEntries(entity: Record<string, unknown>, issues: string[]): void {
  const value = entity.entries;
  if (!Array.isArray(value)) {
    issues.push('entries must be an array');
    return;
  }
  for (const [index, entry] of value.entries()) {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      issues.push(`entries[${index}] must be an object`);
      continue;
    }
    const row = entry as Record<string, unknown>;
    for (const key of Object.keys(row)) {
      if (key !== 'path' && key !== 'type' && key !== 'sha') {
        issues.push(`entries[${index}].${key} is not a known field`);
      }
    }
    if (typeof row.path !== 'string' || row.path.length === 0) {
      issues.push(`entries[${index}].path is required`);
    }
    if (row.sha !== undefined && (typeof row.sha !== 'string' || !SHA_PATTERN.test(row.sha))) {
      issues.push(`entries[${index}].sha must be 7-40 hex chars`);
    }
  }
}

export function validateGithubEntity(value: unknown): { ok: boolean; issues: string[] } {
  const issues: string[] = [];
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return { ok: false, issues: ['entity is not an object'] };
  }
  const entity = value as Record<string, unknown>;
  if (entity.backend_text !== undefined || entity.backendText !== undefined) {
    issues.push('backend_text is not allowed on github paths');
  }
  const kind = entity.kind;
  if (!isGithubEntityKind(kind)) {
    return { ok: false, issues: [...issues, 'kind is not a valid github entity kind'] };
  }
  if (entity.version !== 1) issues.push('version must be 1');
  if (typeof entity.id !== 'string' || entity.id.trim().length === 0) issues.push('id is required');
  if (typeof entity.backend !== 'string' || entity.backend.trim().length === 0) {
    issues.push('backend is required');
  }
  for (const key of Object.keys(entity)) {
    if (!GITHUB_BASE_FIELDS.has(key) && !GITHUB_KIND_FIELDS[kind].has(key)) {
      issues.push(`${key} is not a known field for kind ${kind}`);
    }
  }

  switch (kind) {
    case 'repo': {
      if (typeof entity.url !== 'string' || !isValidHttpUrl(entity.url)) {
        issues.push('url is not a valid http(s) URL');
      }
      checkStringField(entity, 'name', issues);
      checkStringField(entity, 'full_name', issues);
      checkStringField(entity, 'description', issues);
      checkFiniteNumber(entity, 'stars', issues);
      checkFiniteNumber(entity, 'forks', issues);
      checkStringField(entity, 'language', issues);
      checkStringField(entity, 'default_branch', issues);
      checkBoundedText(entity, 'readme', issues);
      break;
    }
    case 'file': {
      if (typeof entity.path !== 'string' || entity.path.length === 0) issues.push('path is required');
      checkOptionalUrl(entity, issues);
      checkFiniteNumber(entity, 'size', issues);
      checkBoundedText(entity, 'content', issues);
      checkStringField(entity, 'encoding', issues);
      break;
    }
    case 'tree': {
      validateTreeEntries(entity, issues);
      break;
    }
    case 'search_result': {
      if (typeof entity.url !== 'string' || !isValidHttpUrl(entity.url)) {
        issues.push('url is not a valid http(s) URL');
      }
      checkStringField(entity, 'path', issues);
      checkStringField(entity, 'repository', issues);
      checkStringField(entity, 'title', issues);
      checkBoundedText(entity, 'snippet', issues);
      break;
    }
    case 'issue':
    case 'pull': {
      if (typeof entity.number !== 'number' || !Number.isInteger(entity.number) || entity.number < 1) {
        issues.push('number must be a positive integer');
      }
      if (typeof entity.title !== 'string' || entity.title.length === 0) issues.push('title is required');
      if (typeof entity.state !== 'string' || entity.state.length === 0) issues.push('state is required');
      checkStringField(entity, 'author', issues);
      checkOptionalUrl(entity, issues);
      checkBoundedText(entity, 'body', issues);
      checkStringList(entity, 'labels', issues);
      checkStringField(entity, 'created_at', issues);
      break;
    }
    case 'release': {
      if (typeof entity.tag !== 'string' || entity.tag.length === 0) issues.push('tag is required');
      checkStringField(entity, 'name', issues);
      checkStringField(entity, 'published_at', issues);
      checkOptionalUrl(entity, issues);
      checkBoundedText(entity, 'body', issues);
      break;
    }
    case 'commit': {
      if (typeof entity.sha !== 'string' || !SHA_PATTERN.test(entity.sha)) {
        issues.push('sha must be 7-40 hex chars');
      }
      checkBoundedText(entity, 'message', issues);
      checkStringField(entity, 'author', issues);
      checkStringField(entity, 'date', issues);
      checkOptionalUrl(entity, issues);
      break;
    }
    case 'workflow': {
      checkSafePositiveInt(entity, 'workflow_id', issues);
      if (entity.workflow_id === undefined) issues.push('workflow_id is required');
      checkStringField(entity, 'name', issues);
      checkStringField(entity, 'path', issues);
      checkStringField(entity, 'state', issues);
      checkOptionalUrl(entity, issues);
      checkStringField(entity, 'badge_url', issues);
      break;
    }
    case 'workflow_run': {
      checkSafePositiveInt(entity, 'run_id', issues);
      if (entity.run_id === undefined) issues.push('run_id is required');
      checkSafePositiveInt(entity, 'run_number', issues);
      checkStringField(entity, 'name', issues);
      checkStringField(entity, 'status', issues);
      checkStringField(entity, 'conclusion', issues);
      checkStringField(entity, 'head_branch', issues);
      checkStringField(entity, 'head_sha', issues);
      checkStringField(entity, 'event', issues);
      checkOptionalUrl(entity, issues);
      checkStringField(entity, 'created_at', issues);
      checkStringField(entity, 'actor', issues);
      break;
    }
    case 'workflow_job': {
      checkSafePositiveInt(entity, 'job_id', issues);
      if (entity.job_id === undefined) issues.push('job_id is required');
      checkSafePositiveInt(entity, 'run_id', issues);
      if (entity.run_id === undefined) issues.push('run_id is required');
      if (typeof entity.name !== 'string' || entity.name.length === 0) issues.push('name is required');
      checkStringField(entity, 'status', issues);
      checkStringField(entity, 'conclusion', issues);
      checkStringField(entity, 'started_at', issues);
      checkStringField(entity, 'completed_at', issues);
      checkOptionalUrl(entity, issues);
      break;
    }
  }
  return { ok: issues.length === 0, issues };
}

// ── Result pages ──

export interface GithubPageV1 {
  entities: GithubEntityV1[];
  pagination: {
    supported: boolean;
    limit: number;
    returned: number;
    hasMore: boolean;
    nextCursor?: string;
  };
  partial: boolean;
  warnings: string[];
}

const GITHUB_TEXT_FIELDS: readonly string[] = ['readme', 'content', 'body', 'message', 'snippet', 'description'];

function githubEntityTextLength(entity: GithubEntityV1): number {
  const row = entity as unknown as Record<string, unknown>;
  return GITHUB_TEXT_FIELDS.reduce(
    (sum, field) => sum + (typeof row[field] === 'string' ? (row[field] as string).length : 0),
    0,
  );
}

export function dedupeGithubEntities(entities: GithubEntityV1[]): GithubEntityV1[] {
  const seen = new Set<string>();
  const out: GithubEntityV1[] = [];
  for (const entity of entities) {
    if (seen.has(entity.id)) continue;
    seen.add(entity.id);
    out.push(entity);
  }
  return out;
}

export function validateGithubPage(value: unknown): { ok: boolean; issues: string[]; page?: GithubPageV1 } {
  const issues: string[] = [];
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return { ok: false, issues: ['page is not an object'] };
  }
  const page = value as Record<string, unknown>;
  for (const key of Object.keys(page)) {
    if (key !== 'entities' && key !== 'pagination' && key !== 'partial' && key !== 'warnings') {
      issues.push(`${key} is not a known page field`);
    }
  }
  if (page.backend_text !== undefined || page.backendText !== undefined) {
    issues.push('backend_text is not allowed on github paths');
  }
  if (!Array.isArray(page.entities)) {
    issues.push('entities must be an array');
  } else {
    for (const [index, entity] of page.entities.entries()) {
      const check = validateGithubEntity(entity);
      if (!check.ok) issues.push(`entities[${index}]: ${check.issues.join('; ')}`);
    }
    if (issues.length === 0) {
      const entities = page.entities as GithubEntityV1[];
      if (dedupeGithubEntities(entities).length !== entities.length) {
        issues.push('entities contain duplicate ids (dedupe by id, first-wins)');
      }
      const total = entities.reduce((sum, entity) => sum + githubEntityTextLength(entity), 0);
      if (total > GITHUB_PAGE_CONTENT_MAX) {
        issues.push(`page content exceeds maximum of ${GITHUB_PAGE_CONTENT_MAX} chars`);
      }
    }
  }
  if (typeof page.partial !== 'boolean') issues.push('partial must be a boolean');
  if (!Array.isArray(page.warnings) || page.warnings.some((warning) => typeof warning !== 'string')) {
    issues.push('warnings must be an array of strings');
  }
  if (typeof page.pagination !== 'object' || page.pagination === null || Array.isArray(page.pagination)) {
    issues.push('pagination must be an object');
  } else {
    const pagination = page.pagination as Record<string, unknown>;
    if (typeof pagination.supported !== 'boolean') issues.push('pagination.supported must be a boolean');
    if (typeof pagination.hasMore !== 'boolean') issues.push('pagination.hasMore must be a boolean');
    if (typeof pagination.limit !== 'number' || !Number.isFinite(pagination.limit)) {
      issues.push('pagination.limit must be a finite number');
    }
    if (typeof pagination.returned !== 'number' || !Number.isFinite(pagination.returned)) {
      issues.push('pagination.returned must be a finite number');
    }
    if (Array.isArray(page.entities) && pagination.returned !== page.entities.length) {
      issues.push('pagination.returned must equal entities.length');
    }
    if (pagination.supported === false) {
      if (pagination.hasMore === true) issues.push('hasMore must be false when pagination is unsupported');
      if (pagination.nextCursor !== undefined) issues.push('nextCursor is not issued when pagination is unsupported');
    } else {
      if (pagination.hasMore === true) {
        if (typeof pagination.nextCursor !== 'string' || pagination.nextCursor.length === 0) {
          issues.push('hasMore true requires a nextCursor');
        }
      }
      if (pagination.nextCursor !== undefined && pagination.hasMore !== true) {
        issues.push('nextCursor present requires hasMore true');
      }
    }
  }
  return issues.length === 0 ? { ok: true, issues, page: page as unknown as GithubPageV1 } : { ok: false, issues };
}

// ── Pagination cursors (Link-header lists) ──
// Opaque base64url JSON bound to action/backend plus a fingerprint pinning
// owner/repo/action/limit. Cursors carry the upstream Link-header page state in
// typed state; they never contain tokens or URLs. Single-shot actions
// (repo/file/tree/trending) never issue cursors.

export const GITHUB_MAX_CURSOR_LENGTH = 4096;

export type GithubCursorState = Record<string, string | number | boolean>;

export interface GithubCursorV1 {
  v: 1;
  action: GithubAction;
  backend: string;
  fingerprint: string;
  state: GithubCursorState;
}

export interface DecodedGithubCursor {
  action: GithubAction;
  backend: string;
  state: GithubCursorState;
}

const FORBIDDEN_GITHUB_CURSOR_SUBSTRINGS: readonly string[] = [
  'token',
  'cookie',
  'authorization',
  'bearer',
  'password',
  'secret',
  'api_key',
  'apikey',
  'http://',
  'https://',
];

function assertGithubCursorSafe(state: GithubCursorState): void {
  for (const [key, value] of Object.entries(state)) {
    if (key.length === 0) {
      throw githubError('cursor_invalid', 'cursor state keys must be non-empty');
    }
    const haystack = `${key} ${typeof value === 'string' ? value : ''}`.toLowerCase();
    for (const forbidden of FORBIDDEN_GITHUB_CURSOR_SUBSTRINGS) {
      if (haystack.includes(forbidden)) {
        throw githubError('cursor_invalid', `cursor state contains forbidden material in "${key}"`);
      }
    }
  }
}

export interface GithubCursorFingerprintInput {
  action: GithubAction;
  owner?: string;
  repo?: string;
  limit: number;
  workflow?: string;
  ref?: string;
  status?: string;
  number?: number;
  author?: string;
  jobs?: boolean;
}

/** SHA-256 fingerprint pinning action/owner/repo/limit plus every
 * result-shaping selector (workflow, ref, status, number, author, jobs), so a
 * cursor cannot be reused with a different query. */
export function githubCursorFingerprint(input: GithubCursorFingerprintInput): string {
  const parts: string[] = [
    input.action,
    input.owner ?? '',
    input.repo ?? '',
    String(input.limit),
    input.workflow ?? '',
    input.ref ?? '',
    input.status ?? '',
    input.number !== undefined ? String(input.number) : '',
    input.author ?? '',
    input.jobs === true ? 'jobs' : '',
  ];
  return createHash('sha256').update(parts.join('|'), 'utf8').digest('hex');
}

export function encodeGithubCursor(input: {
  action: GithubAction;
  backend: string;
  fingerprint: string;
  state: GithubCursorState;
}): string {
  assertGithubCursorSafe(input.state);
  const payload: GithubCursorV1 = {
    v: 1,
    action: input.action,
    backend: input.backend,
    fingerprint: input.fingerprint,
    state: input.state,
  };
  const encoded = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  if (encoded.length > GITHUB_MAX_CURSOR_LENGTH) {
    throw githubError('cursor_invalid', `cursor exceeds maximum length of ${GITHUB_MAX_CURSOR_LENGTH}`);
  }
  return encoded;
}

/**
 * Decode and verify a cursor against the current request. Rejects malformed
 * tokens (cursor_invalid) and cursors bound to a different action, backend, or
 * selector fingerprint (cursor_mismatch). A cursor-pinned request must never
 * switch backends.
 */
export function decodeGithubCursor(
  cursor: string,
  expected: { action: GithubAction; backend: string; fingerprint: string },
): DecodedGithubCursor {
  if (typeof cursor !== 'string' || cursor.length === 0) {
    throw githubError('cursor_invalid', 'cursor is required');
  }
  if (cursor.length > GITHUB_MAX_CURSOR_LENGTH) {
    throw githubError('cursor_invalid', `cursor exceeds maximum length of ${GITHUB_MAX_CURSOR_LENGTH}`);
  }
  let payload: unknown;
  try {
    payload = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
  } catch {
    throw githubError('cursor_invalid', 'cursor is not a valid opaque token');
  }
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
    throw githubError('cursor_invalid', 'cursor payload is invalid');
  }
  const record = payload as Record<string, unknown>;
  if (record.v !== 1) throw githubError('cursor_invalid', 'cursor payload version must be 1');
  if (!isGithubAction(record.action)) throw githubError('cursor_invalid', 'cursor action is invalid');
  if (
    typeof record.backend !== 'string' ||
    record.backend.length === 0 ||
    typeof record.fingerprint !== 'string' ||
    record.fingerprint.length === 0
  ) {
    throw githubError('cursor_invalid', 'cursor backend/fingerprint is invalid');
  }
  if (
    typeof record.state !== 'object' ||
    record.state === null ||
    Array.isArray(record.state) ||
    !Object.values(record.state as Record<string, unknown>).every(
      (entry) => typeof entry === 'string' || typeof entry === 'number' || typeof entry === 'boolean',
    )
  ) {
    throw githubError('cursor_invalid', 'cursor state contains non-scalar values');
  }
  const state = record.state as GithubCursorState;
  assertGithubCursorSafe(state);
  if (record.action !== expected.action || record.backend !== expected.backend || record.fingerprint !== expected.fingerprint) {
    throw githubError(
      'cursor_mismatch',
      `cursor was issued for ${String(record.action)}/${String(record.backend)}, not ${expected.action}/${expected.backend}`,
      { backend: expected.backend },
    );
  }
  return { action: record.action, backend: record.backend as string, state };
}

// ── Backend plan seam ──

export interface GithubExecutionContext {
  /** Abort signal propagated to every backend execution. */
  signal?: AbortSignal;
}

export interface GithubBackendPlan {
  backend: string;
  authTier: GithubAuthTier;
  pagination: GithubPaginationMode;
  /** Fallback or limited backend contributing to degraded status. */
  degraded: boolean;
  quality: GithubBackendQuality;
  execute(signal?: AbortSignal): Promise<unknown>;
}

export interface GithubWorker {
  readonly backends: readonly string[];
  plans(request: GithubRequest, context: GithubExecutionContext): Promise<readonly GithubBackendPlan[]>;
  normalize(request: GithubRequest, plan: GithubBackendPlan, payload: unknown): GithubPageV1;
}

/** Single REST v3 backend for every canonical action. */
export const GITHUB_BACKEND_PREFERENCE: Readonly<Record<GithubAction, readonly string[]>> = {
  repo: ['github-api'],
  file: ['github-api'],
  tree: ['github-api'],
  search: ['github-api'],
  trending: ['github-api'],
  issues: ['github-api'],
  workflows: ['github-api'],
  runs: ['github-api'],
  pulls: ['github-api'],
  releases: ['github-api'],
  commits: ['github-api'],
  search_repos: ['github-api'],
};

const GITHUB_AUTH_TIER_RANK: Readonly<Record<GithubAuthTier, number>> = {
  env_var: 0,
  anonymous: 1,
};

/**
 * Resolve the auth tier from the environment. Token is optional: GITHUB_TOKEN
 * (or GH_TOKEN) selects env_var, absence falls back to anonymous rate limits.
 */
export function resolveGithubAuthTier(env?: Record<string, string | undefined>): GithubAuthTier {
  const token = env?.GITHUB_TOKEN ?? env?.GH_TOKEN ?? process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN;
  return token !== undefined && token.length > 0 ? 'env_var' : 'anonymous';
}

function githubPreferenceIndex(action: GithubAction, backend: string): number {
  const index = GITHUB_BACKEND_PREFERENCE[action].indexOf(backend);
  return index >= 0 ? index : GITHUB_BACKEND_PREFERENCE[action].length;
}

function githubPaginationRank(pagination: GithubPaginationMode): number {
  return pagination === 'cursor' ? 0 : 1;
}

/**
 * Order backend plans: non-degraded first, full quality before degraded,
 * cursor-capable before unsupported, then authenticated before anonymous, then
 * per-action backend preference. Mirrors orderMediaPlans.
 */
export function orderGithubPlans(action: GithubAction, plans: readonly GithubBackendPlan[]): GithubBackendPlan[] {
  return [...plans].sort((a, b) => {
    if (a.degraded !== b.degraded) return a.degraded ? 1 : -1;
    const qualityRank = (quality: GithubBackendQuality): number => (quality === 'full' ? 0 : 1);
    if (qualityRank(a.quality) !== qualityRank(b.quality)) {
      return qualityRank(a.quality) - qualityRank(b.quality);
    }
    const pagination = githubPaginationRank(a.pagination) - githubPaginationRank(b.pagination);
    if (pagination !== 0) return pagination;
    const tier = GITHUB_AUTH_TIER_RANK[a.authTier] - GITHUB_AUTH_TIER_RANK[b.authTier];
    if (tier !== 0) return tier;
    return githubPreferenceIndex(action, a.backend) - githubPreferenceIndex(action, b.backend);
  });
}
