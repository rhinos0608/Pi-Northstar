// Per-platform Xiaohongshu fixture normalization (extracted from social-xiaohongshu.ts).
//
// Owns record/string/count parsing, entity builders, URL canonicalization +
// xsec-token stripping, and the backend-specific handlers (normalizeXhsCli,
// normalizeOpencli) with per-action helpers. The worker
// (src/social-xiaohongshu.ts) keeps capabilities, argv, subprocess, env, and
// backend selection; it delegates normalize() here.
//
// Page policy (preserved): unlike Twitter's validating pageFromEntities, both
// Xiaohongshu handlers apply a partial/limit/drop-invalid policy via
// finishPage — entities are sliced to request.limit (with a truncation
// warning), each entity is re-validated with validateSocialEntity and invalid
// ones are dropped with warnings, and partial is set when any row was dropped
// or an entity failed validation.

import { createHash } from 'node:crypto';

import {
  SocialError,
  parseSocialDate,
  socialEntityId,
  validateSocialEntity,
  type SocialActorV1,
  type SocialEntityV1,
  type SocialMetricsV1,
  type SocialPageV1,
  type SocialRequest,
} from './social-contract.js';

export type XiaohongshuNormalizeBackend = 'xhs-cli' | 'opencli-xiaohongshu';

// ── xsec_token stripping ──

/** Remove xsec_token from URL query strings and from raw text occurrences. */
export function stripXsecToken(value: string): string {
  const stripped = value.replace(/([?&])xsec_token=[^&#]*&?/gi, '$1');
  return stripped.replace(/xsec_token[=:]\s*\S+/gi, 'xsec_token=***');
}

export function stripXsecTokenUrl(value: string): string {
  try {
    const parsed = new URL(value);
    if (parsed.searchParams.has('xsec_token')) {
      parsed.searchParams.delete('xsec_token');
      return parsed.toString();
    }
  } catch {
    // Not a URL: fall through to text-level stripping.
  }
  return stripXsecToken(value);
}

// ── Shared normalization helpers ──

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function pickString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === 'string' && value.trim().length > 0) return value.trim();
  }
  return undefined;
}

// Text-level xsec_token stripping for every emitted human-readable string
// field (module contract: tokens may hide in title/desc/text, not just URLs).
// URL fields must NOT use this: they go through stripXsecTokenUrl (URL-param
// deletion), which text-mode redaction would corrupt into a trailing '?'.
function pickText(...values: unknown[]): string | undefined {
  const picked = pickString(...values);
  return picked === undefined ? undefined : stripXsecToken(picked);
}

/** Parse XHS-style counts: numbers, numeric strings, and 万/亿 suffixes.
 *  Non-numeric values (e.g. "赞") are omitted, never zeroed. */
export function parseXhsCount(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value !== 'string') return undefined;
  const text = value.trim();
  if (text.length === 0) return undefined;
  const multiplier = text.endsWith('万') ? 10_000 : text.endsWith('亿') ? 100_000_000 : 1;
  const numeric = Number.parseFloat(text.replace(/[,万亿]/g, ''));
  if (!Number.isFinite(numeric) || numeric < 0) return undefined;
  return numeric * multiplier;
}

function hashId(parts: readonly string[]): string {
  return createHash('sha256').update(parts.join('|'), 'utf8').digest('hex').slice(0, 16);
}

function actorFrom(user: unknown): SocialActorV1 | undefined {
  const userRecord = record(user);
  if (userRecord === undefined) return undefined;
  const id = pickString(userRecord.userId, userRecord.user_id, userRecord.id);
  const nickname = pickText(userRecord.nickname, userRecord.nick_name, userRecord.displayName);
  const profileUrlRaw = pickString(userRecord.profileUrl, userRecord.profile_url);
  if (id === undefined && nickname === undefined && profileUrlRaw === undefined) return undefined;
  const actor: SocialActorV1 = {};
  if (id !== undefined) actor.id = id;
  if (nickname !== undefined) actor.displayName = nickname;
  if (profileUrlRaw !== undefined) actor.profileUrl = stripXsecTokenUrl(profileUrlRaw);
  return actor;
}

function actorFromName(name: unknown): SocialActorV1 | undefined {
  const displayName = pickText(name);
  return displayName !== undefined ? { displayName } : undefined;
}

