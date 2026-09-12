// Stage 3 central media integrator.
//
// Canonical-only runtime seam for the video/media/feeds tools: resolve the
// channel (explicit or URL-inferred), validate the canonical action directly
// against the media contract (unknown/legacy spellings such as 'video' or
// 'subtitle' throw unsupported_action before any backend dispatch), validate
// selectors/limit, fetch channel backend plans, reject plans absent from the
// capability registry, select a backend (completeness-first ordering via
// orderMediaPlans), execute with bounded retryable-only fallback,
// schema-validate the normalized page before success, and surface Pi-owned
// normalized entities with an additive `details.northstar` envelope.
// `content` renders only from normalized entities — raw CLI stdout/stderr
// never reaches a success result.
//
// Channels:
// - youtube: search/hot via the keyed Data API only (fail closed without
//   YOUTUBE_API_KEY — never scrape); details via Data API when keyed, keyless
//   oEmbed fallback otherwise (degraded); transcript is an unofficial
//   keyless/degraded path (watch page + timedtext, never yt-dlp).
// - bilibili: bili-cli (search/details/hot) and OpenCLI (transcript) under
//   sanitized child environments.
// - rss: native fetch + parse into feed_entry entities (pagination unsupported).
//
// Cursors pin the backend (no switching). There is no archive or generic web
// fallback here; only capability-declared backends run (plus the single
// documented unofficial youtube-transcript plan).

import { spawn } from 'node:child_process';
import type { BackendCallResult } from './backend.js';
import { backendCapability, inferPlatformFromUrl } from './capabilities.js';
import { cookieAuthEnvironment, cookieHeaderForUrl } from './cookie-jar.js';
import { fetchJson as boundedFetchJson, fetchJsonNoRedirect, fetchText as boundedFetchText, validatePublicHttpUrl } from './http.js';
import {
  decodeMediaCursor,
  encodeMediaCursor,
  isMediaChannel,
  mediaCursorFingerprint,
  orderMediaPlans,
  parseMediaDate,
  resolveMediaAction,
  validateMediaEntity,
  validateMediaPage,
  validateMediaRequest,
  type MediaAction,
  type MediaBackendPlan,
  type MediaChannel,
  type MediaEntityV1,
  type MediaPageV1,
  type MediaRequest,
  type MediaRequestInput,
  type MediaVideoTranscriptV1,
} from './media-contract.js';
import type { DnsLookup } from './network-policy.js';
import { buildPythonChildEnvironment } from './python-child-env.js';
import { buildNorthstarResult, type NorthstarEntityV1 } from './result-contract.js';
import { redactCliDiagnostics, requireCliPositional } from './social-cli-safety.js';
import { SocialError, type SocialPlatform } from './social-contract.js';
import { openCliChildEnv } from './social-opencli.js';
import { dedupeBy, northstarTextResult } from './tool-output.js';

const USER_AGENT = 'pi-northstar/0.1';
const YOUTUBE_API_BASE = 'https://www.googleapis.com/youtube/v3';
const YOUTUBE_OEMBED_URL = 'https://www.youtube.com/oembed';
const YOUTUBE_TRANSCRIPT_BACKEND = 'youtube-transcript';
const CLI_TIMEOUT_MS = 120_000;
const CLI_KILL_AFTER_MS = 5_000;
const MAX_CLI_OUTPUT_CHARS = 1_000_000;
// Transcript bounds: total caption text and segment count caps.
const MAX_TRANSCRIPT_CHARS = 100_000;
const MAX_TRANSCRIPT_SEGMENTS = 3_000;
// Watch-page player-response scan caps.
const MAX_PLAYER_JSON_CHARS = 1_000_000;

export interface ExecuteMediaOptions {
  signal?: AbortSignal | undefined;
  env?: Record<string, string | undefined> | undefined;
  lookup?: DnsLookup | undefined;
}

interface CliResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

function mediaPlatform(value: MediaChannel): SocialPlatform {
  return value as unknown as SocialPlatform;
}

function abortError(): Error {
  const error = new Error('Aborted');
  error.name = 'AbortError';
  return error;
}

