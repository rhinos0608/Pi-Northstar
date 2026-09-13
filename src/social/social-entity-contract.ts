// Social entity contract: normalized entity types, envelope validators, and
// human-readable rendering helpers. Imports foundational vocabulary from
// social-core only — never from the social-contract facade (no runtime cycle).

import { SOCIAL_ENTITY_KINDS, isSocialPlatform, type SocialEntityKind, type SocialPlatform } from './social-core.js';

// ── Normalized entities ──
// Only fields present upstream are set. Never synthesize zero metrics, dates,
// parent relationships, or verification status.

export interface SocialEntityBaseV1 {
  version: 1;
  kind: SocialEntityKind;
  id: string;
  platformId?: string;
  platform: SocialPlatform;
  backend: string;
  url?: string;
  publishedAt?: string;
}

export interface SocialActorV1 {
  id?: string;
  handle?: string;
  displayName?: string;
  profileUrl?: string;
  avatarUrl?: string;
  verified?: boolean;
}

export interface SocialMetricsV1 {
  likes?: number;
  replies?: number;
  comments?: number;
  shares?: number;
  reposts?: number;
  quotes?: number;
  saves?: number;
  views?: number;
  score?: number;
  followers?: number;
  following?: number;
}

export interface SocialMediaV1 {
  type?: 'image' | 'video' | 'gif' | 'link';
  url?: string;
  thumbnailUrl?: string;
  altText?: string;
  width?: number;
  height?: number;
}

export interface SocialPostV1 extends SocialEntityBaseV1 {
  kind: 'social_post';
  contentType: 'post' | 'article' | 'note' | 'topic';
  title?: string;
  text?: string;
  author?: SocialActorV1;
  communityId?: string;
  threadId?: string;
  parentId?: string;
  metrics?: SocialMetricsV1;
  media?: SocialMediaV1[];
}

export interface SocialCommentV1 extends SocialEntityBaseV1 {
  kind: 'social_comment';
  postId: string;
  parentCommentId?: string;
  depth?: number;
  text: string;
  author?: SocialActorV1;
  metrics?: SocialMetricsV1;
}

export interface SocialAccountV1 extends SocialEntityBaseV1 {
  kind: 'social_account';
  handle?: string;
  displayName?: string;
  bio?: string;
  metrics?: SocialMetricsV1;
}

export interface SocialThreadV1 extends SocialEntityBaseV1 {
  kind: 'social_thread';
  rootPostId: string;
  title?: string;
  text?: string;
  postIds?: string[];
  author?: SocialActorV1;
  metrics?: SocialMetricsV1;
}

export interface SocialCommunityV1 extends SocialEntityBaseV1 {
  kind: 'social_community';
  name?: string;
  description?: string;
  metrics?: SocialMetricsV1;
}

export interface SocialMediaItemV1 extends SocialEntityBaseV1 {
  kind: 'social_media';
  postId: string;
  mediaType: 'image' | 'video' | 'gif' | 'link';
  thumbnailUrl?: string;
  altText?: string;
  width?: number;
  height?: number;
  author?: SocialActorV1;
  metrics?: SocialMetricsV1;
}

export interface SocialRelationshipV1 extends SocialEntityBaseV1 {
  kind: 'social_relationship';
  user: string;
  relatedUser: string;
  relationship: 'following' | 'followed_by' | 'mutual';
  actor?: SocialActorV1;
  metrics?: SocialMetricsV1;
}

export interface SocialEngagementV1 extends SocialEntityBaseV1 {
  kind: 'social_engagement';
  postId: string;
  engagementType: 'like' | 'repost' | 'share' | 'save' | 'view' | 'quote';
  actor?: SocialActorV1;
  metrics?: SocialMetricsV1;
}

export interface SocialTopicV1 extends SocialEntityBaseV1 {
  kind: 'social_topic';
  name?: string;
  description?: string;
  metrics?: SocialMetricsV1;
}

export interface SocialNotificationV1 extends SocialEntityBaseV1 {
  kind: 'social_notification';
  type?: string;
  text?: string;
  actor?: SocialActorV1;
  relatedEntityId?: string;
}

export interface SocialReferenceV1 extends SocialEntityBaseV1 {
  // Sparse-row fallback only: search listings too sparse to form a
  // post/comment/account/community/topic/notification entity. Never
  // synthesize a reference when a richer kind applies.
  kind: 'social_reference';
  title?: string;
  snippet?: string;
  author?: SocialActorV1;
  metrics?: SocialMetricsV1;
}