function metricsFromInteract(interact: unknown): SocialMetricsV1 | undefined {
  const interactRecord = record(interact);
  if (interactRecord === undefined) return undefined;
  const metrics: SocialMetricsV1 = {};
  const assign = (key: keyof SocialMetricsV1, ...candidates: unknown[]) => {
    for (const candidate of candidates) {
      const parsed = parseXhsCount(candidate);
      if (parsed !== undefined) {
        metrics[key] = parsed;
        return;
      }
    }
  };
  assign('likes', interactRecord.liked_count, interactRecord.likedCount);
  assign('saves', interactRecord.collected_count, interactRecord.collectedCount);
  assign('comments', interactRecord.comment_count, interactRecord.commentCount);
  assign('shares', interactRecord.share_count, interactRecord.shareCount);
  return Object.keys(metrics).length > 0 ? metrics : undefined;
}

function canonicalNoteUrl(noteId: string): string {
  return `https://www.xiaohongshu.com/explore/${noteId}`;
}

function requireRows(payload: unknown, containerKeys: readonly string[], backend: string): unknown[] {
  if (Array.isArray(payload)) return payload;
  const root = record(payload);
  if (root !== undefined) {
    for (const key of containerKeys) {
      if (Array.isArray(root[key])) return root[key];
    }
  }
  throw new SocialError('malformed_upstream', `${backend}: payload has no row list`, { platform: 'xiaohongshu', backend });
}

// ── xhs-cli normalization (shapes verified from xhs-cli 0.1.4 cli.py) ──

interface NoteLikeRowResult {
  entity: SocialEntityV1;
  warning?: string;
}

interface NormalizeState {
  backend: string;
  warnings: string[];
  partial: boolean;
  entities: SocialEntityV1[];
}

function drop(state: NormalizeState, warning: string): void {
  state.partial = true;
  state.warnings.push(warning);
}

/** Build a note-like entity from an XHS note_card/item row. Returns the error
 *  reason when the row lacks an id (malformed). */
function noteLikeEntity(
  row: Record<string, unknown>,
  wantKind: 'social_post' | 'social_reference',
  backend: string,
): NoteLikeRowResult | { error: string } {
  const card = record(row.note_card) ?? record(row.noteCard) ?? row;
  const nativeId = pickString(row.id, row.note_id, row.noteId, card.note_id, card.id);
  if (nativeId === undefined) {
    return { error: 'row has no note id' };
  }
  const title = pickText(card.display_title, card.displayTitle, card.title);
  const desc = pickText(card.desc, card.text);
  const author = actorFrom(card.user);
  const metrics = metricsFromInteract(record(card.interact_info) ?? record(card.interactInfo));
  const publishedAt = parseSocialDate(card.time);
  const base = {
    version: 1 as const,
    platform: 'xiaohongshu' as const,
    backend,
    platformId: nativeId,
    url: stripXsecTokenUrl(canonicalNoteUrl(nativeId)),
  };
  if (wantKind === 'social_reference') {
    const entity: SocialEntityV1 = {
      ...base,
      kind: 'social_reference',
      id: socialEntityId('xiaohongshu', 'social_reference', nativeId),
      ...(publishedAt !== undefined ? { publishedAt } : {}),
      ...(title !== undefined ? { title } : {}),
      ...(author !== undefined ? { author } : {}),
      ...(metrics !== undefined ? { metrics } : {}),
    };
    return { entity };
  }
  const entity: SocialEntityV1 = {
    ...base,
    kind: 'social_post',
    id: socialEntityId('xiaohongshu', 'social_post', nativeId),
    ...(publishedAt !== undefined ? { publishedAt } : {}),
    contentType: 'note',
    ...(title !== undefined ? { title } : {}),
    ...(desc !== undefined ? { text: desc } : {}),
    ...(author !== undefined ? { author } : {}),
    ...(metrics !== undefined ? { metrics } : {}),
  };
  return { entity };
}

