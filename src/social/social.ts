// Stage 2 central social integrator.
//
// Canonical-only runtime seam: parse the raw request, resolve the platform
// (explicit or URL-inferred), validate the canonical action directly against
// the registry (unknown/legacy spellings throw unsupported_action before any
// dispatch), validate selectors/limit/cursor, fetch worker backend plans,
// reject plans absent from the registry, select a backend (cookie →
// anonymous → API key, cursor-capable preferred, platform preference breaks
// ties), execute with bounded retryable-only fallback, schema-validate the
// normalized page before success, and surface Pi-owned normalized entities
// with an additive `details.northstar` envelope. `content` renders only from
// normalized entities.
//
// Safety: Instagram has no post-detail action until a verified read-only
// adapter exists — canonical post-detail spellings are unadvertised and throw
// unsupported_action before any dispatch. No download, no mutation, no file
// writes. Cursors pin the backend (no switching). There is no archive or
// generic web fallback here; only capability-declared backends run.

import type { BackendCallResult } from '../backend.js';
import {
  SOCIAL_BACKEND_PREFERENCE,
  inferPlatformFromUrl,
} from '../capabilities.js';
import {
  SOCIAL_CANONICAL_ACTIONS,
  SOCIAL_PLATFORMS,
  SocialError,
  decodeSocialCursor,
  isSocialPlatform,
  renderSocialPage,
  resolveSocialAction,
  socialCursorFingerprint,
  validateSocialPage,
  validateSocialRequest,
  type SocialAction,
  type SocialAuthTier,
  type SocialBackendPlan,
  type SocialEntityV1,
  type SocialPlatform,
  type SocialPlatformWorker,
  type SocialPageV1,
  type SocialRequest,
  type BackendCapability as SocialBackendCapability,
} from './social-contract.js';
import {
  TWITTER_BACKEND_CAPABILITIES,
  SocialTwitterWorker,
} from './social-twitter.js';
import {
  REDDIT_BACKEND_CAPABILITIES,
  createRedditWorker,
} from './social-reddit.js';
import {
  OPENCLI_XIAOHONGSHU_CAPABILITY,
  XHS_CLI_CAPABILITY,
  createXiaohongshuWorker,
} from './social-xiaohongshu.js';
import {
  OPENCLI_FACEBOOK_CAPABILITY,
  OPENCLI_INSTAGRAM_CAPABILITY,
  OPENCLI_LINKEDIN_CAPABILITY,
  createOpenCliSocialWorker,
} from './social-opencli.js';
import {
  v2exBackendCapabilities,
  createV2exWorker,
} from './social-v2ex.js';
import {
  buildNorthstarResult,
  type NorthstarEntityV1,
} from '../result-contract.js';
import { northstarTextResult, textResult } from '../core/tool-output.js';
import { isSocialWriteAction } from './social-write-contract.js';
import { trySocialWrite } from './social-write-policy.js';

// ── Backend-operation registry (single source of truth for plan eligibility) ──
// Aggregated from the per-worker verified capability declarations. A worker
// plan executes only when its backend declares an operation for the requested
// canonical action on this platform.

interface PlatformBackendEntry {
  readonly platforms: readonly SocialPlatform[];
  readonly capability: SocialBackendCapability;
}

export const SOCIAL_BACKEND_REGISTRY: readonly PlatformBackendEntry[] = [
  ...TWITTER_BACKEND_CAPABILITIES.map((capability) => ({
    platforms: ['twitter'] as const,
    capability,
  })),
  ...REDDIT_BACKEND_CAPABILITIES.map((capability) => ({
    platforms: ['reddit'] as const,
    capability,
  })),
  { platforms: ['xiaohongshu'] as const, capability: OPENCLI_XIAOHONGSHU_CAPABILITY },
  { platforms: ['xiaohongshu'] as const, capability: XHS_CLI_CAPABILITY },
  { platforms: ['facebook'] as const, capability: OPENCLI_FACEBOOK_CAPABILITY },
  { platforms: ['instagram'] as const, capability: OPENCLI_INSTAGRAM_CAPABILITY },
  { platforms: ['linkedin'] as const, capability: OPENCLI_LINKEDIN_CAPABILITY },
  ...v2exBackendCapabilities.map((capability) => ({
    platforms: ['v2ex'] as const,
    capability,
  })),
];

/** Whether a backend declares an operation for a canonical action on a platform. */
export function socialRegistrySupports(
  backend: string,
  platform: SocialPlatform,
  action: SocialAction,
): boolean {
  return SOCIAL_BACKEND_REGISTRY.some(
    (entry) =>
      entry.platforms.includes(platform) &&
      entry.capability.name === backend &&
      entry.capability.operations.some((operation) => operation.action === action),
  );
}

