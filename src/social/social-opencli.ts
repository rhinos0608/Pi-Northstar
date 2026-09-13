// Stage 2 social worker for the OpenCLI backends: Facebook, Instagram, and
// LinkedIn (verified against OpenCLI 1.8.6, `-f json` output).
//
// This worker owns the closed argv mapping, the sanitized child environment,
// JSON payload parsing, and platform normalization for its three platforms.
// It never chooses global fallback order (the central integrator does that)
// and it never dispatches download, write, or mutation commands. Instagram
// has no read/post action: any post-detail request resolves to a
// deterministic unsupported_action with no child process.
//
// OpenCLI is a Node CLI that reads its own logged-in Chrome session; it is
// NOT a Python child and therefore does not use buildPythonChildEnvironment().
// It still gets a sanitized allowlisted environment (openCliChildEnv) so stored
// cookies, API keys, and tokens never reach the subprocess.

import { spawnCliCommand } from '../process/cli-command.js';
import { redactCliDiagnostics, requireCliPositional } from './social-cli-safety.js';
import {
  SocialError,
  parseSocialDate,
  socialEntityId,
  validateSocialEntity,
  type BackendActionCapability,
  type BackendCapability,
  type SocialAction,
  type SocialBackendPlan,
  type SocialEntityV1,
  type SocialExecutionContext,
  type SocialPageV1,
  type SocialPlatform,
  type SocialPlatformWorker,
  type SocialRequest,
} from './social-contract.js';

// ── Verified capability registry data (OpenCLI 1.8.6) ──

export const OPENCLI_VERSION = '1.8.6';
export const OPENCLI_BACKEND = 'opencli';

const COMMAND_TIMEOUT_MS = 120_000;
const MAX_OUTPUT_CHARS = 1_000_000;
const SIGKILL_AFTER_MS = 5_000;

/** LinkedIn people-search hard cap; every query consumes the Commercial Use Limit. */
const LINKEDIN_PEOPLE_SEARCH_MAX = 10;

const cookieAuth = ['cookie'] as const;
const noPagination = 'none' as const;

function operation(
  action: SocialAction,
  upstreamAction: string[],
  required: BackendActionCapability['required'],
  maxLimit = 100,
): BackendActionCapability {
  return { action, upstreamAction, auth: cookieAuth, pagination: noPagination, required, maxLimit };
}

/**
 * LinkedIn social search uses `people-search`, never `opencli linkedin search`
 * (which searches jobs). Each invocation consumes LinkedIn's monthly
 * Commercial Use Limit, so the action is capped at 10 results.
 */
export const OPENCLI_FACEBOOK_CAPABILITY: BackendCapability = {
  name: OPENCLI_BACKEND,
  type: 'external',
  command: 'opencli',
  verifiedVersion: OPENCLI_VERSION,
  operations: [
    operation('search', ['search'], ['query']),
    operation('get_profile', ['profile'], ['user']),
    operation('get_feed', ['feed'], []),
    operation('get_notifications', ['notifications'], []),
    // OpenCLI groups is an account-owned listing; the community selector is
    // not applied upstream. Declared because it is the only verified command.
    operation('get_community', ['groups'], ['community']),
  ],
};

export const OPENCLI_INSTAGRAM_CAPABILITY: BackendCapability = {
  name: OPENCLI_BACKEND,
  type: 'external',
  command: 'opencli',
  verifiedVersion: OPENCLI_VERSION,
  operations: [
    operation('search', ['search'], ['query']),
    operation('get_profile', ['profile'], ['user']),
    operation('get_user_posts', ['user'], ['user']),
    operation('get_followers', ['followers'], ['user']),
    operation('get_following', ['following'], ['user']),
    operation('get_trending', ['explore'], []),
    operation('get_saved', ['saved'], []),
  ],
};

export const OPENCLI_LINKEDIN_CAPABILITY: BackendCapability = {
  name: OPENCLI_BACKEND,
  type: 'external',
  command: 'opencli',
  verifiedVersion: OPENCLI_VERSION,
  operations: [
    operation('search', ['people-search'], ['query'], LINKEDIN_PEOPLE_SEARCH_MAX),
    operation('get_profile', ['profile-read'], ['user']),
    operation('get_user_posts', ['posts'], ['user']),
    operation('get_feed', ['timeline'], []),
  ],
};

