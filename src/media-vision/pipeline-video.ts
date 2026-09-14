// Video pipeline (Plan D Task D4): internal metadata + transcript first
// (via src/media/* shapes, injected), then ≤12 timestamped keyframes through
// vision. No ffmpeg: when no keyframe source exists the pipeline returns
// metadata + transcript only with warnings and adds no binary dependency.

import {
  untrustedWarnings,
  type VisionEvidence,
} from './pipeline-image.js';

/** Hard ceilings (operator-lower-only): video 250MiB / 120min / 12 keyframes. */
export const VIDEO_MAX_BYTES = 250 * 1024 * 1024;
export const VIDEO_MAX_MINUTES = 120;
export const VIDEO_MAX_KEYFRAMES = 12;

export interface VideoMetadata {
  title?: string | undefined;
  durationSec?: number | undefined;
  byteLength?: number | undefined;
}

export interface VideoTranscriptSegment {
  timestampMs: number;
  text: string;
}

export interface VideoKeyframe {
  timestampMs: number;
  bytes: Uint8Array;
  mimeType: string;
}

export interface VideoVisionSeams {
  readMetadata(): Promise<VideoMetadata>;
  readTranscript(): Promise<VideoTranscriptSegment[]>;
  /**
   * Timestamped keyframes (≤12 honored; extras ignored with a warning).
   * Absent/empty = no keyframe source (no-ffmpeg path): metadata +
   * transcript only, no new binary dep.
   */
  readKeyframes?: (() => Promise<VideoKeyframe[]>) | undefined;
  describeKeyframe?: ((frame: VideoKeyframe) => Promise<{ text: string; warnings?: string[] | undefined }>) | undefined;
}

export type VideoPipelineResult =
  | { ok: true; evidence: VisionEvidence[]; warnings: string[] }
  | { ok: false; reason: string; warnings: string[] };

/**
 * Full video pipeline. Metadata + transcript are always attempted first;
 * keyframe vision is additive. Admission rejects before any read.
 */
export async function runVideoPipeline(seams: VideoVisionSeams): Promise<VideoPipelineResult> {
  const warnings: string[] = [];
  const evidence: VisionEvidence[] = [];

  const metadata = await seams.readMetadata();
  if (metadata.byteLength !== undefined && metadata.byteLength > VIDEO_MAX_BYTES) {
    return { ok: false, reason: 'over-byte-ceiling', warnings: ['video-over-byte-ceiling'] };
  }
  if (metadata.durationSec !== undefined && metadata.durationSec > VIDEO_MAX_MINUTES * 60) {
    return { ok: false, reason: 'over-duration-ceiling', warnings: ['video-over-duration-ceiling'] };
  }
  const metaLines: string[] = [];
  if (metadata.title !== undefined && metadata.title.trim().length > 0) {
    metaLines.push(`title: ${metadata.title.trim()}`);
  }
  if (metadata.durationSec !== undefined) metaLines.push(`durationSec: ${metadata.durationSec}`);
  if (metaLines.length > 0) {
    const text = metaLines.join('\n');
    evidence.push({
      sourceKind: 'extracted',
      kind: 'metadata',
      text,
      locator: {},
      warnings: untrustedWarnings(text, 'metadata'),
    });
  }

  const transcript = await seams.readTranscript();
  for (const segment of transcript) {
    if (segment.text.trim().length === 0) continue;
    evidence.push({
      sourceKind: 'extracted',
      kind: 'transcript',
      text: segment.text,
      locator: { timestampMs: segment.timestampMs },
      warnings: untrustedWarnings(segment.text, 'transcript'),
    });
  }
  if (transcript.length === 0) warnings.push('transcript-empty');

  if (seams.readKeyframes === undefined || seams.describeKeyframe === undefined) {
    warnings.push('no-keyframe-source-metadata-transcript-only');
    if (evidence.length === 0) warnings.push('no-video-evidence');
    return { ok: true, evidence, warnings };
  }
  const frames = await seams.readKeyframes();
  if (frames.length === 0) {
    warnings.push('no-keyframes-returned');
    return { ok: true, evidence, warnings };
  }
  const honored = frames.slice(0, VIDEO_MAX_KEYFRAMES);
  if (frames.length > VIDEO_MAX_KEYFRAMES) warnings.push('keyframe-ceiling-12-excess-ignored');
  const describe = seams.describeKeyframe;
  for (const frame of honored) {
    const derived = await describe(frame);
    if (derived.text.trim().length === 0) {
      warnings.push(`keyframe-${frame.timestampMs}-vision-empty`);
      continue;
    }
    evidence.push({
      sourceKind: 'derived',
      kind: 'keyframe',
      text: derived.text,
      locator: { timestampMs: frame.timestampMs },
      warnings: [...(derived.warnings ?? []), ...untrustedWarnings(derived.text, 'keyframe')],
    });
  }
  return { ok: true, evidence, warnings };
}