/** Registry-declared backend names for a canonical platform action. */
export function socialRegistryBackends(
  platform: SocialPlatform,
  action: SocialAction,
): readonly string[] {
  return SOCIAL_BACKEND_REGISTRY.filter(
    (entry) =>
      entry.platforms.includes(platform) &&
      entry.capability.operations.some((operation) => operation.action === action),
  ).map((entry) => entry.capability.name);
}

// ── Execution options ──

export interface ExecuteSocialOptions {
  signal?: AbortSignal | undefined;
  env?: Record<string, string | undefined> | undefined;
  /** Test seam: override workers per platform. */
  workers?: Partial<Record<SocialPlatform, SocialPlatformWorker>>;
}

function defaultWorkers(env: Record<string, string | undefined>): Record<SocialPlatform, SocialPlatformWorker> {
  return {
    twitter: new SocialTwitterWorker({ parentEnv: env }),
    reddit: createRedditWorker({ env }),
    xiaohongshu: createXiaohongshuWorker({ childEnv: env }),
    facebook: createOpenCliSocialWorker(),
    instagram: createOpenCliSocialWorker(),
    linkedin: createOpenCliSocialWorker(),
    v2ex: createV2exWorker({ env }),
  };
}

// ── Raw request parsing (canonical selectors only) ──

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

function resolvePlatform(args: Record<string, unknown>): SocialPlatform {
  const explicit = args.platform;
  if (typeof explicit === 'string' && isSocialPlatform(explicit)) return explicit;
  if (typeof args.url === 'string') {
    const inferred = inferPlatformFromUrl(args.url, SOCIAL_PLATFORMS);
    if (inferred !== undefined && isSocialPlatform(inferred)) return inferred;
  }
  throw new SocialError(
    'invalid_request',
    `platform is required. Expected one of: ${SOCIAL_PLATFORMS.join(', ')}`,
  );
}

/**
 * Resolve the canonical action directly against the registry. Unknown or
 * legacy spellings (read/post/subreddit/note/topic/...) throw
 * unsupported_action before any dispatch. No alias mapping exists.
 */
function resolveCanonicalAction(platform: SocialPlatform, args: Record<string, unknown>): SocialAction {
  const raw = args.action;
  if (raw === undefined || raw === null) {
    return resolveSocialAction(platform, platform === 'v2ex' ? 'get_trending' : 'search');
  }
  if (typeof raw !== 'string' || raw.trim().length === 0) {
    throw new SocialError('invalid_request', 'action must be a non-empty string', { platform });
  }
  return resolveSocialAction(platform, raw.trim());
}

// ── Backend selection ──

const AUTH_TIER_RANK: Readonly<Record<SocialAuthTier, number>> = {
  cookie: 0,
  anonymous: 1,
  api_key: 2,
};

function preferenceIndex(platform: SocialPlatform, backend: string): number {
  const index = SOCIAL_BACKEND_PREFERENCE[platform].indexOf(backend);
  return index >= 0 ? index : SOCIAL_BACKEND_PREFERENCE[platform].length;
}

function orderPlans(
  platform: SocialPlatform,
  plans: readonly SocialBackendPlan[],
): SocialBackendPlan[] {
  return [...plans].sort((a, b) => {
    const aCursor = a.pagination === 'cursor' || a.pagination === 'page' ? 0 : 1;
    const bCursor = b.pagination === 'cursor' || b.pagination === 'page' ? 0 : 1;
    if (aCursor !== bCursor) return aCursor - bCursor;
    const tier = AUTH_TIER_RANK[a.authTier] - AUTH_TIER_RANK[b.authTier];
    if (tier !== 0) return tier;
    return preferenceIndex(platform, a.backend) - preferenceIndex(platform, b.backend);
  });
}

/**
 * Pin cursor-bound requests to the issuing backend. Returns only plans whose
 * backend decodes the cursor; throws cursor_invalid for malformed tokens,
 * backend_unavailable when the pinned backend has no declared plan (backend
 * loss — never switch), and cursor_mismatch otherwise.
 */