function isAbort(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

// ── Channel / action resolution ──

function resolveChannel(tool: string, args: Record<string, unknown>): MediaChannel {
  const explicit = args.platform;
  if (typeof explicit === 'string' && isMediaChannel(explicit)) return explicit;
  if (tool === 'feeds') return 'rss';
  if (typeof args.url === 'string') {
    const inferred = inferPlatformFromUrl(args.url, ['youtube', 'bilibili']);
    if (inferred === 'youtube' || inferred === 'bilibili') return inferred;
  }
  // The media tool routes feed-action requests without an explicit platform to rss.
  if (typeof args.action === 'string' && args.action.trim() === 'feed') return 'rss';
  throw new SocialError('invalid_request', 'platform is required. Expected one of: youtube, bilibili, rss');
}

function rawActionFor(channel: MediaChannel, args: Record<string, unknown>): string {
  const raw = args.action;
  if (typeof raw === 'string' && raw.trim().length > 0) return raw.trim();
  if (channel === 'rss') return 'feed';
  return typeof args.url === 'string' || typeof args.id === 'string' ? 'details' : 'search';
}

// ── Registry eligibility ──

function mediaRegistrySupports(backend: string, channel: MediaChannel, action: MediaAction): boolean {
  // The unofficial keyless youtube transcript path has no registry backend
  // entry by design (the registry advertises the action; no official API
  // serves captions). Every other plan must be registry-declared.
  if (channel === 'youtube' && action === 'transcript' && backend === YOUTUBE_TRANSCRIPT_BACKEND) return true;
  const declared = backendCapability(channel, backend);
  return declared !== undefined && declared.actions.includes(action);
}

// ── Cursor pinning ──

const CURSOR_ACTIONS: ReadonlySet<string> = new Set(['youtube:search', 'youtube:hot']);

function pinCursorPlans(request: MediaRequest, plans: readonly MediaBackendPlan[]): readonly MediaBackendPlan[] {
  if (request.cursor === undefined) return plans;
  if (!CURSOR_ACTIONS.has(`${request.channel}:${request.action}`)) {
    throw new SocialError('cursor_invalid', `${request.channel} ${request.action} does not support pagination`, {
      platform: mediaPlatform(request.channel),
    });
  }
  const fingerprint = mediaCursorFingerprint({
    channel: request.channel,
    action: request.action,
    ...(request.query !== undefined ? { query: request.query } : {}),
    ...(request.id !== undefined ? { id: request.id } : {}),
    ...(request.url !== undefined ? { url: request.url } : {}),
    limit: request.limit,
  });
  const pinned = plans.filter((plan) => {
    try {
      decodeMediaCursor(request.cursor as string, {
        channel: request.channel,
        action: request.action,
        backend: plan.backend,
        fingerprint,
      });
      return true;
    } catch {
      return false;
    }
  });
  if (pinned.length > 0) return pinned;
  // A cursor-pinned request must never switch backends or silently drop the
  // cursor: malformed tokens and backend switches both reject invalid_cursor.
  throw new SocialError('cursor_invalid', 'cursor does not match the current channel/action/backend/request', {
    platform: mediaPlatform(request.channel),
  });
}

function cursorPageToken(request: MediaRequest, backend: string): string | undefined {
  if (request.cursor === undefined) return undefined;
  const fingerprint = mediaCursorFingerprint({
    channel: request.channel,
    action: request.action,
    ...(request.query !== undefined ? { query: request.query } : {}),
    ...(request.id !== undefined ? { id: request.id } : {}),
    ...(request.url !== undefined ? { url: request.url } : {}),
    limit: request.limit,
  });
  const decoded = decodeMediaCursor(request.cursor, {
    channel: request.channel,
    action: request.action,
    backend,
    fingerprint,
  });
  const token = decoded.state['pageToken'];
  return typeof token === 'string' && token.length > 0 ? token : undefined;
}

function nextCursorFor(request: MediaRequest, backend: string, pageToken: string): string {
  return encodeMediaCursor({
    channel: request.channel,
    action: request.action,
    backend,
    fingerprint: mediaCursorFingerprint({
      channel: request.channel,
      action: request.action,
      ...(request.query !== undefined ? { query: request.query } : {}),
      ...(request.id !== undefined ? { id: request.id } : {}),
      ...(request.url !== undefined ? { url: request.url } : {}),
      limit: request.limit,
    }),
    state: { pageToken },
  });
}

// ── YouTube helpers ──

function youtubeKey(env: Record<string, string | undefined>): string {
  return typeof env.YOUTUBE_API_KEY === 'string' ? env.YOUTUBE_API_KEY.trim() : '';
}

function videoIdFromUrl(raw: string): string | undefined {
  try {
    const url = new URL(raw);
    const host = url.hostname.toLowerCase();
    // Host must be a canonical YouTube host before any `v` extraction —
    // lookalike/non-YouTube URLs must never yield a video ID.
    if (host !== 'youtube.com' && host !== 'youtu.be' && !host.endsWith('.youtube.com')) return undefined;
    const fromParam = url.searchParams.get('v');
    if (fromParam) return fromParam;
    // Canonical youtu.be short links carry the video ID as the first path segment.
    if (host === 'youtu.be') {
      const segment = url.pathname.split('/').filter(Boolean)[0];
      return segment && /^[a-zA-Z0-9_-]{1,20}$/.test(segment) ? segment : undefined;
    }
    return undefined;
  } catch {
    return undefined;
  }
}

function canonicalYoutubeWatchUrl(args: { id?: string; url?: string }): string {
  if (args.id !== undefined && args.id.trim()) return `https://www.youtube.com/watch?v=${encodeURIComponent(args.id.trim())}`;
  const rawUrl = typeof args.url === 'string' ? args.url.trim() : '';
  if (!rawUrl) throw new SocialError('invalid_request', 'youtube details require id or url', { platform: mediaPlatform('youtube') });
  // Reject non-http(s) schemes before any host/ID extraction so wrapper
  // validation errors ("Disallowed URL scheme") match the shared contract.
  let isHttp = false;
  try {
    const parsed = new URL(rawUrl);
    isHttp = parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    isHttp = false;
  }
  if (!isHttp) validatePublicHttpUrl(rawUrl); // throws "Disallowed URL scheme"
  const videoId = videoIdFromUrl(rawUrl);
  if (!videoId) throw new SocialError('invalid_request', 'youtube details require a canonical youtube.com or youtu.be URL', { platform: mediaPlatform('youtube') });
  // Only validate SSRF on the canonical youtube.com URL actually used.
  const canonical = `https://www.youtube.com/watch?v=${encodeURIComponent(videoId)}`;
  validatePublicHttpUrl(canonical);
  return canonical;
}

function youtubeApiUrl(action: MediaAction, request: MediaRequest, key: string, pageToken?: string): string {
  if (action === 'search') {
    const params = new URLSearchParams({ part: 'snippet', type: 'video', maxResults: String(request.limit), key });
    if (request.query !== undefined) params.set('q', request.query);
    if (pageToken !== undefined) params.set('pageToken', pageToken);
    return `${YOUTUBE_API_BASE}/search?${params.toString()}`;
  }
  if (action === 'hot') {
    const params = new URLSearchParams({ part: 'snippet,contentDetails,statistics', chart: 'mostPopular', maxResults: String(request.limit), key });
    if (pageToken !== undefined) params.set('pageToken', pageToken);
    return `${YOUTUBE_API_BASE}/videos?${params.toString()}`;
  }
  // details: single-video lookup, no pagination.
  const videoId = request.id?.trim() || (request.url !== undefined ? videoIdFromUrl(request.url) : undefined) || '';
  if (!videoId) throw new SocialError('invalid_request', 'youtube details require id or url', { platform: mediaPlatform('youtube') });
  const params = new URLSearchParams({ part: 'snippet,contentDetails,statistics', id: videoId, key });
  return `${YOUTUBE_API_BASE}/videos?${params.toString()}`;
}

function youtubeRedactKey(err: unknown, key: string): Error {
  const message = err instanceof Error ? err.message : String(err);
  const redacted = message.replace(/([?&]key=)[^&\s]*/g, '$1[redacted]').split(key).join('[redacted]');
  const error = new Error(redacted);
  if (err instanceof Error && err.name === 'AbortError') error.name = 'AbortError';
  return error;
}

function youtubeApiError(err: unknown, key: string, backend: string): Error {
  if (isAbort(err)) return err as Error;
  const redacted = youtubeRedactKey(err, key);
  const message = redacted.message;
  const detail = `youtube-data-api request failed: ${message}`;
  if (/HTTP 401/.test(message)) return new SocialError('authentication_required', detail, { platform: mediaPlatform('youtube'), backend });
  if (/HTTP 403/.test(message)) return new SocialError('permission_denied', detail, { platform: mediaPlatform('youtube'), backend });
  if (/HTTP 404/.test(message)) return new SocialError('not_found', detail, { platform: mediaPlatform('youtube'), backend });
  if (/HTTP 400/.test(message)) return new SocialError('invalid_request', detail, { platform: mediaPlatform('youtube'), backend });
  if (/HTTP 429/.test(message)) return new SocialError('rate_limited', detail, { platform: mediaPlatform('youtube'), backend });
  return new SocialError('upstream_error', detail, { platform: mediaPlatform('youtube'), backend });
}

function optString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

function optNumber(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim().length > 0) {
    const parsed = Number(value.replace(/[,+\s]/g, ''));
    return Number.isFinite(parsed) ? parsed : undefined;
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

function parseIsoDuration(value: unknown): number | undefined {
  if (typeof value !== 'string') return undefined;
  const match = /^P(?:(\d+)D)?T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?$/.exec(value.trim());
  if (!match) return undefined;
  const days = Number(match[1] ?? 0);
  const hours = Number(match[2] ?? 0);
  const minutes = Number(match[3] ?? 0);
  const seconds = Number(match[4] ?? 0);
  if (match[1] === undefined && match[2] === undefined && match[3] === undefined && match[4] === undefined) return undefined;
  return days * 86400 + hours * 3600 + minutes * 60 + seconds;
}

function thumbnailFrom(row: Record<string, unknown>): string | undefined {
  const thumbnails = row['thumbnails'] as Record<string, { url?: unknown } | undefined> | undefined;
  if (typeof thumbnails !== 'object' || thumbnails === null) return undefined;
  for (const quality of ['maxres', 'high', 'medium', 'default']) {
    const url = thumbnails[quality]?.url;
    const valid = validHttpUrl(typeof url === 'string' ? url : undefined);
    if (valid !== undefined) return valid;
  }
  return undefined;
}

const YOUTUBE_HOME = 'https://www.youtube.com/';
const BILIBILI_HOME = 'https://www.bilibili.com/';

function channelHome(channel: MediaChannel): string {
  switch (channel) {
    case 'youtube': return YOUTUBE_HOME;
    case 'bilibili': return BILIBILI_HOME;
    case 'rss': return '';
  }
}

function mediaEntityId(channel: MediaChannel, kind: 'video' | 'feed_entry', nativeId: string): string {
  return `${channel}:${kind}:${nativeId}`;
}

function normalizeYoutubeSearchRow(item: unknown, warnings: string[]): MediaEntityV1 | undefined {
  if (typeof item !== 'object' || item === null) {
    warnings.push('dropped non-object search row');
    return undefined;
  }
  const row = item as Record<string, unknown>;
  const snippet = (row['snippet'] ?? {}) as Record<string, unknown>;
  const idObject = row['id'] as { videoId?: unknown } | undefined;
  const videoId = typeof idObject?.videoId === 'string' ? idObject.videoId : undefined;
  if (!videoId) {
    warnings.push('dropped search row without videoId');
    return undefined;
  }
  const title = optString(snippet['title']);
  const author = optString(snippet['channelTitle']);
  const entity: MediaEntityV1 = {
    version: 1,
    kind: 'video',
    id: mediaEntityId('youtube', 'video', videoId),
    channel: 'youtube',
    backend: 'youtube-data-api',
    url: `https://www.youtube.com/watch?v=${videoId}`,
    ...(title !== undefined ? { title } : {}),
    ...(parseMediaDate(snippet['publishedAt']) !== undefined ? { publishedAt: parseMediaDate(snippet['publishedAt']) as string } : {}),
    ...(optString(snippet['description']) !== undefined ? { description: optString(snippet['description']) as string } : {}),
    ...((author !== undefined ? { author: { name: author } } : {})),
  };
  const check = validateMediaEntity(entity);
  if (!check.ok) {
    warnings.push(`dropped invalid search row: ${check.issues.join('; ')}`);
    return undefined;
  }
  return entity;
}

function normalizeYoutubeVideoRow(item: unknown, warnings: string[]): MediaEntityV1 | undefined {
  if (typeof item !== 'object' || item === null) {
    warnings.push('dropped non-object video row');
    return undefined;
  }
  const row = item as Record<string, unknown>;
  const snippet = (row['snippet'] ?? {}) as Record<string, unknown>;
  const details = (row['contentDetails'] ?? {}) as Record<string, unknown>;
  const statistics = (row['statistics'] ?? {}) as Record<string, unknown>;
  const id = optString(row['id']);
  if (id === undefined) {
    warnings.push('dropped video row without id');
    return undefined;
  }
  const title = optString(snippet['title']);
  const author = optString(snippet['channelTitle']);
  const duration = parseIsoDuration(details['duration']);
  const views = optNumber(statistics['viewCount']);
  const thumbnail = thumbnailFrom(snippet);
  const entity: MediaEntityV1 = {
    version: 1,
    kind: 'video',
    id: mediaEntityId('youtube', 'video', id),
    channel: 'youtube',
    backend: 'youtube-data-api',
    url: `https://www.youtube.com/watch?v=${id}`,
    ...(title !== undefined ? { title } : {}),
    ...(parseMediaDate(snippet['publishedAt']) !== undefined ? { publishedAt: parseMediaDate(snippet['publishedAt']) as string } : {}),
    ...(optString(snippet['description']) !== undefined ? { description: optString(snippet['description']) as string } : {}),
    ...(duration !== undefined ? { durationSeconds: duration } : {}),
    ...(views !== undefined ? { viewCount: views } : {}),
    ...(author !== undefined ? { author: { name: author } } : {}),
    ...(thumbnail !== undefined ? { thumbnailUrl: thumbnail } : {}),
  };
  const check = validateMediaEntity(entity);
  if (!check.ok) {
    warnings.push(`dropped invalid video row: ${check.issues.join('; ')}`);
    return undefined;
  }
  return entity;
}

function youtubeItemsOf(payload: unknown): { items: unknown[]; nextPageToken?: string } {
  if (typeof payload !== 'object' || payload === null) return { items: [] };
  const record = payload as Record<string, unknown>;
  const items = Array.isArray(record['items']) ? record['items'] as unknown[] : [];
  const nextPageToken = typeof record['nextPageToken'] === 'string' && record['nextPageToken'].length > 0
    ? record['nextPageToken'] as string
    : undefined;
  return { items, ...(nextPageToken !== undefined ? { nextPageToken } : {}) };
}

function youtubePage(
  request: MediaRequest,
  backend: string,
  entities: MediaEntityV1[],
  warnings: string[],
  nextPageToken?: string,
): MediaPageV1 {
  const paginated = request.action === 'search' || request.action === 'hot';
  const hasMore = paginated && nextPageToken !== undefined;
  return {
    entities,
    pagination: {
      supported: paginated,
      limit: request.limit,
      returned: entities.length,
      hasMore,
      ...(hasMore ? { nextCursor: nextCursorFor(request, backend, nextPageToken as string) } : {}),
    },
    partial: warnings.length > 0,
    warnings,
  };
}

// ── YouTube transcript (unofficial keyless path) ──

function extractPlayerJson(html: string): string | undefined {
  const marker = /ytInitialPlayerResponse\s*=\s*/.exec(html);
  if (!marker) return undefined;
  let index = marker.index + marker[0].length;
  while (index < html.length && html[index] !== '{') {
    index += 1;
    if (index - marker.index > 1024) return undefined;
  }
  let depth = 0;
  let inString = false;
  let escaped = false;
  const start = index;
  for (; index < html.length; index += 1) {
    if (index - start > MAX_PLAYER_JSON_CHARS) return undefined;
    const char = html[index] as string;
    if (inString) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') inString = true;
    else if (char === '{') depth += 1;
    else if (char === '}') {
      depth -= 1;
      if (depth === 0) return html.slice(start, index + 1);
    }
  }
  return undefined;
}

function decodeJsonString(value: string): string {
  return value
    .replace(/\\u([0-9a-fA-F]{4})/g, (_, hex: string) => String.fromCharCode(Number.parseInt(hex, 16)))
    .replace(/\\\//g, '/')
    .replace(/\\"/g, '"')
    .replace(/\\n/g, '\n')
    .replace(/\\t/g, ' ');
}

function extractCaptionTrack(playerJson: string): { baseUrl: string; language?: string } | undefined {
  const tracksMarker = /"captionTracks"\s*:\s*\[/.exec(playerJson);
  if (!tracksMarker) return undefined;
  // Scan only a bounded window past the captionTracks marker.
  const window = playerJson.slice(tracksMarker.index, tracksMarker.index + 100_000);
  const baseUrlMatch = /"baseUrl"\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(window);
  if (!baseUrlMatch?.[1]) return undefined;
  const languageMatch = /"languageCode"\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(window);
  return {
    baseUrl: decodeJsonString(baseUrlMatch[1]),
    ...(languageMatch?.[1] !== undefined ? { language: decodeJsonString(languageMatch[1]) } : {}),
  };
}

function isTimedtextHostAllowed(raw: string): boolean {
  try {
    const host = new URL(raw).hostname.toLowerCase();
    return host === 'www.youtube.com' || host.endsWith('.googlevideo.com');
  } catch {
    return false;
  }
}

function decodeCaptionText(value: string): string {
  return value
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim();
}

interface TranscriptDraft {
  start: number;
  duration: number;
  text: string;
}

function draftFromXml(xml: string): TranscriptDraft[] {
  const drafts: TranscriptDraft[] = [];
  for (const match of xml.matchAll(/<text\s+([^>]*)>([\s\S]*?)<\/text>/gi)) {
    const attrs = match[1] ?? '';
    const start = Number(/start="([^"]*)"/.exec(attrs)?.[1]);
    const duration = Number(/dur="([^"]*)"/.exec(attrs)?.[1]);
    const text = decodeCaptionText(match[2] ?? '');
    if (!Number.isFinite(start) || start < 0 || !Number.isFinite(duration) || duration <= 0 || text.length === 0) continue;
    drafts.push({ start, duration, text });
  }
  return drafts;
}

function draftFromJson3(payload: unknown): TranscriptDraft[] {
  if (typeof payload !== 'object' || payload === null) return [];
  const events = (payload as Record<string, unknown>)['events'];
  if (!Array.isArray(events)) return [];
  const drafts: TranscriptDraft[] = [];
  for (const event of events) {
    if (typeof event !== 'object' || event === null) continue;
    const row = event as Record<string, unknown>;
    const startMs = typeof row['tStartMs'] === 'number' ? row['tStartMs'] : undefined;
    const durationMs = typeof row['dDurationMs'] === 'number' ? row['dDurationMs'] : undefined;
    const segs = Array.isArray(row['segs']) ? row['segs'] : [];
    const text = decodeCaptionText(
      segs.map((seg) => (typeof seg === 'object' && seg !== null ? String((seg as Record<string, unknown>)['utf8'] ?? '') : '')).join(''),
    );
    if (startMs === undefined || !Number.isFinite(startMs) || startMs < 0 || text.length === 0) continue;
    const duration = durationMs !== undefined && Number.isFinite(durationMs) && durationMs > 0 ? durationMs / 1000 : 2;
    drafts.push({ start: startMs / 1000, duration, text });
  }
  return drafts;
}

function boundTranscriptDrafts(drafts: TranscriptDraft[], warnings: string[]): MediaVideoTranscriptV1['segments'] {
  const segments: MediaVideoTranscriptV1['segments'] = [];
  let chars = 0;
  for (const draft of drafts) {
    if (segments.length >= MAX_TRANSCRIPT_SEGMENTS) {
      warnings.push(`transcript truncated to ${MAX_TRANSCRIPT_SEGMENTS} segments`);
      break;
    }
    if (chars + draft.text.length > MAX_TRANSCRIPT_CHARS) {
      warnings.push(`transcript truncated to ${MAX_TRANSCRIPT_CHARS} characters`);
      break;
    }
    chars += draft.text.length;
    segments.push(draft);
  }
  return segments;
}

// ── CLI execution ──

function runCli(command: string, args: string[], env: Record<string, string>, signal?: AbortSignal): Promise<CliResult> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(abortError());
      return;
    }
    let stdout = '';
    let stderr = '';
    let aborted = false;
    let timedOut = false;
    const child = spawn(command, args, { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let killTimer: NodeJS.Timeout | undefined;
    const terminate = () => {
      child.kill('SIGTERM');
      killTimer ??= setTimeout(() => child.kill('SIGKILL'), CLI_KILL_AFTER_MS);
    };
    const onAbort = () => {
      aborted = true;
      terminate();
    };
    const timer = setTimeout(() => {
      timedOut = true;
      terminate();
    }, CLI_TIMEOUT_MS);
    signal?.addEventListener('abort', onAbort, { once: true });
    child.stdout.on('data', (chunk) => {
      stdout = (stdout + String(chunk)).slice(-MAX_CLI_OUTPUT_CHARS);
    });
    child.stderr.on('data', (chunk) => {
      stderr = (stderr + String(chunk)).slice(-MAX_CLI_OUTPUT_CHARS);
    });
    child.on('error', (error: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      signal?.removeEventListener('abort', onAbort);
      if (aborted || signal?.aborted) {
        reject(abortError());
        return;
      }
      resolve({ code: error.code === 'ENOENT' ? 127 : 1, stdout, stderr: error.message });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      signal?.removeEventListener('abort', onAbort);
      if (aborted || signal?.aborted) {
        reject(abortError());
        return;
      }
      if (timedOut) {
        resolve({ code: 124, stdout, stderr: `command timed out after ${CLI_TIMEOUT_MS}ms` });
        return;
      }
      resolve({ code, stdout, stderr });
    });
  });
}

/** Bili Schwartz: Python-sanitized env plus derived bilibili cookie vars only. Never OPENCLI_*. */
function biliChildEnv(parentEnv: Record<string, string | undefined>): Record<string, string> {
  return { ...buildPythonChildEnvironment(parentEnv), ...cookieAuthEnvironment('bilibili', parentEnv) };
}

function publicBiliTarget(request: MediaRequest): string {
  if (request.url !== undefined) return validatePublicHttpUrl(request.url);
  const id = requireCliPositional(request.id, 'id', mediaPlatform(request.channel));
  return id;
}

function biliArgv(request: MediaRequest): string[] {
  const limit = String(request.limit);
  switch (request.action) {
    case 'search': {
      const query = requireCliPositional(request.query, 'query', mediaPlatform(request.channel));
      return ['search', query, '--type', 'video', '-n', limit];
    }
    case 'hot':
      return ['hot', '-n', limit];
    case 'details':
      return ['video', publicBiliTarget(request)];
    default:
      throw new SocialError('unsupported_action', `Unsupported bilibili action: ${request.action}`, {
        platform: mediaPlatform(request.channel),
      });
  }
}

function cliPayloadUsable(result: CliResult): boolean {
  const output = (result.stdout || result.stderr).trim();
  if (!output) return false;
  let parsed: unknown;
  try {
    parsed = JSON.parse(output) as unknown;
  } catch {
    // Not JSON: usable as text output; row-shape validation runs below.
    return true;
  }
  if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
    const error = (parsed as Record<string, unknown>)['error'];
    if (typeof error === 'string' && error.trim()) return false;
  }
  return true;
}

