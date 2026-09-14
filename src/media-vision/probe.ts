// Plan D task D2: synthetic vision capability probe.
//
// Runs BEFORE any user content reaches a model: sends one tiny synthetic
// image with a closed-vocabulary prompt ("which shape...") and accepts the
// model only when it returns a non-empty description without a non-vision
// refusal. Rejects text-only / non-vision models fail-closed. Transport is
// injected, so tests never touch the network.

import type {
  OpenAICompatibleVisionTransport,
  VisionDescribeRequest,
} from './openai-compatible.js';

/** Minimal transport surface the probe needs (subset of the real transport). */
export interface VisionProbeTransport {
  describe: (
    request: VisionDescribeRequest,
    fetchFn?: never,
  ) => Promise<{ ok: boolean; text?: string; error?: string }>;
}

export type AnyVisionProbeTransport =
  | VisionProbeTransport
  | Pick<OpenAICompatibleVisionTransport, 'describe'>;

/** Closed-vocabulary probe prompt: only a vision model can answer. */
export const VISION_PROBE_PROMPT =
  'This is a vision capability check. Name the single solid shape in this image ' +
  'and its color in under 20 words. If you cannot see images, say so plainly.';

/** Phrases proving the model has no vision path (fail-closed rejection). */
export const VISION_PROBE_REFUSAL_PATTERNS: readonly RegExp[] = [
  /cannot (see|view|process|access) (images?|pictures?|visual)/i,
  /don't have (vision|image|visual) (capabilit|access)/i,
  /do not have (vision|image|visual) (capabilit|access)/i,
  /text-only/i,
  /unable to (see|view|process) (images?|visual)/i,
  /as an? (text|language)[ -]only model/i,
];

/** 1x1 red PNG (67 bytes): synthetic probe pixels, no user content. */
const SYNTHETIC_PROBE_PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

export interface SyntheticProbeImage {
  bytes: Uint8Array;
  mimeType: string;
}

/** Builds the tiny synthetic probe image (no network, no user content). */
export function buildSyntheticProbeImage(): SyntheticProbeImage {
  return {
    bytes: new Uint8Array(Buffer.from(SYNTHETIC_PROBE_PNG_BASE64, 'base64')),
    mimeType: 'image/png',
  };
}

export interface VisionProbeOptions {
  modelId: string;
  timeoutMs?: number;
}

export interface VisionProbeResult {
  ok: boolean;
  modelId: string;
  text?: string;
  reason?: string;
}

/** True when model text is a non-vision refusal rather than a description. */
export function isVisionRefusal(text: string): boolean {
  return VISION_PROBE_REFUSAL_PATTERNS.some((pattern) => pattern.test(text));
}

/**
 * Probes one exact model ID with the synthetic image. Must pass before user
 * content is sent to that model. Any transport failure, empty response, or
 * refusal text rejects the model fail-closed (`ok: false` + `reason`).
 */
export async function runVisionProbe(
  transport: AnyVisionProbeTransport,
  options: VisionProbeOptions,
): Promise<VisionProbeResult> {
  const { bytes, mimeType } = buildSyntheticProbeImage();
  let outcome: { ok: boolean; text?: string; error?: string };
  try {
    outcome = await transport.describe({
      imageBytes: bytes,
      mimeType,
      prompt: VISION_PROBE_PROMPT,
      modelId: options.modelId,
      ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
    });
  } catch {
    return { ok: false, modelId: options.modelId, reason: 'transport_error' };
  }
  if (!outcome.ok) {
    return {
      ok: false,
      modelId: options.modelId,
      reason: outcome.error ?? 'probe_failed',
    };
  }
  const text = outcome.text ?? '';
  if (text.trim().length === 0) {
    return { ok: false, modelId: options.modelId, reason: 'empty_vision_response' };
  }
  if (isVisionRefusal(text)) {
    return { ok: false, modelId: options.modelId, reason: 'non_vision_model' };
  }
  return { ok: true, modelId: options.modelId, text };
}

/**
 * Probes several exact model IDs in order, returning per-model results.
 * Stops at the first passing model when `stopAtFirstPass` is set.
 */
export async function probeVisionModels(
  transport: AnyVisionProbeTransport,
  modelIds: readonly string[],
  options?: { timeoutMs?: number; stopAtFirstPass?: boolean },
): Promise<VisionProbeResult[]> {
  const results: VisionProbeResult[] = [];
  for (const modelId of modelIds) {
    const result = await runVisionProbe(transport, {
      modelId,
      ...(options?.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
    });
    results.push(result);
    if (result.ok && options?.stopAtFirstPass) break;
  }
  return results;
}
