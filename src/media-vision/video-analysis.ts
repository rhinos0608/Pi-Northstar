// M8b: fetch-time YouTube video analysis orchestration.
//
// Built on runVideoPipeline (pipeline-video.ts): metadata from yt-dlp
// duration/title (bounded) only under the exact-'1' frames opt-in, transcript
// from the existing transcript path only (callReachTool('video'), no new
// transcript backend), keyframes from extractYoutubeKeyframes only when
// PI_VISION_FETCH_VIDEO_FRAMES === '1', keyframe description through the existing image describe seams selected by
// eligibility order with eligibleTiersAfterFailure on tier failure (never
// broadening). Fail-closed: opt-in absent, no eligible non-native tier, or no
// keyframe source yields evidence-only (metadata + transcript) with warnings;
// no yt-dlp/ffmpeg invocation happens without the exact-'1' opt-in.

import {
  eligibleTiersAfterFailure,
  resolveVisionEligibilityFromEnv,
  type VisionTier,
} from './eligibility.js';
import {
  extractYoutubeKeyframes,
  isVideoFramesOptIn,
  isYoutubeFetchVideoUrl,
  readYoutubeStreamInfo,
  type FrameRunner,
} from './frame-extract.js';
import { createGeminiTransport, describeImageWithGemini, resolveGeminiConfig } from './gemini.js';
import {
  createOpenAICompatibleVisionTransport,
  resolveOpenAICompatibleVisionConfig,
  type VisionFetchFn,
} from './openai-compatible.js';
import {
  runVideoPipeline,
  VIDEO_MAX_KEYFRAMES,
  type VideoKeyframe,
} from './pipeline-video.js';
import { callReachTool } from '../reach-tools.js';
import type { BackendCallResult } from '../backend.js';
import {
  isVideoSynthesisConfigured,
  synthesizeVideoEvidence,
} from './video-synthesis.js';

function resultText(result: BackendCallResult): string {
  const content = (result as { content?: Array<{ type?: string; text?: string }> }).content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((c) => c?.type === 'text' && typeof c.text === 'string')
    .map((c) => c.text as string)
    .join('\n');
}

export interface FetchVideoAnalysisSeams {
  env?: NodeJS.ProcessEnv | Record<string, string | undefined> | undefined;
  signal?: AbortSignal | undefined;
  /** Transcript text override (default: existing callReachTool video path). */
  transcript?: (() => Promise<string>) | undefined;
  /** Stream-info override (default: yt-dlp duration/title). */
  streamInfo?:
    | (() => Promise<{ durationSec?: number | undefined; title?: string | undefined }>)
    | undefined;
  /** Keyframe-source override (default: extractYoutubeKeyframes). */
  keyframes?: (() => Promise<VideoKeyframe[]>) | undefined;
  /** Keyframe describe override (default: tier-order describe below). */
  describeImage?:
    | ((frame: VideoKeyframe) => Promise<{ text: string; warnings?: string[] | undefined }>)
    | undefined;
  /** OpenAI-compatible fetch seam for the default keyframe describer. */
  openaiFetch?: VisionFetchFn | undefined;
  /** Synthesis override (default: synthesizeVideoEvidence, tier-gated). */
  synthesize?: ((evidenceText: string) => Promise<{ text: string; model: string } | undefined>) | undefined;
  runner?: FrameRunner | undefined;
}

export interface FetchVideoAnalysisResult {
  text: string;
  warnings: string[];
  keyframes: number;
  synthesized: boolean;
  degraded: boolean;
  synthesis?: { text: string; model: string } | undefined;
}

/**
 * Run fetch-time video analysis for a YouTube URL. Never throws for
 * provider/child failures: every failure degrades to evidence-only with a
 * fixed warning. Only AbortError propagates.
 */
