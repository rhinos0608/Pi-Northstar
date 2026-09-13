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

import { spawnCliCommand } from '../process/cli-command.js';
import type { BackendCallResult } from '../backend.js';
import { backendCapability, inferPlatformFromUrl } from '../capabilities.js';
import { cookieAuthEnvironment, cookieHeaderForUrl } from '../chrome/cookie-jar.js';
import { fetchJson as boundedFetchJson, fetchJsonNoRedirect, fetchText as boundedFetchText, validatePublicHttpUrl } from '../core/http.js';
import {
  decodeMediaCursor,
  isMediaChannel,
  mediaCursorFingerprint,
  orderMediaPlans,
  resolveMediaAction,
  validateMediaPage,
  validateMediaRequest,
  type MediaAction,
  type MediaBackendPlan,
  type MediaChannel,
  type MediaEntityV1,
  type MediaPageV1,
  type MediaRequest,
  type MediaRequestInput,
} from './media-contract.js';
import {
  YOUTUBE_TRANSCRIPT_BACKEND,
  draftFromJson3,
  draftFromXml,
  normalizeMediaPage,
  youtubeItemsOf,
} from './media-normalization.js';
import { buildPythonChildEnvironment } from '../process/python-child-env.js';
import { buildNorthstarResult, type NorthstarEntityV1 } from '../result-contract.js';
import { redactCliDiagnostics, requireCliPositional } from '../social/social-cli-safety.js';
import { SocialError, type SocialPlatform } from '../social/social-contract.js';
import { openCliChildEnv } from '../social/social-opencli.js';
import { dedupeBy, northstarTextResult } from '../core/tool-output.js';

const USER_AGENT = 'pi-northstar/0.1';
const YOUTUBE_API_BASE = 'https://www.googleapis.com/youtube/v3';
const YOUTUBE_OEMBED_URL = 'https://www.youtube.com/oembed';
import type { DnsLookup } from '../network-policy.js';
const CLI_TIMEOUT_MS = 120_000;
const CLI_KILL_AFTER_MS = 5_000;
const MAX_CLI_OUTPUT_CHARS = 1_000_000;
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

function explicitChannel(args: Record<string, unknown>): MediaChannel | undefined {
  const explicit = args.platform;
  return typeof explicit === 'string' && isMediaChannel(explicit) ? explicit : undefined;
}

function inferredUrlChannel(args: Record<string, unknown>): MediaChannel | undefined {
  if (typeof args.url !== 'string') return undefined;
  const inferred = inferPlatformFromUrl(args.url, ['youtube', 'bilibili']);
  return inferred === 'youtube' || inferred === 'bilibili' ? inferred : undefined;
}

function isFeedActionRequest(tool: string, args: Record<string, unknown>): boolean {
  if (tool === 'feeds') return true;
  // The media tool routes feed-action requests without an explicit platform to rss.
  return typeof args.action === 'string' && args.action.trim() === 'feed';
}

function resolveChannel(tool: string, args: Record<string, unknown>): MediaChannel {
  const explicit = explicitChannel(args);
  if (explicit !== undefined) return explicit;
  if (isFeedActionRequest(tool, args)) return 'rss';
  const inferred = inferredUrlChannel(args);
  if (inferred !== undefined) return inferred;
  throw new SocialError('invalid_request', 'platform is required. Expected one of: youtube, bilibili, rss');
}

function rawActionFor(channel: MediaChannel, args: Record<string, unknown>): string {
  const raw = args.action;
  if (typeof raw === 'string' && raw.trim().length > 0) return raw.trim();
  if (channel === 'rss') return 'feed';
  return typeof args.url === 'string' || typeof args.id === 'string' ? 'details' : 'search';
}

// ── Registry eligibility ──

function isUnofficialTranscriptBackend(backend: string, channel: MediaChannel, action: MediaAction): boolean {
  return channel === 'youtube' && action === 'transcript' && backend === YOUTUBE_TRANSCRIPT_BACKEND;
}

