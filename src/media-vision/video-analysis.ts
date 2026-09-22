// M8b: fetch-time YouTube video analysis orchestration.
//
// Built on runVideoPipeline (pipeline-video.ts): metadata from yt-dlp
// duration/title (bounded) only under the exact-'1' frames opt-in, transcript
// from the existing transcript path only (callReachTool('media'), no new
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
import { readFile } from 'node:fs/promises';
import { createGeminiTransport, describeImageWithGemini, isGeminiVideoEnabled, queryVideoWithGeminiFiles, resolveGeminiConfig } from './gemini.js';
import { askGeminiWebVideo, GeminiWebLeaseUnavailableError } from './gemini-web.js';
import type { GeminiVideoResult } from './gemini.js';
import type { GeminiWebLease, GeminiWebResult } from './gemini-web.js';
import {
  admitLocalVideoFile,
  extractLocalVideoFrames,
  isLocalVideoFile,
  parseLocalFrameCount,
  readLocalVideoDurationSec,
} from './video-local.js';
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

function isVideoAbort(error: unknown, signal?: AbortSignal): boolean {
  if (signal?.aborted === true) return true;
  return error instanceof Error && (error.name === 'AbortError' || error.message === 'Aborted');
}

/**
 * Build live Chrome owners for the Gemini Web leased-tab fallback.
 *
 * Adapts the canonical user-Chrome controller (profile adapter auth lock +
 * bound target + execute, allowed ops only) plus the pinned bridge owner
 * check. Owners are resolved live at the fallback point; no credentials are
 * read or stored here. Throws fail-closed (lease-unavailable or bridge
 * owner error) when no live owners exist; exact-origin confinement stays in
 * the lease module.
 */
async function acquireLiveChromeGeminiWebLease(
  env: NodeJS.ProcessEnv | Record<string, string | undefined>,
  signal?: AbortSignal | undefined,
): Promise<GeminiWebLease> {
  const { getUserChromeController } = await import('../browser/browser-tools.js');
  const { acquireGeminiWebLeaseFromChromeOwners } = await import('./gemini-web.js');
  const controller = getUserChromeController(env as Record<string, string | undefined>);
  let requireBridgeOwner: () => void;
  try {
    const { ensureChromeBridgeServer } = await import('../index.js');
    const server = await ensureChromeBridgeServer(env as Record<string, string | undefined>);
    requireBridgeOwner = () => server.requireOwner();
  } catch (error) {
    if (error instanceof GeminiWebLeaseUnavailableError) throw error;
    throw new GeminiWebLeaseUnavailableError(
      'gemini-web-lease-unavailable: Chrome bridge owner unavailable (' +
      (error instanceof Error ? error.message.slice(0, 120) : 'unknown') +
      '); trying isolated Reach session fallback',
    );
  }
  const owners = {
    isAuthorized: () => controller.auth.canExecute(),
    boundTarget: () => controller.adapter.boundTarget(),
    requireBridgeOwner,
    execute: (args: Record<string, unknown>) =>
      controller.adapter.execute(args, signal !== undefined ? { signal } : undefined) as Promise<{
        content?: unknown;
      }>,
  };
  return acquireGeminiWebLeaseFromChromeOwners(env, owners);
}