function xhsCommentEntity(
  comment: Record<string, unknown>,
  postEntityId: string,
  backend: string,
): NoteLikeRowResult | { error: string } {
  const commentId = pickString(comment.id, comment.comment_id);
  const text = pickText(comment.content);
  if (commentId === undefined) return { error: 'comment row without id' };
  if (text === undefined) return { error: 'comment row without content' };
  const created = parseSocialDate(comment.create_time);
  const parent = pickString(comment.parent_comment_id);
  const author = actorFrom(record(comment.user_info) ?? record(comment.userInfo));
  const metrics = metricsFromInteract({ liked_count: comment.like_count ?? comment.likeCount });
  const entity: SocialEntityV1 = {
    version: 1,
    kind: 'social_comment',
    id: socialEntityId('xiaohongshu', 'social_comment', commentId),
    platform: 'xiaohongshu',
    backend,
    ...(created !== undefined ? { publishedAt: created } : {}),
    postId: postEntityId,
    ...(parent !== undefined ? { parentCommentId: socialEntityId('xiaohongshu', 'social_comment', parent) } : {}),
    text,
    ...(author !== undefined ? { author } : {}),
    ...(metrics !== undefined ? { metrics } : {}),
  };
  return { entity };
}

function xhsProfileEntity(payload: unknown, backend: string): NoteLikeRowResult | { error: string } {
  const root = record(payload);
  if (root === undefined) return { error: 'payload is not an object' };
  const userPage = record(root.userPageData) ?? record(root.user_page_data);
  const basic = record(userPage?.basicInfo) ?? record(userPage?.basic_info)
    ?? record(root.basicInfo) ?? record(root.basic_info) ?? root;
  const userRecord = record(root.userInfo) ?? record(root.user_info);
  const userId = pickString(basic.userId, basic.user_id, basic.id, userRecord?.userId, userRecord?.user_id);
  if (userId === undefined) return { error: 'profile payload has no user id' };
  const nickname = pickText(basic.nickname, basic.nick_name);
  const handle = pickText(basic.redId, basic.red_id);
  const bio = pickText(basic.desc, basic.description);
  const metrics: SocialMetricsV1 = {};
  const interactions = Array.isArray(userPage?.interactions) ? userPage?.interactions : Array.isArray(root.interactions) ? root.interactions : [];
  for (const raw of interactions) {
    const item = record(raw);
    if (item === undefined) continue;
    const name = pickString(item.name, item.type);
    const count = parseXhsCount(item.count ?? item.value);
    if (name === undefined || count === undefined) continue;
    if (name === 'fans' || name === '粉丝') metrics.followers = count;
    else if (name === 'follows' || name === '关注') metrics.following = count;
  }
  const entity: SocialEntityV1 = {
    version: 1,
    kind: 'social_account',
    id: socialEntityId('xiaohongshu', 'social_account', userId),
    platform: 'xiaohongshu',
    backend,
    platformId: userId,
    ...(handle !== undefined ? { handle } : {}),
    ...(nickname !== undefined ? { displayName: nickname } : {}),
    ...(bio !== undefined ? { bio } : {}),
    ...(Object.keys(metrics).length > 0 ? { metrics } : {}),
  };
  return { entity };
}

function xhsProfileFromUserRecord(user: Record<string, unknown>, backend: string): NoteLikeRowResult | { error: string } {
  const userId = pickString(user.userId, user.user_id, user.id);
  if (userId === undefined) return { error: 'user row without id' };
  const nickname = pickText(user.nickname, user.nick_name);
  const handle = pickText(user.redId, user.red_id);
  const entity: SocialEntityV1 = {
    version: 1,
    kind: 'social_account',
    id: socialEntityId('xiaohongshu', 'social_account', userId),
    platform: 'xiaohongshu',
    backend,
    platformId: userId,
    ...(handle !== undefined ? { handle } : {}),
    ...(nickname !== undefined ? { displayName: nickname } : {}),
  };
  return { entity };
}

// ── xhs-cli per-action helpers ──