export const OPENCLI_SOCIAL_CAPABILITIES: readonly BackendCapability[] = [
  OPENCLI_FACEBOOK_CAPABILITY,
  OPENCLI_INSTAGRAM_CAPABILITY,
  OPENCLI_LINKEDIN_CAPABILITY,
];

type OpenCliSite = 'facebook' | 'instagram' | 'linkedin';

const PLATFORM_ACTIONS: Readonly<Record<OpenCliSite, readonly SocialAction[]>> = {
  facebook: OPENCLI_FACEBOOK_CAPABILITY.operations.map((op) => op.action),
  instagram: OPENCLI_INSTAGRAM_CAPABILITY.operations.map((op) => op.action),
  linkedin: OPENCLI_LINKEDIN_CAPABILITY.operations.map((op) => op.action),
};

// Matches the Stage 2 contract wording exactly.
const INSTAGRAM_POST_DETAIL_MESSAGE =
  'instagram read/post is unavailable: no verified read-only post-detail adapter exists; OpenCLI download is intentionally disabled';

const INSTAGRAM_POST_DETAIL_ACTIONS: ReadonlySet<SocialAction> = new Set(['get_post', 'get_thread', 'get_comments']);

// ── Sanitized child environment ──
// OpenCLI reads its own Chrome session; it must never receive stored cookies
// or secret-bearing env vars. Only these operator-owned variables pass through.

const OPENCLI_ENV_ALLOWLIST: readonly string[] = [
  'PATH', 'HOME', 'USERPROFILE', 'TMPDIR', 'TEMP', 'TMP', 'LANG', 'LC_ALL',
  'XDG_CONFIG_HOME', 'XDG_CACHE_HOME', 'XDG_DATA_HOME',
  // Windows spawn essentials (benign, no secrets).
  'SystemRoot', 'windir', 'COMSPEC', 'PATHEXT',
  // Remote OpenCLI instance configuration (operator-owned, see providers.ts).
  'OPENCLI_HOST', 'OPENCLI_PORT', 'OPENCLI_TOKEN',
];

export function openCliChildEnv(source: NodeJS.ProcessEnv): Record<string, string> {
  const env: Record<string, string> = {};
  for (const key of OPENCLI_ENV_ALLOWLIST) {
    const value = source[key];
    if (typeof value === 'string' && value.length > 0) env[key] = value;
  }
  if (env.PATH === undefined) {
    const alt = source.Path ?? source.path;
    if (typeof alt === 'string' && alt.length > 0) env.PATH = alt;
  }
  return env;
}

// ── Subprocess execution ──

export interface OpenCliRunResult {
  code: number;
  stdout: string;
  stderr: string;
  timedOut?: boolean;
}

export type OpenCliExec = (
  command: string,
  args: string[],
  env: Record<string, string>,
  signal: AbortSignal | undefined,
) => Promise<OpenCliRunResult>;

const defaultExec: OpenCliExec = (command, args, env, signal) =>
  new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new SocialError('upstream_error', 'aborted before dispatch'));
      return;
    }
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    // win32: bare commands resolve via PATHEXT; .cmd/.bat shims run through
    // cmd.exe with pre-quoted argv (shell:false cannot execute them — spawn
    // EINVAL; shell:true concatenates args unescaped). See cli-command.ts.
    const child = spawnCliCommand(command, args, { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let killTimer: NodeJS.Timeout | undefined;
    const terminate = () => {
      child.kill('SIGTERM');
      killTimer ??= setTimeout(() => child.kill('SIGKILL'), SIGKILL_AFTER_MS);
    };
    const onAbort = () => terminate();
    signal?.addEventListener('abort', onAbort, { once: true });
    const timer = setTimeout(() => {
      timedOut = true;
      terminate();
    }, COMMAND_TIMEOUT_MS);
    child.stdout.on('data', (chunk) => {
      stdout = (stdout + String(chunk)).slice(-MAX_OUTPUT_CHARS);
    });
    child.stderr.on('data', (chunk) => {
      stderr = (stderr + String(chunk)).slice(-MAX_OUTPUT_CHARS);
    });
    child.on('error', (error: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      signal?.removeEventListener('abort', onAbort);
      if (signal?.aborted) {
        reject(new SocialError('upstream_error', 'aborted during execution'));
        return;
      }
      resolve({ code: error.code === 'ENOENT' ? 127 : 1, stdout, stderr: error.message });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      signal?.removeEventListener('abort', onAbort);
      if (signal?.aborted) {
        reject(new SocialError('upstream_error', 'aborted during execution'));
        return;
      }
      resolve({ code: code ?? 1, stdout, stderr, timedOut });
    });
  });