export async function runFetchVideoAnalysis(
  url: string,
  seams: FetchVideoAnalysisSeams = {},
): Promise<FetchVideoAnalysisResult> {
  const env = seams.env ?? process.env;
  const signal = seams.signal;
  const warnings: string[] = [];
  const framesOptIn = isVideoFramesOptIn(env);
  const synthesisTier = isVideoSynthesisConfigured(env);

  const readTranscriptText = async (): Promise<string> => {
    if (seams.transcript !== undefined) {
      try {
        return await seams.transcript();
      } catch {
        warnings.push('transcript-unavailable');
        return '';
      }
    }
    try {
      const result = await callReachTool(
        'video',
        { url },
        { ...(signal !== undefined ? { signal } : {}), env: env as Record<string, string | undefined> },
      );
      return result ? resultText(result) : '';
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') throw error;
      warnings.push('transcript-unavailable');
      return '';
    }
  };

  const readStreamInfo = async (): Promise<{
    durationSec?: number | undefined;
    title?: string | undefined;
  }> => {
    // yt-dlp metadata never runs without the exact-'1' frames opt-in: with
    // the opt-in absent the analysis is transcript-only (metadata comes from
    // the transcript/media path or is absent with a warning).
    if (!framesOptIn) return {};
    if (seams.streamInfo !== undefined) {
      try {
        return await seams.streamInfo();
      } catch {
        warnings.push('video-metadata-unavailable');
        return {};
      }
    }
    try {
      return await readYoutubeStreamInfo(url, {
        env: env as Record<string, string | undefined>,
        ...(signal !== undefined ? { signal } : {}),
        ...(seams.runner !== undefined ? { runner: seams.runner } : {}),
      });
    } catch (error) {
      if (error instanceof Error && error.message === 'Aborted') throw error;
      warnings.push('video-metadata-unavailable');
      return {};
    }
  };

  // Keyframes only when the exact-'1' opt-in is present AND a non-native
  // vision tier can describe them; otherwise no child process ever spawns.
  const eligible = resolveVisionEligibilityFromEnv(env);
  const describableTiers: VisionTier[] = eligible.filter(
    (tier) => tier === 'openai-compatible' || tier === 'gemini',
  );
  const keyframesRequested = framesOptIn && isYoutubeFetchVideoUrl(url);
  if (framesOptIn && !isYoutubeFetchVideoUrl(url)) warnings.push('video-frames-non-youtube-url');
  if (!framesOptIn) warnings.push('video-frames-opt-in-absent');
  if (keyframesRequested && describableTiers.length === 0) {
    warnings.push('video-frames-no-vision-tier');
  }
  const keyframesEnabled = keyframesRequested && describableTiers.length > 0;

  const describeKeyframe = async (
    frame: VideoKeyframe,
  ): Promise<{ text: string; warnings?: string[] | undefined }> => {
    if (seams.describeImage !== undefined) return seams.describeImage(frame);
    let remaining: VisionTier[] = [...describableTiers];
    for (const tier of describableTiers) {
      if (!remaining.includes(tier)) continue;
      try {
        if (tier === 'openai-compatible') {
          const config = resolveOpenAICompatibleVisionConfig(env);
          const modelId = config?.modelIds[0];
          if (config === null || modelId === undefined) {
            remaining = eligibleTiersAfterFailure(remaining, tier);
            continue;
          }
          const transport = createOpenAICompatibleVisionTransport(config);
          const out = await transport.describe(
            { imageBytes: frame.bytes, mimeType: frame.mimeType, prompt: 'Describe this video frame factually.', modelId },
            seams.openaiFetch,
          );
          if (out.ok && typeof out.text === 'string' && out.text.trim().length > 0) {
            return { text: out.text };
          }
          remaining = eligibleTiersAfterFailure(remaining, tier);
        } else {
          const resolved = resolveGeminiConfig(env);
          if (!resolved.ok) {
            remaining = eligibleTiersAfterFailure(remaining, tier);
            continue;
          }
          const transport = createGeminiTransport(resolved.config, env);
          const out = await describeImageWithGemini(
            frame.bytes,
            frame.mimeType,
            'Describe this video frame factually.',
            resolved.config,
            { transport, env },
          );
          if (out.text.trim().length > 0) return { text: out.text, warnings: out.warnings };
          remaining = eligibleTiersAfterFailure(remaining, tier);
        }
      } catch {
        remaining = eligibleTiersAfterFailure(remaining, tier);
      }
    }
    return { text: '', warnings: ['keyframe-describe-unavailable'] };
  };

  const readKeyframesSafe = async (): Promise<VideoKeyframe[]> => {
    try {
      if (seams.keyframes !== undefined) return await seams.keyframes();
      const frames = await extractYoutubeKeyframes(url, {
        env: env as Record<string, string | undefined>,
        ...(signal !== undefined ? { signal } : {}),
        ...(seams.runner !== undefined ? { runner: seams.runner } : {}),
        count: VIDEO_MAX_KEYFRAMES,
      });
      return frames;
    } catch (error) {
      if (error instanceof Error && error.message === 'Aborted') throw error;
      warnings.push('keyframe-extract-failed');
      return [];
    }
  };

  const transcriptText = await readTranscriptText();
  const pipeline = await runVideoPipeline({
    readMetadata: readStreamInfo,
    readTranscript: async () =>
      transcriptText.trim().length > 0 ? [{ timestampMs: 0, text: transcriptText }] : [],
    ...(keyframesEnabled
      ? { readKeyframes: readKeyframesSafe, describeKeyframe }
      : {}),
  });
  for (const warning of pipeline.warnings) {
    if (!warnings.includes(warning)) warnings.push(warning);
  }
  if (!pipeline.ok) {
    return {
      text: transcriptText,
      warnings,
      keyframes: 0,
      synthesized: false,
      degraded: true,
    };
  }

  const text = pipeline.evidence.map((entry) => entry.text).join('\n\n');
  const keyframeCount = pipeline.evidence.filter((entry) => entry.kind === 'keyframe').length;

  let synthesis: { text: string; model: string } | undefined;
  let synthesized = false;
  if (synthesisTier && text.trim().length > 0) {
    try {
      synthesis =
        seams.synthesize !== undefined
          ? await seams.synthesize(text)
          : await synthesizeVideoEvidence(text, {
              env,
              ...(seams.openaiFetch !== undefined ? { openaiFetch: seams.openaiFetch } : {}),
            });
      synthesized = synthesis !== undefined;
      if (!synthesized) warnings.push('synthesis-unavailable');
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') throw error;
      warnings.push('synthesis-unavailable');
    }
  }

  const degraded =
    (keyframesRequested && keyframeCount === 0) || (!pipeline.ok && text.length > 0);
  return {
    text,
    warnings,
    keyframes: keyframeCount,
    synthesized,
    degraded,
    ...(synthesis !== undefined ? { synthesis } : {}),
  };
}
