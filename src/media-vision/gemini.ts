// Gemini Developer / Vertex transport via the official @google/genai SDK (Plan D Task D3).
//
// Developer API key or Vertex ADC/project/location. Models are exact
// operator-configured IDs passed verbatim (no alias resolution). Unconfigured
// or disabled state performs zero network calls: resolve first, construct
// the transport only on ok. Secrets never appear in errors or results, and
// provider/model identity is never embedded in returned text.

import { GoogleGenAI } from '@google/genai';
import {
  GEMINI_API_KEY_ENV_VARS,
  GEMINI_ENABLED_ENV_VAR,
  VERTEX_PROJECT_ENV_VARS,
} from './eligibility.js';
import { sniffImageMime } from './pipeline-image.js';

export { GEMINI_ENABLED_ENV_VAR };

/** Env holding the exact vision model ID (passed verbatim, never aliased). */
export const GEMINI_VISION_MODEL_ENV_VAR = 'PI_VISION_GEMINI_MODEL';

/** Default model ID used only when the operator configures no exact model. */
export const GEMINI_DEFAULT_VISION_MODEL = 'gemini-2.0-flash';

/** Byte ceiling for a single inline vision payload (operator-lower-only). */
export const GEMINI_MAX_INLINE_BYTES = 20 * 1024 * 1024;

export interface GeminiDeveloperAuth {
  kind: 'developer';
}

export interface GeminiVertexAuth {
  kind: 'vertex';
  project: string;
  location: string;
}

export type GeminiAuth = GeminiDeveloperAuth | GeminiVertexAuth;

export interface GeminiConfig {
  /** Exact model ID from operator config (verbatim). */
  model: string;
  auth: GeminiAuth;
}

export type GeminiConfigResult =
  | { ok: true; config: GeminiConfig }
  | { ok: false; reason: string };

// Credential key list is sibling W-D1's source of truth (plan-specified import).
function readApiKey(env: NodeJS.ProcessEnv | Record<string, string | undefined>): string | undefined {
  for (const key of GEMINI_API_KEY_ENV_VARS) {
    const raw = env[key];
    if (typeof raw === 'string' && raw.trim().length > 0) return raw.trim();
  }
  return undefined;
}

/**
 * Resolve Gemini config from operator env. Returns ok:false (never throws)
 * when disabled or unconfigured so callers degrade without network calls.
 * Auth/policy failure never implies another tier: no fallback is attempted.
 */
function resolveModel(env: NodeJS.ProcessEnv | Record<string, string | undefined>): string {
  const raw = env[GEMINI_VISION_MODEL_ENV_VAR];
  return typeof raw === 'string' && raw.trim().length > 0 ? raw.trim() : GEMINI_DEFAULT_VISION_MODEL;
}

function resolveVertexConfig(
  env: NodeJS.ProcessEnv | Record<string, string | undefined>,
  model: string,
): GeminiConfigResult {
  let project = '';
  for (const key of VERTEX_PROJECT_ENV_VARS) {
    const raw = env[key];
    if (typeof raw === 'string' && raw.trim().length > 0) {
      project = raw.trim();
      break;
    }
  }
  const location = typeof env.GOOGLE_CLOUD_LOCATION === 'string' ? env.GOOGLE_CLOUD_LOCATION.trim() : '';
  if (project.length === 0 || location.length === 0) {
    return { ok: false, reason: 'vertex-misconfigured' };
  }
  return { ok: true, config: { model, auth: { kind: 'vertex', project, location } } };
}

export function resolveGeminiConfig(
  env: NodeJS.ProcessEnv | Record<string, string | undefined> = process.env,
): GeminiConfigResult {
  if (env[GEMINI_ENABLED_ENV_VAR] !== '1') return { ok: false, reason: 'disabled' };
  const model = resolveModel(env);
  if (env.GOOGLE_GENAI_USE_VERTEXAI === '1') return resolveVertexConfig(env, model);
  if (readApiKey(env) === undefined) return { ok: false, reason: 'unconfigured' };
  return { ok: true, config: { model, auth: { kind: 'developer' } } };
}

export interface GeminiGenerateRequest {
  prompt: string;
  inlineData?: { mimeType: string; base64: string } | undefined;
}

export interface GeminiGenerateResponse {
  text: string;
  usageTokens?: number | undefined;
}

export interface GeminiTransport {
  generateContent(request: GeminiGenerateRequest): Promise<GeminiGenerateResponse>;
  countTokens(request: GeminiGenerateRequest): Promise<{ totalTokens?: number | undefined }>;
}