async function askGeminiWebVideoWithSessionFallback(
  filePath: string,
  prompt: string,
  env: NodeJS.ProcessEnv | Record<string, string | undefined>,
  signal?: AbortSignal | undefined,
): Promise<GeminiWebResult> {
  let liveFallbackWarning = 'gemini-web-live-lease-unavailable';
  try {
    return await askGeminiWebVideo(
      filePath,
      prompt,
      { acquireLease: () => acquireLiveChromeGeminiWebLease(env, signal) },
      env,
    );
  } catch (error) {
    if (isVideoAbort(error, signal)) throw error;
    const { isGeminiWebLeaseUnavailableError } = await import('./gemini-web.js');
    if (!isGeminiWebLeaseUnavailableError(error)) throw error;
    if (error instanceof Error && error.message.includes('no file-attachment primitive')) {
      liveFallbackWarning = 'gemini-web-live-lease-no-file-upload';
    }
  }

  try {
    const { acquireGeminiWebCookieLease } = await import('./gemini-web-cookie.js');
    const out = await askGeminiWebVideo(
      filePath,
      prompt,
      {
        acquireLease: () =>
          acquireGeminiWebCookieLease(
            env as Record<string, string | undefined>,
            signal !== undefined ? { signal } : {},
          ),
      },
      env,
    );
    return {
      ...out,
      warnings: [liveFallbackWarning, ...out.warnings],
    };
  } catch (error) {
    if (isVideoAbort(error, signal)) throw error;
    const { isGeminiWebLeaseUnavailableError } = await import('./gemini-web.js');
    if (!isGeminiWebLeaseUnavailableError(error)) throw error;
    return {
      ok: false,
      reason: 'lease-unavailable',
      warnings: ['gemini-web-video-unavailable', 'gemini-web-cookie-unavailable'],
    };
  }
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
  /** Local-file interrogation: `secs | MM:SS | H:MM:SS`, optionally `start-end`. */
  timestamp?: string | undefined;
  /** Local-file interrogation frame count (reject-not-clamp integer in [1, 12]). */
  frames?: number | undefined;
  /** Full-file Gemini video override (default: Files API when configured). */
  geminiVideo?: ((prompt: string) => Promise<GeminiVideoResult>) | undefined;
  /**
   * Full-file Gemini Web video fallback override. The path is supplied so a
   * test/custom seam cannot claim video analysis without receiving the file.
   */
  geminiWebVideo?: ((filePath: string, prompt: string) => Promise<GeminiWebResult>) | undefined;
  /** Chrome lease acquisition for the default Web fallback (leases owned by Chrome owners). */
  acquireGeminiWebLease?: (() => Promise<GeminiWebLease>) | undefined;
  /** Fetch seam for the default Files API upload. */
  geminiVideoFetch?: typeof fetch | undefined;
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
      } catch (error) {
        if (isVideoAbort(error, signal)) throw error;
        warnings.push('transcript-unavailable');
        return '';
      }
    }
    try {
      const result = await callReachTool(
        'media',
        { url },
        { ...(signal !== undefined ? { signal } : {}), env: env as Record<string, string | undefined> },
      );
      return result ? resultText(result) : '';
    } catch (error) {
      if (isVideoAbort(error, signal)) throw error;
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
      } catch (error) {
        if (isVideoAbort(error, signal)) throw error;
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
      if (isVideoAbort(error, signal)) throw error;
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
  const isLocalFile = isLocalVideoFile(url);
  const keyframesRequested = framesOptIn && !isLocalFile && isYoutubeFetchVideoUrl(url);
  if (framesOptIn && !isLocalFile && !isYoutubeFetchVideoUrl(url)) warnings.push('video-frames-non-youtube-url');
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
      } catch (error) {
        if (isVideoAbort(error, signal)) throw error;
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
      if (isVideoAbort(error, signal)) throw error;
      warnings.push('keyframe-extract-failed');
      return [];
    }
  };

  // Local-file route: operator video files interrogated with ffmpeg/ffprobe
  // (fixed argv, shell:false, native-child env, no disk writes). Frame bytes
  // stay local by default: description rides the same tier-gated
  // `describeKeyframe` path as YouTube. Only the exact-'1'
  // PI_VISION_VIDEO_GEMINI flag adds a full-file Gemini fallback (Files API
  // upload with existing Developer key, else Gemini Web leased tab) when
  // local frames yield nothing. No transcript source exists for local files.
  const runLocalVideoAnalysis = async (): Promise<FetchVideoAnalysisResult> => {
    warnings.push('transcript-unavailable-local-file');
    let admitted: { path: string; byteLength: number };
    try {
      admitted = admitLocalVideoFile(url, env as Record<string, string | undefined>);
    } catch (error) {
      const code = error instanceof Error ? error.message.split(':')[0] : '';
      if (code?.includes('video-file-too-large')) warnings.push('video-file-too-large');
      else if (code?.includes('video-invalid-timestamp')) warnings.push('video-invalid-timestamp');
      else if (code?.includes('video-invalid-frames')) warnings.push('video-invalid-frames');
      else warnings.push('video-file-not-found');
      return { text: '', keyframes: 0, synthesized: false, degraded: true, warnings };
    }
    let frameCount: number;
    try {
      frameCount = parseLocalFrameCount(seams.frames ?? (seams.timestamp ? undefined : VIDEO_MAX_KEYFRAMES));
    } catch {
      warnings.push('video-invalid-frames');
      return { text: '', keyframes: 0, synthesized: false, degraded: true, warnings };
    }
    const basename = admitted.path.split('/').pop() ?? admitted.path;
    const readLocalMetadata = async (): Promise<{ title?: string | undefined; durationSec?: number | undefined; byteLength?: number | undefined }> => {
      const out: { title?: string | undefined; durationSec?: number | undefined; byteLength?: number | undefined } = {
        title: basename,
        byteLength: admitted.byteLength,
      };
      if (!framesOptIn) return out;
      try {
        const durationSec = await readLocalVideoDurationSec(admitted.path, {
          env: env as Record<string, string | undefined>,
          ...(signal !== undefined ? { signal } : {}),
          ...(seams.runner !== undefined ? { runner: seams.runner } : {}),
        });
        if (durationSec !== undefined) out.durationSec = durationSec;
      } catch (error) {
        if (isVideoAbort(error, signal)) throw error;
        warnings.push('video-metadata-unavailable');
      }
      return out;
    };
    const readLocalKeyframes = async (): Promise<VideoKeyframe[]> => {
      try {
        if (seams.keyframes !== undefined) return await seams.keyframes();
        return await extractLocalVideoFrames(url, {
          env: env as Record<string, string | undefined>,
          ...(signal !== undefined ? { signal } : {}),
          ...(seams.runner !== undefined ? { runner: seams.runner } : {}),
          ...(seams.timestamp !== undefined ? { timestamp: seams.timestamp } : {}),
          frames: frameCount,
        });
      } catch (error) {
        if (isVideoAbort(error, signal)) throw error;
        const code = error instanceof Error ? error.message.split(':')[0] : '';
        if (code?.includes('video-timestamp-out-of-range')) warnings.push('video-timestamp-out-of-range');
        else if (code?.includes('video-invalid-timestamp')) warnings.push('video-invalid-timestamp');
        else warnings.push('keyframe-extract-failed');
        return [];
      }
    };
    const localKeyframesEnabled = framesOptIn && describableTiers.length > 0;
    if (!framesOptIn) warnings.push('video-frames-opt-in-absent');
    if (framesOptIn && describableTiers.length === 0) warnings.push('video-frames-no-vision-tier');
    // Gemini full-file fallback: runs only when local frames yielded nothing
    // and the exact-'1' PI_VISION_VIDEO_GEMINI flag is set. Developer key ->
    // Files API upload; no API key/ADC -> Gemini Web leased tab; Vertex
    // (no REST bearer path) warns without widening. Never throws for
    // provider failures (only abort propagates).
    const runGeminiVideoFallback = async (
      filePath: string,
      byteLength: number,
      title: string,
    ): Promise<{ text: string; warnings: string[] } | undefined> => {
      const prompt = 'Describe this video factually (' + title + '): visible events, on-screen text, spoken content.';
      const resolved = resolveGeminiConfig(env);
      if (resolved.ok && resolved.config.auth.kind === 'developer') {
        try {
          let fileBytes: Uint8Array;
          try {
            fileBytes = await readFile(filePath);
          } catch {
            warnings.push('video-file-not-found');
            return undefined;
          }
          if (fileBytes.byteLength !== byteLength || fileBytes.byteLength === 0) {
            warnings.push('video-file-not-found');
            return undefined;
          }
          const out =
            seams.geminiVideo !== undefined
              ? await seams.geminiVideo(prompt)
              : await queryVideoWithGeminiFiles(fileBytes, filePath, prompt, resolved.config, {
                  env,
                  ...(signal !== undefined ? { signal } : {}),
                  ...(seams.geminiVideoFetch !== undefined ? { fetchImpl: seams.geminiVideoFetch } : {}),
                });
          if (out.ok) return { text: out.text, warnings: out.warnings };
          for (const warning of out.warnings) {
            if (!warnings.includes(warning)) warnings.push(warning);
          }
          return undefined;
        } catch (error) {
          if (isVideoAbort(error, signal)) throw error;
          warnings.push('gemini-video-unavailable');
          return undefined;
        }
      }
      if (resolved.ok) {
        warnings.push('gemini-video-vertex-unsupported');
        return undefined;
      }
      try {
        let out;
        if (seams.geminiWebVideo !== undefined) {
          out = await seams.geminiWebVideo(filePath, prompt);
        } else if (seams.acquireGeminiWebLease !== undefined) {
          out = await askGeminiWebVideo(
            filePath,
            prompt,
            { acquireLease: seams.acquireGeminiWebLease },
            env,
          );
        } else {
          out = await askGeminiWebVideoWithSessionFallback(filePath, prompt, env, signal);
          // Preserve the pre-wiring fail-closed warning: a disabled web route
          // carries no lease warning of its own.
          if (!out.ok && out.reason === 'disabled') {
            out = {
              ok: false as const,
              reason: 'lease-unavailable' as const,
              warnings: ['gemini-web-lease-unavailable'],
            };
          }
        }
        for (const warning of out.warnings) {
          if (!warnings.includes(warning)) warnings.push(warning);
        }
        if (out.ok) return { text: out.text, warnings: [] };
        return undefined;
      } catch (error) {
        if (isVideoAbort(error, signal)) throw error;
        warnings.push('gemini-web-unavailable');
        return undefined;
      }
    };
    const pipeline = await runVideoPipeline({
      readMetadata: readLocalMetadata,
      readTranscript: async () => [],
      ...(localKeyframesEnabled
        ? { readKeyframes: readLocalKeyframes, describeKeyframe }
        : {}),
    });
    for (const warning of pipeline.warnings) {
      if (!warnings.includes(warning)) warnings.push(warning);
    }
    if (!pipeline.ok) {
      return { text: '', keyframes: 0, synthesized: false, degraded: true, warnings };
    }
    const text = pipeline.evidence.map((entry) => entry.text).join('\n\n');
    const keyframeCount = pipeline.evidence.filter((entry) => entry.kind === 'keyframe').length;
    if (keyframeCount === 0 && isGeminiVideoEnabled(env)) {
      const geminiVideo = await runGeminiVideoFallback(admitted.path, admitted.byteLength, basename);
      if (geminiVideo !== undefined) {
        return {
          text: geminiVideo.text,
          warnings: [...warnings, ...geminiVideo.warnings.filter((warning) => !warnings.includes(warning))],
          keyframes: 0,
          synthesized: false,
          degraded: false,
        };
      }
    }
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
        if (isVideoAbort(error, signal)) throw error;
        warnings.push('synthesis-unavailable');
      }
    }
    // Local files have no transcript source. If no keyframe description and
    // no full-file Gemini result survived, the remaining evidence is metadata
    // only and must be reported as degraded regardless of frame opt-in state.
    const degraded = keyframeCount === 0;
    return {
      text,
      warnings,
      keyframes: keyframeCount,
      synthesized,
      degraded,
      ...(synthesis !== undefined ? { synthesis } : {}),
    };
  };

  if (isLocalFile) return runLocalVideoAnalysis();

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
      if (isVideoAbort(error, signal)) throw error;
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