function xhsNoteDetail(request: SocialRequest, payload: unknown, state: NormalizeState): void {
  const root = record(payload);
  if (root === undefined) {
    throw new SocialError('malformed_upstream', 'xhs-cli read payload is not an object', { platform: 'xiaohongshu', backend: state.backend });
  }
  const note = record(root.note);
  if (note !== undefined) {
    const nativeId = pickString(note.note_id, note.id, request.postId);
    if (nativeId !== undefined) {
      const interact = record(note.interact_info) ?? record(note.interactInfo);
      const publishedAt = parseSocialDate(note.time);
      const title = pickText(note.title);
      const desc = pickText(note.desc);
      const author = actorFrom(note.user);
      const metrics = metricsFromInteract(interact);
      const postEntityId = socialEntityId('xiaohongshu', 'social_post', nativeId);
      state.entities.push({
        version: 1,
        kind: 'social_post',
        id: postEntityId,
        platform: 'xiaohongshu',
        backend: state.backend,
        platformId: nativeId,
        url: stripXsecTokenUrl(canonicalNoteUrl(nativeId)),
        ...(publishedAt !== undefined ? { publishedAt } : {}),
        contentType: 'note',
        ...(title !== undefined ? { title } : {}),
        ...(desc !== undefined ? { text: desc } : {}),
        ...(author !== undefined ? { author } : {}),
        ...(metrics !== undefined ? { metrics } : {}),
      });
      const comments = Array.isArray(root.comments) ? root.comments : record(root.comments)?.comments;
      if (Array.isArray(comments)) {
        for (const raw of comments) {
          const comment = record(raw);
          if (comment === undefined) {
            drop(state, 'dropped malformed comment row');
            continue;
          }
          const built = xhsCommentEntity(comment, postEntityId, state.backend);
          if ('error' in built) {
            drop(state, `dropped ${built.error}`);
            continue;
          }
          state.entities.push(built.entity);
        }
      }
    }
  }
  const hasPost = state.entities.some((entity) => entity.kind === 'social_post');
  if (request.action === 'get_post' && !hasPost) {
    throw new SocialError('not_found', `xiaohongshu post not found`, { platform: 'xiaohongshu', backend: state.backend });
  }
}

function xhsProfile(request: SocialRequest, payload: unknown, state: NormalizeState): void {
  void request;
  const profile = xhsProfileEntity(payload, state.backend);
  if ('error' in profile) {
    throw new SocialError('not_found', `xiaohongshu profile not found`, { platform: 'xiaohongshu', backend: state.backend });
  }
  state.entities.push(profile.entity);
}

function xhsSearch(payload: unknown, state: NormalizeState): void {
  for (const raw of requireRows(payload, ['items', 'notes'], state.backend)) {
    const row = record(raw);
    if (row === undefined) {
      drop(state, 'dropped malformed search row');
      continue;
    }
    const built = noteLikeEntity(row, 'social_reference', state.backend);
    if ('error' in built) {
      drop(state, `dropped search row: ${built.error}`);
      continue;
    }
    state.entities.push(built.entity);
  }
}

function xhsNoteList(payload: unknown, state: NormalizeState): void {
  for (const raw of requireRows(payload, ['items', 'notes'], state.backend)) {
    const row = record(raw);
    if (row === undefined) {
      drop(state, 'dropped malformed row');
      continue;
    }
    const built = noteLikeEntity(row, 'social_post', state.backend);
    if ('error' in built) {
      drop(state, `dropped row: ${built.error}`);
      continue;
    }
    state.entities.push(built.entity);
  }
}

function xhsUserList(payload: unknown, state: NormalizeState): void {
  for (const raw of requireRows(payload, [], state.backend)) {
    const row = record(raw);
    if (row === undefined) {
      drop(state, 'dropped malformed user row');
      continue;
    }
    const built = xhsProfileFromUserRecord(row, state.backend);
    if ('error' in built) {
      drop(state, `dropped ${built.error}`);
      continue;
    }
    state.entities.push(built.entity);
  }
}

function normalizeXhsCliPayload(request: SocialRequest, payload: unknown, backend: string): SocialPageV1 {
  const state: NormalizeState = { backend, warnings: [], partial: false, entities: [] };
  switch (request.action) {
    case 'get_post':
    case 'get_comments':
      xhsNoteDetail(request, payload, state);
      break;
    case 'get_profile':
      xhsProfile(request, payload, state);
      break;
    case 'search':
      xhsSearch(payload, state);
      break;
    case 'get_user_posts':
    case 'get_feed':
    case 'get_saved':
      xhsNoteList(payload, state);
      break;
    case 'get_followers':
    case 'get_following':
      xhsUserList(payload, state);
      break;
    default:
      throw new SocialError('invalid_request', `xhs-cli backend does not implement this action`, { platform: 'xiaohongshu', backend });
  }
  return finishPage(state, request);
}

