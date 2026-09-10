// Stage 2 social worker: V2EX (read-only).
//
// Backends, in declared plan order (cookie tier does not exist for V2EX, so
// the binding cookie → anonymous → api_key order collapses to):
//   1. `v2ex-legacy-api` — fixed-host legacy API v1, anonymous, no cursor.
//   2. `v2ex-api-v2`     — official API 2.0 with Personal Access Token
//                          (`V2EX_PAT`, Authorization: Bearer). Token lives in
//                          the Authorization header only; never in URLs,
//                          output, warnings, or cursors.
//
// Page cursors are issued only where the upstream exposes pagination
// metadata (API 2.0 list endpoints that return page/total/per_page). Legacy
// v1 endpoints return bare arrays, so they are declared pagination 'none'
// and never fabricate hasMore. No Arctic Shift or web fallback, no
// mutation, no download, no file writes, no child processes — every plan is
// an HTTP GET against https://www.v2ex.com only.

import { fetchJsonNoRedirect } from './http.js';
import {
  decodeSocialCursor,
  encodeSocialCursor,
  parseSocialDate,
  socialCursorFingerprint,
  socialEntityId,
  SocialError,
  type BackendActionCapability,
  type BackendCapability,
  type SocialActorV1,
  type SocialBackendPlan,
  type SocialCommentV1,
  type SocialCommunityV1,
  type SocialEntityV1,
  type SocialExecutionContext,
  type SocialNotificationV1,
  type SocialPageV1,
  type SocialPlatformWorker,
  type SocialAccountV1,
  type SocialPostV1,
  type SocialRequest,
} from './social-contract.js';

export const V2EX_HOST = 'https://www.v2ex.com';
export const V2EX_LEGACY_API_BASE = `${V2EX_HOST}/api`;
export const V2EX_V2_API_BASE = `${V2EX_HOST}/api/v2`;
export const V2EX_BACKEND_LEGACY = 'v2ex-legacy-api';
export const V2EX_BACKEND_V2 = 'v2ex-api-v2';
/** Optional API 2.0 Personal Access Token env var; injectable for tests. */
export const V2EX_PAT_ENV = 'V2EX_PAT';

export type V2exOperation =
  | 'legacy_hot'
  | 'legacy_node_topics'
  | 'legacy_topic'
  | 'legacy_thread'
  | 'legacy_replies'
  | 'legacy_member'
  | 'v2_topic'
  | 'v2_node'
  | 'v2_node_topics'
  | 'v2_replies'
  | 'v2_notifications';

/** Internal plan extension carrying the closed operation mapping. */
export interface V2exBackendPlan extends SocialBackendPlan {
  readonly operation: V2exOperation;
}

function isV2exPlan(plan: SocialBackendPlan): plan is V2exBackendPlan {
  return typeof (plan as Partial<V2exBackendPlan>).operation === 'string';
}

// ── Capability declaration (registry shape; consumed by the integrator) ──

const MAX_V2EX_LIMIT = 100;

function operation(
  action: BackendActionCapability['action'],
  upstreamAction: string[],
  auth: BackendActionCapability['auth'],
  pagination: BackendActionCapability['pagination'],
  required: BackendActionCapability['required'],
): BackendActionCapability {
  return { action, upstreamAction, auth, pagination, required, maxLimit: MAX_V2EX_LIMIT };
}