function mediaRegistrySupports(backend: string, channel: MediaChannel, action: MediaAction): boolean {
  // The unofficial keyless youtube transcript path has no registry backend
  // entry by design (the registry advertises the action; no official API
  // serves captions). Every other plan must be registry-declared.
  if (isUnofficialTranscriptBackend(backend, channel, action)) return true;
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

// ── YouTube helpers ──

function youtubeKey(env: Record<string, string | undefined>): string {
  return typeof env.YOUTUBE_API_KEY === 'string' ? env.YOUTUBE_API_KEY.trim() : '';
}

function isYoutubeVideoHost(host: string): boolean {
  return host === 'youtube.com' || host === 'youtu.be' || host.endsWith('.youtube.com');
}

function isAllowedTimedtextHost(host: string): boolean {
  return host === 'www.youtube.com' || host.endsWith('.googlevideo.com');
}

function videoIdFromUrl(raw: string): string | undefined {
  try {
    const url = new URL(raw);
    const host = url.hostname.toLowerCase();
    // Host must be a canonical YouTube host before any `v` extraction —
    // lookalike/non-YouTube URLs must never yield a video ID.
    if (!isYoutubeVideoHost(host)) return undefined;
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

function watchUrlForVideoId(videoId: string): string {
  return `https://www.youtube.com/watch?v=${encodeURIComponent(videoId)}`;
}

function requireRawWatchUrl(url: string | undefined): string {
  const rawUrl = typeof url === 'string' ? url.trim() : '';
  if (!rawUrl) throw new SocialError('invalid_request', 'youtube details require id or url', { platform: mediaPlatform('youtube') });
  return rawUrl;
}

function isHttpScheme(rawUrl: string): boolean {
  try {
    const parsed = new URL(rawUrl);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

function requireCanonicalVideoId(rawUrl: string): string {
  // Reject non-http(s) schemes before any host/ID extraction so wrapper
  // validation errors ("Disallowed URL scheme") match the shared contract.
  if (!isHttpScheme(rawUrl)) validatePublicHttpUrl(rawUrl); // throws "Disallowed URL scheme"
  const videoId = videoIdFromUrl(rawUrl);
  if (!videoId) throw new SocialError('invalid_request', 'youtube details require a canonical youtube.com or youtu.be URL', { platform: mediaPlatform('youtube') });
  return videoId;
}

function canonicalYoutubeWatchUrl(args: { id?: string; url?: string }): string {
  if (args.id !== undefined && args.id.trim()) return watchUrlForVideoId(args.id.trim());
  const videoId = requireCanonicalVideoId(requireRawWatchUrl(args.url));
  // Only validate SSRF on the canonical youtube.com URL actually used.
  const canonical = watchUrlForVideoId(videoId);
  validatePublicHttpUrl(canonical);
  return canonical;
}

function applyPageToken(params: URLSearchParams, pageToken?: string): void {
  if (pageToken !== undefined) params.set('pageToken', pageToken);
}

function youtubeSearchUrl(request: MediaRequest, key: string, pageToken?: string): string {
  const params = new URLSearchParams({ part: 'snippet', type: 'video', maxResults: String(request.limit), key });
  if (request.query !== undefined) params.set('q', request.query);
  applyPageToken(params, pageToken);
  return `${YOUTUBE_API_BASE}/search?${params.toString()}`;
}

function youtubeHotUrl(request: MediaRequest, key: string, pageToken?: string): string {
  const params = new URLSearchParams({ part: 'snippet,contentDetails,statistics', chart: 'mostPopular', maxResults: String(request.limit), key });
  applyPageToken(params, pageToken);
  return `${YOUTUBE_API_BASE}/videos?${params.toString()}`;
}

function youtubeDetailsVideoId(request: MediaRequest): string {
  const videoId = request.id?.trim() || (request.url !== undefined ? videoIdFromUrl(request.url) : undefined) || '';
  if (!videoId) throw new SocialError('invalid_request', 'youtube details require id or url', { platform: mediaPlatform('youtube') });
  return videoId;
}

function youtubeDetailsUrl(request: MediaRequest, key: string): string {
  const videoId = youtubeDetailsVideoId(request);
  const params = new URLSearchParams({ part: 'snippet,contentDetails,statistics', id: videoId, key });
  return `${YOUTUBE_API_BASE}/videos?${params.toString()}`;
}

function youtubeApiUrl(action: MediaAction, request: MediaRequest, key: string, pageToken?: string): string {
  if (action === 'search') return youtubeSearchUrl(request, key, pageToken);
  if (action === 'hot') return youtubeHotUrl(request, key, pageToken);
  // details: single-video lookup, no pagination.
  return youtubeDetailsUrl(request, key);
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

const YOUTUBE_HOME = 'https://www.youtube.com/';
const BILIBILI_HOME = 'https://www.bilibili.com/';

function channelHome(channel: MediaChannel): string {
  switch (channel) {
    case 'youtube': return YOUTUBE_HOME;
    case 'bilibili': return BILIBILI_HOME;
    case 'rss': return '';
  }
}

// ── YouTube transcript (unofficial keyless path) ──

function findPlayerJsonStart(html: string, markerIndex: number, markerLength: number): number {
  let index = markerIndex + markerLength;
  while (index < html.length && html[index] !== '{') {
    index += 1;
    if (index - markerIndex > 1024) return -1;
  }
  return index;
}

interface PlayerJsonScanState {
  depth: number;
  inString: boolean;
  escaped: boolean;
}

function stepInStringChar(char: string, state: PlayerJsonScanState): void {
  if (state.escaped) state.escaped = false;
  else if (char === '\\') state.escaped = true;
  else if (char === '"') state.inString = false;
}

function stepPlayerJsonChar(char: string, state: PlayerJsonScanState): boolean {
  if (state.inString) {
    stepInStringChar(char, state);
    return false;
  }
  if (char === '"') state.inString = true;
  else if (char === '{') state.depth += 1;
  else if (char === '}') {
    state.depth -= 1;
    if (state.depth === 0) return true;
  }
  return false;
}

function scanBalancedPlayerJson(html: string, start: number): string | undefined {
  const state: PlayerJsonScanState = { depth: 0, inString: false, escaped: false };
  for (let index = start; index < html.length; index += 1) {
    if (index - start > MAX_PLAYER_JSON_CHARS) return undefined;
    if (stepPlayerJsonChar(html[index] as string, state)) return html.slice(start, index + 1);
  }
  return undefined;
}

function extractPlayerJson(html: string): string | undefined {
  const marker = /ytInitialPlayerResponse\s*=\s*/.exec(html);
  if (!marker) return undefined;
  const start = findPlayerJsonStart(html, marker.index, marker[0].length);
  if (start === -1 || start >= html.length) return undefined;
  return scanBalancedPlayerJson(html, start);
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
    return isAllowedTimedtextHost(new URL(raw).hostname.toLowerCase());
  } catch {
    return false;
  }
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
    // Portable spawn: .cmd/.bat shims run via cmd.exe with pre-quoted argv
    // (shell:false cannot execute them — spawn EINVAL); see cli-command.ts.
    const child = spawnCliCommand(command, args, { env, stdio: ['ignore', 'pipe', 'pipe'] });
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

function isErrorPayloadObject(parsed: unknown): parsed is Record<string, unknown> {
  return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed);
}

function isNonEmptyErrorString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function hasUpstreamErrorField(parsed: unknown): boolean {
  if (!isErrorPayloadObject(parsed)) return false;
  return isNonEmptyErrorString(parsed['error']);
}

function parseCliPayloadOutput(output: string): unknown | undefined {
  try {
    return JSON.parse(output) as unknown;
  } catch {
    // Not JSON: usable as text output; row-shape validation runs below.
    return undefined;
  }
}

function cliPayloadUsable(result: CliResult): boolean {
  const output = (result.stdout || result.stderr).trim();
  if (!output) return false;
  const parsed = parseCliPayloadOutput(output);
  if (parsed === undefined) return true;
  return !hasUpstreamErrorField(parsed);
}

function parseCliJson(stdout: string, backend: string, platform: SocialPlatform): unknown {
  try {
    return JSON.parse(stdout) as unknown;
  } catch {
    throw new SocialError('malformed_upstream', `${backend}: stdout is not valid JSON`, { platform, backend });
  }
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
      return executeYoutubeDataApi(request, key, backend, { ...(signal !== undefined ? { signal } : {}), ...(lookup !== undefined ? { lookup } : {}) });
    },
  };
}

function requireYoutubeDataKey(request: MediaRequest, key: string, backend: string): void {
  if (!key) {
    throw new SocialError('authentication_required', `YouTube ${request.action} requires YOUTUBE_API_KEY for the official Data API`, {
      platform: mediaPlatform('youtube'),
      backend,
    });
  }
}

async function fetchYoutubeDataItems(request: MediaRequest, key: string, backend: string, fetchCtx: FetchContext): Promise<{ items: unknown[]; nextPageToken?: string }> {
  const pageToken = request.action === 'details' ? undefined : cursorPageToken(request, backend);
  const url = youtubeApiUrl(request.action, request, key, pageToken);
  // The request URL carries the API key: redirects must never be followed
  // off the fixed Google host (credential-routing control).
  try {
    const data = await fetchJsonNoRedirect(url, {}, fetchCtx.signal, undefined, fetchCtx.lookup);
    return youtubeItemsOf(data);
  } catch (err) {
    throw youtubeApiError(err, key, backend);
  }
}

function requireDetailsItems(request: MediaRequest, backend: string, items: unknown[]): void {
  if (request.action === 'details' && items.length === 0) {
    // Empty details fall through to the degraded oEmbed tier; empty
    // search/hot pages are valid-empty and stop selection.
    throw new SocialError('upstream_error', 'youtube-data-api returned no details items', {
      platform: mediaPlatform('youtube'),
      backend,
    });
  }
}

async function executeYoutubeDataApi(request: MediaRequest, key: string, backend: string, fetchCtx: FetchContext): Promise<unknown> {
  requireYoutubeDataKey(request, key, backend);
  const { items, nextPageToken } = await fetchYoutubeDataItems(request, key, backend, fetchCtx);
  requireDetailsItems(request, backend, items);
  return { items, ...(nextPageToken !== undefined ? { nextPageToken } : {}) };
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

function transcriptWatchTarget(request: MediaRequest): { canonical: string; videoId: string } {
  const canonical = canonicalYoutubeWatchUrl({ ...(request.id !== undefined ? { id: request.id } : {}), ...(request.url !== undefined ? { url: request.url } : {}) });
  const videoId = new URL(canonical).searchParams.get('v') ?? request.id ?? 'unknown';
  return { canonical, videoId };
}

function transcriptWatchHeaders(cookie: string | undefined): Record<string, string> {
  return cookie !== undefined ? { 'User-Agent': USER_AGENT, Cookie: cookie } : { 'User-Agent': USER_AGENT };
}

async function fetchTranscriptWatchHtml(canonical: string, env: Record<string, string | undefined>, signal?: AbortSignal, lookup?: DnsLookup): Promise<string> {
  // A stored Pi cookie-jar cookie is attached to the watch-page fetch
  // only; it is never forwarded to timedtext or other hosts and never
  // logged or echoed.
  const cookie = cookieHeaderForUrl('youtube', canonical, env);
  try {
    return await boundedFetchText(canonical, transcriptWatchHeaders(cookie), signal, undefined, lookup);
  } catch (err) {
    if (isAbort(err)) throw err;
    const message = err instanceof Error ? err.message : String(err);
    throw new SocialError('upstream_error', `YouTube transcript is unavailable: watch page request failed: ${message}`, {
      platform: mediaPlatform('youtube'),
      backend: YOUTUBE_TRANSCRIPT_BACKEND,
    });
  }
}

function requirePlayerResponse(watchHtml: string): string {
  const playerJson = extractPlayerJson(watchHtml);
  if (playerJson === undefined) {
    throw new SocialError('upstream_error', 'YouTube transcript is unavailable: no player response on the watch page', {
      platform: mediaPlatform('youtube'),
      backend: YOUTUBE_TRANSCRIPT_BACKEND,
    });
  }
  return playerJson;
}

function requireCaptionTrack(playerJson: string): { baseUrl: string; language?: string } {
  const track = extractCaptionTrack(playerJson);
  if (track === undefined) {
    throw new SocialError('upstream_error', 'YouTube transcript is unavailable: no caption tracks on this video', {
      platform: mediaPlatform('youtube'),
      backend: YOUTUBE_TRANSCRIPT_BACKEND,
    });
  }
  if (!isTimedtextHostAllowed(track.baseUrl)) {
    throw new SocialError('upstream_error', 'YouTube transcript is unavailable: caption host is not allowlisted', {
      platform: mediaPlatform('youtube'),
      backend: YOUTUBE_TRANSCRIPT_BACKEND,
    });
  }
  return track;
}

async function fetchCaptionTimedtext(baseUrl: string, signal?: AbortSignal, lookup?: DnsLookup): Promise<string> {
  try {
    // No Cookie header here: credentials never leave the watch origin.
    return await boundedFetchText(validatePublicHttpUrl(baseUrl), { 'User-Agent': USER_AGENT }, signal, undefined, lookup);
  } catch (err) {
    if (isAbort(err)) throw err;
    const message = err instanceof Error ? err.message : String(err);
    throw new SocialError('upstream_error', `YouTube transcript is unavailable: caption fetch failed: ${message}`, {
      platform: mediaPlatform('youtube'),
      backend: YOUTUBE_TRANSCRIPT_BACKEND,
    });
  }
}

function transcriptDraftsFromTimedtext(timedtext: string): unknown {
  const trimmed = timedtext.trim();
  if (trimmed.startsWith('<')) return draftFromXml(trimmed);
  let payload: unknown;
  try {
    payload = JSON.parse(trimmed) as unknown;
  } catch (err) {
    throw new SocialError(
      'malformed_upstream',
      `youtube-transcript: timedtext payload is neither valid XML nor valid JSON: ${err instanceof Error ? err.message : String(err)}`,
      { platform: mediaPlatform('youtube'), backend: YOUTUBE_TRANSCRIPT_BACKEND },
    );
  }
  return draftFromJson3(payload);
}

async function fetchTranscriptPayload(
  request: MediaRequest,
  env: Record<string, string | undefined>,
  signal?: AbortSignal,
  lookup?: DnsLookup,
): Promise<{ videoId: string; drafts: unknown; language?: string }> {
  const { canonical, videoId } = transcriptWatchTarget(request);
  const watchHtml = await fetchTranscriptWatchHtml(canonical, env, signal, lookup);
  const track = requireCaptionTrack(requirePlayerResponse(watchHtml));
  const timedtext = await fetchCaptionTimedtext(track.baseUrl, signal, lookup);
  const drafts = transcriptDraftsFromTimedtext(timedtext);
  return { videoId, drafts, ...(track.language !== undefined ? { language: track.language } : {}) };
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
      return fetchTranscriptPayload(request, env, signal, lookup);
    },
  };
}

interface CliRunContext {
  commandLabel: string;
  platform: SocialPlatform;
  backend: string;
  sensitive: string[];
  signal?: AbortSignal;
}

interface FetchContext {
  signal?: AbortSignal;
  lookup?: DnsLookup;
}

function resolveBiliCliArgv(request: MediaRequest, platform: SocialPlatform, backend: string): string[] {
  try {
    return biliArgv(request);
  } catch (err) {
    if (err instanceof SocialError && !err.retryable) throw err;
    throw new SocialError('invalid_request', err instanceof Error ? err.message : String(err), { platform, backend });
  }
}

function resolveOpenCliTarget(request: MediaRequest, platform: SocialPlatform): string {
  return request.url !== undefined ? validatePublicHttpUrl(request.url) : requireCliPositional(request.id, 'id', platform);
}

async function spawnBackendCli(ctx: CliRunContext, command: string, argv: string[], childEnv: Record<string, string>): Promise<CliResult> {
  try {
    return await runCli(command, argv, childEnv, ctx.signal);
  } catch (err) {
    if (isAbort(err)) throw err;
    throw new SocialError('backend_unavailable', `${ctx.commandLabel} failed to spawn: ${redactCliDiagnostics(err instanceof Error ? err.message : String(err), ctx.sensitive)}`, {
      platform: ctx.platform,
      backend: ctx.backend,
    });
  }
}

function assertCliCompleted(ctx: CliRunContext, notInstalledMessage: string, result: CliResult): void {
  if (result.code === 127) {
    throw new SocialError('backend_unavailable', notInstalledMessage, { platform: ctx.platform, backend: ctx.backend });
  }
  if (result.code !== 0) {
    throw new SocialError(
      'upstream_error',
      `${ctx.commandLabel} exited ${String(result.code)}: ${redactCliDiagnostics(result.stderr || result.stdout || `exit code ${String(result.code)}`, ctx.sensitive)}`,
      { platform: ctx.platform, backend: ctx.backend },
    );
  }
}

function assertCliPayloadUsable(ctx: CliRunContext, result: CliResult): void {
  if (!cliPayloadUsable(result)) {
    throw new SocialError('upstream_error', `${ctx.commandLabel} returned an empty or error payload: ${redactCliDiagnostics(result.stderr || result.stdout, ctx.sensitive)}`, {
      platform: ctx.platform,
      backend: ctx.backend,
    });
  }
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
      const argv = resolveBiliCliArgv(request, platform, backend);
      const childEnv = biliChildEnv(env);
      const ctx: CliRunContext = { commandLabel: 'bili-cli', platform, backend, sensitive: Object.values(childEnv).filter((value) => value.length > 0), ...(signal !== undefined ? { signal } : {}) };
      const result = await spawnBackendCli(ctx, 'bili', argv, childEnv);
      if (signal?.aborted) throw abortError();
      assertCliCompleted(ctx, 'bili-cli is not installed', result);
      assertCliPayloadUsable(ctx, result);
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
      const argv = ['bilibili', 'subtitle', resolveOpenCliTarget(request, platform), '-f', 'json'];
      const childEnv = openCliChildEnv(env);
      const token = childEnv['OPENCLI_TOKEN'];
      const ctx: CliRunContext = { commandLabel: 'OpenCLI', platform, backend, sensitive: token !== undefined ? [token] : [], ...(signal !== undefined ? { signal } : {}) };
      const result = await spawnBackendCli(ctx, 'opencli', argv, childEnv);
      if (signal?.aborted) throw abortError();
      assertCliCompleted(ctx, 'opencli executable is not installed', result);
      assertCliPayloadUsable(ctx, result);
      return parseCliJson(result.stdout, backend, platform);
    },
  };
}