// ── Closed argv mapping ──
// argv is generated only from this closed mapping. There is no download, no
// write command, no file-output flag, and no browser-opening command anywhere
// in this file.

function linkedinProfileUrl(user: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9\-_%]{2,99}$/.test(user)) {
    throw new SocialError('invalid_request', 'invalid linkedin handle', { platform: 'linkedin' });
  }
  return `https://www.linkedin.com/in/${user}/`;
}

function requireSelector(request: SocialRequest, field: 'query' | 'user'): string {
  return requireCliPositional(request[field], field, request.platform);
}

/**
 * Build the full argv for a validated request, or null when the platform has
 * no OpenCLI mapping. Always ends with `-f json`.
 */
export function buildOpenCliArgs(request: SocialRequest): string[] | null {
  const mapped = mapOpenCliArgs(request);
  return mapped === null ? null : [...mapped, '-f', 'json'];
}

function mapOpenCliArgs(request: SocialRequest): string[] | null {
  const site = request.platform;
  if (site !== 'facebook' && site !== 'instagram' && site !== 'linkedin') return null;
  if (!PLATFORM_ACTIONS[site].includes(request.action)) return null;

  const limit = String(request.limit);
  switch (site) {
    case 'facebook':
      switch (request.action) {
        case 'search':
          return ['opencli', site, 'search', requireSelector(request, 'query'), '--limit', limit];
        case 'get_profile':
          return ['opencli', site, 'profile', requireSelector(request, 'user')];
        case 'get_feed':
          return ['opencli', site, 'feed', '--limit', limit];
        case 'get_notifications':
          return ['opencli', site, 'notifications', '--limit', limit];
        case 'get_community':
          return ['opencli', site, 'groups', '--limit', limit];
        default:
          return null;
      }
    case 'instagram':
      switch (request.action) {
        case 'search':
          return ['opencli', site, 'search', requireSelector(request, 'query'), '--limit', limit];
        case 'get_profile':
          return ['opencli', site, 'profile', requireSelector(request, 'user')];
        case 'get_user_posts':
          return ['opencli', site, 'user', requireSelector(request, 'user'), '--limit', limit];
        case 'get_followers':
          return ['opencli', site, 'followers', requireSelector(request, 'user'), '--limit', limit];
        case 'get_following':
          return ['opencli', site, 'following', requireSelector(request, 'user'), '--limit', limit];
        case 'get_trending':
          return ['opencli', site, 'explore', '--limit', limit];
        case 'get_saved':
          return ['opencli', site, 'saved', '--limit', limit];
        default:
          return null;
      }
    case 'linkedin':
      switch (request.action) {
        case 'search':
          return ['opencli', site, 'people-search', requireSelector(request, 'query'), '--limit', limit];
        case 'get_profile':
          return ['opencli', site, 'profile-read', '--profile-url', linkedinProfileUrl(requireSelector(request, 'user'))];
        case 'get_user_posts':
          return [
            'opencli', site, 'posts',
            '--profile-url', linkedinProfileUrl(requireSelector(request, 'user')),
            '--limit', limit,
          ];
        case 'get_feed':
          return ['opencli', site, 'timeline', '--limit', limit];
        default:
          return null;
      }
  }
  return null;
}

// ── Payload parsing (fail closed on unknown shapes) ──