/** BackendCapability entries for the V2EX workers (single source per backend). */
export const v2exBackendCapabilities: readonly BackendCapability[] = [
  {
    name: V2EX_BACKEND_LEGACY,
    type: 'native',
    operations: [
      operation('get_topic', ['topics/show.json?id='], ['anonymous'], 'none', ['topic']),
      operation('get_thread', ['topics/show.json?id=', 'replies/show.json?topic_id='], ['anonymous'], 'none', ['postId']),
      operation('get_comments', ['replies/show.json?topic_id='], ['anonymous'], 'none', ['postId']),
      operation('get_profile', ['members/show.json?username='], ['anonymous'], 'none', ['user']),
      operation('get_trending', ['topics/hot.json'], ['anonymous'], 'none', []),
      operation('get_community_posts', ['topics/show.json?node_name='], ['anonymous'], 'none', ['community']),
    ],
  },
  {
    name: V2EX_BACKEND_V2,
    type: 'native',
    operations: [
      operation('get_topic', ['topics/:topic_id'], ['api_key'], 'none', ['topic']),
      operation('get_comments', ['topics/:topic_id/replies'], ['api_key'], 'page', ['postId']),
      operation('get_community', ['nodes/:node_name'], ['api_key'], 'none', ['community']),
      operation('get_community_posts', ['nodes/:node_name/topics'], ['api_key'], 'page', ['community']),
      operation('get_notifications', ['notifications'], ['api_key'], 'page', []),
    ],
  },
];

// ── Worker ──

export interface V2exWorkerOptions {
  /** Defaults to process.env; injectable for tests. */
  env?: Record<string, string | undefined>;
  /**
   * HTTP fetcher for fixed-host JSON GETs. Defaults to the shared
   * SSRF-validated, redirect-rejecting, bounded helper.
   */
  fetchJson?: (url: string, headers: Record<string, string>, signal?: AbortSignal) => Promise<unknown>;
}

const DEFAULT_USER_AGENT = 'pi-northstar/0.1';

/** Map transport failures to SocialError codes; never leaks the PAT (header-only). */
function upstreamError(error: unknown, backend: string): SocialError {
  if (error instanceof SocialError) return error;
  const message = error instanceof Error ? error.message : String(error);
  const status = /HTTP (\d{3})/.exec(message)?.[1];
  if (status === '401' || status === '403') {
    return new SocialError('authentication_required', 'v2ex API 2.0 rejected the Personal Access Token', { platform: 'v2ex', backend, cause: error });
  }
  if (status === '429') {
    return new SocialError('rate_limited', 'v2ex API rate limit reached', { platform: 'v2ex', backend, cause: error });
  }
  return new SocialError('upstream_error', `v2ex request failed: ${message}`, { platform: 'v2ex', backend, cause: error });
}