export type SocialEntityV1 =
  | SocialPostV1
  | SocialCommentV1
  | SocialAccountV1
  | SocialThreadV1
  | SocialCommunityV1
  | SocialMediaItemV1
  | SocialRelationshipV1
  | SocialEngagementV1
  | SocialTopicV1
  | SocialNotificationV1
  | SocialReferenceV1;

function isSocialEntityKind(value: unknown): value is SocialEntityKind {
  return typeof value === 'string' && SOCIAL_ENTITY_KINDS.has(value);
}

/** Namespaced entity id: platform/kind/native ID. */
export function socialEntityId(platform: SocialPlatform, kind: SocialEntityKind, nativeId: string): string {
  return `${platform}:${kind}:${nativeId}`;
}

/** ISO 8601 timestamp or undefined. Invalid dates are omitted by callers (with a warning). */
export function parseSocialDate(value: unknown): string | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) {
    // Epoch seconds vs milliseconds heuristic.
    const ms = Math.abs(value) >= 1e12 ? value : value * 1000;
    const date = new Date(ms);
    return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
  }
  if (typeof value !== 'string' || value.trim().length === 0) return undefined;
  const parsed = new Date(value.trim());
  return Number.isNaN(parsed.getTime()) ? undefined : parsed.toISOString();
}

// ── Envelope validation ──
// Normalized envelope validator: rejects unknown fields, NaN metrics, invalid
// dates, and malformed URLs before a page is surfaced.

const METRIC_KEYS: readonly (keyof SocialMetricsV1)[] = [
  'likes', 'replies', 'comments', 'shares', 'reposts', 'quotes', 'saves',
  'views', 'score', 'followers', 'following',
];

const ENTITY_KIND_FIELDS: Readonly<Record<SocialEntityKind, ReadonlySet<string>>> = {
  social_post: new Set(['contentType', 'title', 'text', 'author', 'communityId', 'threadId', 'parentId', 'metrics', 'media']),
  social_comment: new Set(['postId', 'parentCommentId', 'depth', 'text', 'author', 'metrics']),
  social_account: new Set(['handle', 'displayName', 'bio', 'metrics']),
  social_thread: new Set(['rootPostId', 'title', 'text', 'postIds', 'author', 'metrics']),
  social_community: new Set(['name', 'description', 'metrics']),
  social_media: new Set(['postId', 'mediaType', 'thumbnailUrl', 'altText', 'width', 'height', 'author', 'metrics']),
  social_relationship: new Set(['user', 'relatedUser', 'relationship', 'actor', 'metrics']),
  social_engagement: new Set(['postId', 'engagementType', 'actor', 'metrics']),
  social_topic: new Set(['name', 'description', 'metrics']),
  social_notification: new Set(['type', 'text', 'actor', 'relatedEntityId']),
  social_reference: new Set(['title', 'snippet', 'author', 'metrics']),
};

function isValidHttpUrl(value: string): boolean {
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

function validateActor(value: unknown, issues: string[]): void {
  if (value === undefined) return;
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    issues.push('actor must be an object');
    return;
  }
  const actor = value as Record<string, unknown>;
  const allowed = new Set(['id', 'handle', 'displayName', 'profileUrl', 'avatarUrl', 'verified']);
  for (const key of Object.keys(actor)) {
    if (!allowed.has(key)) issues.push(`actor.${key} is not a known field`);
  }
  for (const key of ['id', 'handle', 'displayName', 'profileUrl', 'avatarUrl'] as const) {
    if (actor[key] !== undefined && typeof actor[key] !== 'string') issues.push(`actor.${key} must be a string`);
  }
  if (actor.profileUrl !== undefined && typeof actor.profileUrl === 'string' && !isValidHttpUrl(actor.profileUrl)) {
    issues.push('actor.profileUrl is not a valid http(s) URL');
  }
  if (actor.verified !== undefined && typeof actor.verified !== 'boolean') {
    issues.push('actor.verified must be a boolean');
  }
}

function validateMetrics(value: unknown, path: string, issues: string[]): void {
  if (value === undefined) return;
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    issues.push(`${path} must be an object`);
    return;
  }
  const metrics = value as Record<string, unknown>;
  for (const key of Object.keys(metrics)) {
    if (!(METRIC_KEYS as readonly string[]).includes(key)) {
      issues.push(`${path}.${key} is not a known metric`);
      continue;
    }
    const metric = metrics[key];
    if (metric !== undefined && (typeof metric !== 'number' || !Number.isFinite(metric))) {
      issues.push(`${path}.${key} must be a finite number`);
    }
  }
}