type PayloadRow = Record<string, unknown>;

function parseRows(payload: unknown, platform: SocialPlatform): PayloadRow[] {
  if (Array.isArray(payload)) {
    if (payload.every((row) => typeof row === 'object' && row !== null && !Array.isArray(row))) {
      return payload as PayloadRow[];
    }
    throw new SocialError('malformed_upstream', `${platform}: opencli JSON rows must be objects`, { platform });
  }
  if (typeof payload === 'object' && payload !== null) {
    return [payload as PayloadRow];
  }
  throw new SocialError('malformed_upstream', `${platform}: opencli payload is not JSON rows`, { platform });
}

function str(row: PayloadRow, keys: readonly string[]): string | undefined {
  for (const key of keys) {
    const value = row[key];
    if (typeof value === 'string' && value.trim().length > 0) return value.trim();
  }
  return undefined;
}

function num(row: PayloadRow, keys: readonly string[]): number | undefined {
  for (const key of keys) {
    const value = row[key];
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (typeof value === 'string' && Number.isFinite(Number(value.replace(/[,+\s]/g, '')))) {
      return Number(value.replace(/[,+\s]/g, ''));
    }
  }
  return undefined;
}

function validHttpUrl(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? value : undefined;
  } catch {
    return undefined;
  }
}

function actorFrom(
  row: PayloadRow,
  handleKeys: readonly string[],
  urlKeys: readonly string[] = [],
): { handle?: string; profileUrl?: string } | undefined {
  const handle = str(row, handleKeys);
  const profileUrl = validHttpUrl(str(row, urlKeys));
  if (handle === undefined && profileUrl === undefined) return undefined;
  const actor: { handle?: string; profileUrl?: string } = {};
  if (handle !== undefined) actor.handle = handle;
  if (profileUrl !== undefined) actor.profileUrl = profileUrl;
  return actor;
}

function linkedinHandleFromUrl(url: string | undefined): string | undefined {
  if (url === undefined) return undefined;
  try {
    const parsed = new URL(url);
    if (parsed.hostname !== 'www.linkedin.com' && parsed.hostname !== 'linkedin.com') return undefined;
    const match = /^\/in\/([^/]+)\/?$/.exec(parsed.pathname);
    return match ? match[1]! : undefined;
  } catch {
    return undefined;
  }
}

// ── Per-command normalization ──

interface NormalizeOutcome {
  entities: SocialEntityV1[];
  warnings: string[];
  partial: boolean;
}

function baseFields(platform: OpenCliSite, kind: SocialEntityV1['kind'], nativeId: string) {
  return {
    version: 1 as const,
    kind,
    id: socialEntityId(platform, kind, nativeId),
    platform,
    backend: OPENCLI_BACKEND,
  };
}

function pushValidated(
  entities: SocialEntityV1[],
  entity: unknown,
  warnings: string[],
): boolean {
  const check = validateSocialEntity(entity);
  if (check.ok) {
    entities.push(entity as SocialEntityV1);
    return true;
  }
  warnings.push(`dropped invalid entity: ${check.issues.join('; ')}`);
  return false;
}