export interface GeminiTransportSeams {
  /** SDK import seam; tests inject a mock client factory instead. */
  createClient?: ((config: GeminiConfig) => { generate: GeminiTransport }) | undefined;
}

/** Machine-readable code marking a local Gemini misconfiguration (not a provider failure). */
export const GEMINI_UNCONFIGURED_CODE = 'gemini-unconfigured';

/**
 * Local configuration failure: Gemini route disabled or credential missing.
 * Thrown unwrapped (never prefixed with `gemini generate failed:`) so
 * callers can distinguish it from retryable provider errors via
 * `isGeminiUnconfiguredError` without string-matching message text.
 */
export class GeminiUnconfiguredError extends Error {
  readonly code = GEMINI_UNCONFIGURED_CODE;
  constructor(message: string) {
    super(message);
    this.name = 'GeminiUnconfiguredError';
  }
}

/** True for local Gemini misconfiguration; false for provider failures. */
export function isGeminiUnconfiguredError(error: unknown): boolean {
  if (error instanceof GeminiUnconfiguredError) return true;
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { code?: unknown }).code === GEMINI_UNCONFIGURED_CODE
  );
}

function buildSdkClient(config: GeminiConfig, apiKey: string | undefined): GoogleGenAI {
  if (config.auth.kind === 'vertex') {
    return new GoogleGenAI({
      vertexai: true,
      project: config.auth.project,
      location: config.auth.location,
    });
  }
  if (apiKey === undefined || apiKey.trim().length === 0) {
    throw new GeminiUnconfiguredError('gemini unconfigured: developer API key missing');
  }
  return new GoogleGenAI({ apiKey });
}

/**
 * Create a lazily-connected transport. The SDK client is constructed on the
 * first call (never at resolve time), so an idle transport makes no calls.
 */
export function createGeminiTransport(
  config: GeminiConfig,
  env: NodeJS.ProcessEnv | Record<string, string | undefined> = process.env,
  seams: GeminiTransportSeams = {},
): GeminiTransport {
  // Local misconfiguration fails fast here (before any SDK construction)
  // so a disabled route never reaches the network, even lazily.
  if (env[GEMINI_ENABLED_ENV_VAR] !== '1') {
    throw new GeminiUnconfiguredError(
      `gemini disabled: set ${GEMINI_ENABLED_ENV_VAR}=1 to enable this route`,
    );
  }
  const wrap = (inner: GeminiTransport): GeminiTransport => ({
    async generateContent(request: GeminiGenerateRequest): Promise<GeminiGenerateResponse> {
      try {
        return await inner.generateContent(request);
      } catch (error) {
        if (isGeminiUnconfiguredError(error)) throw error;
        throw new Error(`gemini generate failed: ${redactGeminiError(error)}`);
      }
    },
    async countTokens(request: GeminiGenerateRequest): Promise<{ totalTokens?: number | undefined }> {
      try {
        return await inner.countTokens(request);
      } catch (error) {
        if (isGeminiUnconfiguredError(error)) throw error;
        throw new Error(`gemini count failed: ${redactGeminiError(error)}`);
      }
    },
  });
  if (seams.createClient !== undefined) return wrap(seams.createClient(config).generate);
  let client: GoogleGenAI | undefined;
  const apiKey = readApiKey(env);
  const getClient = (): GoogleGenAI => {
    if (client === undefined) client = buildSdkClient(config, apiKey);
    return client;
  };
  const toContents = (request: GeminiGenerateRequest): unknown => {
    const parts: unknown[] = [{ text: request.prompt }];
    if (request.inlineData !== undefined) {
      parts.unshift({
        inlineData: {
          mimeType: request.inlineData.mimeType,
          data: request.inlineData.base64,
        },
      });
    }
    return parts;
  };
  return {
    async generateContent(request: GeminiGenerateRequest): Promise<GeminiGenerateResponse> {
      try {
        const response = await getClient().models.generateContent({
          model: config.model,
          contents: toContents(request) as never,
        });
        const text = typeof response.text === 'string' ? response.text : '';
        const usageTokens = response.usageMetadata?.totalTokenCount ?? undefined;
        return usageTokens === undefined ? { text } : { text, usageTokens };
      } catch (error) {
        if (isGeminiUnconfiguredError(error)) throw error;
        throw new Error(`gemini generate failed: ${redactGeminiError(error)}`);
      }
    },
    async countTokens(request: GeminiGenerateRequest): Promise<{ totalTokens?: number | undefined }> {
      try {
        const response = await getClient().models.countTokens({
          model: config.model,
          contents: toContents(request) as never,
        });
        return response.totalTokens === undefined || response.totalTokens === null
          ? {}
          : { totalTokens: response.totalTokens };
      } catch (error) {
        if (isGeminiUnconfiguredError(error)) throw error;
        throw new Error(`gemini count failed: ${redactGeminiError(error)}`);
      }
    },
  };
}

