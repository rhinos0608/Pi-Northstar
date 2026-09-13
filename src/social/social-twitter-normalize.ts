// Per-platform Twitter/X fixture normalization (extracted from social-twitter.ts).
//
// Owns row interfaces, actor/metric/media/profile/tweet helpers, toComment,
// expectList, notFound, page assembly, and the backend payload dispatch for
// the two verified Twitter backends (`twitter-cli`, `opencli-twitter`).
// The worker (src/social-twitter.ts) keeps capabilities, argv, subprocess,
// env, and backend selection; it delegates normalize() here.
//
// Page policy (preserved): pages are assembled with pageFromEntities, which
// throws malformed_upstream when validateSocialPage fails. Warnings mark the
// page partial. Thread/comment listings skip rows.slice(1) (the root row).

import {
  SocialError,
  parseSocialDate,
  socialEntityId,
  validateSocialPage,
  type SocialAccountV1,
  type SocialActorV1,
  type SocialCommentV1,
  type SocialEntityV1,
  type SocialMetricsV1,
  type SocialNotificationV1,
  type SocialPageV1,
  type SocialPostV1,
  type SocialRequest,
  type SocialTopicV1,
} from './social-contract.js';

export type TwitterNormalizeBackend = 'twitter-cli' | 'opencli-twitter';

// ── Fixture shapes ──
// twitter-cli --json emits arrays of tweet dicts, or a single user dict for
// `user` (shapes per public-clis/twitter-cli serialization.py at v0.8.5).
// OpenCLI `-f json` prints the command's raw row array (shapes per
// jackwener/OpenCLI clis/twitter/*.js at v1.8.6).

interface TwitterCliTweetRow {
  id: unknown;
  text: unknown;
  author?: {
    id?: unknown;
    name?: unknown;
    screenName?: unknown;
    profileImageUrl?: unknown;
    verified?: unknown;
  };
  metrics?: {
    likes?: unknown;
    retweets?: unknown;
    replies?: unknown;
    quotes?: unknown;
    views?: unknown;
    bookmarks?: unknown;
  };
  createdAt?: unknown;
  createdAtISO?: unknown;
  media?: ReadonlyArray<{ type?: unknown; url?: unknown; width?: unknown; height?: unknown }>;
  articleTitle?: unknown;
  isRetweet?: unknown;
  retweetedBy?: unknown;
}

interface TwitterCliUserRow {
  id: unknown;
  name: unknown;
  screenName: unknown;
  bio?: unknown;
  followers?: unknown;
  following?: unknown;
  verified?: unknown;
  profileImageUrl?: unknown;
  createdAt?: unknown;
  createdAtISO?: unknown;
}

interface OpenCliTweetRow {
  id: unknown;
  author?: unknown;
  bio?: unknown;
  name?: unknown;
  text: unknown;
  likes?: unknown;
  retweets?: unknown;
  replies?: unknown;
  views?: unknown;
  created_at?: unknown;
  url?: unknown;
  media_urls?: unknown;
  media_posters?: unknown;
}

interface OpenCliProfileRow {
  screen_name?: unknown;
  name?: unknown;
  bio?: unknown;
  followers?: unknown;
  following?: unknown;
  verified?: unknown;
  created_at?: unknown;
}

interface OpenCliTrendRow {
  rank?: unknown;
  topic?: unknown;
  category?: unknown;
}

interface OpenCliNotificationRow {
  id: unknown;
  action?: unknown;
  author?: unknown;
  text?: unknown;
  url?: unknown;
}

function optionalFiniteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