// ── opencli normalization (row shapes from verified 1.8.6 column lists) ──

function noteIdFromUrl(url: string): string | undefined {
  try {
    const parsed = new URL(url);
    const segments = parsed.pathname.split('/').filter((segment) => segment.length > 0);
    for (let index = 0; index < segments.length; index++) {
      if ((segments[index] === 'explore' || segments[index] === 'item') && segments[index + 1] !== undefined) {
        const candidate = segments[index + 1]!;
        if (/^[0-9a-f]{24}$/i.test(candidate)) return candidate.toLowerCase();
      }
    }
    return undefined;
  } catch {
    return undefined;
  }
}

function opencliSearch(request: SocialRequest, payload: readonly unknown[], state: NormalizeState): void {
  void request;
  for (const raw of payload) {
    const row = record(raw);
    if (row === undefined) {
      drop(state, 'dropped malformed search row');
      continue;
    }
    const title = pickText(row.title);
    const urlRaw = pickString(row.url);
    const url = urlRaw !== undefined ? stripXsecTokenUrl(urlRaw) : undefined;
    const noteId = urlRaw !== undefined ? noteIdFromUrl(urlRaw) : undefined;
    const metrics: SocialMetricsV1 = {};
    const likes = parseXhsCount(row.likes);
    if (likes !== undefined) metrics.likes = likes;
    const author = actorFromName(row.author);
    const publishedAt = parseSocialDate(row.published_at);
    if (noteId !== undefined) {
      state.entities.push({
        version: 1,
        kind: 'social_reference',
        id: socialEntityId('xiaohongshu', 'social_reference', noteId),
        platform: 'xiaohongshu',
        backend: state.backend,
        platformId: noteId,
        ...(url !== undefined ? { url } : {}),
        ...(publishedAt !== undefined ? { publishedAt } : {}),
        ...(title !== undefined ? { title } : {}),
        ...(author !== undefined ? { author } : {}),
        ...(Object.keys(metrics).length > 0 ? { metrics } : {}),
      });
    } else {
      // No note id available: hash-derived id, flagged by warning.
      state.entities.push({
        version: 1,
        kind: 'social_reference',
        id: socialEntityId('xiaohongshu', 'social_reference', hashId([pickString(row.author) ?? '', title ?? ''])),
        platform: 'xiaohongshu',
        backend: state.backend,
        ...(url !== undefined ? { url } : {}),
        ...(title !== undefined ? { title } : {}),
        ...(author !== undefined ? { author } : {}),
        ...(Object.keys(metrics).length > 0 ? { metrics } : {}),
      });
      state.warnings.push('search row id derived from content hash');
    }
  }
}

function opencliPostDetail(request: SocialRequest, payload: readonly unknown[], state: NormalizeState): void {
  const fields = new Map<string, unknown>();
  for (const raw of payload) {
    const row = record(raw);
    const field = row === undefined ? undefined : pickString(row.field);
    if (row === undefined || field === undefined) {
      drop(state, 'dropped malformed note field row');
      continue;
    }
    fields.set(field, row.value);
  }
  const noteId = pickString(fields.get('note_id'), fields.get('id'), fields.get('noteId'), request.postId);
  if (noteId === undefined) {
    throw new SocialError('not_found', `xiaohongshu post not found`, { platform: 'xiaohongshu', backend: state.backend });
  }
  const metrics: SocialMetricsV1 = {};
  const likes = parseXhsCount(fields.get('liked_count') ?? fields.get('liked') ?? fields.get('likes'));
  if (likes !== undefined) metrics.likes = likes;
  const saves = parseXhsCount(fields.get('collected_count') ?? fields.get('collected'));
  if (saves !== undefined) metrics.saves = saves;
  const comments = parseXhsCount(fields.get('comment_count') ?? fields.get('comments'));
  if (comments !== undefined) metrics.comments = comments;
  const shares = parseXhsCount(fields.get('share_count') ?? fields.get('shares'));
  if (shares !== undefined) metrics.shares = shares;
  const title = pickText(fields.get('title'));
  const text = pickText(fields.get('desc'), fields.get('content'));
  const author = actorFrom({ id: fields.get('user_id'), nickname: fields.get('nickname') ?? fields.get('author') });
  const publishedAt = parseSocialDate(fields.get('time') ?? fields.get('published_at'));
  state.entities.push({
    version: 1,
    kind: 'social_post',
    id: socialEntityId('xiaohongshu', 'social_post', noteId),
    platform: 'xiaohongshu',
    backend: state.backend,
    platformId: noteId,
    url: canonicalNoteUrl(noteId),
    ...(publishedAt !== undefined ? { publishedAt } : {}),
    contentType: 'note',
    ...(title !== undefined ? { title } : {}),
    ...(text !== undefined ? { text } : {}),
    ...(author !== undefined ? { author } : {}),
    ...(Object.keys(metrics).length > 0 ? { metrics } : {}),
  });
}

