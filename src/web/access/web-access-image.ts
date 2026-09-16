// Fetch remote-image specialist (M4): metadata via asset-acquire, optional
// operator-gated vision description. No resize/thumbnail: Atlas has no image
// codec dependency (no `sharp`); v1 reports sniff-verified metadata only.
//
// Fail-closed: sniff mismatch or ceiling breach throws inside acquireAsset;
// callers treat any throw as "not an image" and keep page-reader behavior.
// Description is double-gated: exact-'1' PI_VISION_FETCH_DESCRIBE plus an
// explicitly configured non-native vision tier; otherwise metadata only.
// Described text is returned separately (never merged into content) and is
// labeled with the vision tier that produced it.

import { acquireAsset, type AssetAcquireDeps } from '../../assets/asset-acquire.js';
import { resolveVisionEligibilityFromEnv } from '../../media-vision/eligibility.js';
import {
  createOpenAICompatibleVisionTransport,
  resolveOpenAICompatibleVisionConfig,
  type OpenAICompatibleVisionConfig,
} from '../../media-vision/openai-compatible.js';
import {
  createGeminiTransport,
  describeImageWithGemini,
  resolveGeminiConfig,
  type GeminiTransport,
} from '../../media-vision/gemini.js';
import { sniffImageMime } from '../../media-vision/pipeline-image.js';

/** Exact-'1' operator opt-in for fetch-time image description (D5). */
export const VISION_FETCH_DESCRIBE_ENV_VAR = 'PI_VISION_FETCH_DESCRIBE';

/** Fixed describe prompt: no URL, cookie, or caller text ever enters it. */
export const IMAGE_DESCRIBE_PROMPT =
  'Describe this fetched image in one short paragraph for a text-only reader. ' +
  'Name visible subjects, text, and layout; do not guess beyond what is visible.';

/** Bound on described text kept in the envelope (truncate with marker, never reject). */
export const IMAGE_DESCRIPTION_MAX_CHARS = 4000;

const IMAGE_EXTENSIONS: ReadonlySet<string> = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp']);

export interface FetchedRemoteImage {
  mime: string;
  bytes: Uint8Array;
  width?: number | undefined;
  height?: number | undefined;
  pixels?: number | undefined;
}

export interface ImageDescribeSeams {
  /** Test seam: replaces the OpenAI-compatible transport describe call. */
  describeWithOpenAI?:
    | ((input: { bytes: Uint8Array; mime: string; modelId: string }) => Promise<string | undefined>)
    | undefined;
  /** Test seam: replaces the Gemini transport (describe still runs unless describeWithGemini is set). */
  geminiTransport?: GeminiTransport | undefined;
  /** Test seam: replaces the Gemini describe call. */
  describeWithGemini?:
    | ((input: { bytes: Uint8Array; mime: string }) => Promise<string | undefined>)
    | undefined;
}

/** Extension gate for the fetch-site image sniff (magic bytes verify inside acquireAsset). */
export function isImageUrl(url: string): boolean {
  let path = '';
  try {
    path = new URL(url).pathname.toLowerCase();
  } catch {
    return false;
  }
  const dot = path.lastIndexOf('.');
  if (dot < 0) return false;
  return IMAGE_EXTENSIONS.has(path.slice(dot));
}

/**
 * Fetch one remote image under Plan B ceilings (never truncate: over-budget
 * bytes reject). Sniff-first: magic bytes must agree with the image kind or
 * acquireAsset throws and the caller keeps page-reader behavior.
 */
export async function fetchRemoteImage(rawUrl: string, deps: AssetAcquireDeps = {}): Promise<FetchedRemoteImage> {
  const acquired = await acquireAsset(rawUrl, 'image', deps);
  const sniffed = sniffImageMime(acquired.bytes);
  const image: FetchedRemoteImage = { mime: sniffed ?? acquired.mime, bytes: acquired.bytes };
  if (acquired.width !== undefined && acquired.height !== undefined) {
    image.width = acquired.width;
    image.height = acquired.height;
    image.pixels = acquired.width * acquired.height;
  }
  return image;
}

function boundDescription(text: string): string {
  if (text.length <= IMAGE_DESCRIPTION_MAX_CHARS) return text;
  return `${text.slice(0, IMAGE_DESCRIPTION_MAX_CHARS)} [image description truncated]`;
}

async function describeViaOpenAI(
  config: OpenAICompatibleVisionConfig,
  modelId: string,
  bytes: Uint8Array,
  mime: string,
): Promise<string | undefined> {
  const transport = createOpenAICompatibleVisionTransport(config);
  const out = await transport.describe({ imageBytes: bytes, mimeType: mime, prompt: IMAGE_DESCRIBE_PROMPT, modelId });
  return out.ok && typeof out.text === 'string' ? out.text : undefined;
}

/**
 * Describe a fetched image through the first configured vision tier in route
 * order (openai-compatible, then gemini). `native` and `gemini-web` have no
 * fetch describe seam and are skipped. Returns undefined when the exact-'1'
 * opt-in is absent, no tier is configured, bytes fail the sniff check, or
 * every tier fails — callers fall back to metadata only.
 */
export async function describeFetchedImage(
  bytes: Uint8Array,
  mime: string,
  env: Record<string, string | undefined> = process.env,
  seams: ImageDescribeSeams = {},
): Promise<{ tier: string; text: string } | undefined> {
  if (env[VISION_FETCH_DESCRIBE_ENV_VAR] !== '1') return undefined;
  if (!(bytes instanceof Uint8Array) || bytes.byteLength === 0) return undefined;
  const sniffed = sniffImageMime(bytes);
  if (sniffed === undefined || sniffed !== mime) return undefined;
  const tiers = resolveVisionEligibilityFromEnv(env);
  if (tiers.includes('openai-compatible')) {
    const config = resolveOpenAICompatibleVisionConfig(env);
    const modelId = config?.modelIds[0];
    if (config !== null && modelId !== undefined) {
      try {
        const text =
          seams.describeWithOpenAI !== undefined
            ? await seams.describeWithOpenAI({ bytes, mime, modelId })
            : await describeViaOpenAI(config, modelId, bytes, mime);
        if (text !== undefined && text.trim().length > 0) return { tier: 'openai-compatible', text: boundDescription(text.trim()) };
      } catch {
        // Fall through to the next tier; metadata-only when all tiers fail.
      }
    }
  }
  if (tiers.includes('gemini')) {
    const resolved = resolveGeminiConfig(env);
    if (resolved.ok) {
      try {
        const text =
          seams.describeWithGemini !== undefined
            ? await seams.describeWithGemini({ bytes, mime })
            : (
                await describeImageWithGemini(bytes, mime, IMAGE_DESCRIBE_PROMPT, resolved.config, {
                  transport: seams.geminiTransport ?? createGeminiTransport(resolved.config, env),
                  env,
                })
              ).text;
        if (text !== undefined && text.trim().length > 0) return { tier: 'gemini', text: boundDescription(text.trim()) };
      } catch {
        // Fail closed to metadata only.
      }
    }
  }
  return undefined;
}