export function validateSocialEntity(value: unknown): { ok: boolean; issues: string[] } {
  const issues: string[] = [];
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return { ok: false, issues: ['entity is not an object'] };
  }
  const entity = value as Record<string, unknown>;
  const kind = entity.kind;
  if (!isSocialEntityKind(kind)) {
    return { ok: false, issues: ['kind is not a valid social entity kind'] };
  }
  if (entity.version !== 1) issues.push('version must be 1');
  if (typeof entity.id !== 'string' || entity.id.trim().length === 0) issues.push('id is required');
  if (!isSocialPlatform(entity.platform)) issues.push('platform is not a valid social platform');
  if (typeof entity.backend !== 'string' || entity.backend.trim().length === 0) issues.push('backend is required');
  if (entity.platformId !== undefined && typeof entity.platformId !== 'string') issues.push('platformId must be a string');
  if (entity.url !== undefined && (typeof entity.url !== 'string' || !isValidHttpUrl(entity.url))) {
    issues.push('url is not a valid http(s) URL');
  }
  if (entity.publishedAt !== undefined && parseSocialDate(entity.publishedAt) === undefined) {
    issues.push('publishedAt is not a valid date');
  }

  const allowed = new Set([
    'version', 'kind', 'id', 'platformId', 'platform', 'backend', 'url', 'publishedAt',
    ...ENTITY_KIND_FIELDS[kind],
  ]);
  for (const key of Object.keys(entity)) {
    if (!allowed.has(key)) issues.push(`${key} is not a known field for kind ${String(kind)}`);
  }

  if (kind === 'social_post') {
    if (!['post', 'article', 'note', 'topic'].includes(entity.contentType as string)) {
      issues.push('contentType must be post, article, note, or topic');
    }
    validateActor(entity.author, issues);
    validateMetrics(entity.metrics, 'metrics', issues);
    if (entity.media !== undefined) {
      if (!Array.isArray(entity.media)) issues.push('media must be an array');
      else {
        for (const [index, media] of entity.media.entries()) {
          if (typeof media !== 'object' || media === null || Array.isArray(media)) {
            issues.push(`media[${index}] must be an object`);
            continue;
          }
          const row = media as Record<string, unknown>;
          const mediaAllowed = new Set(['type', 'url', 'thumbnailUrl', 'altText', 'width', 'height']);
          for (const key of Object.keys(row)) {
            if (!mediaAllowed.has(key)) issues.push(`media[${index}].${key} is not a known field`);
          }
          if (row.url !== undefined && (typeof row.url !== 'string' || !isValidHttpUrl(row.url))) {
            issues.push(`media[${index}].url is not a valid http(s) URL`);
          }
        }
      }
    }
  } else if (kind === 'social_comment') {
    if (typeof entity.postId !== 'string' || entity.postId.trim().length === 0) issues.push('postId is required');
    if (typeof entity.text !== 'string' || entity.text.trim().length === 0) issues.push('text is required');
    if (entity.depth !== undefined && (typeof entity.depth !== 'number' || !Number.isFinite(entity.depth))) {
      issues.push('depth must be a finite number');
    }
    validateActor(entity.author, issues);
    validateMetrics(entity.metrics, 'metrics', issues);
  } else if (kind === 'social_thread') {
    if (typeof entity.rootPostId !== 'string' || entity.rootPostId.trim().length === 0) issues.push('rootPostId is required');
    if (entity.title !== undefined && typeof entity.title !== 'string') issues.push('title must be a string');
    if (entity.text !== undefined && typeof entity.text !== 'string') issues.push('text must be a string');
    if (entity.postIds !== undefined && (!Array.isArray(entity.postIds) || entity.postIds.some((id) => typeof id !== 'string'))) {
      issues.push('postIds must be an array of strings');
    }
    validateActor(entity.author, issues);
    validateMetrics(entity.metrics, 'metrics', issues);
  } else if (kind === 'social_media') {
    if (typeof entity.postId !== 'string' || entity.postId.trim().length === 0) issues.push('postId is required');
    if (!['image', 'video', 'gif', 'link'].includes(entity.mediaType as string)) {
      issues.push('mediaType must be image, video, gif, or link');
    }
    if (entity.thumbnailUrl !== undefined && (typeof entity.thumbnailUrl !== 'string' || !isValidHttpUrl(entity.thumbnailUrl))) {
      issues.push('thumbnailUrl is not a valid http(s) URL');
    }
    for (const dim of ['width', 'height'] as const) {
      if (entity[dim] !== undefined && (typeof entity[dim] !== 'number' || !Number.isFinite(entity[dim]))) {
        issues.push(`${dim} must be a finite number`);
      }
    }
    validateActor(entity.author, issues);
    validateMetrics(entity.metrics, 'metrics', issues);
  } else if (kind === 'social_relationship') {
    if (typeof entity.user !== 'string' || entity.user.trim().length === 0) issues.push('user is required');
    if (typeof entity.relatedUser !== 'string' || entity.relatedUser.trim().length === 0) issues.push('relatedUser is required');
    if (!['following', 'followed_by', 'mutual'].includes(entity.relationship as string)) {
      issues.push('relationship must be following, followed_by, or mutual');
    }
    validateActor(entity.actor, issues);
    validateMetrics(entity.metrics, 'metrics', issues);
  } else if (kind === 'social_engagement') {
    if (typeof entity.postId !== 'string' || entity.postId.trim().length === 0) issues.push('postId is required');
    if (!['like', 'repost', 'share', 'save', 'view', 'quote'].includes(entity.engagementType as string)) {
      issues.push('engagementType must be like, repost, share, save, view, or quote');
    }
    validateActor(entity.actor, issues);
    validateMetrics(entity.metrics, 'metrics', issues);
  } else if (kind === 'social_notification') {
    validateActor(entity.actor, issues);
  } else {
    validateActor(entity.author, issues);
    validateMetrics(entity.metrics, 'metrics', issues);
  }

  return { ok: issues.length === 0, issues };
}