function opencliComments(request: SocialRequest, payload: readonly unknown[], state: NormalizeState): void {
  if (request.postId === undefined) {
    throw new SocialError('invalid_request', 'opencli-xiaohongshu get_comments requires postId', { platform: 'xiaohongshu', backend: state.backend });
  }
  const postEntityId = socialEntityId('xiaohongshu', 'social_post', request.postId);
  for (const raw of payload) {
    const row = record(raw);
    if (row === undefined) {
      drop(state, 'dropped malformed comment row');
      continue;
    }
    const text = pickText(row.text);
    if (text === undefined) {
      drop(state, 'dropped comment row without text');
      continue;
    }
    const userId = pickString(row.userId, row.user_id);
    const rank = typeof row.rank === 'number' && Number.isFinite(row.rank) ? row.rank : undefined;
    const nativeId = pickString(row.id, row.commentId, row.comment_id)
      ?? (userId !== undefined && rank !== undefined ? `${userId}:${rank}` : undefined);
    if (nativeId === undefined) {
      drop(state, 'dropped comment row without id');
      continue;
    }
    const parent = pickString(row.reply_to, row.replyTo);
    const created = parseSocialDate(row.time);
    const profileUrl = typeof row.profileUrl === 'string' && row.profileUrl.length > 0
      ? stripXsecTokenUrl(row.profileUrl)
      : undefined;
    const author: SocialActorV1 | undefined = userId === undefined && pickText(row.author) === undefined && profileUrl === undefined
      ? undefined
      : {
        ...(userId !== undefined ? { id: userId } : {}),
        ...(pickText(row.author) !== undefined ? { displayName: pickText(row.author)! } : {}),
        ...(profileUrl !== undefined ? { profileUrl } : {}),
      };
    const metrics: SocialMetricsV1 = {};
    const likes = parseXhsCount(row.likes);
    if (likes !== undefined) metrics.likes = likes;
    const entity: SocialEntityV1 = {
      version: 1,
      kind: 'social_comment',
      id: socialEntityId('xiaohongshu', 'social_comment', nativeId),
      platform: 'xiaohongshu',
      backend: state.backend,
      ...(created !== undefined ? { publishedAt: created } : {}),
      postId: postEntityId,
      text,
      ...(parent !== undefined ? { parentCommentId: socialEntityId('xiaohongshu', 'social_comment', parent) } : {}),
      ...(author !== undefined ? { author } : {}),
      ...(Object.keys(metrics).length > 0 ? { metrics } : {}),
    };
    state.entities.push(entity);
  }
}

