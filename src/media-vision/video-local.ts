// Local video ingestion + interrogation (fetch-time, operator files only).
//
// Default path keeps frame JPEG bytes local, described through the existing
// vision tier transports (openai-compatible / gemini exact model IDs, no new
// creds). The only exception is the exact-'1' PI_VISION_VIDEO_GEMINI opt-in
// (gemini.ts Files API upload, wired in video-analysis.ts; the Gemini Web
// Web path requires exact PI_VISION_GEMINI_WEB_ENABLED=1 +
// PI_VISION_VIDEO_GEMINI=1. A live authorized Chrome session is preferred;
// full-file attachment may instead use the isolated Reach-cookie session.
// Without either usable session it degrades closed. Default off means zero
// video bytes leave the box.
// Uploading operator video bytes to a hosted file store would move private
// bytes off-machine outside the transfer-policy gate; Northstar keeps them
// in-process per privacy invariant unless the operator enables the flag.
//
// Threat model (condensed):
// - actor controlling `raw` (model prompt / operator typo) -> filesystem read:
//   allowlisted extensions, path must look like a local path (leading `/`,
//   `./`, `../`, `file://`, or bare relative with a video ext), `statSync`
//   must report a regular file, paths starting with `-` rejected so the file
//   path can never become an ffmpeg/ffprobe flag. No directory traversal
//   beyond what the operator can already read; errors carry fixed codes (never
//   raw fs text) so absent/unreadable paths are indistinguishable to callers.
// - malicious container -> ffmpeg/ffprobe: fixed argv arrays, `shell: false`,
//   env is `buildNativeChildEnvironment` plus nothing else (no cookies/proxy),
//   per-frame 30s / total 120s timeouts, 5MiB per-frame byte ceiling, no disk
//   writes (single JPEG to pipe:1). Timestamp > duration rejects before spawn.
// - frame bytes -> cloud vision: only via the existing eligibility-gated tiers
//   in video-analysis.ts, or the exact-'1' PI_VISION_VIDEO_GEMINI full-file
//   Files API path. Gemini Web requires exact PI_VISION_GEMINI_WEB_ENABLED=1
//   + PI_VISION_VIDEO_GEMINI=1 and uses either the live authorized Chrome
//   session where sufficient or the isolated Reach-cookie attachment session;
//   no other upload exists.

import { lstatSync } from 'node:fs';
import {
  assertFrameArgvAllowed,
  buildFrameChildEnv,
  defaultFrameRunner,
  FRAME_MAX_BYTES,
  FRAMES_TOTAL_TIMEOUT_MS,
  type FrameExtractOptions,
  type FrameRunner,
} from './frame-extract.js';
import { VIDEO_MAX_KEYFRAMES, type VideoKeyframe } from './pipeline-video.js';

/** Video container extensions eligible for local ingestion. */
export const LOCAL_VIDEO_EXTENSIONS: readonly string[] = [
  '.mp4',
  '.mov',
  '.webm',
  '.avi',
  '.mpeg',
  '.mpg',
  '.wmv',
  '.flv',
  '.3gp',
  '.3gpp',
];

/** Default local-file size ceiling (MiB). Operator-lowerable via env. */
export const LOCAL_VIDEO_DEFAULT_MAX_MB = 50;

/** Env override for the local-file size ceiling (`video.maxSizeMB`). */
export const LOCAL_VIDEO_MAX_SIZE_ENV_VAR = 'PI_VISION_VIDEO_MAX_SIZE_MB';

/** Per-frame ffmpeg wall clock for local extraction (ms). */
export const LOCAL_FRAME_TIMEOUT_MS = 30_000;

/** Per-frame JPEG byte ceiling for local extraction (5MiB). */
export const LOCAL_FRAME_MAX_BYTES = 5 * 1024 * 1024;

/** ffprobe duration probe wall clock (ms). */
export const LOCAL_PROBE_TIMEOUT_MS = 10_000;

export type LocalVideoErrorCode =
  | 'unsupported-video-path'
  | 'video-file-not-found'
  | 'video-file-too-large'
  | 'video-invalid-timestamp'
  | 'video-timestamp-out-of-range'
  | 'video-invalid-frames'
  | 'ffmpeg-failed'
  | 'ffprobe-failed'
  | 'frame-extract-timeout'
  | 'frame-binary-missing';