function pinCursorPlans(
  request: SocialRequest,
  plans: readonly SocialBackendPlan[],
): readonly SocialBackendPlan[] {
  if (request.cursor === undefined) return plans;
  const fingerprint = socialCursorFingerprint(request);
  const pinned: SocialBackendPlan[] = [];
  let invalid: SocialError | undefined;
  for (const plan of plans) {
    try {
      decodeSocialCursor(request.cursor, {
        platform: request.platform,
        action: request.action,
        backend: plan.backend,
        fingerprint,
      });
      pinned.push(plan);
    } catch (error) {
      if (error instanceof SocialError && error.code === 'cursor_invalid' && invalid === undefined) {
        invalid = error;
      }
    }
  }
  if (pinned.length > 0) return pinned;
  if (invalid !== undefined) throw invalid;
  throw cursorUnpinnedError(request, plans);
}

function cursorUnpinnedError(
  request: SocialRequest,
  plans: readonly SocialBackendPlan[],
): SocialError {
  let payload: unknown;
  try {
    payload = JSON.parse(Buffer.from(request.cursor ?? '', 'base64url').toString('utf8'));
  } catch {
    return new SocialError('cursor_invalid', 'cursor is not a valid opaque token', {
      platform: request.platform,
    });
  }
  if (typeof payload === 'object' && payload !== null && !Array.isArray(payload)) {
    const record = payload as Record<string, unknown>;
    if (
      record.v === 1 &&
      record.platform === request.platform &&
      record.action === request.action &&
      record.fingerprint === socialCursorFingerprint(request) &&
      typeof record.backend === 'string' &&
      !plans.some((plan) => plan.backend === record.backend)
    ) {
      return new SocialError(
        'backend_unavailable',
        `cursor-pinned backend ${String(record.backend)} is unavailable; no backend switch`,
        { platform: request.platform, backend: String(record.backend) },
      );
    }
  }
  return new SocialError('cursor_mismatch', 'cursor does not match the current platform/action/backend/filter', {
    platform: request.platform,
  });
}

function abortError(): Error {
  const error = new Error('Aborted');
  error.name = 'AbortError';
  return error;
}

function isAbort(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}

// ── Northstar mapping ──
// Social entities map 1:1 onto the extended northstar kinds. Only
// upstream-present fields cross the boundary; title/url fall back to
// deterministic platform values because the envelope requires them.

const PLATFORM_HOME_URL: Readonly<Record<SocialPlatform, string>> = {
  twitter: 'https://x.com/',
  reddit: 'https://www.reddit.com/',
  xiaohongshu: 'https://www.xiaohongshu.com/',
  facebook: 'https://www.facebook.com/',
  instagram: 'https://www.instagram.com/',
  v2ex: 'https://www.v2ex.com/',
  linkedin: 'https://www.linkedin.com/',
};

function entityTitle(entity: SocialEntityV1, platform: SocialPlatform): string {
  if (entity.kind === 'social_post') {
    const text = entity.title ?? entity.text;
    if (text !== undefined && text.trim().length > 0) return text.slice(0, 280);
  }
  if (entity.kind === 'social_comment' && entity.text.trim().length > 0) {
    return entity.text.slice(0, 280);
  }
  if (entity.kind === 'social_account') {
    const label = entity.handle !== undefined ? `@${entity.handle}` : entity.displayName;
    if (label !== undefined) return label;
  }
  if (entity.kind === 'social_thread') {
    const text = entity.title ?? entity.text;
    if (text !== undefined && text.trim().length > 0) return text.slice(0, 280);
  }
  if (
    (entity.kind === 'social_community' || entity.kind === 'social_topic') &&
    entity.name !== undefined
  ) {
    return entity.name;
  }
  if (entity.kind === 'social_notification' && entity.text !== undefined) {
    return entity.text.slice(0, 280);
  }
  if (entity.kind === 'social_reference') {
    const text = entity.title ?? entity.snippet;
    if (text !== undefined && text.trim().length > 0) return text.slice(0, 280);
  }
  return `${platform} ${entity.kind}`;
}

function entitySnippet(entity: SocialEntityV1): string | undefined {
  switch (entity.kind) {
    case 'social_post':
      return entity.text;
    case 'social_comment':
      return entity.text;
    case 'social_account':
      return entity.bio;
    case 'social_thread':
      return entity.text;
    case 'social_community':
    case 'social_topic':
      return entity.description;
    case 'social_media':
      return entity.altText;
    case 'social_notification':
      return entity.text;
    case 'social_reference':
      return entity.snippet ?? entity.title;
    case 'social_relationship':
    case 'social_engagement':
      return undefined;
  }
}