// Normalized page envelope over entities. Lives here (not the facade) so the
// envelope validators and renderers share one definition; the facade
// re-exports it for the worker seam.
export interface SocialPageV1 {
  entities: SocialEntityV1[];
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

export function validateSocialPage(value: unknown): { ok: boolean; issues: string[]; page?: SocialPageV1 } {
  const issues: string[] = [];
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return { ok: false, issues: ['page is not an object'] };
  }
  const page = value as Record<string, unknown>;

  if (!Array.isArray(page.entities)) {
    issues.push('entities must be an array');
  } else {
    for (const [index, entity] of page.entities.entries()) {
      const check = validateSocialEntity(entity);
      if (!check.ok) issues.push(`entities[${index}]: ${check.issues.join('; ')}`);
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
    if (pagination.hasMore === true) {
      if (pagination.supported !== true) issues.push('hasMore true requires pagination.supported true');
      if (typeof pagination.nextCursor !== 'string' || pagination.nextCursor.length === 0) {
        issues.push('hasMore true requires a nextCursor');
      }
    }
    if (pagination.nextCursor !== undefined && (typeof pagination.nextCursor !== 'string' || pagination.nextCursor.length === 0)) {
      issues.push('nextCursor must be a non-empty string when present');
    }
    if (pagination.nextCursor !== undefined && pagination.hasMore !== true) {
      issues.push('nextCursor present requires hasMore true');
    }
  }

  return issues.length === 0 ? { ok: true, issues, page: page as unknown as SocialPageV1 } : { ok: false, issues };
}

// ── Human-readable rendering ──

function boundedText(value: string, maxChars: number): string {
  const flat = value.replace(/\s+/g, ' ').trim();
  return flat.length > maxChars ? `${flat.slice(0, maxChars)}…` : flat;
}

function actorLabel(actor: SocialActorV1 | undefined): string | undefined {
  if (actor === undefined) return undefined;
  if (actor.handle !== undefined) return `@${actor.handle}`;
  if (actor.displayName !== undefined) return actor.displayName;
  return undefined;
}

const METRIC_LABELS: Record<keyof SocialMetricsV1, string> = {
  likes: 'likes', replies: 'replies', comments: 'comments', shares: 'shares',
  reposts: 'reposts', quotes: 'quotes', saves: 'saves', views: 'views',
  score: 'score', followers: 'followers', following: 'following',
};

function metricsSummary(metrics: SocialMetricsV1 | undefined): string | undefined {
  if (metrics === undefined) return undefined;
  const parts: string[] = [];
  for (const key of METRIC_KEYS) {
    const value = metrics[key];
    if (value !== undefined) parts.push(`${METRIC_LABELS[key]} ${value}`);
  }
  return parts.length > 0 ? parts.join(' · ') : undefined;
}

/** Render one normalized entity as deterministic human-readable text. */
export function renderSocialEntity(entity: SocialEntityV1, options?: { maxTextChars?: number }): string {
  const maxTextChars = options?.maxTextChars ?? 200;
  const lines: string[] = [];

  switch (entity.kind) {
    case 'social_post': {
      const headline = entity.title ?? entity.text ?? '';
      const headlineText = boundedText(headline, maxTextChars);
      lines.push(headlineText.length > 0 ? `[post] ${headlineText}` : '[post]');
      break;
    }
    case 'social_comment': {
      lines.push(`[comment] ${boundedText(entity.text, maxTextChars)}`);
      lines.push(`on post ${entity.postId}`);
      break;
    }
    case 'social_account': {
      const label = entity.handle !== undefined ? `@${entity.handle}` : entity.displayName ?? entity.id;
      lines.push(`[account] ${label}`);
      if (entity.bio !== undefined) lines.push(boundedText(entity.bio, maxTextChars));
      break;
    }
    case 'social_thread': {
      const threadHeadline = entity.title ?? entity.text ?? entity.rootPostId;
      lines.push(`[thread] ${boundedText(threadHeadline, maxTextChars)}`);
      lines.push(`root post ${entity.rootPostId}`);
      if (entity.postIds !== undefined) lines.push(`${entity.postIds.length} posts`);
      break;
    }
    case 'social_community': {
      lines.push(`[community] ${entity.name ?? entity.id}`);
      if (entity.description !== undefined) lines.push(boundedText(entity.description, maxTextChars));
      break;
    }
    case 'social_media': {
      lines.push(`[media:${entity.mediaType}] on post ${entity.postId}`);
      if (entity.altText !== undefined) lines.push(boundedText(entity.altText, maxTextChars));
      break;
    }
    case 'social_relationship': {
      lines.push(`[relationship] ${entity.user} ${entity.relationship} ${entity.relatedUser}`);
      break;
    }
    case 'social_engagement': {
      lines.push(`[engagement:${entity.engagementType}] on post ${entity.postId}`);
      break;
    }
    case 'social_topic': {
      lines.push(`[topic] ${entity.name ?? entity.id}`);
      if (entity.description !== undefined) lines.push(boundedText(entity.description, maxTextChars));
      break;
    }
    case 'social_notification': {
      lines.push(`[notification] ${entity.type ?? 'event'}`);
      if (entity.text !== undefined) lines.push(boundedText(entity.text, maxTextChars));
      break;
    }
    case 'social_reference': {
      const headline = boundedText(entity.title ?? entity.snippet ?? '', maxTextChars);
      lines.push(headline.length > 0 ? `[reference] ${headline}` : '[reference]');
      break;
    }
  }

  if ('author' in entity) {
    const label = actorLabel(entity.author);
    if (label !== undefined) lines.push(`by ${label}`);
  } else if ('actor' in entity) {
    const label = actorLabel(entity.actor);
    if (label !== undefined) lines.push(`by ${label}`);
  }
  if (entity.publishedAt !== undefined) lines.push(`published ${entity.publishedAt}`);
  const metricsLine = metricsSummary('metrics' in entity ? entity.metrics : undefined);
  if (metricsLine !== undefined) lines.push(metricsLine);
  if (entity.url !== undefined) lines.push(entity.url);
  return lines.join('\n');
}

/** Render a normalized page: entities joined by blank lines plus pagination footer. */
export function renderSocialPage(page: SocialPageV1, options?: { maxTextChars?: number }): string {
  const sections = page.entities.map((entity) => renderSocialEntity(entity, options));
  const footer: string[] = [];
  if (page.pagination.hasMore) footer.push('more results available (use nextCursor to continue)');
  else if (page.pagination.supported) footer.push(`${page.pagination.returned} of up to ${page.pagination.limit} results`);
  for (const warning of page.warnings) footer.push(`warning: ${warning}`);
  if (page.partial) footer.push('partial: some upstream rows were dropped');
  const body = sections.join('\n\n');
  const tail = footer.join('\n');
  if (body.length === 0 && tail.length === 0) return '(no results)';
  if (tail.length === 0) return body;
  return body.length === 0 ? tail : `${body}\n\n--\n${tail}`;
}