function parseCliJson(stdout: string, backend: string, platform: SocialPlatform): unknown {
  try {
    return JSON.parse(stdout) as unknown;
  } catch {
    throw new SocialError('malformed_upstream', `${backend}: stdout is not valid JSON`, { platform, backend });
  }
}

function payloadRows(payload: unknown): unknown[] | undefined {
  if (Array.isArray(payload)) return payload as unknown[];
  if (typeof payload === 'object' && payload !== null) {
    const record = payload as Record<string, unknown>;
    for (const key of ['items', 'videos', 'list', 'data', 'results']) {
      if (Array.isArray(record[key])) return record[key] as unknown[];
    }
    return [payload];
  }
  return undefined;
}

function parseBiliDuration(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value) && value >= 0) return value;
  if (typeof value === 'string') {
    const parts = value.trim().split(':').map(Number);
    if (parts.length > 0 && parts.every((part) => Number.isFinite(part))) {
      return parts.reduce((total, part) => total * 60 + part, 0);
    }
  }
  return undefined;
}

function normalizeBiliVideoRow(item: unknown, warnings: string[]): MediaEntityV1 | undefined {
  if (typeof item !== 'object' || item === null || Array.isArray(item)) {
    warnings.push('dropped non-object bilibili row');
    return undefined;
  }
  const row = item as Record<string, unknown>;
  const nativeId = optString(row['bvid']) ?? optString(row['aid']) ?? optString(row['id']) ?? optString(row['video_id']);
  if (nativeId === undefined) {
    warnings.push('dropped bilibili row without id');
    return undefined;
  }
  const title = optString(row['title']);
  const author = optString(row['author']) ?? optString(row['uploader']) ?? optString(row['username']);
  const link = validHttpUrl(optString(row['url']) ?? optString(row['link']));
  const url = link ?? (/^BV[0-9A-Za-z]{10}$/.test(nativeId) ? `https://www.bilibili.com/video/${nativeId}` : BILIBILI_HOME);
  const entity: MediaEntityV1 = {
    version: 1,
    kind: 'video',
    id: mediaEntityId('bilibili', 'video', nativeId),
    channel: 'bilibili',
    backend: 'bili-cli',
    url,
    ...(title !== undefined ? { title } : {}),
    ...(parseMediaDate(row['publishedAt'] ?? row['pubdate'] ?? row['created']) !== undefined
      ? { publishedAt: parseMediaDate(row['publishedAt'] ?? row['pubdate'] ?? row['created']) as string }
      : {}),
    ...(optString(row['description'] ?? row['desc']) !== undefined
      ? { description: optString(row['description'] ?? row['desc']) as string }
      : {}),
    ...(parseBiliDuration(row['duration'] ?? row['length']) !== undefined
      ? { durationSeconds: parseBiliDuration(row['duration'] ?? row['length']) as number }
      : {}),
    ...(optNumber(row['viewCount'] ?? row['play'] ?? row['views']) !== undefined
      ? { viewCount: optNumber(row['viewCount'] ?? row['play'] ?? row['views']) as number }
      : {}),
    ...(author !== undefined ? { author: { name: author } } : {}),
    ...(validHttpUrl(optString(row['pic'] ?? row['thumbnail'] ?? row['cover'])) !== undefined
      ? { thumbnailUrl: validHttpUrl(optString(row['pic'] ?? row['thumbnail'] ?? row['cover'])) as string }
      : {}),
  };
  const check = validateMediaEntity(entity);
  if (!check.ok) {
    warnings.push(`dropped invalid bilibili row: ${check.issues.join('; ')}`);
    return undefined;
  }
  return entity;
}