/** Strip any credential-shaped material from SDK errors before surfacing. */
function redactGeminiError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message
    .replace(/[A-Za-z0-9_\-]{20,}/g, '[redacted]')
    .slice(0, 500);
}

export interface GeminiDescribeResult {
  text: string;
  usageTokens?: number | undefined;
  warnings: string[];
}

/**
 * Describe/OCR one image through Gemini. Rejects oversize payloads before
 * any call; returns empty-text results verbatim (never fabricates content).
 */
export interface DescribeImageOptions {
  transport?: GeminiTransport | undefined;
  env?: NodeJS.ProcessEnv | Record<string, string | undefined> | undefined;
}

export async function describeImageWithGemini(
  imageBytes: Uint8Array,
  mimeType: string,
  prompt: string,
  config: GeminiConfig,
  options: DescribeImageOptions = {},
): Promise<GeminiDescribeResult> {
  const warnings: string[] = [];
  if (imageBytes.byteLength === 0) {
    return { text: '', warnings: ['empty-image-bytes'] };
  }
  if (imageBytes.byteLength > GEMINI_MAX_INLINE_BYTES) {
    return { text: '', warnings: ['image-over-byte-ceiling'] };
  }
  // Never trust caller MIME verbatim: sniff first, reject disagreements with
  // the same unknown-image-type failure the image pipeline uses.
  const sniffed = sniffImageMime(imageBytes);
  if (sniffed === undefined || sniffed !== mimeType) {
    return { text: '', warnings: ['unknown-image-type'] };
  }
  const active = options.transport ?? createGeminiTransport(config, options.env ?? process.env);
  const response = await active.generateContent({
    prompt,
    inlineData: { mimeType, base64: Buffer.from(imageBytes).toString('base64') },
  });
  if (response.text.trim().length === 0) warnings.push('empty-model-response');
  return response.usageTokens === undefined
    ? { text: response.text, warnings }
    : { text: response.text, usageTokens: response.usageTokens, warnings };
}

// Full-file video query via Gemini Files API. Operator video bytes leave the
// box ONLY behind the exact-'1' PI_VISION_VIDEO_GEMINI flag (default off =
// zero network calls). The Developer API key comes from the existing key
// resolution and travels to Google endpoints only. Vertex/ADC has no REST
// bearer path here and fails closed (never falls to another credential).
// Uploaded files are DELETE-cleaned in a finally block. Size ceiling mirrors
// the local-file gate (50MiB).

/** Single exact flag gating BOTH the Files API upload and the Web fallback. */
export const GEMINI_VIDEO_ENABLED_ENV_VAR = 'PI_VISION_VIDEO_GEMINI';

/** Full-file video byte ceiling: mirrors the local-file size gate (50MiB). */
export const GEMINI_VIDEO_MAX_BYTES = 50 * 1024 * 1024;

/** Files API poll budget: 120s deadline, 5s interval. */
export const GEMINI_FILES_POLL_TIMEOUT_MS = 120_000;
export const GEMINI_FILES_POLL_INTERVAL_MS = 5_000;

/** True only on the exact opt-in value "1"; absent/any other value is off. */
export function isGeminiVideoEnabled(
  env: NodeJS.ProcessEnv | Record<string, string | undefined> = process.env,
): boolean {
  return env[GEMINI_VIDEO_ENABLED_ENV_VAR] === '1';
}

const VIDEO_MIME_BY_EXTENSION: Record<string, string> = {
  '.mp4': 'video/mp4',
  '.mov': 'video/quicktime',
  '.webm': 'video/webm',
  '.avi': 'video/x-msvideo',
  '.mpeg': 'video/mpeg',
  '.mpg': 'video/mpeg',
  '.wmv': 'video/x-ms-wmv',
  '.flv': 'video/x-flv',
  '.3gp': 'video/3gpp',
  '.3gpp': 'video/3gpp',
};