function toNorthstarEntity(
  entity: SocialEntityV1,
  platform: SocialPlatform,
  source: string,
): NorthstarEntityV1 {
  const authors =
    entity.kind === 'social_notification'
      ? entity.actor !== undefined
        ? [{ name: entity.actor.displayName ?? entity.actor.handle ?? entity.actor.id ?? 'unknown' }]
        : undefined
      : 'author' in entity && entity.author !== undefined
        ? [{ name: entity.author.displayName ?? entity.author.handle ?? entity.author.id ?? 'unknown' }]
        : undefined;
  const metrics =
    'metrics' in entity && entity.metrics !== undefined
      ? {
          ...(entity.metrics.score !== undefined ? { score: entity.metrics.score } : {}),
          ...(entity.metrics.comments !== undefined ? { comments: entity.metrics.comments } : {}),
          ...(entity.metrics.views !== undefined ? { views: entity.metrics.views } : {}),
        }
      : undefined;
  const snippet = entitySnippet(entity);
  return {
    entityVersion: 1,
    kind: entity.kind,
    id: entity.id,
    source,
    title: entityTitle(entity, platform),
    url: entity.url ?? PLATFORM_HOME_URL[platform],
    ...(snippet !== undefined ? { snippet } : {}),
    ...(authors !== undefined ? { authors } : {}),
    ...(entity.publishedAt !== undefined ? { publishedAt: entity.publishedAt } : {}),
    ...(metrics !== undefined && Object.keys(metrics).length > 0 ? { metrics } : {}),
  };
}

// ── Stage 8b write gate (explicit + isolated) ──
// Denied → SocialError. Dry-run → normalized BackendCallResult preview.
// Never dispatches, never touches workers, never spawns/fetches.
function executeSocialWriteGate(
  platform: SocialPlatform,
  action: string,
  args: Record<string, unknown>,
  env: Record<string, string | undefined>,
): BackendCallResult {
  const postId = optionalString(args.postId);
  const commentId = optionalString(args.commentId);
  const user = optionalString(args.user);
  const community = optionalString(args.community);
  const topic = optionalString(args.topic);
  const gate = trySocialWrite(
    {
      platform,
      action,
      ...(postId !== undefined ? { postId } : {}),
      ...(commentId !== undefined ? { commentId } : {}),
      ...(user !== undefined ? { user } : {}),
      ...(community !== undefined ? { community } : {}),
      ...(topic !== undefined ? { topic } : {}),
      ...(args.payload !== undefined ? { payload: args.payload } : {}),
    },
    env,
  );
  if (gate.status === 'denied') {
    const code = gate.reason === 'social_write_invalid' ? 'invalid_request' : 'permission_denied';
    throw new SocialError(code, `${gate.reason}: social write ${platform}/${action} is not enabled`, {
      platform,
    });
  }
  return textResult(`dry_run preview: ${platform} ${action} (no side effects)`, {
    platform,
    action,
    canonicalAction: action,
    dryRun: true,
    preview: gate.preview,
    warnings: [],
  });
}

// ── Integrator ──