function opencliNoteList(payload: readonly unknown[], state: NormalizeState): void {
  for (const raw of payload) {
    const row = record(raw);
    if (row === undefined) {
      drop(state, 'dropped malformed row');
      continue;
    }
    const nativeId = pickString(row.id, row.note_id);
    const title = pickText(row.title);
    if (nativeId === undefined && title === undefined) {
      drop(state, 'dropped row without id or title');
      continue;
    }
    // Rows without a native note id get a hash-derived id plus warning.
    const idSource = nativeId ?? hashId([title ?? '']);
    const metrics: SocialMetricsV1 = {};
    const likes = parseXhsCount(row.likes);
    if (likes !== undefined) metrics.likes = likes;
    const author = row.author !== undefined ? actorFromName(row.author) : actorFrom(row.user);
    const urlRaw = pickString(row.url);
    const url = urlRaw !== undefined ? stripXsecTokenUrl(urlRaw) : undefined;
    state.entities.push({
      version: 1,
      kind: 'social_post',
      id: socialEntityId('xiaohongshu', 'social_post', idSource),
      platform: 'xiaohongshu',
      backend: state.backend,
      ...(nativeId !== undefined ? { platformId: nativeId } : {}),
      ...(url !== undefined ? { url } : {}),
      contentType: 'note',
      ...(title !== undefined ? { title } : {}),
      ...(author !== undefined ? { author } : {}),
      ...(Object.keys(metrics).length > 0 ? { metrics } : {}),
    });
    if (nativeId === undefined) state.warnings.push('row id derived from content hash');
  }
}

function opencliNotifications(payload: readonly unknown[], state: NormalizeState): void {
  for (const raw of payload) {
    const row = record(raw);
    if (row === undefined) {
      drop(state, 'dropped malformed notification row');
      continue;
    }
    const text = pickText(row.content);
    const action = pickText(row.action);
    if (text === undefined && action === undefined) {
      drop(state, 'dropped notification row without content');
      continue;
    }
    const actor = row.user !== undefined ? actorFromName(row.user) : undefined;
    const publishedAt = parseSocialDate(row.time);
    state.entities.push({
      version: 1,
      kind: 'social_notification',
      id: socialEntityId('xiaohongshu', 'social_notification', hashId([String(row.rank ?? ''), action ?? '', text ?? ''])),
      platform: 'xiaohongshu',
      backend: state.backend,
      ...(publishedAt !== undefined ? { publishedAt } : {}),
      ...(action !== undefined ? { type: action } : {}),
      ...(text !== undefined ? { text } : {}),
      ...(actor !== undefined ? { actor } : {}),
    });
    state.warnings.push('notification id derived from content hash');
  }
}

function normalizeOpencliPayload(request: SocialRequest, payload: unknown, backend: string): SocialPageV1 {
  if (!Array.isArray(payload)) {
    throw new SocialError('malformed_upstream', 'opencli-xiaohongshu: payload is not a JSON row array', { platform: 'xiaohongshu', backend });
  }
  const state: NormalizeState = { backend, warnings: [], partial: false, entities: [] };
  switch (request.action) {
    case 'search':
      opencliSearch(request, payload, state);
      break;
    case 'get_post':
      opencliPostDetail(request, payload, state);
      break;
    case 'get_comments':
      opencliComments(request, payload, state);
      break;
    case 'get_user_posts':
    case 'get_feed':
    case 'get_saved':
      opencliNoteList(payload, state);
      break;
    case 'get_notifications':
      opencliNotifications(payload, state);
      break;
    default:
      throw new SocialError('invalid_request', `opencli-xiaohongshu backend does not implement this action`, { platform: 'xiaohongshu', backend });
  }
  return finishPage(state, request);
}

function finishPage(state: NormalizeState, request: SocialRequest): SocialPageV1 {
  const limited = state.entities.slice(0, request.limit);
  const finalWarnings = [...state.warnings];
  const truncated = limited.length < state.entities.length;
  if (truncated) finalWarnings.push(`truncated ${state.entities.length - limited.length} rows to limit`);

  const valid: SocialEntityV1[] = [];
  for (const entity of limited) {
    const check = validateSocialEntity(entity);
    if (check.ok) {
      valid.push(entity);
    } else {
      finalWarnings.push(`dropped invalid entity: ${check.issues.join('; ')}`);
    }
  }
  return {
    entities: valid,
    pagination: {
      supported: false,
      limit: request.limit,
      returned: valid.length,
      hasMore: truncated,
    },
    partial: state.partial || valid.length < limited.length || truncated,
    warnings: finalWarnings,
  };
}

// ── Payload dispatch ──

export function normalizeXiaohongshuPayload(
  request: SocialRequest,
  backend: XiaohongshuNormalizeBackend,
  payload: unknown,
): SocialPageV1 {
  if (backend === 'opencli-xiaohongshu') return normalizeOpencliPayload(request, payload, backend);
  return normalizeXhsCliPayload(request, payload, backend);
}