/** MIME type for a local video path by extension; undefined when unknown. */
export function mimeForVideoPath(path: string): string | undefined {
  const lower = path.toLowerCase();
  const base = lower.split('/').pop() ?? lower;
  const dot = base.lastIndexOf('.');
  if (dot === -1) return undefined;
  return VIDEO_MIME_BY_EXTENSION[base.slice(dot)];
}

export type GeminiVideoFailureReason =
  | 'disabled'
  | 'unconfigured'
  | 'vertex-unsupported'
  | 'video-file-too-large'
  | 'upload-failed'
  | 'poll-timeout'
  | 'query-failed';

export type GeminiVideoResult =
  | { ok: true; text: string; warnings: string[] }
  | { ok: false; reason: GeminiVideoFailureReason; warnings: string[] };

export interface GeminiVideoSeams {
  env?: NodeJS.ProcessEnv | Record<string, string | undefined> | undefined;
  signal?: AbortSignal | undefined;
  /** Fetch seam; tests inject a mock. Defaults to global fetch. */
  fetchImpl?: typeof fetch | undefined;
  /** Poll sleep seam (default: 5s setTimeout). */
  sleep?: ((ms: number) => Promise<void>) | undefined;
}

function throwIfVideoAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted === true) throw new Error('Aborted');
}

const defaultVideoSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => { setTimeout(resolve, ms); });

async function videoPollSleep(
  ms: number,
  sleep: (ms: number) => Promise<void>,
  signal: AbortSignal | undefined,
): Promise<void> {
  throwIfVideoAborted(signal);
  if (signal === undefined) {
    await sleep(ms);
    return;
  }
  await new Promise<void>((resolve, reject) => {
    let settled = false;
    const finish = (error?: Error): void => {
      if (settled) return;
      settled = true;
      signal.removeEventListener('abort', onAbort);
      if (error !== undefined) reject(error);
      else resolve();
    };
    const onAbort = (): void => finish(new Error('Aborted'));
    signal.addEventListener('abort', onAbort, { once: true });
    void sleep(ms).then(() => finish(), (error: unknown) =>
      finish(error instanceof Error ? error : new Error('video poll sleep failed')));
  });
  throwIfVideoAborted(signal);
}

function trustedGeminiUploadSessionUrl(raw: string): string | undefined {
  try {
    const parsed = new URL(raw);
    if (
      parsed.protocol !== 'https:'
      || parsed.username !== ''
      || parsed.password !== ''
      || parsed.hostname !== 'generativelanguage.googleapis.com'
    ) {
      return undefined;
    }
    return parsed.href;
  } catch {
    return undefined;
  }
}

function trustedGeminiFileName(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined;
  return /^files\/[A-Za-z0-9._~-]+$/.test(raw) ? raw : undefined;
}

/**
 * Upload full video bytes through the Files resumable protocol, poll to
 * ACTIVE, query with prompt + file URI, DELETE the hosted file in finally.
 * Zero network calls when the flag is off, unconfigured, or Vertex-authed.
 * Never throws for provider failures (only abort propagates).
 */