export class LocalVideoError extends Error {
  readonly code: LocalVideoErrorCode;
  constructor(code: LocalVideoErrorCode, detail?: string) {
    super(detail ? `${code}: ${detail}` : code);
    this.name = 'LocalVideoError';
    this.code = code;
  }
}

/**
 * Strip a `file://` URI to a filesystem path (percent-decoded). Returns null
 * when raw is not a `file://` URI.
 */
export function stripFileUri(raw: string): string | null {
  if (!raw.startsWith('file://')) return null;
  const withoutScheme = raw.slice('file://'.length);
  // `file://host/path` and `file:///path` both reduce to a local path; an
  // authority other than empty/localhost is not a local file.
  if (withoutScheme.startsWith('/') || withoutScheme.startsWith('./') || withoutScheme === '') {
    try {
      const decoded = decodeURIComponent(withoutScheme);
      // file:///C:/clip.mp4 -> C:/clip.mp4 so Windows lstat succeeds.
      const drive = /^\/([a-zA-Z]:[\/])/.exec(decoded);
      return drive ? decoded.slice(1) : decoded;
    } catch {
      return null;
    }
  }
  const slash = withoutScheme.indexOf('/');
  if (slash === -1) return null;
  const host = withoutScheme.slice(0, slash).toLowerCase();
  if (host !== '' && host !== 'localhost') return null;
  try {
    const decoded = decodeURIComponent(withoutScheme.slice(slash));
    return /^\/[a-zA-Z]:[\/]/.test(decoded) ? decoded.slice(1) : decoded;
  } catch {
    return null;
  }
}

function hasVideoExtension(path: string): boolean {
  const lower = path.toLowerCase();
  const base = lower.split('/').pop() ?? lower;
  const dot = base.lastIndexOf('.');
  if (dot === -1) return false;
  return (LOCAL_VIDEO_EXTENSIONS as readonly string[]).includes(base.slice(dot));
}

function looksLikeLocalPath(raw: string): boolean {
  if (raw.startsWith('file://')) return true;
  // Windows: C:\clip.mp4, C:/clip.mp4, \\host\share\clip.mp4 are local,
  // not URL schemes. Check before the generic scheme guard below.
  if (/^[a-zA-Z]:[\\/]/.test(raw) || raw.startsWith('\\\\')) return true;
  if (raw.startsWith('/') || raw.startsWith('./') || raw.startsWith('../') || raw.startsWith('.\\') || raw.startsWith('..\\')) return true;
  // Bare relative filenames (`clip.mp4`) are local paths when the extension matches.
  if (!/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(raw)) return true;
  return false;
}

/** Resolve raw input to a filesystem path, or null when not file-shaped. */
export function resolveLocalVideoPath(raw: string): string | null {
  const trimmed = raw.trim();
  if (trimmed.length === 0 || trimmed.startsWith('-')) return null;
  const stripped = stripFileUri(trimmed);
  const candidate = stripped ?? trimmed;
  if (candidate.startsWith('-')) return null;
  if (!looksLikeLocalPath(trimmed)) return null;
  if (!hasVideoExtension(candidate)) return null;
  return candidate;
}

/**
 * True when raw names an existing regular, non-symlink local video file.
 * Missing/unreadable/directory/symlink paths are all false (no throw, no
 * error-text oracle). Rejecting symlinks prevents a harmless-looking .mp4
 * alias from becoming a read/upload path to a differently named local file.
 */
export function isLocalVideoFile(raw: string): boolean {
  const candidate = resolveLocalVideoPath(raw);
  if (candidate === null) return false;
  try {
    const stat = lstatSync(candidate);
    return stat.isFile() && !stat.isSymbolicLink();
  } catch {
    return false;
  }
}