function normalizeFacebook(rows: PayloadRow[], request: SocialRequest, warnings: string[]): NormalizeOutcome {
  const entities: SocialEntityV1[] = [];
  let partial = false;

  for (const [index, row] of rows.entries()) {
    const rowKey = str(row, ['notif_id']) ?? `row-${index}`;
    switch (request.action) {
      case 'search': {
        // Search rows lack enough semantics to be typed posts or profiles.
        const title = str(row, ['title']);
        const snippet = str(row, ['text']);
        const url = validHttpUrl(str(row, ['url']));
        if (title === undefined && snippet === undefined && url === undefined) {
          warnings.push(`dropped empty search row ${index}`);
          partial = true;
          break;
        }
        const entity = {
          ...baseFields('facebook', 'social_reference', rowKey),
          title,
          snippet,
          url,
        };
        if (!pushValidated(entities, entity, warnings)) partial = true;
        break;
      }
      case 'get_profile': {
        const entity = {
          ...baseFields('facebook', 'social_account', rowKey),
          handle: str(row, ['username']),
          displayName: str(row, ['name']),
          url: validHttpUrl(str(row, ['url'])),
          metrics: { followers: num(row, ['followers']) },
        };
        if (!pushValidated(entities, entity, warnings)) partial = true;
        break;
      }
      case 'get_feed': {
        const entity = {
          ...baseFields('facebook', 'social_post', rowKey),
          contentType: 'post' as const,
          text: str(row, ['content']),
          author: actorFrom(row, ['author']),
          metrics: {
            likes: num(row, ['likes']),
            comments: num(row, ['comments']),
            shares: num(row, ['shares']),
          },
        };
        if (!pushValidated(entities, entity, warnings)) partial = true;
        break;
      }
      case 'get_notifications': {
        const entity = {
          ...baseFields('facebook', 'social_notification', rowKey),
          platformId: str(row, ['notif_id']),
          type: str(row, ['notif_type']),
          text: str(row, ['text']),
          url: validHttpUrl(str(row, ['url'])),
          publishedAt: parseSocialDate(str(row, ['time'])),
        };
        if (!pushValidated(entities, entity, warnings)) partial = true;
        break;
      }
      case 'get_community': {
        const entity = {
          ...baseFields('facebook', 'social_community', rowKey),
          name: str(row, ['name']),
          url: validHttpUrl(str(row, ['url'])),
        };
        if (!pushValidated(entities, entity, warnings)) partial = true;
        break;
      }
      default:
        throw new SocialError('unsupported_action', `facebook ${request.action} has no OpenCLI operation`, {
          platform: 'facebook',
        });
    }
  }

  if (request.action === 'get_community') {
    warnings.push('OpenCLI facebook groups lists account-owned groups; the community selector is not applied');
  }
  return { entities, warnings, partial };
}

function normalizeInstagram(rows: PayloadRow[], request: SocialRequest, warnings: string[]): NormalizeOutcome {
  const entities: SocialEntityV1[] = [];
  let partial = false;

  for (const [index, row] of rows.entries()) {
    const rowKey = `row-${index}`;
    switch (request.action) {
      case 'search':
      case 'get_followers':
      case 'get_following': {
        const entity = {
          ...baseFields('instagram', 'social_account', rowKey),
          handle: str(row, ['username']),
          displayName: str(row, ['name']),
          url: validHttpUrl(str(row, ['url'])),
        };
        if (!pushValidated(entities, entity, warnings)) partial = true;
        break;
      }
      case 'get_profile': {
        const entity = {
          ...baseFields('instagram', 'social_account', rowKey),
          handle: str(row, ['username']),
          displayName: str(row, ['name']),
          bio: str(row, ['bio']),
          url: validHttpUrl(str(row, ['url'])),
          metrics: {
            followers: num(row, ['followers']),
            following: num(row, ['following']),
          },
        };
        if (!pushValidated(entities, entity, warnings)) partial = true;
        break;
      }
      case 'get_user_posts':
      case 'get_trending':
      case 'get_saved': {
        const mediaType = str(row, ['type']);
        const entity = {
          ...baseFields('instagram', 'social_post', rowKey),
          contentType: 'post' as const,
          text: str(row, ['caption']),
          author: actorFrom(row, ['user', 'username']),
          publishedAt: parseSocialDate(str(row, ['date'])),
          metrics: {
            likes: num(row, ['likes']),
            comments: num(row, ['comments']),
          },
          ...(mediaType === 'image' || mediaType === 'video'
            ? { media: [{ type: mediaType }] }
            : {}),
        };
        if (!pushValidated(entities, entity, warnings)) partial = true;
        break;
      }
      default:
        throw new SocialError('unsupported_action', `instagram ${request.action} has no OpenCLI operation`, {
          platform: 'instagram',
        });
    }
  }
  return { entities, warnings, partial };
}

