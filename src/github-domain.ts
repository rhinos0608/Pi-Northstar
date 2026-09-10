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

import type { BackendCallResult } from './backend.js';
import { fetchInit, safeResponseText } from './http.js';
import { buildNorthstarResult, type NorthstarEntityV1 } from './result-contract.js';
import { northstarTextResult } from './tool-output.js';
import { SocialError } from './social-contract.js';
import {
  decodeGithubCursor,
  encodeGithubCursor,
  GITHUB_ENTITY_CONTENT_MAX,
  githubCursorFingerprint,
  githubPaginationSupported,
  validateGithubPage,
  validateGithubPath,
  validateGithubRequest,
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

function capped(text: string): string {
  return text.length > GITHUB_ENTITY_CONTENT_MAX ? text.slice(0, GITHUB_ENTITY_CONTENT_MAX) : text;
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

function loginOf(value: unknown): string | undefined {
  if (!isRecord(value)) return undefined;
  const login = value.login;
  return typeof login === 'string' && login.length > 0 ? login : undefined;
}

function labelNames(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const names = value.flatMap((entry) => {
    if (typeof entry === 'string' && entry.length > 0) return [entry];
    if (isRecord(entry) && typeof entry.name === 'string' && entry.name.length > 0) return [entry.name];
    return [];
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

async function githubFetch(url: string, env: Record<string, string | undefined>, signal?: AbortSignal): Promise<Fetched> {
  const headers: Record<string, string> = {
    Accept: 'application/vnd.github+json',
    'User-Agent': USER_AGENT,
  };
  const token = githubToken(env);
  if (token !== undefined) headers.Authorization = `Bearer ${token}`;
  let response: Response;
  try {
    response = await fetch(url, fetchInit(headers, signal));
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') throw error;
    throw githubError('upstream_error', 'GitHub request failed before any response was received');
  }
  if (!response.ok) {
    if (response.status === 401) throw githubError('authentication_required', 'GitHub authentication_required: invalid or missing token');
    if (response.status === 403 || response.status === 429) {
      // Single-attempt: no automatic retry loop. The Retry-After hint is
      // surfaced on the error cause as a bare clamped number for the caller.
      const retryAfter = parseGithubRetryAfter(response.headers.get('retry-after'));
      throw githubError('rate_limited', 'GitHub rate_limited: quota exhausted, retry later', {
        ...(retryAfter !== undefined ? { cause: { retryAfter } } : {}),
      });
    }
    if (response.status === 404) throw githubError('not_found', 'GitHub not_found: resource does not exist');
    throw githubError('upstream_error', `GitHub upstream_error: request failed with status ${response.status}`);
  }
  // Redacted label instead of the URL: size-limit errors must not echo the URL.
  const text = await safeResponseText(response, BACKEND);
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    throw githubError('malformed_upstream', 'GitHub response was not valid JSON');
  }
  return { data, link: response.headers.get('link') };
}

function repoUrl(owner: string, repo: string): string {
  return `${API_BASE}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;
}

function pageNumber(request: GithubRequest): number {
  if (request.cursor === undefined) return 1;
  let decoded: { state: Record<string, string | number | boolean> };
  try {
    decoded = decodeGithubCursor(request.cursor, {
      action: request.action,
      backend: BACKEND,
      fingerprint: githubCursorFingerprint({
        action: request.action,
        ...(request.owner !== undefined ? { owner: request.owner } : {}),
        ...(request.repo !== undefined ? { repo: request.repo } : {}),
        limit: request.limit,
      }),
    });
  } catch (error) {
    // Contract distinguishes malformed vs mismatched cursors; the domain
    // surfaces both as cursor_invalid per the Stage 5 contract.
    if (error instanceof SocialError && (error.code === 'cursor_mismatch' || error.code === 'cursor_invalid')) {
      throw githubError('cursor_invalid', error.message);
    }
    throw error;
  }
  const page = decoded.state.page;
  return typeof page === 'number' && Number.isInteger(page) && page >= 1 ? page : 1;
}

function nextCursor(request: GithubRequest, link: string | null, page: number): string | undefined {
  if (!githubPaginationSupported(request.action)) return undefined;
  if (link === null || !/rel="next"/.test(link)) return undefined;
  return encodeGithubCursor({
    action: request.action,
    backend: BACKEND,
    fingerprint: githubCursorFingerprint({
      action: request.action,
      ...(request.owner !== undefined ? { owner: request.owner } : {}),
      ...(request.repo !== undefined ? { repo: request.repo } : {}),
      limit: request.limit,
    }),
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
  if (description !== undefined) entity.description = capped(description);
  const stars = numberField(row, 'stargazers_count');
  if (stars !== undefined) entity.stars = stars;
  const forks = numberField(row, 'forks_count') ?? numberField(row, 'forks');
  if (forks !== undefined) entity.forks = forks;
  const language = stringField(row, 'language');
  if (language !== undefined) entity.language = language;
  const branch = stringField(row, 'default_branch');
  if (branch !== undefined) entity.default_branch = branch;
  if (readme !== undefined) entity.readme = capped(readme);
  return entity;
}

function normalizeFileContent(path: string, row: Record<string, unknown>, owner: string, repo: string, ref?: string): GithubEntityV1 {
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
  const content = stringField(row, 'content');
  const encoding = stringField(row, 'encoding');
  if (content !== undefined && encoding === 'base64') {
    // Binary or undecodable payloads omit content and keep metadata.
    const stripped = content.replace(/\s/g, '');
    if (/^[A-Za-z0-9+/=]*$/.test(stripped) && stripped.length > 0) {
      entity.content = capped(Buffer.from(stripped, 'base64').toString('utf8'));
      entity.encoding = 'utf8';
    }
  } else if (content !== undefined) {
    entity.content = capped(content);
    if (encoding !== undefined) entity.encoding = encoding;
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
  if (body !== undefined) entity.body = capped(body);
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
  if (body !== undefined) entity.body = capped(body);
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
  if (message !== undefined) entity.message = capped(message);
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
          readme = Buffer.from(content.replace(/\s/g, ''), 'base64').toString('utf8').slice(0, GITHUB_ENTITY_CONTENT_MAX);
        }
      }
    } catch {
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
  return [normalizeFileContent(path, data, owner, repo, request.ref)];
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
  const { data, link } = await githubFetch(searchUrl(`${API_BASE}/search/code`, q, request.limit, pageNum), env, signal);
  if (!isRecord(data) || !Array.isArray(data.items)) throw githubError('malformed_upstream', 'GitHub search response was not an object');
  const entities = (data.items as unknown[]).flatMap((item): GithubEntityV1[] => {
    if (!isRecord(item)) return [];
    try {
      return [normalizeCodeItem(item)];
    } catch {
      return [];
    }
  }).slice(0, request.limit);
  const cursor = nextCursor(request, link, pageNum);
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

async function handleSearchRepos(request: GithubRequest, env: Record<string, string | undefined>, signal?: AbortSignal): Promise<{ page: GithubPageV1; degraded: boolean }> {
  const pageNum = pageNumber(request);
  let q = request.query!;
  if (request.language !== undefined) q += ` language:${request.language}`;
  const { data, link } = await githubFetch(searchUrl(`${API_BASE}/search/repositories`, q, request.limit, pageNum), env, signal);
  if (!isRecord(data) || !Array.isArray(data.items)) throw githubError('malformed_upstream', 'GitHub repository search response was not an object');
  const entities = (data.items as unknown[]).flatMap((item): GithubEntityV1[] => {
    if (!isRecord(item)) return [];
    return [normalizeRepo(item)];
  }).slice(0, request.limit);
  const cursor = nextCursor(request, link, pageNum);
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

async function handleIssues(request: GithubRequest, env: Record<string, string | undefined>, signal?: AbortSignal): Promise<{ page: GithubPageV1; degraded: boolean }> {
  const owner = request.owner!;
  const repo = request.repo!;
  if (request.number !== undefined) {
    const { data } = await githubFetch(`${repoUrl(owner, repo)}/issues/${request.number}`, env, signal);
    if (!isRecord(data)) throw githubError('malformed_upstream', 'GitHub issue response was not an object');
    const page = checkPage({
      entities: [normalizeIssue(data, owner, repo)],
      pagination: { supported: true, limit: request.limit, returned: 1, hasMore: false },
      partial: false,
      warnings: [],
    });
    return { page, degraded: false };
  }
  const pageNum = pageNumber(request);
  const url = new URL(`${repoUrl(owner, repo)}/issues`);
  url.searchParams.set('state', request.state ?? 'open');
  if (request.labels !== undefined) url.searchParams.set('labels', request.labels.join(','));
  url.searchParams.set('per_page', String(request.limit));
  url.searchParams.set('page', String(pageNum));
  const { data, link } = await githubFetch(url.href, env, signal);
  if (!Array.isArray(data)) throw githubError('malformed_upstream', 'GitHub issues response was not a list');
  const entities = data.flatMap((item): GithubEntityV1[] => {
    if (!isRecord(item)) return [];
    return [normalizeIssue(item, owner, repo)];
  }).slice(0, request.limit);
  const cursor = nextCursor(request, link, pageNum);
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

async function handlePulls(request: GithubRequest, args: Record<string, unknown>, env: Record<string, string | undefined>, signal?: AbortSignal): Promise<{ page: GithubPageV1; degraded: boolean }> {
  const owner = request.owner!;
  const repo = request.repo!;
  if (request.number !== undefined && args.files === true) {
    const { data } = await githubFetch(`${repoUrl(owner, repo)}/pulls/${request.number}/files`, env, signal);
    if (!Array.isArray(data)) throw githubError('malformed_upstream', 'GitHub pull files response was not a list');
    const entities = data.flatMap((item): GithubEntityV1[] => {
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
      if (patch !== undefined) entity.content = capped(patch);
      return [entity];
    }).slice(0, request.limit);
    const page = checkPage({
      entities,
      pagination: { supported: true, limit: request.limit, returned: entities.length, hasMore: false },
      partial: false,
      warnings: [],
    });
    return { page, degraded: false };
  }
  if (request.number !== undefined) {
    const { data } = await githubFetch(`${repoUrl(owner, repo)}/pulls/${request.number}`, env, signal);
    if (!isRecord(data)) throw githubError('malformed_upstream', 'GitHub pull response was not an object');
    const page = checkPage({
      entities: [normalizePull(data, owner, repo)],
      pagination: { supported: true, limit: request.limit, returned: 1, hasMore: false },
      partial: false,
      warnings: [],
    });
    return { page, degraded: false };
  }
  const pageNum = pageNumber(request);
  const url = new URL(`${repoUrl(owner, repo)}/pulls`);
  url.searchParams.set('state', request.state ?? 'open');
  url.searchParams.set('per_page', String(request.limit));
  url.searchParams.set('page', String(pageNum));
  const { data, link } = await githubFetch(url.href, env, signal);
  if (!Array.isArray(data)) throw githubError('malformed_upstream', 'GitHub pulls response was not a list');
  const entities = data.flatMap((item): GithubEntityV1[] => {
    if (!isRecord(item)) return [];
    return [normalizePull(item, owner, repo)];
  }).slice(0, request.limit);
  const cursor = nextCursor(request, link, pageNum);
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

async function handleReleases(request: GithubRequest, args: Record<string, unknown>, env: Record<string, string | undefined>, signal?: AbortSignal): Promise<{ page: GithubPageV1; degraded: boolean }> {
  const owner = request.owner!;
  const repo = request.repo!;
  if (request.tag !== undefined) {
    const { data } = await githubFetch(`${repoUrl(owner, repo)}/releases/tags/${encodeURIComponent(request.tag)}`, env, signal);
    if (!isRecord(data)) throw githubError('malformed_upstream', 'GitHub release response was not an object');
    const page = checkPage({
      entities: [normalizeRelease(data, owner, repo)],
      pagination: { supported: true, limit: request.limit, returned: 1, hasMore: false },
      partial: false,
      warnings: [],
    });
    return { page, degraded: false };
  }
  if (args.latest === true) {
    const { data } = await githubFetch(`${repoUrl(owner, repo)}/releases/latest`, env, signal);
    if (!isRecord(data)) throw githubError('malformed_upstream', 'GitHub release response was not an object');
    const page = checkPage({
      entities: [normalizeRelease(data, owner, repo)],
      pagination: { supported: true, limit: request.limit, returned: 1, hasMore: false },
      partial: false,
      warnings: [],
    });
    return { page, degraded: false };
  }
  const pageNum = pageNumber(request);
  const url = new URL(`${repoUrl(owner, repo)}/releases`);
  url.searchParams.set('per_page', String(request.limit));
  url.searchParams.set('page', String(pageNum));
  const { data, link } = await githubFetch(url.href, env, signal);
  if (!Array.isArray(data)) throw githubError('malformed_upstream', 'GitHub releases response was not a list');
  const entities = data.flatMap((item): GithubEntityV1[] => {
    if (!isRecord(item)) return [];
    return [normalizeRelease(item, owner, repo)];
  }).slice(0, request.limit);
  const cursor = nextCursor(request, link, pageNum);
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

async function handleCommits(request: GithubRequest, args: Record<string, unknown>, env: Record<string, string | undefined>, signal?: AbortSignal): Promise<{ page: GithubPageV1; degraded: boolean }> {
  const owner = request.owner!;
  const repo = request.repo!;
  if (request.sha !== undefined) {
    const { data } = await githubFetch(`${repoUrl(owner, repo)}/commits/${request.sha}`, env, signal);
    if (!isRecord(data)) throw githubError('malformed_upstream', 'GitHub commit response was not an object');
    const page = checkPage({
      entities: [normalizeCommit(data, owner, repo)],
      pagination: { supported: true, limit: request.limit, returned: 1, hasMore: false },
      partial: false,
      warnings: [],
    });
    return { page, degraded: false };
  }
  const pageNum = pageNumber(request);
  const url = new URL(`${repoUrl(owner, repo)}/commits`);
  if (request.path !== undefined) url.searchParams.set('path', request.path);
  const author = optionalString(args.author);
  if (author !== undefined) url.searchParams.set('author', author);
  if (request.since !== undefined) url.searchParams.set('since', request.since);
  if (request.ref !== undefined) url.searchParams.set('sha', request.ref);
  url.searchParams.set('per_page', String(request.limit));
  url.searchParams.set('page', String(pageNum));
  const { data, link } = await githubFetch(url.href, env, signal);
  if (!Array.isArray(data)) throw githubError('malformed_upstream', 'GitHub commits response was not a list');
  const entities = data.flatMap((item): GithubEntityV1[] => {
    if (!isRecord(item)) return [];
    return [normalizeCommit(item, owner, repo)];
  }).slice(0, request.limit);
  const cursor = nextCursor(request, link, pageNum);
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
    const response = await fetch(`https://github.com/trending?since=${encodeURIComponent(since)}`, fetchInit(headers, signal));
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

// ── Entrypoint ──

function resolvePaths(args: Record<string, unknown>, action: string): string[] {
  const rawPaths = args.paths;
  const rawPath = args.path;
  if (rawPaths !== undefined && rawPath !== undefined) {
    throw githubError('invalid_request', 'path and paths are mutually exclusive');
  }
  if (rawPaths !== undefined) {
    if (action !== 'file') throw githubError('invalid_request', 'paths is only supported for github file');
    if (!Array.isArray(rawPaths) || rawPaths.length === 0) throw githubError('invalid_request', 'paths must be a non-empty array of strings');
    if (rawPaths.length > MULTI_FILE_MAX) {
      throw githubError('invalid_request', `paths exceeds maximum of ${MULTI_FILE_MAX} entries`);
    }
    return rawPaths.map((entry) => {
      if (typeof entry !== 'string' || entry.trim().length === 0) throw githubError('invalid_request', 'paths entries must be non-empty strings');
      return validateGithubPath(entry.replace(/^\/+/, ''));
    });
  }
  if (typeof rawPath === 'string') {
    return [validateGithubPath(rawPath.replace(/^\/+/, ''))];
  }
  return [];
}

function rejectMisplacedFlags(args: Record<string, unknown>, action: string): void {
  if (args.files !== undefined && !(action === 'pulls')) {
    throw githubError('invalid_request', 'files is only supported for github pulls');
  }
  if (args.files === true && (action !== 'pulls')) {
    throw githubError('invalid_request', 'files is only supported for github pulls');
  }
  if (args.latest !== undefined && action !== 'releases') {
    throw githubError('invalid_request', 'latest is only supported for github releases');
  }
  if (args.recursive !== undefined && action !== 'tree') {
    throw githubError('invalid_request', 'recursive is only supported for github tree');
  }
  if (args.includeReadme !== undefined && action !== 'repo') {
    throw githubError('invalid_request', 'includeReadme is only supported for github repo');
  }
  if (args.author !== undefined && action !== 'commits') {
    throw githubError('invalid_request', 'author is only supported for github commits');
  }
}

function entityTitle(entity: GithubEntityV1): string {
  switch (entity.kind) {
    case 'repo': return entity.full_name ?? entity.name ?? entity.id;
    case 'file': return entity.path;
    case 'tree': return entity.id;
    case 'search_result': return entity.title ?? entity.path ?? entity.id;
    case 'issue': return `#${entity.number} ${entity.title}`;
    case 'pull': return `#${entity.number} ${entity.title}`;
    case 'release': return entity.name ?? entity.tag;
    case 'commit': return entity.message?.split('\n')[0] ?? entity.sha;
  }
}

function entitySnippet(entity: GithubEntityV1): string | undefined {
  switch (entity.kind) {
    case 'repo': return entity.description;
    case 'file': return entity.content?.slice(0, 2000);
    case 'tree': return undefined;
    case 'search_result': return entity.snippet;
    case 'issue': return entity.body?.slice(0, 2000);
    case 'pull': return entity.body?.slice(0, 2000);
    case 'release': return entity.body?.slice(0, 2000);
    case 'commit': return entity.message?.slice(0, 2000);
  }
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
    ...(typeof args.cursor === 'string' ? { cursor: args.cursor } : {}),
  });

  const signal = options.signal;
  let result: { page: GithubPageV1; degraded: boolean };
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
  }

  const { page, degraded } = result;
  const allWarnings = [...validationWarnings, ...page.warnings];
  const notes = [...allWarnings];
  if (page.partial) notes.push('partial: some upstream rows were dropped or truncated');
  if (degraded) notes.push('degraded: github-api is a limited fallback backend');
  const envelope = buildNorthstarResult({
    request: { tool: 'github', channel: 'github', action: request.action, source: BACKEND },
    outcomes: [{
      source: 'github',
      backend: BACKEND,
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
    backend: BACKEND,
    entities: page.entities,
    pagination: page.pagination,
    partial: page.partial,
    warnings: allWarnings,
  };
  return northstarTextResult(renderPage(page, request), legacyDetails, envelope);
}