/** Operator size ceiling in bytes (env override, positive int, else default). */
export function resolveLocalVideoMaxBytes(
  env: NodeJS.ProcessEnv | Record<string, string | undefined> = process.env,
): number {
  const raw = env[LOCAL_VIDEO_MAX_SIZE_ENV_VAR];
  if (raw !== undefined && raw.trim().length > 0) {
    const normalized = raw.trim();
    if (/^\d+$/.test(normalized)) {
      const parsed = Number(normalized);
      if (Number.isSafeInteger(parsed) && parsed > 0 && parsed <= LOCAL_VIDEO_DEFAULT_MAX_MB) {
        return parsed * 1024 * 1024;
      }
    }
  }
  return LOCAL_VIDEO_DEFAULT_MAX_MB * 1024 * 1024;
}

/**
 * Assert the file exists, is regular, and fits the size gate. Returns
 * `{ path, byteLength }`. Throws LocalVideoError with an actionable message
 * (suggesting timestamp/frames/compress) on the too-large branch.
 */
export function admitLocalVideoFile(
  raw: string,
  env: NodeJS.ProcessEnv | Record<string, string | undefined> = process.env,
): { path: string; byteLength: number } {
  const candidate = resolveLocalVideoPath(raw);
  if (candidate === null) throw new LocalVideoError('unsupported-video-path');
  let byteLength: number;
  try {
    const stat = lstatSync(candidate);
    if (!stat.isFile() || stat.isSymbolicLink()) {
      throw new LocalVideoError('video-file-not-found');
    }
    byteLength = stat.size;
  } catch (error) {
    if (error instanceof LocalVideoError) throw error;
    throw new LocalVideoError('video-file-not-found');
  }
  const maxBytes = resolveLocalVideoMaxBytes(env);
  if (byteLength > maxBytes) {
    const maxMB = Math.round(maxBytes / (1024 * 1024));
    throw new LocalVideoError(
      'video-file-too-large',
      `file exceeds the ${maxMB}MB local video ceiling; ` +
        `interrogate a timestamp (MM:SS), request fewer frames, or compress the file`,
    );
  }
  return { path: candidate, byteLength };
}

function parseClockPart(part: string): number | null {
  if (!/^\d+(\.\d+)?$/.test(part)) return null;
  const value = Number.parseFloat(part);
  return Number.isFinite(value) && value >= 0 ? value : null;
}

/** Parse `secs | MM:SS | H:MM:SS` to seconds. Null when malformed. */
export function parseVideoTimestamp(raw: string): number | null {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return null;
  if (/^\d+(\.\d+)?$/.test(trimmed)) {
    const value = Number.parseFloat(trimmed);
    return Number.isFinite(value) && value >= 0 ? value : null;
  }
  const parts = trimmed.split(':');
  if (parts.length < 2 || parts.length > 3) return null;
  if (parts.some((part) => part.length === 0)) return null;
  const numbers = parts.map(parseClockPart);
  if (numbers.some((n) => n === null)) return null;
  const nums = numbers as number[];
  if (parts.length === 3) {
    const [h, m, s] = nums as [number, number, number];
    if (m >= 60 || s >= 60) return null;
    return h * 3600 + m * 60 + s;
  }
  const [m, s] = nums as [number, number];
  if (s >= 60) return null;
  return m * 60 + s;
}

export type LocalTimestampSpec =
  | { kind: 'single'; seconds: number }
  | { kind: 'range'; startSec: number; endSec: number };

/** Parse `timestamp` or `start-end` range specs. Throws LocalVideoError. */
export function parseLocalTimestampSpec(raw: string | undefined): LocalTimestampSpec | null {
  if (raw === undefined) return null;
  const trimmed = raw.trim();
  if (trimmed.length === 0) throw new LocalVideoError('video-invalid-timestamp');
  const dash = trimmed.indexOf('-');
  if (dash !== -1) {
    const start = parseVideoTimestamp(trimmed.slice(0, dash));
    const end = parseVideoTimestamp(trimmed.slice(dash + 1));
    if (start === null || end === null || end <= start) {
      throw new LocalVideoError('video-invalid-timestamp');
    }
    return { kind: 'range', startSec: start, endSec: end };
  }
  const seconds = parseVideoTimestamp(trimmed);
  if (seconds === null) throw new LocalVideoError('video-invalid-timestamp');
  return { kind: 'single', seconds };
}

/** Validate `frames` (reject-not-clamp): integer in [1, 12]. */
export function parseLocalFrameCount(raw: number | undefined): number {
  if (raw === undefined) return 1;
  if (!Number.isInteger(raw) || raw < 1 || raw > VIDEO_MAX_KEYFRAMES) {
    throw new LocalVideoError('video-invalid-frames');
  }
  return raw;
}