export async function queryVideoWithGeminiFiles(
  fileBytes: Uint8Array,
  filePath: string,
  prompt: string,
  config: GeminiConfig,
  options: GeminiVideoSeams = {},
): Promise<GeminiVideoResult> {
  const env = options.env ?? process.env;
  const signal = options.signal;
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const sleep = options.sleep ?? defaultVideoSleep;
  if (!isGeminiVideoEnabled(env)) return { ok: false, reason: 'disabled', warnings: [] };
  if (config.auth.kind !== 'developer') {
    return { ok: false, reason: 'vertex-unsupported', warnings: ['gemini-video-vertex-unsupported'] };
  }
  const apiKey = readApiKey(env);
  if (apiKey === undefined) return { ok: false, reason: 'unconfigured', warnings: [] };
  if (fileBytes.byteLength === 0 || fileBytes.byteLength > GEMINI_VIDEO_MAX_BYTES) {
    return { ok: false, reason: 'video-file-too-large', warnings: ['video-file-too-large'] };
  }
  const mimeType = mimeForVideoPath(filePath) ?? 'video/mp4';
  const basename = filePath.split('/').pop() ?? filePath;
  const authHeaders = { 'x-goog-api-key': apiKey };
  let fileName: string | undefined;
  try {
    throwIfVideoAborted(signal);
    const startResponse = await fetchImpl(
      'https://generativelanguage.googleapis.com/upload/v1beta/files',
      {
        method: 'POST',
        headers: {
          ...authHeaders,
          'X-Goog-Upload-Protocol': 'resumable',
          'X-Goog-Upload-Command': 'start',
          'X-Goog-Upload-Header-Content-Length': String(fileBytes.byteLength),
          'X-Goog-Upload-Header-Content-Type': mimeType,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ file: { displayName: basename.slice(0, 128) } }),
        ...(signal !== undefined ? { signal } : {}),
      },
    );
    const sessionHeader = startResponse.headers?.get('x-goog-upload-url') ?? null;
    const sessionUrl = sessionHeader === null
      ? undefined
      : trustedGeminiUploadSessionUrl(sessionHeader);
    if (!startResponse.ok || sessionUrl === undefined) {
      return { ok: false, reason: 'upload-failed', warnings: ['gemini-video-upload-failed'] };
    }
    throwIfVideoAborted(signal);
    const uploadResponse = await fetchImpl(sessionUrl, {
      method: 'POST',
      headers: {
        ...authHeaders,
        'Content-Length': String(fileBytes.byteLength),
        'X-Goog-Upload-Offset': '0',
        'X-Goog-Upload-Command': 'upload, finalize',
      },
      body: fileBytes as BodyInit,
      ...(signal !== undefined ? { signal } : {}),
    });
    const uploaded = (await uploadResponse.json().catch(() => null)) as
      | { file?: { name?: string; uri?: string } }
      | null;
    fileName = trustedGeminiFileName(uploaded?.file?.name);
    const fileUri = uploaded?.file?.uri;
    if (!uploadResponse.ok || fileName === undefined || typeof fileUri !== 'string' || fileUri.length === 0) {
      return { ok: false, reason: 'upload-failed', warnings: ['gemini-video-upload-failed'] };
    }
    const deadline = Date.now() + GEMINI_FILES_POLL_TIMEOUT_MS;
    for (;;) {
      throwIfVideoAborted(signal);
      const statusResponse = await fetchImpl(
        'https://generativelanguage.googleapis.com/v1beta/' + fileName,
        {
          method: 'GET',
          headers: { ...authHeaders },
          ...(signal !== undefined ? { signal } : {}),
        },
      );
      const status = (await statusResponse.json().catch(() => null)) as
        | { state?: string }
        | null;
      if (!statusResponse.ok) {
        return { ok: false, reason: 'upload-failed', warnings: ['gemini-video-status-failed'] };
      }
      if (status?.state === 'ACTIVE') break;
      if (status?.state === 'FAILED') {
        return { ok: false, reason: 'upload-failed', warnings: ['gemini-video-processing-failed'] };
      }
      if (Date.now() >= deadline) {
        return { ok: false, reason: 'poll-timeout', warnings: ['gemini-video-poll-timeout'] };
      }
      await videoPollSleep(GEMINI_FILES_POLL_INTERVAL_MS, sleep, signal);
    }
    throwIfVideoAborted(signal);
    const queryResponse = await fetchImpl(
      'https://generativelanguage.googleapis.com/v1beta/models/' + config.model + ':generateContent',
      {
        method: 'POST',
        headers: { ...authHeaders, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [
            { parts: [{ text: prompt.slice(0, 8000) }, { fileData: { mimeType, fileUri } }] },
          ],
        }),
        ...(signal !== undefined ? { signal } : {}),
      },
    );
    const queried = (await queryResponse.json().catch(() => null)) as
      | { candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }> }
      | null;
    const text = (queried?.candidates?.[0]?.content?.parts ?? [])
      .map((part) => (typeof part.text === 'string' ? part.text : ''))
      .join('')
      .trim();
    if (!queryResponse.ok || text.length === 0) {
      return { ok: false, reason: 'query-failed', warnings: ['gemini-video-query-failed'] };
    }
    return { ok: true, text, warnings: ['video-gemini-files'] };
  } catch (error) {
    if (error instanceof Error && (error.message === 'Aborted' || error.name === 'AbortError')) throw error;
    return { ok: false, reason: 'query-failed', warnings: ['gemini-video-unavailable'] };
  } finally {
    if (fileName !== undefined) {
      try {
        await fetchImpl(
          'https://generativelanguage.googleapis.com/v1beta/' + fileName,
          { method: 'DELETE', headers: { ...authHeaders } },
        );
      } catch {
        // Hosted-file orphan is provider-side; local result already decided.
      }
    }
  }
}