function extractBiliId(request: MediaRequest): string | undefined {
  if (request.id !== undefined) return request.id;
  if (request.url === undefined) return undefined;
  const match = /\/(?:video|BV)(BV[0-9A-Za-z]{10}|av\d+)/.exec(request.url);
  return match?.[1];
}

function normalizeTranscriptPayload(
  channel: MediaChannel,
  backend: string,
  videoId: string,
  payload: unknown,
  warnings: string[],
): MediaVideoTranscriptV1 {
  const rows = payloadRows(payload);
  if (rows === undefined) {
    throw new SocialError('malformed_upstream', `${backend}: transcript payload has no usable rows`, {
      platform: mediaPlatform(channel),
      backend,
    });
  }
  // Accept plain segment rows or JSON3 event rows.
  const drafts = rows.flatMap((row) => {
    if (typeof row !== 'object' || row === null) return [];
    const record = row as Record<string, unknown>;
    if (typeof record['text'] === 'string') {
      const start = Number(record['start']);
      const duration = Number(record['duration']);
      const text = decodeCaptionText(record['text']);
      if (!Number.isFinite(start) || start < 0 || !Number.isFinite(duration) || duration <= 0 || text.length === 0) return [];
      return [{ start, duration, text }];
    }
    return draftFromJson3({ events: [row] });
  });
  if (rows.length > 0 && drafts.length === 0) {
    throw new SocialError('malformed_upstream', `${backend}: transcript rows have no usable segments`, {
      platform: mediaPlatform(channel),
      backend,
    });
  }
  const segments = boundTranscriptDrafts(drafts, warnings);
  const entity: MediaVideoTranscriptV1 = {
    version: 1,
    kind: 'video_transcript',
    videoId,
    channel,
    backend,
    segments,
  };
  const check = validateMediaEntity(entity);
  if (!check.ok) {
    throw new SocialError('malformed_upstream', `${backend}: transcript failed validation: ${check.issues.join('; ')}`, {
      platform: mediaPlatform(channel),
      backend,
    });
  }
  return entity;
}