export function createV2exWorker(options: V2exWorkerOptions = {}): SocialPlatformWorker {
  const env = options.env ?? process.env;
  const fetchJson = options.fetchJson
    ?? ((url: string, headers: Record<string, string>, signal?: AbortSignal) =>
      fetchJsonNoRedirect(url, headers, signal));

  function pat(): string | undefined {
    const value = env[V2EX_PAT_ENV];
    return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
  }

  function pageModePlan(request: SocialRequest, operationName: V2exOperation): V2exBackendPlan | undefined {
    // Page cursors exist only for the API 2.0 list operations.
    if (operationName !== 'v2_node_topics' && operationName !== 'v2_replies' && operationName !== 'v2_notifications') {
      return undefined;
    }
    return {
      backend: V2EX_BACKEND_V2,
      authTier: 'api_key',
      pagination: 'page',
      operation: operationName,
      execute: async (signal?: AbortSignal) => {
        const page = cursorPage(request);
        const url = v2ListUrl(operationName, request, page);
        return fetchV2(url, signal);
      },
    };
  }

  async function fetchV2(url: string, signal?: AbortSignal): Promise<unknown> {
    const token = pat();
    try {
      return await fetchJson(url, { 'user-agent': DEFAULT_USER_AGENT, authorization: `Bearer ${token}` }, signal);
    } catch (error) {
      throw upstreamError(error, V2EX_BACKEND_V2);
    }
  }

  async function fetchLegacy(url: string, signal?: AbortSignal): Promise<unknown> {
    try {
      return await fetchJson(url, { 'user-agent': DEFAULT_USER_AGENT }, signal);
    } catch (error) {
      throw upstreamError(error, V2EX_BACKEND_LEGACY);
    }
  }

  function cursorPage(request: SocialRequest): number {
    if (request.cursor === undefined) return 1;
    const decoded = decodeSocialCursor(request.cursor, {
      platform: request.platform,
      action: request.action,
      backend: V2EX_BACKEND_V2,
      fingerprint: socialCursorFingerprint(request),
    });
    const page = decoded.state.page;
    return typeof page === 'number' && Number.isInteger(page) && page >= 1 ? page : 1;
  }

  function v2ListUrl(operationName: V2exOperation, request: SocialRequest, page: number): string {
    switch (operationName) {
      case 'v2_node_topics':
        return `${V2EX_V2_API_BASE}/nodes/${encodeURIComponent(selector(request.community, 'community'))}/topics?p=${page}`;
      case 'v2_replies':
        return `${V2EX_V2_API_BASE}/topics/${encodeURIComponent(topicId(request))}/replies?p=${page}`;
      case 'v2_notifications':
        return `${V2EX_V2_API_BASE}/notifications?p=${page}`;
      default:
        throw new SocialError('invalid_request', `operation ${operationName} is not a V2EX v2 list operation`);
    }
  }

  function legacyUrl(operationName: V2exOperation, request: SocialRequest, page: number): string {
    switch (operationName) {
      case 'legacy_hot':
        return `${V2EX_LEGACY_API_BASE}/topics/hot.json`;
      case 'legacy_node_topics':
        return `${V2EX_LEGACY_API_BASE}/topics/show.json?node_name=${encodeURIComponent(selector(request.community, 'community'))}&page=${page}`;
      case 'legacy_topic':
        return `${V2EX_LEGACY_API_BASE}/topics/show.json?id=${encodeURIComponent(topicId(request))}`;
      case 'legacy_replies':
        return `${V2EX_LEGACY_API_BASE}/replies/show.json?topic_id=${encodeURIComponent(topicId(request))}&page=${page}`;
      case 'legacy_member':
        return `${V2EX_LEGACY_API_BASE}/members/show.json?username=${encodeURIComponent(selector(request.user, 'user'))}`;
      default:
        throw new SocialError('invalid_request', `operation ${operationName} is not a V2EX legacy operation`);
    }
  }

  function topicId(request: SocialRequest): string {
    return selector(request.postId ?? request.topic, 'postId');
  }

  function selector(value: string | undefined, name: string): string {
    if (value === undefined || value.trim().length === 0) {
      throw new SocialError('invalid_request', `${name} selector is required`);
    }
    return value.trim();
  }

  const plans = async (
    request: SocialRequest,
    _context: SocialExecutionContext,
  ): Promise<readonly SocialBackendPlan[]> => {
    const token = pat();

    if (request.cursor !== undefined) {
      // Cursor pins the backend: only the page-capable plan that decodes is
      // returned. Backend loss surfaces as cursor_mismatch, never a switch.
      const candidate = pageModePlan(request, v2ListOperationFor(request.action));
      if (candidate === undefined) {
        throw new SocialError(
          'cursor_mismatch',
          `cursor was not issued for v2ex ${request.action} on ${V2EX_BACKEND_V2}`,
          { platform: 'v2ex', backend: V2EX_BACKEND_V2 },
        );
      }
      decodeSocialCursor(request.cursor, {
        platform: request.platform,
        action: request.action,
        backend: candidate.backend,
        fingerprint: socialCursorFingerprint(request),
      });
      return [candidate];
    }

    switch (request.action) {
      case 'get_trending': {
        return [legacyPlan('legacy_hot', request)];
      }
      case 'get_profile': {
        return [legacyPlan('legacy_member', request)];
      }
      case 'get_thread': {
        return [legacyPlan('legacy_thread', request)];
      }
      case 'get_topic': {
        const list: V2exBackendPlan[] = [legacyPlan('legacy_topic', request)];
        if (token !== undefined) list.push(await v2SinglePlan('v2_topic', request));
        return list;
      }
      case 'get_comments': {
        const list: V2exBackendPlan[] = [legacyPlan('legacy_replies', request)];
        if (token !== undefined) list.push(pageModePlan(request, 'v2_replies')!);
        return list;
      }
      case 'get_community_posts': {
        const list: V2exBackendPlan[] = [legacyPlan('legacy_node_topics', request)];
        if (token !== undefined) list.push(pageModePlan(request, 'v2_node_topics')!);
        return list;
      }
      case 'get_community': {
        if (token === undefined) {
          throw new SocialError(
            'authentication_required',
            'v2ex get_community requires a V2EX API 2.0 Personal Access Token (V2EX_PAT); the legacy API exposes no node-detail endpoint',
            { platform: 'v2ex' },
          );
        }
        return [await v2SinglePlan('v2_node', request)];
      }
      case 'get_notifications': {
        if (token === undefined) {
          throw new SocialError(
            'authentication_required',
            'v2ex get_notifications requires a V2EX API 2.0 Personal Access Token (V2EX_PAT); notifications are API-key-only',
            { platform: 'v2ex' },
          );
        }
        return [pageModePlan(request, 'v2_notifications')!];
      }
      default:
        throw new SocialError('unsupported_action', `Unsupported v2ex action: ${request.action}`, { platform: 'v2ex' });
    }
  };

  function legacyPlan(operationName: V2exOperation, request: SocialRequest): V2exBackendPlan {
    return {
      backend: V2EX_BACKEND_LEGACY,
      authTier: 'anonymous',
      pagination: 'none',
      operation: operationName,
      execute: async (signal?: AbortSignal) => {
        if (operationName === 'legacy_thread') {
          // Root topic first, then replies page 1 — fetched in parallel,
          // joined under closed keys for the normalizer.
          const [topic, replies] = await Promise.all([
            fetchLegacy(legacyUrl('legacy_topic', request, 1), signal),
            fetchLegacy(legacyUrl('legacy_replies', request, 1), signal),
          ]);
          return { topic, replies };
        }
        return fetchLegacy(legacyUrl(operationName, request, 1), signal);
      },
    };
  }

  function v2SinglePlan(operationName: 'v2_topic' | 'v2_node', request: SocialRequest): V2exBackendPlan {
    return {
      backend: V2EX_BACKEND_V2,
      authTier: 'api_key',
      pagination: 'none',
      operation: operationName,
      execute: async (signal?: AbortSignal) => {
        const url = operationName === 'v2_topic'
          ? `${V2EX_V2_API_BASE}/topics/${encodeURIComponent(topicId(request))}`
          : `${V2EX_V2_API_BASE}/nodes/${encodeURIComponent(selector(request.community, 'community'))}`;
        return fetchV2(url, signal);
      },
    };
  }

  // ── Payload unwrapping ──

  interface V2PageMeta {
    page: number;
    perPage: number;
    total: number;
  }

  interface UnwrappedPayload {
    items?: unknown[];
    item?: Record<string, unknown>;
    meta?: V2PageMeta;
  }

  function unwrapPayload(payload: unknown): UnwrappedPayload | undefined {
    if (Array.isArray(payload)) return { items: payload };
    const record = asRecord(payload);
    if (record === undefined) return undefined;
    if (Array.isArray(record.result)) {
      const meta = pageMeta(record);
      return { items: record.result, ...(meta !== undefined ? { meta } : {}) };
    }
    const inner = record.result;
    if (inner !== undefined && asRecord(inner) !== undefined) {
      const meta = pageMeta(record);
      return { item: inner as Record<string, unknown>, ...(meta !== undefined ? { meta } : {}) };
    }
    const meta = pageMeta(record);
    return { item: record, ...(meta !== undefined ? { meta } : {}) };
  }

  function pageMeta(record: Record<string, unknown>): V2PageMeta | undefined {
    const page = asFiniteNumber(record.page);
    const total = asFiniteNumber(record.total);
    const perPage = asFiniteNumber(record.per_page);
    if (page === undefined || total === undefined || perPage === undefined || page < 1) return undefined;
    return { page, perPage, total };
  }

  // ── Field coercion ──

  function asRecord(value: unknown): Record<string, unknown> | undefined {
    return typeof value === 'object' && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : undefined;
  }

  function asString(value: unknown): string | undefined {
    if (typeof value !== 'string') return undefined;
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  }

  function asFiniteNumber(value: unknown): number | undefined {
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value))) return Number(value);
    return undefined;
  }

  function httpUrl(value: unknown): string | undefined {
    const raw = asString(value);
    if (raw === undefined) return undefined;
    try {
      const parsed = new URL(raw);
      return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? parsed.href : undefined;
    } catch {
      return undefined;
    }
  }

  function actorFromMember(member: unknown): SocialActorV1 | undefined {
    const record = asRecord(member);
    if (record === undefined) return undefined;
    const actor: SocialActorV1 = {};
    const id = asFiniteNumber(record.id);
    if (id !== undefined) actor.id = String(id);
    const username = asString(record.username);
    if (username !== undefined) {
      actor.handle = username;
      const profileUrl = httpUrl(`${V2EX_HOST}/member/${encodeURIComponent(username)}`);
      if (profileUrl !== undefined) actor.profileUrl = profileUrl;
    }
    const tagline = asString(record.tagline);
    if (tagline !== undefined) actor.displayName = tagline;
    const avatar = httpUrl(record.avatar_normal ?? record.avatar_original);
    if (avatar !== undefined) actor.avatarUrl = avatar;
    return Object.keys(actor).length > 0 ? actor : undefined;
  }

  function metricsFrom(value: unknown, keys: readonly (keyof import('./social-contract.js').SocialMetricsV1)[]): import('./social-contract.js').SocialMetricsV1 | undefined {
    const record = asRecord(value);
    if (record === undefined) return undefined;
    const metrics: import('./social-contract.js').SocialMetricsV1 = {};
    for (const key of keys) {
      const raw = asFiniteNumber(record[key]);
      if (raw !== undefined) metrics[key] = raw;
    }
    return Object.keys(metrics).length > 0 ? metrics : undefined;
  }

  function canonicalUrl(kind: 't' | 'member' | 'go', nativeId: string): string {
    return `${V2EX_HOST}/${kind}/${encodeURIComponent(nativeId)}`;
  }

  // ── Entity normalizers ──
  // Only upstream-present fields are set. No synthesized zero metrics, dates,
  // or relationships. Malformed rows are dropped with warnings (partial).

  function topicToPost(raw: Record<string, unknown>, backend: string): SocialPostV1 | undefined {
    const id = asFiniteNumber(raw.id);
    if (id === undefined) return undefined;
    const nativeId = String(id);
    const post: SocialPostV1 = {
      version: 1,
      kind: 'social_post',
      contentType: 'topic',
      id: socialEntityId('v2ex', 'social_post', nativeId),
      platformId: nativeId,
      platform: 'v2ex',
      backend,
      url: canonicalUrl('t', nativeId),
    };
    const title = asString(raw.title);
    if (title !== undefined) post.title = title;
    const text = asString(raw.content);
    if (text !== undefined) post.text = text;
    const author = actorFromMember(raw.member);
    if (author !== undefined) post.author = author;
    const node = asRecord(raw.node);
    const nodeName = node !== undefined ? asString(node.name) : undefined;
    if (nodeName !== undefined) post.communityId = nodeName;
    const metrics = metricsFrom(raw, ['replies']);
    if (metrics !== undefined) post.metrics = metrics;
    const publishedAt = parseSocialDate(raw.created);
    if (publishedAt !== undefined) post.publishedAt = publishedAt;
    return post;
  }

  function replyToComment(
    raw: Record<string, unknown>,
    backend: string,
    fallbackPostId: string,
  ): SocialCommentV1 | undefined {
    const id = asFiniteNumber(raw.id);
    if (id === undefined) return undefined;
    const comment: SocialCommentV1 = {
      version: 1,
      kind: 'social_comment',
      id: socialEntityId('v2ex', 'social_comment', String(id)),
      platformId: String(id),
      platform: 'v2ex',
      backend,
      postId: asString(raw.topic_id) ?? fallbackPostId,
      text: asString(raw.content) ?? '',
      url: canonicalUrl('t', asString(raw.topic_id) ?? fallbackPostId),
    };
    if (comment.text.length === 0) return undefined;
    const author = actorFromMember(raw.member);
    if (author !== undefined) comment.author = author;
    const thanks = asFiniteNumber(raw.thanks);
    if (thanks !== undefined) comment.metrics = { likes: thanks };
    const publishedAt = parseSocialDate(raw.created);
    if (publishedAt !== undefined) comment.publishedAt = publishedAt;
    return comment;
  }

  function memberToProfile(raw: Record<string, unknown>, backend: string): SocialAccountV1 | undefined {
    const username = asString(raw.username);
    if (username === undefined) return undefined;
    const profile: SocialAccountV1 = {
      version: 1,
      kind: 'social_account',
      id: socialEntityId('v2ex', 'social_account', username),
      platformId: username,
      platform: 'v2ex',
      backend,
      url: canonicalUrl('member', username),
      handle: username,
    };
    const tagline = asString(raw.tagline);
    if (tagline !== undefined) profile.displayName = tagline;
    const bio = asString(raw.bio);
    if (bio !== undefined) profile.bio = bio;
    const publishedAt = parseSocialDate(raw.created);
    if (publishedAt !== undefined) profile.publishedAt = publishedAt;
    return profile;
  }

  function nodeToCommunity(raw: Record<string, unknown>, backend: string): SocialCommunityV1 | undefined {
    const name = asString(raw.name);
    if (name === undefined) return undefined;
    const community: SocialCommunityV1 = {
      version: 1,
      kind: 'social_community',
      id: socialEntityId('v2ex', 'social_community', name),
      platformId: name,
      platform: 'v2ex',
      backend,
      url: canonicalUrl('go', name),
    };
    const title = asString(raw.title);
    if (title !== undefined) community.name = title;
    const description = asString(raw.header) ?? asString(raw.footer);
    if (description !== undefined) community.description = description;
    const metrics = metricsFrom(raw, ['comments', 'views']);
    if (metrics !== undefined) community.metrics = metrics;
    const publishedAt = parseSocialDate(raw.created);
    if (publishedAt !== undefined) community.publishedAt = publishedAt;
    return community;
  }

  function notificationToEntity(raw: Record<string, unknown>, backend: string): SocialNotificationV1 | undefined {
    const id = asFiniteNumber(raw.id);
    if (id === undefined) return undefined;
    const notification: SocialNotificationV1 = {
      version: 1,
      kind: 'social_notification',
      id: socialEntityId('v2ex', 'social_notification', String(id)),
      platformId: String(id),
      platform: 'v2ex',
      backend,
    };
    const text = asString(raw.body) ?? asString(raw.topic_title);
    if (text !== undefined) notification.text = text;
    const actor = actorFromMember(raw.member ?? raw.creator);
    if (actor !== undefined) notification.actor = actor;
    const related = asFiniteNumber(raw.topic_id);
    if (related !== undefined) notification.relatedEntityId = String(related);
    const publishedAt = parseSocialDate(raw.created);
    if (publishedAt !== undefined) notification.publishedAt = publishedAt;
    return notification;
  }

  // ── Page assembly ──

  function emptyPage(request: SocialRequest, plan: SocialBackendPlan): SocialPageV1 {
    return {
      entities: [],
      pagination: {
        supported: plan.pagination !== 'none',
        limit: request.limit,
        returned: 0,
        hasMore: false,
      },
      partial: false,
      warnings: [],
    };
  }

  function finishPage(
    request: SocialRequest,
    plan: SocialBackendPlan,
    entities: SocialEntityV1[],
    warnings: string[],
    meta?: V2PageMeta,
  ): SocialPageV1 {
    let hasMore = false;
    let nextCursor: string | undefined;
    let partial = false;
    const pageWarnings = [...warnings];

    if (plan.pagination === 'page' && meta !== undefined) {
      hasMore = meta.page * meta.perPage < meta.total;
      if (hasMore) {
        nextCursor = encodeSocialCursor({
          platform: request.platform,
          action: request.action,
          backend: plan.backend,
          fingerprint: socialCursorFingerprint(request),
          state: { page: meta.page + 1 },
        });
      }
    } else if (plan.pagination === 'page') {
      // Page-mode backend responded without continuation metadata: truthfully
      // non-continuable for this payload.
      pageWarnings.push('upstream page response did not include pagination metadata; no cursor issued');
    }

    if (entities.length > request.limit) {
      entities = entities.slice(0, request.limit);
    }
    const upstreamTruncated = plan.pagination !== 'page' || meta === undefined;
    if (upstreamTruncated && entities.length === request.limit) {
      // Client-side truncation with no truthful continuation signal.
      partial = true;
      pageWarnings.push(`results truncated to limit ${request.limit} without upstream continuation metadata`);
    }

    return {
      entities,
      pagination: {
        supported: plan.pagination !== 'none',
        limit: request.limit,
        returned: entities.length,
        hasMore,
        ...(nextCursor !== undefined ? { nextCursor } : {}),
      },
      partial,
      warnings: pageWarnings,
    };
  }

  function normalizeList(
    request: SocialRequest,
    plan: SocialBackendPlan,
    payload: unknown,
    toEntity: (raw: Record<string, unknown>) => SocialEntityV1 | undefined,
  ): SocialPageV1 {
    const unwrapped = unwrapPayload(payload);
    if (unwrapped === undefined || unwrapped.items === undefined) {
      throw new SocialError('malformed_upstream', `v2ex ${request.action} payload is not a recognizable list`, {
        platform: 'v2ex',
        backend: plan.backend,
      });
    }
    const warnings: string[] = [];
    const entities: SocialEntityV1[] = [];
    let dropped = 0;
    for (const raw of unwrapped.items) {
      const record = asRecord(raw);
      if (record === undefined) {
        dropped += 1;
        continue;
      }
      const entity = toEntity(record);
      if (entity === undefined) {
        dropped += 1;
        continue;
      }
      entities.push(entity);
    }
    const page = finishPage(request, plan, entities, warnings, unwrapped.meta);
    if (dropped > 0) {
      page.partial = true;
      page.warnings.push(`dropped ${dropped} malformed upstream row(s)`);
    }
    return page;
  }

  function normalizeSingle(
    request: SocialRequest,
    plan: SocialBackendPlan,
    payload: unknown,
    toEntity: (raw: Record<string, unknown>) => SocialEntityV1 | undefined,
  ): SocialPageV1 {
    if (payload === null || payload === undefined) {
      throw new SocialError('not_found', `v2ex ${request.action} returned no matching entity`, {
        platform: 'v2ex',
        backend: plan.backend,
      });
    }
    const unwrapped = unwrapPayload(payload);
    if (unwrapped === undefined) {
      throw new SocialError('malformed_upstream', `v2ex ${request.action} payload is not a recognizable object`, {
        platform: 'v2ex',
        backend: plan.backend,
      });
    }
    const warnings: string[] = [];
    const candidates: SocialEntityV1[] = [];
    if (unwrapped.items !== undefined) {
      for (const raw of unwrapped.items) {
        const record = asRecord(raw);
        if (record === undefined) continue;
        const entity = toEntity(record);
        if (entity !== undefined) candidates.push(entity);
      }
    } else if (unwrapped.item !== undefined) {
      const entity = toEntity(unwrapped.item);
      if (entity !== undefined) candidates.push(entity);
    }
    if (candidates.length !== 1) {
      throw new SocialError('not_found', `v2ex ${request.action} returned no matching entity`, {
        platform: 'v2ex',
        backend: plan.backend,
      });
    }
    if (candidates.length > 1) warnings.push('upstream returned multiple matches; first used');
    const page = emptyPage(request, plan);
    page.entities = [candidates[0]!];
    page.pagination.returned = 1;
    page.warnings = warnings;
    return page;
  }

  const normalize = (
    request: SocialRequest,
    plan: SocialBackendPlan,
    payload: unknown,
  ): SocialPageV1 => {
    if (!isV2exPlan(plan)) {
      throw new SocialError('malformed_upstream', `plan ${plan.backend} is not a V2EX plan`, { platform: 'v2ex' });
    }
    const backend = plan.backend;

    switch (plan.operation) {
      case 'legacy_hot':
      case 'legacy_node_topics':
      case 'v2_node_topics':
        return normalizeList(request, plan, payload, (raw) => topicToPost(raw, backend));
      case 'legacy_replies':
      case 'v2_replies':
        return normalizeList(request, plan, payload, (raw) =>
          replyToComment(raw, backend, selector(request.postId ?? request.topic, 'postId')));
      case 'v2_notifications':
        return normalizeList(request, plan, payload, (raw) => notificationToEntity(raw, backend));
      case 'legacy_topic':
      case 'v2_topic':
        return normalizeSingle(request, plan, payload, (raw) => topicToPost(raw, backend));
      case 'legacy_member':
        return normalizeSingle(request, plan, payload, (raw) => memberToProfile(raw, backend));
      case 'v2_node':
        return normalizeSingle(request, plan, payload, (raw) => nodeToCommunity(raw, backend));
      case 'legacy_thread': {
        const record = asRecord(payload);
        if (record === undefined) {
          throw new SocialError('malformed_upstream', 'v2ex get_thread payload is not a recognizable object', {
            platform: 'v2ex',
            backend,
          });
        }
        const rootUnwrapped = unwrapPayload(record.topic);
        const rootRecord = rootUnwrapped?.item ?? (rootUnwrapped?.items !== undefined ? asRecord(rootUnwrapped.items[0]) : undefined);
        const root = rootRecord !== undefined ? topicToPost(rootRecord, backend) : undefined;
        if (root === undefined) {
          throw new SocialError('not_found', 'v2ex get_thread returned no root topic', { platform: 'v2ex', backend });
        }
        const warnings: string[] = [];
        const comments: SocialEntityV1[] = [];
        const repliesUnwrapped = unwrapPayload(record.replies);
        if (repliesUnwrapped?.items !== undefined) {
          for (const raw of repliesUnwrapped.items) {
            const replyRecord = asRecord(raw);
            if (replyRecord === undefined) {
              warnings.push('dropped malformed upstream reply row');
              continue;
            }
            const comment = replyToComment(replyRecord, backend, root.platformId!);
            if (comment === undefined) {
              warnings.push('dropped upstream reply row missing required identity fields');
              continue;
            }
            comments.push(comment);
          }
        } else {
          warnings.push('upstream returned no recognizable replies payload; thread comments omitted');
        }
        const page = emptyPage(request, plan);
        page.entities = [root, ...comments.slice(0, Math.max(0, request.limit - 1))];
        page.pagination.returned = page.entities.length;
        if (comments.length > Math.max(0, request.limit - 1)) {
          page.partial = true;
          page.warnings.push(`results truncated to limit ${request.limit} without upstream continuation metadata`);
        }
        page.warnings.push(...warnings);
        return page;
      }
      default: {
        const exhaustive: never = plan.operation;
        throw new SocialError('malformed_upstream', `unknown v2ex operation: ${String(exhaustive)}`, { platform: 'v2ex' });
      }
    }
  };

  function v2ListOperationFor(action: SocialRequest['action']): V2exOperation {
    switch (action) {
      case 'get_comments':
        return 'v2_replies';
      case 'get_community_posts':
        return 'v2_node_topics';
      case 'get_notifications':
        return 'v2_notifications';
      default:
        throw new SocialError(
          'cursor_mismatch',
          `v2ex ${action} has no cursor-capable backend`,
          { platform: 'v2ex', backend: V2EX_BACKEND_V2 },
        );
    }
  }

  return {
    platforms: ['v2ex'] as const,
    plans,
    normalize,
  };
}

/** Default worker instance reading V2EX_PAT from process.env. */
export const v2exWorker: SocialPlatformWorker = createV2exWorker();