function normalizeLinkedin(rows: PayloadRow[], request: SocialRequest, warnings: string[]): NormalizeOutcome {
  const entities: SocialEntityV1[] = [];
  let partial = false;

  for (const [index, row] of rows.entries()) {
    const rowKey = `row-${index}`;
    switch (request.action) {
      case 'search': {
        const entity = {
          ...baseFields('linkedin', 'social_account', rowKey),
          handle: linkedinHandleFromUrl(str(row, ['profile_url'])),
          displayName: str(row, ['name']),
          bio: str(row, ['headline']),
          url: validHttpUrl(str(row, ['profile_url'])),
        };
        if (!pushValidated(entities, entity, warnings)) partial = true;
        break;
      }
      case 'get_profile': {
        const entity = {
          ...baseFields('linkedin', 'social_account', rowKey),
          displayName: str(row, ['name']),
          bio: str(row, ['about', 'headline']),
          url: validHttpUrl(str(row, ['profile_url'])),
        };
        if (!pushValidated(entities, entity, warnings)) partial = true;
        break;
      }
      case 'get_user_posts':
      case 'get_feed': {
        const mediaUrls = row['media_urls'];
        const media = Array.isArray(mediaUrls)
          ? mediaUrls
              .map((entry) => (typeof entry === 'string' ? validHttpUrl(entry) : undefined))
              .filter((entry): entry is string => entry !== undefined)
              .map((url) => ({ url }))
          : [];
        const entity = {
          ...baseFields('linkedin', 'social_post', rowKey),
          contentType: 'post' as const,
          text: str(row, ['body', 'text']),
          author: actorFrom(row, ['author'], ['author_url']),
          publishedAt: parseSocialDate(str(row, ['posted_at'])),
          url: validHttpUrl(str(row, ['url'])),
          metrics: {
            likes: num(row, ['reactions']),
            comments: num(row, ['comments']),
            reposts: num(row, ['reposts']),
            views: num(row, ['impressions']),
          },
          ...(media.length > 0 ? { media } : {}),
        };
        if (!pushValidated(entities, entity, warnings)) partial = true;
        break;
      }
      default:
        throw new SocialError('unsupported_action', `linkedin ${request.action} has no OpenCLI operation`, {
          platform: 'linkedin',
        });
    }
  }
  return { entities, warnings, partial };
}

function normalizeRowsFor(
  platform: OpenCliSite,
  rows: PayloadRow[],
  request: SocialRequest,
  warnings: string[],
): NormalizeOutcome {
  switch (platform) {
    case 'facebook': return normalizeFacebook(rows, request, warnings);
    case 'instagram': return normalizeInstagram(rows, request, warnings);
    case 'linkedin': return normalizeLinkedin(rows, request, warnings);
  }
}

// ── Worker ──

export interface OpenCliWorkerOptions {
  /** Test seam: replaces the subprocess runner. */
  exec?: OpenCliExec;
}

interface OpenCliBackendPlan extends SocialBackendPlan {
  readonly requestWarnings: string[];
}

