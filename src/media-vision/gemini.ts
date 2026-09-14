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

function buildSdkClient(config: GeminiConfig, apiKey: string | undefined): GoogleGenAI {
  if (config.auth.kind === 'vertex') {
    return new GoogleGenAI({
      vertexai: true,
      project: config.auth.project,
      location: config.auth.location,
    });
  }
  if (apiKey === undefined || apiKey.trim().length === 0) {
    throw new Error('gemini unconfigured: developer API key missing');
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
  const wrap = (inner: GeminiTransport): GeminiTransport => ({
    async generateContent(request: GeminiGenerateRequest): Promise<GeminiGenerateResponse> {
      try {
        return await inner.generateContent(request);
      } catch (error) {
        throw new Error(`gemini generate failed: ${redactGeminiError(error)}`);
      }
    },
    async countTokens(request: GeminiGenerateRequest): Promise<{ totalTokens?: number | undefined }> {
      try {
        return await inner.countTokens(request);
      } catch (error) {
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