// ── RSS ──

function parseFeedItems(xml: string): Array<{ title: string; url: string; summary?: string | undefined }> {
  const rssItems = [...xml.matchAll(/<item\b[^>]*>([\s\S]*?)<\/item>/gi)].map((match) => {
    const item = match[1] ?? '';
    return {
      title: firstXmlText(item, ['title']) ?? '',
      url: firstXmlText(item, ['link']) ?? firstXmlText(item, ['guid']) ?? '',
      summary: firstXmlText(item, ['description', 'summary', 'content:encoded']),
    };
  });
  const atomItems = [...xml.matchAll(/<entry\b[^>]*>([\s\S]*?)<\/entry>/gi)].map((match) => {
    const item = match[1] ?? '';
    return {
      title: firstXmlText(item, ['title']) ?? '',
      url: firstXmlAttribute(item, 'link', 'href') ?? firstXmlText(item, ['id']) ?? '',
      summary: firstXmlText(item, ['summary', 'content']),
    };
  });
  return [...rssItems, ...atomItems].filter((item) => item.title || item.url);
}

function firstXmlText(xml: string, tags: string[]): string | undefined {
  for (const tag of tags) {
    const match = new RegExp(`<${tag.replace(':', '\\:')}[^>]*>([\\s\\S]*?)<\\/${tag.replace(':', '\\:')}>`, 'i').exec(xml);
    if (match?.[1]) return cleanXml(match[1]);
  }
  return undefined;
}

function firstXmlAttribute(xml: string, tag: string, attribute: string): string | undefined {
  const match = new RegExp(`<${tag}[^>]*\\s${attribute}="([^"]+)"[^>]*>`, 'i').exec(xml);
  return match?.[1] ? cleanXml(match[1]) : undefined;
}