export function createOpenCliSocialWorker(exec: OpenCliExec | OpenCliWorkerOptions = {}): SocialPlatformWorker {
  const run: OpenCliExec = typeof exec === 'function' ? exec : exec.exec ?? defaultExec;

  function planFor(request: SocialRequest, context: SocialExecutionContext): OpenCliBackendPlan | null {
    if (request.platform !== 'facebook' && request.platform !== 'instagram' && request.platform !== 'linkedin') {
      return null;
    }
    const platform = request.platform;

    // Deterministic unsupported_action with no child process. Instagram has no
    // verified read-only post-detail adapter; download is never dispatched.
    if (!PLATFORM_ACTIONS[platform].includes(request.action)) {
      const message =
        platform === 'instagram' && INSTAGRAM_POST_DETAIL_ACTIONS.has(request.action)
          ? INSTAGRAM_POST_DETAIL_MESSAGE
          : `${platform} ${request.action} is not supported by the opencli backend`;
      throw new SocialError('unsupported_action', message, { platform });
    }

    const requestWarnings: string[] = [];
    if (request.feedVariant !== undefined) {
      requestWarnings.push('feedVariant is ignored by the opencli backend');
    }
    if (platform === 'linkedin' && request.action === 'search') {
      requestWarnings.push('linkedin people-search consumes LinkedIn Commercial Use Limit');
      if (request.limit > LINKEDIN_PEOPLE_SEARCH_MAX) {
        requestWarnings.push(`limit clamped to ${LINKEDIN_PEOPLE_SEARCH_MAX} for linkedin people-search`);
      }
    }
    if (platform === 'facebook' && request.action === 'get_community') {
      requestWarnings.push('community selector is not applied; results are account-owned');
    }

    const args = buildOpenCliArgs(
      platform === 'linkedin' && request.action === 'search' && request.limit > LINKEDIN_PEOPLE_SEARCH_MAX
        ? { ...request, limit: LINKEDIN_PEOPLE_SEARCH_MAX }
        : request,
    );
    if (args === null) {
      throw new SocialError('unsupported_action', `${platform} ${request.action} has no OpenCLI operation`, { platform });
    }

    return {
      backend: OPENCLI_BACKEND,
      authTier: 'cookie',
      pagination: 'none',
      requestWarnings,
      async execute(signal?: AbortSignal): Promise<unknown> {
        const activeSignal = signal ?? context.signal;
        if (activeSignal?.aborted) {
          throw new SocialError('upstream_error', 'aborted before dispatch');
        }
        const childArgs = args.slice(1);
        const childEnv = openCliChildEnv(process.env);
        const result = await run('opencli', childArgs, childEnv, activeSignal);
        if (activeSignal?.aborted) {
          throw new SocialError('upstream_error', 'aborted during execution');
        }
        if (result.code === 127) {
          throw new SocialError('backend_unavailable', 'opencli executable is not installed', {
            platform, backend: OPENCLI_BACKEND,
          });
        }
        if (result.code === 124 || result.timedOut === true) {
          throw new SocialError('backend_unavailable', 'opencli command timed out', {
            platform, backend: OPENCLI_BACKEND,
          });
        }
        if (result.code !== 0) {
          const raw = result.stderr.trim() || `exit code ${result.code}`;
          const token = childEnv['OPENCLI_TOKEN'];
          const detail = redactCliDiagnostics(raw, token !== undefined ? [token] : undefined).slice(0, 300);
          throw new SocialError('upstream_error', `opencli failed: ${detail}`, {
            platform, backend: OPENCLI_BACKEND,
          });
        }
        try {
          return JSON.parse(result.stdout) as unknown;
        } catch {
          throw new SocialError('malformed_upstream', `${platform}: opencli stdout is not valid JSON`, {
            platform, backend: OPENCLI_BACKEND,
          });
        }
      },
    };
  }

  return {
    platforms: ['facebook', 'instagram', 'linkedin'],
    async plans(request, context) {
      const plan = planFor(request, context);
      return plan === null ? [] : [plan];
    },
    normalize(request, plan, payload) {
      const platform = request.platform;
      if (platform !== 'facebook' && platform !== 'instagram' && platform !== 'linkedin') {
        throw new SocialError('invalid_request', `platform ${platform} is not handled by the opencli worker`, { platform });
      }
      const rows = parseRows(payload, platform);
      const warnings: string[] = [];
      const outcome = normalizeRowsFor(platform, rows, request, warnings);
      warnings.push(...(plan as OpenCliBackendPlan).requestWarnings);

      if (request.action === 'get_profile') {
        if (rows.length === 0) {
          throw new SocialError('not_found', `${platform} profile was not found`, { platform });
        }
        if (outcome.entities.length > 1) {
          warnings.push('multiple upstream profile rows; using the first');
        }
        return {
          entities: [outcome.entities[0]!],
          pagination: { supported: false, limit: request.limit, returned: 1, hasMore: false },
          partial: outcome.partial,
          warnings,
        };
      }

      const page: SocialPageV1 = {
        entities: outcome.entities,
        pagination: {
          supported: false,
          limit: request.limit,
          returned: outcome.entities.length,
          hasMore: false,
        },
        partial: outcome.partial,
        warnings,
      };
      return page;
    },
  };
}

/** Default worker instance using the real subprocess runner. */
export const openCliSocialWorker: SocialPlatformWorker = createOpenCliSocialWorker();