async function fetchFeedXml(feedUrl: string, channel: MediaChannel, backend: string, fetchCtx: FetchContext): Promise<string> {
  try {
    return await boundedFetchText(feedUrl, { 'User-Agent': USER_AGENT }, fetchCtx.signal, undefined, fetchCtx.lookup);
  } catch (err) {
    if (isAbort(err)) throw err;
    const message = err instanceof Error ? err.message : String(err);
    throw new SocialError('upstream_error', `rss feed fetch failed: ${message}`, {
      platform: mediaPlatform(channel),
      backend,
    });
  }
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
      const xml = await fetchFeedXml(feedUrl, request.channel, backend, { ...(signal !== undefined ? { signal } : {}), ...(lookup !== undefined ? { lookup } : {}) });
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


// ── Rendering + northstar envelope ──

function pushAuthorLine(lines: string[], entity: { author?: { name?: string } | undefined }): void {
  if (entity.author?.name !== undefined) lines.push(`by ${entity.author.name}`);
}

function pushPublishedLine(lines: string[], entity: { publishedAt?: string | undefined }): void {
  if (entity.publishedAt !== undefined) lines.push(`published ${entity.publishedAt}`);
}

function pushUrlLine(lines: string[], entity: { url?: string | undefined }): void {
  if (entity.url !== undefined) lines.push(entity.url);
}

function renderVideoEntity(entity: Extract<MediaEntityV1, { kind: 'video' }>): string {
  const lines: string[] = [`[video] ${entity.title ?? entity.id}`];
  pushAuthorLine(lines, entity);
  pushPublishedLine(lines, entity);
  if (entity.viewCount !== undefined) lines.push(`views ${entity.viewCount}`);
  if (entity.durationSeconds !== undefined) lines.push(`duration ${entity.durationSeconds}s`);
  if (entity.description !== undefined) lines.push(entity.description.slice(0, 500));
  pushUrlLine(lines, entity);
  return lines.join('\n');
}

function renderFeedEntryEntity(entity: Extract<MediaEntityV1, { kind: 'feed_entry' }>): string {
  const lines: string[] = [`[feed] ${entity.title ?? entity.id}`];
  pushAuthorLine(lines, entity);
  pushPublishedLine(lines, entity);
  if (entity.snippet !== undefined) lines.push(entity.snippet.slice(0, 500));
  pushUrlLine(lines, entity);
  return lines.join('\n');
}

function renderTranscriptEntity(entity: Extract<MediaEntityV1, { kind: 'video_transcript' }>): string {
  const lines: string[] = [`[transcript] ${entity.videoId} (${entity.segments.length} segments)`];
  for (const segment of entity.segments) {
    lines.push(`[${segment.start.toFixed(1)}s] ${segment.text}`);
  }
  return lines.join('\n');
}

function renderMediaEntity(entity: MediaEntityV1): string {
  if (entity.kind === 'video') return renderVideoEntity(entity);
  if (entity.kind === 'feed_entry') return renderFeedEntryEntity(entity);
  return renderTranscriptEntity(entity);
}

function renderMediaFooter(page: MediaPageV1): string {
  const footer: string[] = [];
  if (page.pagination.hasMore) footer.push('more results available (use nextCursor to continue)');
  else if (page.pagination.supported) footer.push(`${page.pagination.returned} of up to ${page.pagination.limit} results`);
  for (const warning of page.warnings) footer.push(`warning: ${warning}`);
  if (page.partial) footer.push('partial: some upstream rows were dropped or truncated');
  return footer.join('\n');
}

function joinMediaBodyAndTail(body: string, tail: string): string {
  if (body.length === 0 && tail.length === 0) return '(no results)';
  if (tail.length === 0) return body;
  return body.length === 0 ? tail : `${body}\n\n--\n${tail}`;
}

function renderMediaPage(page: MediaPageV1): string {
  const body = page.entities.map(renderMediaEntity).join('\n\n');
  return joinMediaBodyAndTail(body, renderMediaFooter(page));
}

function transcriptWatchUrl(channel: MediaChannel, videoId: string): string {
  return channel === 'youtube'
    ? `https://www.youtube.com/watch?v=${videoId}`
    : `https://www.bilibili.com/video/${videoId}`;
}

function transcriptSnippet(entity: Extract<MediaEntityV1, { kind: 'video_transcript' }>): string {
  return entity.segments
    .slice(0, 5)
    .map((segment) => segment.text)
    .join(' ')
    .slice(0, 280);
}

function transcriptToNorthstarEntity(entity: Extract<MediaEntityV1, { kind: 'video_transcript' }>, channel: MediaChannel): NorthstarEntityV1 {
  const snippet = transcriptSnippet(entity);
  return {
    entityVersion: 1,
    kind: 'video',
    id: entity.videoId,
    source: channel,
    title: `Transcript for ${entity.videoId}`,
    url: transcriptWatchUrl(channel, entity.videoId),
    ...(snippet.length > 0 ? { snippet } : {}),
  };
}

function applyVideoOrFeedDetails(base: NorthstarEntityV1, entity: Extract<MediaEntityV1, { kind: 'video' }> | Extract<MediaEntityV1, { kind: 'feed_entry' }>): void {
  const snippet = entity.kind === 'video' ? entity.description : entity.snippet;
  if (snippet !== undefined) base.snippet = snippet.slice(0, 500);
  if (entity.author?.name !== undefined) base.authors = [{ name: entity.author.name }];
  if (entity.publishedAt !== undefined) base.publishedAt = entity.publishedAt;
}

function applyVideoMetrics(base: NorthstarEntityV1, entity: Extract<MediaEntityV1, { kind: 'video' }> | Extract<MediaEntityV1, { kind: 'feed_entry' }>): void {
  if (entity.kind === 'video' && entity.viewCount !== undefined) base.metrics = { views: entity.viewCount };
}

function videoOrFeedToNorthstarEntity(entity: Extract<MediaEntityV1, { kind: 'video' }> | Extract<MediaEntityV1, { kind: 'feed_entry' }>, channel: MediaChannel): NorthstarEntityV1 {
  const base: NorthstarEntityV1 = {
    entityVersion: 1,
    kind: entity.kind,
    id: entity.id,
    source: channel,
    title: entity.title ?? `${channel} ${entity.kind}`,
    url: entity.url ?? channelHome(channel),
  };
  applyVideoOrFeedDetails(base, entity);
  applyVideoMetrics(base, entity);
  return base;
}

function toNorthstarEntity(entity: MediaEntityV1, channel: MediaChannel): NorthstarEntityV1 {
  if (entity.kind === 'video_transcript') return transcriptToNorthstarEntity(entity, channel);
  return videoOrFeedToNorthstarEntity(entity, channel);
}

interface BuildMediaResultInput {
  tool: string;
  request: MediaRequest;
  plan: MediaBackendPlan;
  page: MediaPageV1;
  warnings: string[];
}

function buildResultNotes(plan: MediaBackendPlan, page: MediaPageV1, allWarnings: string[]): string[] {
  const notes = [...allWarnings];
  if (page.partial) notes.push('partial: some upstream rows were dropped or truncated');
  if (plan.degraded) notes.push(`degraded: ${plan.backend} is a limited fallback backend`);
  return notes;
}

function buildResultEnvelope(input: BuildMediaResultInput, entities: NorthstarEntityV1[], notes: string[]): ReturnType<typeof buildNorthstarResult> {
  const { tool, request, plan, page } = input;
  return buildNorthstarResult({
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
}

function buildLegacyDetails(input: BuildMediaResultInput, allWarnings: string[]): Record<string, unknown> {
  const { request, plan, page } = input;
  return {
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
}

function buildMediaResult(input: BuildMediaResultInput): BackendCallResult {
  const { request, plan, page, warnings } = input;
  const content = renderMediaPage(page);
  const allWarnings = [...warnings, ...page.warnings];
  const entities = page.entities.map((entity) => toNorthstarEntity(entity, request.channel));
  const notes = buildResultNotes(plan, page, allWarnings);
  const envelope = buildResultEnvelope(input, entities, notes);
  return northstarTextResult(content, buildLegacyDetails(input, allWarnings), envelope);
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
      const normalized = normalizeMediaPage(request, plan, payload);
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
    return buildMediaResult({ tool, request, plan, page, warnings });
  }
  throw new SocialError('backend_unavailable', `No usable ${channel} backend for ${request.action}. ${failures.join('; ')}`, {
    platform: mediaPlatform(channel),
  });
}