/**
 * Timestamps (seconds) for a local interrogation:
 * - range + frames: evenly spaced across [start, end];
 * - single + frames>1: 5s intervals from the timestamp;
 * - single + frames=1: the exact timestamp;
 * - frames-only (no timestamp): full-duration sample via durationSec, else
 *   5s-interval fallback from 5s.
 */
export function timestampsForLocalRequest(
  durationSec: number | undefined,
  spec: LocalTimestampSpec | null,
  count: number,
): number[] {
  if (spec?.kind === 'range') {
    if (count === 1) return [(spec.startSec + spec.endSec) / 2];
    return Array.from(
      { length: count },
      (_, i) => spec.startSec + ((spec.endSec - spec.startSec) * i) / (count - 1),
    );
  }
  if (spec?.kind === 'single') {
    if (count === 1) return [spec.seconds];
    return Array.from({ length: count }, (_, i) => spec.seconds + i * 5);
  }
  if (durationSec !== undefined && Number.isFinite(durationSec) && durationSec > count) {
    return Array.from({ length: count }, (_, i) => (durationSec * (i + 1)) / (count + 1));
  }
  return Array.from({ length: count }, (_, i) => 5 + i * 5);
}

/** Fixed ffprobe argv: duration seconds only, no disk writes. */
export function buildFfprobeDurationArgv(filePath: string): { command: string; argv: string[] } {
  const argv = [
    '-nostdin',
    '-hide_banner',
    '-loglevel',
    'error',
    '-show_entries',
    'format=duration',
    '-of',
    'default=noprint_wrappers=1:nokey=1',
    filePath,
  ];
  assertFrameArgvAllowed(argv);
  return { command: 'ffprobe', argv };
}

/** Fixed ffmpeg argv: one JPEG frame at `seconds` to pipe:1. */
export function buildFfmpegLocalFrameArgv(
  filePath: string,
  seconds: number,
): { command: string; argv: string[] } {
  const argv = [
    '-nostdin',
    '-hide_banner',
    '-loglevel',
    'error',
    '-ss',
    String(seconds),
    '-i',
    filePath,
    '-frames:v',
    '1',
    '-f',
    'image2pipe',
    '-vcodec',
    'mjpeg',
    'pipe:1',
  ];
  assertFrameArgvAllowed(argv);
  return { command: 'ffmpeg', argv };
}

export interface LocalVideoRequestOptions extends FrameExtractOptions {
  /** `secs | MM:SS | H:MM:SS`, optionally `start-end` range. */
  timestamp?: string | undefined;
  /** Reject-not-clamp integer in [1, 12]. */
  frames?: number | undefined;
}