function cleanXml(text: string): string {
  return cleanText(text.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1').replace(/<[^>]+>/g, ' '));
}

function cleanText(text: string): string {
  return text
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim();
}

// ── Plan builders ──

function youtubeDataApiPlan(request: MediaRequest, env: Record<string, string | undefined>, lookup?: DnsLookup): MediaBackendPlan {
  const backend = 'youtube-data-api';
  const key = youtubeKey(env);
  return {
    backend,
    authTier: 'api_key',
    pagination: request.action === 'details' ? 'unsupported' : 'cursor',
    degraded: false,
    quality: 'full',
    async execute(signal?: AbortSignal): Promise<unknown> {
      if (!key) {
        throw new SocialError('authentication_required', `YouTube ${request.action} requires YOUTUBE_API_KEY for the official Data API`, {
          platform: mediaPlatform('youtube'),
          backend,
        });
      }
      const pageToken = request.action === 'details' ? undefined : cursorPageToken(request, backend);
      const url = youtubeApiUrl(request.action, request, key, pageToken);
      // The request URL carries the API key: redirects must never be followed
      // off the fixed Google host (credential-routing control).
      let data: unknown;
      try {
        data = await fetchJsonNoRedirect(url, {}, signal, undefined, lookup);
      } catch (err) {
        throw youtubeApiError(err, key, backend);
      }
      const { items, nextPageToken } = youtubeItemsOf(data);
      if (request.action === 'details' && items.length === 0) {
        // Empty details fall through to the degraded oEmbed tier; empty
        // search/hot pages are valid-empty and stop selection.
        throw new SocialError('upstream_error', 'youtube-data-api returned no details items', {
          platform: mediaPlatform('youtube'),
          backend,
        });
      }
      return { items, ...(nextPageToken !== undefined ? { nextPageToken } : {}) };
    },
  };
}

function youtubeOEmbedPlan(request: MediaRequest, lookup?: DnsLookup): MediaBackendPlan {
  const backend = 'youtube-oembed';
  return {
    backend,
    authTier: 'anonymous',
    pagination: 'unsupported',
    degraded: true,
    quality: 'degraded',
    async execute(signal?: AbortSignal): Promise<unknown> {
      const target = canonicalYoutubeWatchUrl({ ...(request.id !== undefined ? { id: request.id } : {}), ...(request.url !== undefined ? { url: request.url } : {}) });
      const endpoint = `${YOUTUBE_OEMBED_URL}?${new URLSearchParams({ url: target, format: 'json' }).toString()}`;
      try {
        const data = (await boundedFetchJson(endpoint, { 'User-Agent': USER_AGENT }, signal, undefined, lookup)) as Record<string, unknown>;
        return { data, target };
      } catch (err) {
        if (isAbort(err)) throw err;
        const message = err instanceof Error ? err.message : String(err);
        throw new SocialError('upstream_error', `youtube-oembed details failed: ${message}`, {
          platform: mediaPlatform('youtube'),
          backend,
        });
      }
    },
  };
}

function youtubeTranscriptPlan(request: MediaRequest, env: Record<string, string | undefined>, lookup?: DnsLookup): MediaBackendPlan {
  const backend = YOUTUBE_TRANSCRIPT_BACKEND;
  return {
    backend,
    authTier: 'anonymous',
    pagination: 'unsupported',
    degraded: true,
    quality: 'degraded',
    async execute(signal?: AbortSignal): Promise<unknown> {
      const canonical = canonicalYoutubeWatchUrl({ ...(request.id !== undefined ? { id: request.id } : {}), ...(request.url !== undefined ? { url: request.url } : {}) });
      const videoId = new URL(canonical).searchParams.get('v') ?? request.id ?? 'unknown';
      // A stored Pi cookie-jar cookie is attached to the watch-page fetch
      // only; it is never forwarded to timedtext or other hosts and never
      // logged or echoed.
      const cookie = cookieHeaderForUrl('youtube', canonical, env);
      let watchHtml: string;
      try {
        watchHtml = await boundedFetchText(
          canonical,
          cookie !== undefined ? { 'User-Agent': USER_AGENT, Cookie: cookie } : { 'User-Agent': USER_AGENT },
          signal,
          undefined,
          lookup,
        );
      } catch (err) {
        if (isAbort(err)) throw err;
        const message = err instanceof Error ? err.message : String(err);
        throw new SocialError('upstream_error', `YouTube transcript is unavailable: watch page request failed: ${message}`, {
          platform: mediaPlatform('youtube'),
          backend,
        });
      }
      const playerJson = extractPlayerJson(watchHtml);
      if (playerJson === undefined) {
        throw new SocialError('upstream_error', 'YouTube transcript is unavailable: no player response on the watch page', {
          platform: mediaPlatform('youtube'),
          backend,
        });
      }
      const track = extractCaptionTrack(playerJson);
      if (track === undefined) {
        throw new SocialError('upstream_error', 'YouTube transcript is unavailable: no caption tracks on this video', {
          platform: mediaPlatform('youtube'),
          backend,
        });
      }
      if (!isTimedtextHostAllowed(track.baseUrl)) {
        throw new SocialError('upstream_error', 'YouTube transcript is unavailable: caption host is not allowlisted', {
          platform: mediaPlatform('youtube'),
          backend,
        });
      }
      let timedtext: string;
      try {
        // No Cookie header here: credentials never leave the watch origin.
        timedtext = await boundedFetchText(validatePublicHttpUrl(track.baseUrl), { 'User-Agent': USER_AGENT }, signal, undefined, lookup);
      } catch (err) {
        if (isAbort(err)) throw err;
        const message = err instanceof Error ? err.message : String(err);
        throw new SocialError('upstream_error', `YouTube transcript is unavailable: caption fetch failed: ${message}`, {
          platform: mediaPlatform('youtube'),
          backend,
        });
      }
      const trimmed = timedtext.trim();
      const drafts = trimmed.startsWith('<') ? draftFromXml(trimmed) : draftFromJson3(JSON.parse(trimmed) as unknown);
      return { videoId, drafts, ...(track.language !== undefined ? { language: track.language } : {}) };
    },
  };
}

function biliCliPlan(request: MediaRequest, env: Record<string, string | undefined>): MediaBackendPlan {
  const backend = 'bili-cli';
  const platform = mediaPlatform(request.channel);
  return {
    backend,
    authTier: 'cookie',
    pagination: 'unsupported',
    degraded: false,
    quality: 'full',
    async execute(signal?: AbortSignal): Promise<unknown> {
      let argv: string[];
      try {
        argv = biliArgv(request);
      } catch (err) {
        if (err instanceof SocialError && !err.retryable) throw err;
        throw new SocialError('invalid_request', err instanceof Error ? err.message : String(err), { platform, backend });
      }
      const childEnv = biliChildEnv(env);
      const sensitive = Object.values(childEnv).filter((value) => value.length > 0);
      let result: CliResult;
      try {
        result = await runCli('bili', argv, childEnv, signal);
      } catch (err) {
        if (isAbort(err)) throw err;
        throw new SocialError('backend_unavailable', `bili-cli failed to spawn: ${redactCliDiagnostics(err instanceof Error ? err.message : String(err), sensitive)}`, {
          platform,
          backend,
        });
      }
      if (signal?.aborted) throw abortError();
      if (result.code === 127) {
        throw new SocialError('backend_unavailable', 'bili-cli is not installed', { platform, backend });
      }
      if (result.code !== 0) {
        throw new SocialError(
          'upstream_error',
          `bili-cli exited ${String(result.code)}: ${redactCliDiagnostics(result.stderr || result.stdout || `exit code ${String(result.code)}`, sensitive)}`,
          { platform, backend },
        );
      }
      if (!cliPayloadUsable(result)) {
        throw new SocialError('upstream_error', `bili-cli returned an empty or error payload: ${redactCliDiagnostics(result.stderr || result.stdout, sensitive)}`, {
          platform,
          backend,
        });
      }
      return parseCliJson(result.stdout, backend, platform);
    },
  };
}

function biliOpenCliPlan(request: MediaRequest, env: Record<string, string | undefined>): MediaBackendPlan {
  const backend = 'OpenCLI';
  const platform = mediaPlatform(request.channel);
  return {
    backend,
    authTier: 'cookie',
    pagination: 'unsupported',
    degraded: false,
    quality: 'full',
    async execute(signal?: AbortSignal): Promise<unknown> {
      const target = request.url !== undefined ? validatePublicHttpUrl(request.url) : requireCliPositional(request.id, 'id', platform);
      const argv = ['bilibili', 'subtitle', target, '-f', 'json'];
      const childEnv = openCliChildEnv(env);
      const token = childEnv['OPENCLI_TOKEN'];
      const sensitive = token !== undefined ? [token] : [];
      let result: CliResult;
      try {
        result = await runCli('opencli', argv, childEnv, signal);
      } catch (err) {
        if (isAbort(err)) throw err;
        throw new SocialError('backend_unavailable', `OpenCLI failed to spawn: ${redactCliDiagnostics(err instanceof Error ? err.message : String(err), sensitive)}`, {
          platform,
          backend,
        });
      }
      if (signal?.aborted) throw abortError();
      if (result.code === 127) {
        throw new SocialError('backend_unavailable', 'opencli executable is not installed', { platform, backend });
      }
      if (result.code !== 0) {
        throw new SocialError(
          'upstream_error',
          `OpenCLI exited ${String(result.code)}: ${redactCliDiagnostics(result.stderr || result.stdout || `exit code ${String(result.code)}`, sensitive)}`,
          { platform, backend },
        );
      }
      if (!cliPayloadUsable(result)) {
        throw new SocialError('upstream_error', `OpenCLI returned an empty or error payload: ${redactCliDiagnostics(result.stderr || result.stdout, sensitive)}`, {
          platform,
          backend,
        });
      }
      return parseCliJson(result.stdout, backend, platform);
    },
  };
}

function rssPlan(request: MediaRequest, lookup?: DnsLookup): MediaBackendPlan {
  const backend = 'native-rss-atom';
  return {
    backend,
    authTier: 'anonymous',
    pagination: 'unsupported',
    degraded: false,
    quality: 'full',
    async execute(signal?: AbortSignal): Promise<unknown> {
      if (request.url === undefined) {
        throw new SocialError('invalid_request', 'rss feed requires url', { platform: mediaPlatform(request.channel), backend });
      }
      const feedUrl = validatePublicHttpUrl(request.url);
      let xml: string;
      try {
        xml = await boundedFetchText(feedUrl, { 'User-Agent': USER_AGENT }, signal, undefined, lookup);
      } catch (err) {
        if (isAbort(err)) throw err;
        const message = err instanceof Error ? err.message : String(err);
        throw new SocialError('upstream_error', `rss feed fetch failed: ${message}`, {
          platform: mediaPlatform(request.channel),
          backend,
        });
      }
      const items = dedupeBy(parseFeedItems(xml), (item) => item.url || item.title).slice(0, request.limit);
      return { feedUrl, items };
    },
  };
}

function plansFor(request: MediaRequest, env: Record<string, string | undefined>, lookup?: DnsLookup): MediaBackendPlan[] {
  switch (request.channel) {
    case 'youtube': {
      if (request.action === 'transcript') return [youtubeTranscriptPlan(request, env, lookup)];
      if (request.action === 'details') {
        return youtubeKey(env) ? [youtubeDataApiPlan(request, env, lookup), youtubeOEmbedPlan(request, lookup)] : [youtubeOEmbedPlan(request, lookup)];
      }
      // search/hot: keyed Data API only; keyless fails closed in execute (never scrape).
      return [youtubeDataApiPlan(request, env, lookup)];
    }
    case 'bilibili':
      return request.action === 'transcript' ? [biliOpenCliPlan(request, env)] : [biliCliPlan(request, env)];
    case 'rss':
      return [rssPlan(request, lookup)];
  }
}

// ── Normalization (fail closed per plan; no raw passthrough) ──

function normalizeYoutube(request: MediaRequest, plan: MediaBackendPlan, payload: unknown): MediaPageV1 {
  const warnings: string[] = [];
  if (plan.backend === 'youtube-oembed') {
    const record = (payload ?? {}) as Record<string, unknown>;
    const data = (record['data'] ?? {}) as Record<string, unknown>;
    const target = typeof record['target'] === 'string' ? (record['target'] as string) : YOUTUBE_HOME;
    const videoId = target.startsWith('https://www.youtube.com/watch?') ? (new URL(target).searchParams.get('v') ?? undefined) : undefined;
    const title = optString(data['title']);
    const author = optString(data['author_name']);
    const authorUrl = validHttpUrl(optString(data['author_url']));
    const thumbnail = validHttpUrl(optString(data['thumbnail_url']));
    const entity: MediaEntityV1 = {
      version: 1,
      kind: 'video',
      id: mediaEntityId('youtube', 'video', videoId ?? target),
      channel: 'youtube',
      backend: plan.backend,
      url: target,
      ...(title !== undefined ? { title } : {}),
      ...(author !== undefined ? { author: { name: author, ...(authorUrl !== undefined ? { id: authorUrl } : {}) } } : {}),
      ...(thumbnail !== undefined ? { thumbnailUrl: thumbnail } : {}),
    };
    const check = validateMediaEntity(entity);
    if (!check.ok) {
      throw new SocialError('malformed_upstream', `youtube-oembed payload failed validation: ${check.issues.join('; ')}`, {
        platform: mediaPlatform('youtube'),
        backend: plan.backend,
      });
    }
    return {
      entities: [entity],
      pagination: { supported: false, limit: request.limit, returned: 1, hasMore: false },
      partial: false,
      warnings,
    };
  }
  if (plan.backend === YOUTUBE_TRANSCRIPT_BACKEND) {
    const record = (payload ?? {}) as Record<string, unknown>;
    const videoId = typeof record['videoId'] === 'string' && (record['videoId'] as string).length > 0 ? (record['videoId'] as string) : 'unknown';
    const drafts = Array.isArray(record['drafts']) ? (record['drafts'] as TranscriptDraft[]) : [];
    const segments = boundTranscriptDrafts(drafts, warnings);
    const language = typeof record['language'] === 'string' ? (record['language'] as string) : undefined;
    const entity: MediaVideoTranscriptV1 = {
      version: 1,
      kind: 'video_transcript',
      videoId,
      channel: 'youtube',
      backend: plan.backend,
      segments,
      ...(language !== undefined ? { language } : {}),
    };
    const check = validateMediaEntity(entity);
    if (!check.ok) {
      throw new SocialError('malformed_upstream', `youtube transcript failed validation: ${check.issues.join('; ')}`, {
        platform: mediaPlatform('youtube'),
        backend: plan.backend,
      });
    }
    return {
      entities: [entity],
      pagination: { supported: false, limit: request.limit, returned: 1, hasMore: false },
      partial: warnings.length > 0,
      warnings,
    };
  }
  // youtube-data-api: search/hot/details rows plus pageToken pagination.
  const record = (payload ?? {}) as Record<string, unknown>;
  const items = Array.isArray(record['items']) ? (record['items'] as unknown[]) : [];
  const nextPageToken = typeof record['nextPageToken'] === 'string' ? (record['nextPageToken'] as string) : undefined;
  const entities: MediaEntityV1[] = [];
  for (const item of items) {
    const entity = request.action === 'search'
      ? normalizeYoutubeSearchRow(item, warnings)
      : normalizeYoutubeVideoRow(item, warnings);
    if (entity !== undefined) entities.push(entity);
  }
  return youtubePage(request, plan.backend, entities, warnings, nextPageToken);
}

function normalizeBilibili(request: MediaRequest, plan: MediaBackendPlan, payload: unknown): MediaPageV1 {
  const warnings: string[] = [];
  if (plan.backend === 'OpenCLI') {
    const videoId = extractBiliId(request) ?? 'unknown';
    const entity = normalizeTranscriptPayload('bilibili', plan.backend, videoId, payload, warnings);
    return {
      entities: [entity],
      pagination: { supported: false, limit: request.limit, returned: 1, hasMore: false },
      partial: warnings.length > 0,
      warnings,
    };
  }
  const rows = payloadRows(payload);
  if (rows === undefined) {
    throw new SocialError('malformed_upstream', 'bili-cli payload has no usable rows', {
      platform: mediaPlatform(request.channel),
      backend: plan.backend,
    });
  }
  const entities: MediaEntityV1[] = [];
  const capped = rows.slice(0, request.limit);
  if (rows.length > capped.length) warnings.push(`bilibili rows truncated to limit ${request.limit}`);
  for (const row of capped) {
    const entity = normalizeBiliVideoRow(row, warnings);
    if (entity !== undefined) entities.push(entity);
  }
  return {
    entities,
    pagination: { supported: false, limit: request.limit, returned: entities.length, hasMore: false },
    partial: warnings.length > 0,
    warnings,
  };
}

function normalizeRss(request: MediaRequest, plan: MediaBackendPlan, payload: unknown): MediaPageV1 {
  const warnings: string[] = [];
  const record = (payload ?? {}) as Record<string, unknown>;
  const feedUrl = typeof record['feedUrl'] === 'string' ? (record['feedUrl'] as string) : '';
  const items = Array.isArray(record['items']) ? (record['items'] as Array<{ title: string; url: string; summary?: string }>) : [];
  const entities: MediaEntityV1[] = [];
  for (const [index, item] of items.entries()) {
    const url = validHttpUrl(item.url) ?? (feedUrl ? feedUrl : undefined);
    if (url === undefined) {
      warnings.push(`dropped feed entry ${index} without url`);
      continue;
    }
    const title = typeof item.title === 'string' ? item.title : '';
    const snippet = typeof item.summary === 'string' && item.summary.length > 0 ? item.summary : undefined;
    const entity: MediaEntityV1 = {
      version: 1,
      kind: 'feed_entry',
      id: mediaEntityId('rss', 'feed_entry', item.url || title || `entry-${index}`),
      channel: 'rss',
      backend: plan.backend,
      url,
      ...(title.length > 0 ? { title } : {}),
      ...(snippet !== undefined ? { snippet } : {}),
    };
    const check = validateMediaEntity(entity);
    if (!check.ok) {
      warnings.push(`dropped invalid feed entry ${index}: ${check.issues.join('; ')}`);
      continue;
    }
    entities.push(entity);
  }
  return {
    entities,
    pagination: { supported: false, limit: request.limit, returned: entities.length, hasMore: false },
    partial: warnings.length > 0,
    warnings,
  };
}

function normalize(request: MediaRequest, plan: MediaBackendPlan, payload: unknown): MediaPageV1 {
  switch (request.channel) {
    case 'youtube':
      return normalizeYoutube(request, plan, payload);
    case 'bilibili':
      return normalizeBilibili(request, plan, payload);
    case 'rss':
      return normalizeRss(request, plan, payload);
  }
}

// ── Rendering + northstar envelope ──

function renderMediaEntity(entity: MediaEntityV1): string {
  const lines: string[] = [];
  if (entity.kind === 'video') {
    lines.push(`[video] ${entity.title ?? entity.id}`);
    if (entity.author?.name !== undefined) lines.push(`by ${entity.author.name}`);
    if (entity.publishedAt !== undefined) lines.push(`published ${entity.publishedAt}`);
    if (entity.viewCount !== undefined) lines.push(`views ${entity.viewCount}`);
    if (entity.durationSeconds !== undefined) lines.push(`duration ${entity.durationSeconds}s`);
    if (entity.description !== undefined) lines.push(entity.description.slice(0, 500));
    if (entity.url !== undefined) lines.push(entity.url);
    return lines.join('\n');
  }
  if (entity.kind === 'feed_entry') {
    lines.push(`[feed] ${entity.title ?? entity.id}`);
    if (entity.author?.name !== undefined) lines.push(`by ${entity.author.name}`);
    if (entity.publishedAt !== undefined) lines.push(`published ${entity.publishedAt}`);
    if (entity.snippet !== undefined) lines.push(entity.snippet.slice(0, 500));
    if (entity.url !== undefined) lines.push(entity.url);
    return lines.join('\n');
  }
  lines.push(`[transcript] ${entity.videoId} (${entity.segments.length} segments)`);
  for (const segment of entity.segments) {
    lines.push(`[${segment.start.toFixed(1)}s] ${segment.text}`);
  }
  return lines.join('\n');
}

function renderMediaPage(page: MediaPageV1): string {
  const sections = page.entities.map(renderMediaEntity);
  const footer: string[] = [];
  if (page.pagination.hasMore) footer.push('more results available (use nextCursor to continue)');
  else if (page.pagination.supported) footer.push(`${page.pagination.returned} of up to ${page.pagination.limit} results`);
  for (const warning of page.warnings) footer.push(`warning: ${warning}`);
  if (page.partial) footer.push('partial: some upstream rows were dropped or truncated');
  const body = sections.join('\n\n');
  const tail = footer.join('\n');
  if (body.length === 0 && tail.length === 0) return '(no results)';
  if (tail.length === 0) return body;
  return body.length === 0 ? tail : `${body}\n\n--\n${tail}`;
}

function toNorthstarEntity(entity: MediaEntityV1, channel: MediaChannel): NorthstarEntityV1 {
  if (entity.kind === 'video_transcript') {
    const watchUrl = channel === 'youtube'
      ? `https://www.youtube.com/watch?v=${entity.videoId}`
      : `https://www.bilibili.com/video/${entity.videoId}`;
    const snippet = entity.segments
      .slice(0, 5)
      .map((segment) => segment.text)
      .join(' ')
      .slice(0, 280);
    return {
      entityVersion: 1,
      kind: 'video',
      id: entity.videoId,
      source: channel,
      title: `Transcript for ${entity.videoId}`,
      url: watchUrl,
      ...(snippet.length > 0 ? { snippet } : {}),
    };
  }
  const title = entity.title ?? `${channel} ${entity.kind}`;
  const base: NorthstarEntityV1 = {
    entityVersion: 1,
    kind: entity.kind,
    id: entity.id,
    source: channel,
    title,
    url: entity.url ?? channelHome(channel),
  };
  const snippet = entity.kind === 'video' ? entity.description : entity.snippet;
  if (snippet !== undefined) base.snippet = snippet.slice(0, 500);
  if (entity.author?.name !== undefined) base.authors = [{ name: entity.author.name }];
  if (entity.publishedAt !== undefined) base.publishedAt = entity.publishedAt;
  if (entity.kind === 'video' && entity.viewCount !== undefined) base.metrics = { views: entity.viewCount };
  return base;
}

function buildMediaResult(
  tool: string,
  request: MediaRequest,
  plan: MediaBackendPlan,
  page: MediaPageV1,
  warnings: string[],
): BackendCallResult {
  const content = renderMediaPage(page);
  const allWarnings = [...warnings, ...page.warnings];
  const entities = page.entities.map((entity) => toNorthstarEntity(entity, request.channel));
  const notes = [...allWarnings];
  if (page.partial) notes.push('partial: some upstream rows were dropped or truncated');
  if (plan.degraded) notes.push(`degraded: ${plan.backend} is a limited fallback backend`);
  const envelope = buildNorthstarResult({
    request: {
      tool,
      channel: request.channel,
      action: request.action,
      source: plan.backend,
    },
    outcomes: [
      {
        source: request.channel,
        backend: plan.backend,
        ...(entities.length > 0 ? { entities } : {}),
        ...(plan.degraded ? { degraded: true } : {}),
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
    platform: request.channel,
    channel: request.channel,
    action: request.action,
    canonicalAction: request.action,
    backend: plan.backend,
    items: page.entities,
    pagination: page.pagination,
    partial: page.partial,
    warnings: allWarnings,
  };
  return northstarTextResult(content, legacyDetails, envelope);
}

// ── Integrator ──

export async function executeMedia(
  tool: string,
  args: Record<string, unknown>,
  options: ExecuteMediaOptions = {},
): Promise<BackendCallResult> {
  const env = options.env ?? process.env;
  const channel = resolveChannel(tool, args);
  // Canonical-only: unknown/legacy action spellings throw unsupported_action
  // here, before any backend dispatch.
  const rawAction = rawActionFor(channel, args);
  resolveMediaAction(channel, rawAction);
  const rawInput: MediaRequestInput = { channel, action: rawAction };
  if (typeof args.query === 'string') rawInput.query = args.query;
  if (typeof args.id === 'string') rawInput.id = args.id;
  if (typeof args.url === 'string') rawInput.url = args.url;
  if (typeof args.limit === 'number') rawInput.limit = args.limit;
  const { request, warnings: validationWarnings } = validateMediaRequest(rawInput);
  const warnings = [...validationWarnings];
  const cursor = optionalString(args.cursor);
  if (cursor !== undefined) request.cursor = cursor;

  const plans = plansFor(request, env, options.lookup);
  const eligible = plans.filter((plan) => mediaRegistrySupports(plan.backend, request.channel, request.action));
  if (eligible.length === 0) {
    if (plans.length > 0) {
      throw new SocialError('backend_unavailable', `no registry-declared backend for ${channel} ${request.action}`, {
        platform: mediaPlatform(channel),
      });
    }
    throw new SocialError('backend_unavailable', `no usable ${channel} backend for ${request.action}`, {
      platform: mediaPlatform(channel),
    });
  }
  const pinned = pinCursorPlans(request, eligible);
  const ordered = request.cursor === undefined ? orderMediaPlans(request.channel, pinned) : [...pinned];

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
    let page: MediaPageV1;
    try {
      const normalized = normalize(request, plan, payload);
      const check = validateMediaPage(normalized);
      if (!check.ok || check.page === undefined) {
        throw new SocialError('malformed_upstream', `normalized page failed validation: ${check.issues.join('; ')}`, {
          platform: mediaPlatform(channel),
          backend: plan.backend,
        });
      }
      page = check.page;
    } catch (error) {
      if (isAbort(error)) throw error;
      if (error instanceof SocialError && !error.retryable) throw error;
      failures.push(`${plan.backend}: ${error instanceof Error ? error.message : String(error)}`);
      continue;
    }
    // Valid empty results stop selection — never fall through to the next plan.
    return buildMediaResult(tool, request, plan, page, warnings);
  }
  throw new SocialError('backend_unavailable', `No usable ${channel} backend for ${request.action}. ${failures.join('; ')}`, {
    platform: mediaPlatform(channel),
  });
}