function isValidHttpUrl(value: string): boolean {
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

// ── Normalization: twitter-cli ──

function twitterCliActor(row: TwitterCliTweetRow): SocialActorV1 | undefined {
  const author = row.author;
  if (typeof author !== 'object' || author === null) return undefined;
  const actor: SocialActorV1 = {};
  const id = optionalString(author.id);
  const handle = optionalString(author.screenName);
  const displayName = optionalString(author.name);
  const avatar = optionalString(author.profileImageUrl);
  if (id !== undefined) actor.id = id;
  if (handle !== undefined) actor.handle = handle;
  if (displayName !== undefined) actor.displayName = displayName;
  if (avatar !== undefined) actor.avatarUrl = avatar;
  if (author.verified === true) actor.verified = true;
  return Object.keys(actor).length > 0 ? actor : undefined;
}

function twitterCliMetrics(row: TwitterCliTweetRow): SocialMetricsV1 | undefined {
  const metrics = row.metrics;
  if (typeof metrics !== 'object' || metrics === null) return undefined;
  const mapped: SocialMetricsV1 = {};
  const pairs: ReadonlyArray<[keyof SocialMetricsV1, unknown]> = [
    ['likes', metrics.likes],
    ['reposts', metrics.retweets],
    ['replies', metrics.replies],
    ['quotes', metrics.quotes],
    ['views', metrics.views],
    ['saves', metrics.bookmarks],
  ];
  for (const [key, value] of pairs) {
    const number = optionalFiniteNumber(value);
    if (number !== undefined) mapped[key] = number;
  }
  return Object.keys(mapped).length > 0 ? mapped : undefined;
}

function twitterCliMedia(row: TwitterCliTweetRow): NonNullable<SocialPostV1['media']> | undefined {
  if (!Array.isArray(row.media) || row.media.length === 0) return undefined;
  const media: NonNullable<SocialPostV1['media']> = [];
  for (const item of row.media) {
    if (typeof item !== 'object' || item === null) continue;
    const url = optionalString(item.url);
    if (url === undefined || !isValidHttpUrl(url)) continue;
    const entry: NonNullable<SocialPostV1['media']>[number] = { url };
    if (item.type === 'photo') entry.type = 'image';
    else if (item.type === 'video') entry.type = 'video';
    else if (item.type === 'animated_gif') entry.type = 'gif';
    const width = optionalFiniteNumber(item.width);
    const height = optionalFiniteNumber(item.height);
    if (width !== undefined) entry.width = width;
    if (height !== undefined) entry.height = height;
    media.push(entry);
  }
  return media.length > 0 ? media : undefined;
}

function isThreadAction(action: SocialRequest['action']): boolean {
  return action === 'get_thread' || action === 'get_comments' || action === 'get_comment_replies';
}

function normalizeTwitterCliTweet(
  request: SocialRequest,
  row: TwitterCliTweetRow,
  backend: string,
  warnings: string[],
): SocialPostV1 | undefined {
  const id = typeof row.id === 'string' && row.id.trim().length > 0 ? row.id.trim() : undefined;
  if (id === undefined) {
    warnings.push('dropped tweet row without id');
    return undefined;
  }
  const title = optionalString(row.articleTitle);
  const text = optionalString(row.text);
  if (title === undefined && text === undefined) {
    warnings.push(`dropped tweet ${id} without text`);
    return undefined;
  }
  const author = twitterCliActor(row);
  const handle = author?.handle;
  const publishedAt = parseSocialDate(row.createdAtISO ?? row.createdAt);
  if ((row.createdAtISO ?? row.createdAt) !== undefined && publishedAt === undefined) {
    warnings.push(`tweet ${id} has an invalid date; publishedAt omitted`);
  }
  const metrics = twitterCliMetrics(row);
  const media = twitterCliMedia(row);
  const entity: SocialPostV1 = {
    version: 1,
    kind: 'social_post',
    id: socialEntityId('twitter', 'social_post', id),
    platformId: id,
    platform: 'twitter',
    backend,
    url: `https://x.com/${handle ?? 'i'}/status/${id}`,
    contentType: title !== undefined ? 'article' : 'post',
  };
  if (publishedAt !== undefined) entity.publishedAt = publishedAt;
  if (title !== undefined) entity.title = title;
  if (text !== undefined) entity.text = text;
  if (author !== undefined) entity.author = author;
  if (metrics !== undefined) entity.metrics = metrics;
  if (media !== undefined) entity.media = media;
  if (isThreadAction(request.action)) {
    const threadAnchor = request.postId ?? request.commentId;
    if (threadAnchor !== undefined) entity.threadId = threadAnchor;
  }
  if (row.isRetweet === true && typeof row.retweetedBy === 'string' && row.retweetedBy.length > 0) {
    warnings.push(`tweet ${id} is a retweet by @${row.retweetedBy}`);
  }
  return entity;
}

function normalizeTwitterCliProfile(
  row: TwitterCliUserRow,
  backend: string,
  warnings: string[],
): SocialAccountV1 | undefined {
  if (typeof row !== 'object' || row === null) {
    warnings.push('dropped malformed user row');
    return undefined;
  }
  const handle = optionalString(row.screenName);
  const id = optionalString(row.id);
  if (handle === undefined && id === undefined) {
    warnings.push('dropped user row without handle or id');
    return undefined;
  }
  const nativeId = handle ?? id!;
  const displayName = optionalString(row.name);
  const bio = optionalString(row.bio);
  const metrics: SocialMetricsV1 = {};
  const followers = optionalFiniteNumber(row.followers);
  const following = optionalFiniteNumber(row.following);
  if (followers !== undefined) metrics.followers = followers;
  if (following !== undefined) metrics.following = following;
  const publishedAt = parseSocialDate(row.createdAtISO ?? row.createdAt);
  if ((row.createdAtISO ?? row.createdAt) !== undefined && publishedAt === undefined) {
    warnings.push(`profile ${nativeId} has an invalid date; publishedAt omitted`);
  }
  const profile: SocialAccountV1 = {
    version: 1,
    kind: 'social_account',
    id: socialEntityId('twitter', 'social_account', nativeId),
    platformId: nativeId,
    platform: 'twitter',
    backend,
    url: `https://x.com/${handle ?? nativeId}`,
  };
  if (publishedAt !== undefined) profile.publishedAt = publishedAt;
  if (handle !== undefined) profile.handle = handle;
  if (displayName !== undefined) profile.displayName = displayName;
  if (bio !== undefined) profile.bio = bio;
  if (Object.keys(metrics).length > 0) profile.metrics = metrics;
  return profile;
}

// ── Normalization: OpenCLI ──

function openCliAuthor(handle: unknown, displayName: unknown): SocialActorV1 | undefined {
  const actor: SocialActorV1 = {};
  const handleValue = optionalString(handle);
  const name = optionalString(displayName);
  if (handleValue !== undefined) actor.handle = handleValue;
  if (name !== undefined) actor.displayName = name;
  return Object.keys(actor).length > 0 ? actor : undefined;
}

function openCliMetrics(row: OpenCliTweetRow): SocialMetricsV1 | undefined {
  const mapped: SocialMetricsV1 = {};
  const pairs: ReadonlyArray<[keyof SocialMetricsV1, unknown]> = [
    ['likes', row.likes],
    ['reposts', row.retweets],
    ['replies', row.replies],
    ['views', row.views],
  ];
  for (const [key, value] of pairs) {
    const number = optionalFiniteNumber(value);
    if (number !== undefined) mapped[key] = number;
  }
  return Object.keys(mapped).length > 0 ? mapped : undefined;
}

function openCliMedia(row: OpenCliTweetRow): NonNullable<SocialPostV1['media']> | undefined {
  if (!Array.isArray(row.media_urls) || row.media_urls.length === 0) return undefined;
  const posters = Array.isArray(row.media_posters) ? row.media_posters : [];
  const media: NonNullable<SocialPostV1['media']> = [];
  for (const [index, entry] of row.media_urls.entries()) {
    const url = optionalString(entry);
    if (url === undefined || !isValidHttpUrl(url)) continue;
    const item: NonNullable<SocialPostV1['media']>[number] = { url };
    const poster = optionalString(posters[index]);
    if (poster !== undefined) item.thumbnailUrl = poster;
    media.push(item);
  }
  return media.length > 0 ? media : undefined;
}

function normalizeOpenCliTweet(
  request: SocialRequest,
  row: OpenCliTweetRow,
  backend: string,
  warnings: string[],
): SocialPostV1 | undefined {
  const id = optionalString(row.id);
  if (id === undefined) {
    warnings.push('dropped tweet row without id');
    return undefined;
  }
  const text = optionalString(row.text);
  if (text === undefined) {
    warnings.push(`dropped tweet ${id} without text`);
    return undefined;
  }
  const url = optionalString(row.url);
  if (url !== undefined && !isValidHttpUrl(url)) {
    warnings.push(`tweet ${id} has an invalid url; url omitted`);
  }
  const publishedAt = parseSocialDate(row.created_at);
  if (row.created_at !== undefined && publishedAt === undefined) {
    warnings.push(`tweet ${id} has an invalid date; publishedAt omitted`);
  }
  const author = openCliAuthor(row.author, row.name);
  const metrics = openCliMetrics(row);
  const media = openCliMedia(row);
  const entity: SocialPostV1 = {
    version: 1,
    kind: 'social_post',
    id: socialEntityId('twitter', 'social_post', id),
    platformId: id,
    platform: 'twitter',
    backend,
    contentType: 'post',
    text,
  };
  if (url !== undefined && isValidHttpUrl(url)) entity.url = url;
  if (publishedAt !== undefined) entity.publishedAt = publishedAt;
  if (author !== undefined) entity.author = author;
  if (metrics !== undefined) entity.metrics = metrics;
  if (media !== undefined) entity.media = media;
  if (isThreadAction(request.action)) {
    const threadAnchor = request.postId ?? request.commentId;
    if (threadAnchor !== undefined) entity.threadId = threadAnchor;
  }
  return entity;
}

function normalizeOpenCliProfile(
  row: OpenCliProfileRow,
  backend: string,
  warnings: string[],
): SocialAccountV1 | undefined {
  const handle = optionalString(row.screen_name);
  if (handle === undefined) {
    warnings.push('dropped profile row without screen_name');
    return undefined;
  }
  const displayName = optionalString(row.name);
  const bio = optionalString(row.bio);
  const metrics: SocialMetricsV1 = {};
  const followers = optionalFiniteNumber(row.followers);
  const following = optionalFiniteNumber(row.following);
  if (followers !== undefined) metrics.followers = followers;
  if (following !== undefined) metrics.following = following;
  const publishedAt = parseSocialDate(row.created_at);
  if (row.created_at !== undefined && publishedAt === undefined) {
    warnings.push(`profile @${handle} has an invalid date; publishedAt omitted`);
  }
  const profile: SocialAccountV1 = {
    version: 1,
    kind: 'social_account',
    id: socialEntityId('twitter', 'social_account', handle),
    platformId: handle,
    platform: 'twitter',
    backend,
    url: `https://x.com/${handle}`,
    handle,
  };
  if (publishedAt !== undefined) profile.publishedAt = publishedAt;
  if (displayName !== undefined) profile.displayName = displayName;
  if (bio !== undefined) profile.bio = bio;
  if (Object.keys(metrics).length > 0) profile.metrics = metrics;
  return profile;
}

// ── Page assembly ──

function pageFromEntities(
  request: SocialRequest,
  entities: readonly SocialEntityV1[],
  warnings: string[],
): SocialPageV1 {
  const page: SocialPageV1 = {
    entities: [...entities],
    pagination: {
      supported: false,
      limit: request.limit,
      returned: entities.length,
      hasMore: false,
    },
    partial: warnings.length > 0,
    warnings: [...warnings],
  };
  const validated = validateSocialPage(page);
  if (!validated.ok || validated.page === undefined) {
    throw new SocialError(
      'malformed_upstream',
      `normalized page failed validation: ${validated.issues.join('; ')}`,
      { platform: 'twitter' },
    );
  }
  return validated.page;
}

function expectList(payload: unknown, backend: string): unknown[] {
  if (!Array.isArray(payload)) {
    throw new SocialError('malformed_upstream', `${backend} payload is not a list`, {
      platform: 'twitter', backend,
    });
  }
  return payload;
}

function notFound(backend: string, message: string): never {
  throw new SocialError('not_found', message, { platform: 'twitter', backend });
}

function toComment(
  post: SocialPostV1,
  request: SocialRequest,
  parentNativeId: string | undefined,
  directParent: string | undefined,
): SocialCommentV1 {
  const platformId = post.platformId ?? post.id;
  const comment: SocialCommentV1 = {
    version: 1,
    kind: 'social_comment',
    id: socialEntityId('twitter', 'social_comment', platformId),
    platformId,
    platform: 'twitter',
    backend: post.backend,
    postId: parentNativeId ?? request.postId ?? request.commentId ?? platformId,
    depth: 1,
    text: post.text ?? '',
  };
  if (post.url !== undefined) comment.url = post.url;
  if (post.publishedAt !== undefined) comment.publishedAt = post.publishedAt;
  if (directParent !== undefined) comment.parentCommentId = directParent;
  if (post.author !== undefined) comment.author = post.author;
  if (post.metrics !== undefined) comment.metrics = post.metrics;
  return comment;
}

function isObjectRow(row: unknown): boolean {
  return typeof row === 'object' && row !== null;
}

// Reply rows after the root (rows.slice(1)) become comments anchored to the
// thread. Malformed rows are dropped with a warning, preserving source order.
function twitterCliRepliesToComments(
  request: SocialRequest,
  rows: readonly unknown[],
  backend: string,
  warnings: string[],
  postId: string | undefined,
  directParent: string | undefined,
): SocialEntityV1[] {
  const entities: SocialEntityV1[] = [];
  for (const row of rows.slice(1)) {
    if (!isObjectRow(row)) {
      warnings.push('dropped malformed reply row');
      continue;
    }
    const reply = normalizeTwitterCliTweet(request, row as TwitterCliTweetRow, backend, warnings);
    if (reply !== undefined) {
      entities.push(toComment(reply, request, postId, directParent));
    }
  }
  return entities;
}

function openCliRepliesToComments(
  request: SocialRequest,
  rows: readonly unknown[],
  backend: string,
  warnings: string[],
  postId: string | undefined,
  directParent: string | undefined,
): SocialEntityV1[] {
  const entities: SocialEntityV1[] = [];
  for (const row of rows.slice(1)) {
    if (!isObjectRow(row)) {
      warnings.push('dropped malformed reply row');
      continue;
    }
    const reply = normalizeOpenCliTweet(request, row as OpenCliTweetRow, backend, warnings);
    if (reply !== undefined) {
      entities.push(toComment(reply, request, postId, directParent));
    }
  }
  return entities;
}

// ── twitter-cli per-action helpers ──

function twitterCliPostDetail(
  request: SocialRequest,
  payload: unknown,
  backend: string,
  warnings: string[],
): SocialPageV1 {
  const row = Array.isArray(payload) ? payload[0] : payload;
  if (row === undefined || row === null || typeof row !== 'object') {
    notFound(backend, 'tweet not found');
  }
  const entity = normalizeTwitterCliTweet(request, row as TwitterCliTweetRow, backend, warnings);
  if (entity === undefined) {
    throw new SocialError('malformed_upstream', 'tweet payload is malformed', {
      platform: 'twitter', backend,
    });
  }
  return pageFromEntities(request, [entity], warnings);
}

function twitterCliThread(
  request: SocialRequest,
  payload: unknown,
  backend: string,
  warnings: string[],
): SocialPageV1 {
  const rows = expectList(payload, backend);
  if (rows.length === 0) notFound(backend, 'thread not found');
  const entities: SocialEntityV1[] = [];
  if (!isObjectRow(rows[0])) {
    warnings.push('dropped malformed root row');
  } else {
    const root = normalizeTwitterCliTweet(request, rows[0] as TwitterCliTweetRow, backend, warnings);
    if (root !== undefined) entities.push(root);
  }
  entities.push(...twitterCliRepliesToComments(request, rows, backend, warnings, request.postId, undefined));
  return pageFromEntities(request, entities, warnings);
}

function twitterCliComments(
  request: SocialRequest,
  payload: unknown,
  backend: string,
  warnings: string[],
): SocialPageV1 {
  const rows = expectList(payload, backend);
  const entities = twitterCliRepliesToComments(request, rows, backend, warnings, request.postId, undefined);
  return pageFromEntities(request, entities, warnings);
}

function twitterCliCommentReplies(
  request: SocialRequest,
  payload: unknown,
  backend: string,
  warnings: string[],
): SocialPageV1 {
  const rows = expectList(payload, backend);
  const entities = twitterCliRepliesToComments(request, rows, backend, warnings, request.commentId, request.commentId);
  return pageFromEntities(request, entities, warnings);
}

function twitterCliProfile(
  request: SocialRequest,
  payload: unknown,
  backend: string,
  warnings: string[],
): SocialPageV1 {
  const row = Array.isArray(payload) ? payload[0] : payload;
  if (row === undefined || row === null || typeof row !== 'object') {
    notFound(backend, 'profile not found');
  }
  const profile = normalizeTwitterCliProfile(row as TwitterCliUserRow, backend, warnings);
  if (profile === undefined) {
    throw new SocialError('malformed_upstream', 'profile payload is malformed', {
      platform: 'twitter', backend,
    });
  }
  return pageFromEntities(request, [profile], warnings);
}

function twitterCliProfileList(
  request: SocialRequest,
  payload: unknown,
  backend: string,
  warnings: string[],
): SocialPageV1 {
  const rows = expectList(payload, backend);
  const entities: SocialEntityV1[] = [];
  for (const row of rows) {
    if (!isObjectRow(row)) {
      warnings.push('dropped malformed row');
      continue;
    }
    const profile = normalizeTwitterCliProfile(row as TwitterCliUserRow, backend, warnings);
    if (profile !== undefined) entities.push(profile);
  }
  return pageFromEntities(request, entities, warnings);
}

function twitterCliTweetList(
  request: SocialRequest,
  payload: unknown,
  backend: string,
  warnings: string[],
): SocialPageV1 {
  const rows = expectList(payload, backend);
  const entities: SocialEntityV1[] = [];
  for (const row of rows) {
    if (!isObjectRow(row)) {
      warnings.push('dropped malformed row');
      continue;
    }
    const entity = normalizeTwitterCliTweet(request, row as TwitterCliTweetRow, backend, warnings);
    if (entity !== undefined) entities.push(entity);
  }
  return pageFromEntities(request, entities, warnings);
}

function normalizeTwitterCliPayload(
  request: SocialRequest,
  payload: unknown,
  backend: string,
  warnings: string[],
): SocialPageV1 {
  switch (request.action) {
    case 'get_post':
      return twitterCliPostDetail(request, payload, backend, warnings);
    case 'get_thread':
      return twitterCliThread(request, payload, backend, warnings);
    case 'get_comments':
      return twitterCliComments(request, payload, backend, warnings);
    case 'get_comment_replies':
      return twitterCliCommentReplies(request, payload, backend, warnings);
    case 'get_profile':
      return twitterCliProfile(request, payload, backend, warnings);
    case 'get_followers':
    case 'get_following':
      return twitterCliProfileList(request, payload, backend, warnings);
    case 'search':
    case 'get_user_posts':
    case 'get_feed':
    case 'get_saved':
      return twitterCliTweetList(request, payload, backend, warnings);
    default:
      throw new SocialError('backend_unavailable', `twitter-cli cannot serve ${request.action}`, {
        platform: 'twitter', backend, retryable: false,
      });
  }
}

// ── OpenCLI per-action helpers ──

function openCliTrends(
  request: SocialRequest,
  payload: unknown,
  backend: string,
  warnings: string[],
): SocialPageV1 {
  const rows = expectList(payload, backend);
  const entities: SocialTopicV1[] = [];
  for (const row of rows) {
    if (!isObjectRow(row)) {
      warnings.push('dropped malformed trend row');
      continue;
    }
    const trend = row as OpenCliTrendRow;
    const topic = optionalString(trend.topic);
    if (topic === undefined) {
      warnings.push('dropped trend row without topic');
      continue;
    }
    const nativeId = `trend-${optionalString(trend.rank) ?? topic}`;
    const entity: SocialTopicV1 = {
      version: 1,
      kind: 'social_topic',
      id: socialEntityId('twitter', 'social_topic', nativeId),
      platform: 'twitter',
      backend,
      name: topic,
    };
    const category = optionalString(trend.category);
    if (category !== undefined) entity.description = category;
    entities.push(entity);
  }
  if (rows.length > 0) {
    warnings.push('trend ids are rank-derived, not native trend ids');
  }
  return pageFromEntities(request, entities, warnings);
}

function openCliNotifications(
  request: SocialRequest,
  payload: unknown,
  backend: string,
  warnings: string[],
): SocialPageV1 {
  const rows = expectList(payload, backend);
  const entities: SocialNotificationV1[] = [];
  for (const row of rows) {
    if (!isObjectRow(row)) {
      warnings.push('dropped malformed notification row');
      continue;
    }
    const notification = row as OpenCliNotificationRow;
    const id = optionalString(notification.id);
    if (id === undefined) {
      warnings.push('dropped notification row without id');
      continue;
    }
    const url = optionalString(notification.url);
    const entity: SocialNotificationV1 = {
      version: 1,
      kind: 'social_notification',
      id: socialEntityId('twitter', 'social_notification', id),
      platformId: id,
      platform: 'twitter',
      backend,
    };
    if (url !== undefined && isValidHttpUrl(url)) entity.url = url;
    const type = optionalString(notification.action);
    if (type !== undefined) entity.type = type;
    const text = optionalString(notification.text);
    if (text !== undefined) entity.text = text;
    const handle = optionalString(notification.author);
    if (handle !== undefined) entity.actor = { handle };
    entities.push(entity);
  }
  return pageFromEntities(request, entities, warnings);
}

function openCliProfile(
  request: SocialRequest,
  payload: unknown,
  backend: string,
  warnings: string[],
): SocialPageV1 {
  const rows = expectList(payload, backend);
  const profile = rows.length > 0 && typeof rows[0] === 'object' && rows[0] !== null
    ? normalizeOpenCliProfile(rows[0] as OpenCliProfileRow, backend, warnings)
    : undefined;
  if (profile === undefined) {
    notFound(backend, 'profile not found');
  }
  return pageFromEntities(request, [profile], warnings);
}

function openCliProfileList(
  request: SocialRequest,
  payload: unknown,
  backend: string,
  warnings: string[],
): SocialPageV1 {
  const rows = expectList(payload, backend);
  const entities: SocialEntityV1[] = [];
  for (const row of rows) {
    if (!isObjectRow(row)) {
      warnings.push('dropped malformed user row');
      continue;
    }
    const profile = normalizeOpenCliProfile(row as OpenCliProfileRow, backend, warnings);
    if (profile !== undefined) entities.push(profile);
  }
  return pageFromEntities(request, entities, warnings);
}

function openCliPostDetail(
  request: SocialRequest,
  payload: unknown,
  backend: string,
  warnings: string[],
): SocialPageV1 {
  const rows = expectList(payload, backend);
  if (rows.length === 0) notFound(backend, 'tweet not found');
  if (!isObjectRow(rows[0])) {
    throw new SocialError('malformed_upstream', 'tweet payload is malformed', {
      platform: 'twitter', backend,
    });
  }
  const entity = normalizeOpenCliTweet(request, rows[0] as OpenCliTweetRow, backend, warnings);
  if (entity === undefined) {
    throw new SocialError('malformed_upstream', 'tweet payload is malformed', {
      platform: 'twitter', backend,
    });
  }
  return pageFromEntities(request, [entity], warnings);
}

function openCliThread(
  request: SocialRequest,
  payload: unknown,
  backend: string,
  warnings: string[],
): SocialPageV1 {
  const rows = expectList(payload, backend);
  if (rows.length === 0) notFound(backend, 'thread not found');
  const entities: SocialEntityV1[] = [];
  if (!isObjectRow(rows[0])) {
    warnings.push('dropped malformed root row');
  } else {
    const root = normalizeOpenCliTweet(request, rows[0] as OpenCliTweetRow, backend, warnings);
    if (root !== undefined) entities.push(root);
  }
  entities.push(...openCliRepliesToComments(request, rows, backend, warnings, request.postId, undefined));
  return pageFromEntities(request, entities, warnings);
}

function openCliComments(
  request: SocialRequest,
  payload: unknown,
  backend: string,
  warnings: string[],
): SocialPageV1 {
  const rows = expectList(payload, backend);
  const entities = openCliRepliesToComments(request, rows, backend, warnings, request.postId, request.commentId);
  return pageFromEntities(request, entities, warnings);
}

function openCliTweetList(
  request: SocialRequest,
  payload: unknown,
  backend: string,
  warnings: string[],
): SocialPageV1 {
  const rows = expectList(payload, backend);
  const entities: SocialEntityV1[] = [];
  for (const row of rows) {
    if (!isObjectRow(row)) {
      warnings.push('dropped malformed tweet row');
      continue;
    }
    const entity = normalizeOpenCliTweet(request, row as OpenCliTweetRow, backend, warnings);
    if (entity !== undefined) entities.push(entity);
  }
  return pageFromEntities(request, entities, warnings);
}

function normalizeOpenCliPayload(
  request: SocialRequest,
  payload: unknown,
  backend: string,
  warnings: string[],
): SocialPageV1 {
  switch (request.action) {
    case 'get_trending':
      return openCliTrends(request, payload, backend, warnings);
    case 'get_notifications':
      return openCliNotifications(request, payload, backend, warnings);
    case 'get_profile':
      return openCliProfile(request, payload, backend, warnings);
    case 'get_followers':
    case 'get_following':
      return openCliProfileList(request, payload, backend, warnings);
    case 'get_post':
      return openCliPostDetail(request, payload, backend, warnings);
    case 'get_thread':
      return openCliThread(request, payload, backend, warnings);
    case 'get_comments':
    case 'get_comment_replies':
      return openCliComments(request, payload, backend, warnings);
    case 'search':
    case 'get_user_posts':
    case 'get_feed':
    case 'get_saved':
      return openCliTweetList(request, payload, backend, warnings);
    default:
      throw new SocialError('backend_unavailable', `OpenCLI twitter cannot serve ${request.action}`, {
        platform: 'twitter', backend, retryable: false,
      });
  }
}

// ── Payload dispatch ──

export function normalizeTwitterPayload(
  request: SocialRequest,
  backend: TwitterNormalizeBackend,
  payload: unknown,
): SocialPageV1 {
  const warnings: string[] = [];
  if (backend === 'twitter-cli') {
    return normalizeTwitterCliPayload(request, payload, backend, warnings);
  }
  return normalizeOpenCliPayload(request, payload, backend, warnings);
}