/** Duration seconds via ffprobe (bounded); undefined when unparseable. */
export async function readLocalVideoDurationSec(
  filePath: string,
  options: FrameExtractOptions = {},
): Promise<number | undefined> {
  const runner: FrameRunner = options.runner ?? defaultFrameRunner;
  let result: { code: number | null; stdout: Uint8Array; stderr: string; timedOut: boolean };
  try {
    const { command, argv } = buildFfprobeDurationArgv(filePath);
    result = await runner(command, argv, {
      env: buildFrameChildEnv(options.env ?? process.env),
      timeoutMs: LOCAL_PROBE_TIMEOUT_MS,
      ...(options.signal !== undefined ? { signal: options.signal } : {}),
    });
  } catch (error) {
    if (error instanceof Error && error.message === 'Aborted') throw error;
    throw new LocalVideoError('frame-binary-missing');
  }
  if (options.signal?.aborted) throw new Error('Aborted');
  if (result.timedOut) throw new LocalVideoError('frame-extract-timeout');
  if (result.code === 127) throw new LocalVideoError('frame-binary-missing');
  if (result.code !== 0) throw new LocalVideoError('ffprobe-failed');
  const parsed = Number.parseFloat(Buffer.from(result.stdout).toString('utf8').trim());
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

/**
 * Extract interrogation keyframes from a local file. Fixed argv, shell:false,
 * native-child env, no disk writes. Throws LocalVideoError (fixed codes).
 */
export async function extractLocalVideoFrames(
  raw: string,
  options: LocalVideoRequestOptions = {},
): Promise<VideoKeyframe[]> {
  const { path: filePath } = admitLocalVideoFile(raw, options.env ?? process.env);
  const spec = parseLocalTimestampSpec(options.timestamp);
  const count = parseLocalFrameCount(options.frames);
  const runner: FrameRunner = options.runner ?? defaultFrameRunner;
  const env = buildFrameChildEnv(options.env ?? process.env);

  let durationSec: number | undefined;
  if (spec === null && count > 1) {
    try {
      durationSec = await readLocalVideoDurationSec(filePath, {
        ...options,
        env: options.env ?? process.env,
      });
    } catch (error) {
      if (error instanceof Error && error.message === 'Aborted') throw error;
      throw error;
    }
  } else if (spec !== null) {
    try {
      durationSec = await readLocalVideoDurationSec(filePath, {
        ...options,
        env: options.env ?? process.env,
      });
    } catch (error) {
      if (error instanceof Error && error.message === 'Aborted') throw error;
      // Duration unknown: range/single spacing still applies; out-of-range is
      // then enforced per-frame by ffmpeg failure mapping below.
      durationSec = undefined;
    }
  }

  const timestamps = timestampsForLocalRequest(durationSec, spec, count);
  for (const seconds of timestamps) {
    if (durationSec !== undefined && seconds > durationSec) {
      throw new LocalVideoError('video-timestamp-out-of-range');
    }
  }

  const deadline = Date.now() + FRAMES_TOTAL_TIMEOUT_MS;
  const frames: VideoKeyframe[] = [];
  for (const seconds of timestamps) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      if (frames.length > 0) return frames;
      throw new LocalVideoError('frame-extract-timeout');
    }
    const { command, argv } = buildFfmpegLocalFrameArgv(filePath, seconds);
    let result: { code: number | null; stdout: Uint8Array; stderr: string; timedOut: boolean };
    try {
      result = await runner(command, argv, {
        env,
        timeoutMs: Math.min(LOCAL_FRAME_TIMEOUT_MS, remaining),
        ...(options.signal !== undefined ? { signal: options.signal } : {}),
      });
    } catch (error) {
      if (error instanceof Error && error.message === 'Aborted') throw error;
      throw new LocalVideoError('frame-binary-missing');
    }
    if (options.signal?.aborted) throw new Error('Aborted');
    if (result.timedOut) {
      if (frames.length > 0) return frames;
      throw new LocalVideoError('frame-extract-timeout');
    }
    if (result.code === 127) throw new LocalVideoError('frame-binary-missing');
    if (result.code !== 0 || result.stdout.byteLength === 0) {
      if (frames.length > 0) return frames;
      throw new LocalVideoError('ffmpeg-failed');
    }
    if (result.stdout.byteLength > LOCAL_FRAME_MAX_BYTES) {
      if (frames.length > 0) return frames;
      throw new LocalVideoError('ffmpeg-failed');
    }
    if (result.stdout.byteLength > FRAME_MAX_BYTES) {
      if (frames.length > 0) return frames;
      throw new LocalVideoError('ffmpeg-failed');
    }
    frames.push({
      timestampMs: Math.round(seconds * 1000),
      bytes: result.stdout,
      mimeType: 'image/jpeg',
    });
  }
  return frames;
}

export interface LocalFramePayload {
  data: string;
  mimeType: 'image/jpeg';
  timestamp: string;
}

/** `timestampMs` -> `MM:SS` label for frame payloads. */
export function formatLocalFrameTimestamp(timestampMs: number): string {
  const totalSec = Math.max(0, Math.floor(timestampMs / 1000));
  const minutes = Math.floor(totalSec / 60);
  const seconds = totalSec % 60;
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
}

/** Internal keyframe -> upstream-shaped `{ data base64, mimeType, timestamp }`. */
export function toLocalFramePayload(frame: VideoKeyframe): LocalFramePayload {
  return {
    data: Buffer.from(frame.bytes).toString('base64'),
    mimeType: 'image/jpeg',
    timestamp: formatLocalFrameTimestamp(frame.timestampMs),
  };
}
