// Stage 8 social write boundary contract: vocabulary + validation ONLY.
//
// Boundary machinery with no write adapter, no dispatch, no POST to any
// content endpoint. Deny-by-default: the default capability matrix allows
// nothing on every platform.
//
// FORBIDDEN (never representable in any allowlist):
//   - 'delete_post' and every other destructive action (delete_comment,
//     remove, destroy, purge, delete_account, ...). The SocialWriteAction
//     vocabulary below is closed; unknown spellings throw unsupported_action
//     before any dispatch. Destructive actions must never be added here.

import { SOCIAL_PLATFORMS, SocialError, type SocialPlatform } from './social-contract.js';

// ── Write vocabulary (closed) ──

export const SOCIAL_WRITE_ACTIONS = ['create_post', 'add_comment', 'like', 'follow'] as const;

export type SocialWriteAction = (typeof SOCIAL_WRITE_ACTIONS)[number];

export function isSocialWriteAction(value: unknown): value is SocialWriteAction {
  return typeof value === 'string' && (SOCIAL_WRITE_ACTIONS as readonly string[]).includes(value);
}

// ── Capability matrix (provider → allowed actions) ──

export type SocialWriteCapabilityMatrix = Readonly<Record<SocialPlatform, readonly SocialWriteAction[]>>;

// DEFAULT: every platform disallowed. Empty allowlist — no write can execute.
export const DEFAULT_SOCIAL_WRITE_MATRIX: SocialWriteCapabilityMatrix = {
  twitter: [],
  reddit: [],
  xiaohongshu: [],
  facebook: [],
  instagram: [],
  v2ex: [],
  linkedin: [],
} satisfies Record<SocialPlatform, readonly SocialWriteAction[]>;

// ── Request validation (mirrors social-contract.ts style) ──

const MAX_SELECTOR_LENGTH = 1024;
const MAX_TEXT_LENGTH = 5000;
const ECHO_LIMIT = 32;

export interface SocialWritePayloadInput {
  text?: unknown;
}

export interface SocialWriteRequestInput {
  platform: string;
  action: string;
  postId?: unknown;
  commentId?: unknown;
  user?: unknown;
  community?: unknown;
  topic?: unknown;
  payload?: SocialWritePayloadInput | unknown;
}

export interface SocialWriteRequest {
  platform: SocialPlatform;
  action: SocialWriteAction;
  postId?: string;
  commentId?: string;
  user?: string;
  community?: string;
  topic?: string;
  text?: string;
}

function cappedEcho(value: string): string {
  return JSON.stringify(value.slice(0, ECHO_LIMIT));
}

function cleanSelector(field: string, value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new SocialError('invalid_request', `invalid ${field}`);
  }
  const trimmed = value.trim();
  if (trimmed.length > MAX_SELECTOR_LENGTH) {
    throw new SocialError(
      'invalid_request',
      `invalid ${field} ${cappedEcho(trimmed)} exceeds maximum length of ${MAX_SELECTOR_LENGTH}`,
    );
  }
  return trimmed;
}

// Payload text is secret-adjacent: reject without echoing any content.
function cleanPayloadText(value: unknown, required: boolean, action: string): string | undefined {
  if (value === undefined || value === null) {
    if (required) {
      throw new SocialError('invalid_request', `invalid payload text for ${action}`);
    }
    return undefined;
  }
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new SocialError('invalid_request', `invalid payload text for ${action}`);
  }
  const trimmed = value.trim();
  if (trimmed.length > MAX_TEXT_LENGTH) {
    throw new SocialError(
      'invalid_request',
      `invalid payload text for ${action} exceeds maximum length of ${MAX_TEXT_LENGTH}`,
    );
  }
  return trimmed;
}

/**
 * Validate a raw social write request. Reject-not-clamp: unknown actions
 * (including 'delete_post', legacy spellings, destructive names) throw
 * unsupported_action; bad selectors/payloads throw invalid_request with
 * capped (≤32 char) selector echoes and zero payload echo.
 */
export function validateSocialWriteRequest(input: SocialWriteRequestInput): {
  request: SocialWriteRequest;
  warnings: string[];
} {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    throw new SocialError('invalid_request', 'request must be an object');
  }
  if (!SOCIAL_PLATFORMS.includes(input.platform as SocialPlatform)) {
    throw new SocialError('invalid_request', `Unsupported platform: ${cappedEcho(String(input.platform))}`);
  }
  const platform = input.platform as SocialPlatform;
  if (!isSocialWriteAction(input.action)) {
    throw new SocialError('unsupported_action', `Unsupported ${platform} write action: ${cappedEcho(String(input.action))}`, {
      platform,
    });
  }
  const action = input.action;

  const postId = cleanSelector('postId', input.postId);
  const commentId = cleanSelector('commentId', input.commentId);
  const user = cleanSelector('user', input.user);
  const community = cleanSelector('community', input.community);
  const topic = cleanSelector('topic', input.topic);

  const rawPayload = input.payload;
  const textRaw =
    typeof rawPayload === 'object' && rawPayload !== null && !Array.isArray(rawPayload)
      ? (rawPayload as Record<string, unknown>).text
      : undefined;
  if (rawPayload !== undefined && (typeof rawPayload !== 'object' || rawPayload === null || Array.isArray(rawPayload))) {
    throw new SocialError('invalid_request', `invalid payload for ${action}`);
  }
  if (
    typeof rawPayload === 'object' &&
    rawPayload !== null &&
    !Array.isArray(rawPayload) &&
    Object.keys(rawPayload).some((key) => key !== 'text')
  ) {
    throw new SocialError('invalid_request', `invalid payload field for ${action}`);
  }

  let text: string | undefined;
  switch (action) {
    case 'create_post': {
      text = cleanPayloadText(textRaw, true, action);
      break;
    }
    case 'add_comment': {
      if (postId === undefined) {
        throw new SocialError('invalid_request', `${platform} ${action} requires selector: postId`);
      }
      text = cleanPayloadText(textRaw, true, action);
      break;
    }
    case 'like': {
      if (postId === undefined) {
        throw new SocialError('invalid_request', `${platform} ${action} requires selector: postId`);
      }
      text = cleanPayloadText(textRaw, false, action);
      if (text !== undefined) {
        throw new SocialError('invalid_request', `invalid payload for ${action}`);
      }
      break;
    }
    case 'follow': {
      if (user === undefined) {
        throw new SocialError('invalid_request', `${platform} ${action} requires selector: user`);
      }
      text = cleanPayloadText(textRaw, false, action);
      if (text !== undefined) {
        throw new SocialError('invalid_request', `invalid payload for ${action}`);
      }
      break;
    }
  }

  const request: SocialWriteRequest = { platform, action };
  if (postId !== undefined) request.postId = postId;
  if (commentId !== undefined) request.commentId = commentId;
  if (user !== undefined) request.user = user;
  if (community !== undefined) request.community = community;
  if (topic !== undefined) request.topic = topic;
  if (text !== undefined) request.text = text;
  return { request, warnings: [] };
}