export async function executeSocial(
  args: Record<string, unknown>,
  options: ExecuteSocialOptions = {},
): Promise<BackendCallResult> {
  const env = options.env ?? process.env;
  const platform = resolvePlatform(args);
  // Stage 8b write gate: closed write vocabulary intercepts before canonical
  // read resolution and before any worker plan construction. Default matrix
  // denies everything, so read-only behavior is byte-identical. No dispatch,
  // no worker changes, no POST paths. Gate imports contracts/policy only.
  const rawAction = typeof args.action === 'string' ? args.action.trim() : undefined;
  if (rawAction !== undefined && isSocialWriteAction(rawAction)) {
    return executeSocialWriteGate(platform, rawAction, args, env);
  }
  // Canonical-only: unknown/legacy action names throw unsupported_action here,
  // before any worker dispatch.
  const canonical = resolveCanonicalAction(platform, args);

  const query = optionalString(args.query);
  const postId = optionalString(args.postId);
  const commentId = optionalString(args.commentId);
  const user = optionalString(args.user);
  const community = optionalString(args.community);
  const topic = optionalString(args.topic);
  const url = optionalString(args.url);
  const feedVariant = optionalString(args.feedVariant);
  const sort = optionalString(args.sort);
  const timeRange = optionalString(args.timeRange);
  const { request, warnings: validationWarnings } = validateSocialRequest({
    platform,
    action: canonical,
    ...(query !== undefined ? { query } : {}),
    ...(postId !== undefined ? { postId } : {}),
    ...(commentId !== undefined ? { commentId } : {}),
    ...(user !== undefined ? { user } : {}),
    ...(community !== undefined ? { community } : {}),
    ...(topic !== undefined ? { topic } : {}),
    ...(url !== undefined ? { url } : {}),
    ...(feedVariant !== undefined ? { feedVariant } : {}),
    ...(sort !== undefined ? { sort } : {}),
    ...(timeRange !== undefined ? { timeRange } : {}),
    ...(typeof args.includeReplies === 'boolean' ? { includeReplies: args.includeReplies } : {}),
    ...(typeof args.limit === 'number' ? { limit: args.limit } : {}),
  });
  const warnings = [...validationWarnings];
  const cursor = optionalString(args.cursor);
  if (cursor !== undefined) request.cursor = cursor;

  const workers = options.workers;
  const defaults = workers === undefined ? defaultWorkers(env) : undefined;
  const worker = workers?.[platform] ?? defaults?.[platform];
  if (worker === undefined) {
    throw new SocialError('backend_unavailable', `no social worker for ${platform}`, { platform });
  }
  const context = options.signal !== undefined ? { signal: options.signal } : {};

  const plans = await worker.plans(request, context);
  const eligible = plans.filter((plan) => socialRegistrySupports(plan.backend, platform, request.action));
  if (eligible.length === 0) {
    if (plans.length > 0) {
      throw new SocialError(
        'backend_unavailable',
        `no registry-declared backend for ${platform} ${request.action}`,
        { platform },
      );
    }
    throw new SocialError('backend_unavailable', `no usable ${platform} backend for ${request.action}`, {
      platform,
    });
  }
  const pinned = pinCursorPlans(request, eligible);
  const ordered = request.cursor === undefined ? orderPlans(platform, pinned) : [...pinned];

  const failures: string[] = [];
  for (const plan of ordered) {
    if (options.signal?.aborted) throw abortError();
    let payload: unknown;
    try {
      payload = await plan.execute(options.signal);
    } catch (error) {
      if (isAbort(error)) throw error;
      if (error instanceof SocialError && !error.retryable) throw error;
      failures.push(`${plan.backend}: ${error instanceof Error ? error.message : String(error)}`);
      continue;
    }
    let page: SocialPageV1;
    try {
      const normalized = worker.normalize(request, plan, payload);
      const check = validateSocialPage(normalized);
      if (!check.ok || check.page === undefined) {
        throw new SocialError(
          'malformed_upstream',
          `normalized page failed validation: ${check.issues.join('; ')}`,
          { platform, backend: plan.backend },
        );
      }
      page = check.page;
    } catch (error) {
      if (isAbort(error)) throw error;
      if (error instanceof SocialError && !error.retryable) throw error;
      failures.push(`${plan.backend}: ${error instanceof Error ? error.message : String(error)}`);
      continue;
    }
    // Valid empty results stop selection — never fall through to the next plan.
    return buildSocialResult(platform, request, plan, page, warnings);
  }
  throw new SocialError(
    'backend_unavailable',
    `No usable ${platform} backend for ${request.action}. ${failures.join('; ')}`,
    { platform },
  );
}

function buildSocialResult(
  platform: SocialPlatform,
  request: SocialRequest,
  plan: SocialBackendPlan,
  page: SocialPageV1,
  warnings: string[],
): BackendCallResult {
  const content = renderSocialPage(page);
  const allWarnings = [...warnings, ...page.warnings];
  const entities: NorthstarEntityV1[] = [];
  for (const entity of page.entities) {
    entities.push(toNorthstarEntity(entity, platform, platform));
  }
  const notes = [...allWarnings];
  if (page.partial) notes.push('partial: some upstream rows were dropped or truncated');
  const envelope = buildNorthstarResult({
    request: {
      tool: 'social',
      channel: platform,
      action: request.action,
      source: plan.backend,
    },
    outcomes: [
      {
        source: platform,
        backend: plan.backend,
        ...(entities.length > 0 ? { entities } : {}),
      },
    ],
    pagination: {
      supported: page.pagination.supported,
      limit: page.pagination.limit,
      hasMore: page.pagination.hasMore,
      ...(page.pagination.nextCursor !== undefined ? { nextCursor: page.pagination.nextCursor } : {}),
    },
    notes,
  });
  const legacyDetails: Record<string, unknown> = {
    platform,
    action: request.action,
    canonicalAction: request.action,
    backend: plan.backend,
    pagination: page.pagination,
    partial: page.partial,
    warnings: allWarnings,
  };
  return northstarTextResult(content, legacyDetails, envelope);
}

/** Advertised canonical actions per platform (registry source of truth). */
export function advertisedSocialActions(platform: SocialPlatform): readonly SocialAction[] {
  return SOCIAL_CANONICAL_ACTIONS[platform];
}
