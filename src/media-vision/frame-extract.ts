// M8a: anonymous YouTube keyframe extraction via yt-dlp + ffmpeg.
//
// Frames-only child-process seam for fetch-time video analysis. Anonymous by
// construction: fixed argv arrays, `shell: false`, env is
// `buildNativeChildEnvironment` plus nothing else (no cookie vars, no proxy),
// `--no-config` always so user config can never inject credentials or
// cookies. No argv passthrough API exists, so callers cannot add flags.
// Local video files are out of scope (D1): HTTP(S) YouTube URLs only, and no
// disk writes anywhere (ffmpeg emits a single JPEG to pipe:1 per keyframe).

import { spawn } from 'node:child_process';
import { buildNativeChildEnvironment } from '../process/native-child-env.js';
import { VIDEO_MAX_KEYFRAMES, type VideoKeyframe } from './pipeline-video.js';

export { VIDEO_MAX_KEYFRAMES };

/** Exact-'1' operator opt-in gating fetch-time frame extraction. */
export const VIDEO_FRAMES_ENV_VAR = 'PI_VISION_FETCH_VIDEO_FRAMES';

/** Per-frame ffmpeg wall clock (ms). */
export const FRAME_PER_TIMEOUT_MS = 30_000;

/** Total keyframe-run wall clock (ms) across all frames. */
export const FRAMES_TOTAL_TIMEOUT_MS = 120_000;

/** Grace after SIGTERM before escalating to SIGKILL (mirrors github-clone). */
export const FRAME_KILL_GRACE_MS = 1000;

/** Frame byte ceiling: one JPEG must fit the shared image bound. */
export const FRAME_MAX_BYTES = 20 * 1024 * 1024;

/**
 * Hard rejection list: these argv elements must never appear in any spawned
 * command (test-enforced on every argv builder branch). Note `-c` is banned,
 * so the ffmpeg argv below uses only long-form flags.
 */
export const FORBIDDEN_FRAME_ARGV_TOKENS: readonly string[] = [
  '--cookies',
  '--cookies-from-browser',
  '--username',
  '--password',
  '--netrc',
  '--proxy',
  '-c',
  '--config-location',
];

/**
 * Throws when argv contains a forbidden token. Prefix forms (`--flag=value`,
 * `--flag:value`) match as well as exact elements, so smuggled values like
 * `--cookies=/tmp/x` or `--proxy=http://…` cannot bypass the list. `-c`
 * stays exact-element (it takes no attached value in our fixed argv).
 */
export function assertFrameArgvAllowed(argv: readonly string[]): void {
  for (const token of argv) {
    for (const entry of FORBIDDEN_FRAME_ARGV_TOKENS) {
      if (entry === '-c') {
        if (token === '-c') throw new Error(`frame argv forbidden token: ${token}`);
        continue;
      }
      if (token === entry || token.startsWith(`${entry}=`) || token.startsWith(`${entry}:`)) {
        throw new Error(`frame argv forbidden token: ${token}`);
      }
    }
  }
}

/** True only on the exact opt-in value '1'; absent/any other value is off. */
export function isVideoFramesOptIn(
  env: NodeJS.ProcessEnv | Record<string, string | undefined> = process.env,
): boolean {
  return env[VIDEO_FRAMES_ENV_VAR] === '1';
}

/** YouTube watch/shorts/canonical URLs eligible for frame extraction. */
export function isYoutubeFetchVideoUrl(raw: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return false;
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return false;
  const host = parsed.hostname.toLowerCase().replace(/\.$/, '');
  if (host === 'youtu.be') return parsed.pathname.split('/').filter(Boolean).length >= 1;
  if (host === 'youtube.com' || host.endsWith('.youtube.com')) {
    const path = parsed.pathname.toLowerCase();
    return path === '/watch' || path.startsWith('/shorts/');
  }
  return false;
}

/**
 * Sanitized child env: the native allowlist plus nothing else. No cookie,
 * proxy, or token vars can reach yt-dlp/ffmpeg through this seam.
 */
export function buildFrameChildEnv(
  parentEnv: Record<string, string | undefined> = process.env,
): Record<string, string> {
  return buildNativeChildEnvironment(parentEnv);
}

/** Fixed yt-dlp argv: duration + title + stream URL print only. */
export function buildYtDlpStreamArgv(url: string): { command: string; argv: string[] } {
  const argv = [
    '--no-config',
    '--no-cache-dir',
    '--no-playlist',
    '--no-warnings',
    '--no-part',
    '--print',
    'duration',
    '--print',
    'title',
    '--print',
    'urls',
    url,
  ];
  assertFrameArgvAllowed(argv);
  return { command: 'yt-dlp', argv };
}

/** Fixed ffmpeg argv: one JPEG frame at `seconds` to pipe:1. */
export function buildFfmpegFrameArgv(streamUrl: string, seconds: number): { command: string; argv: string[] } {
  const argv = [
    '-nostdin',
    '-hide_banner',
    '-loglevel',
    'error',
    '-ss',
    String(seconds),
    '-i',
    streamUrl,
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

/** Injected process runner. Implementations must use shell:false. */
export type FrameRunner = (
  command: string,
  argv: readonly string[],
  options: { env: Record<string, string>; timeoutMs: number; signal?: AbortSignal | undefined },
) => Promise<{ code: number | null; stdout: Uint8Array; stderr: string; timedOut: boolean }>;

/** Fixed error strings for frame extraction (never raw stderr echo). */
export type FrameErrorCode =
  | 'unsupported-video-url'
  | 'video-unavailable'
  | 'video-private-or-age-restricted'
  | 'video-region-restricted'
  | 'video-live-stream'
  | 'video-not-found'
  | 'yt-dlp-failed'
  | 'ffmpeg-failed'
  | 'frame-extract-timeout'
  | 'frame-binary-missing';

export class FrameExtractError extends Error {
  readonly code: FrameErrorCode;
  constructor(code: FrameErrorCode) {
    super(code);
    this.name = 'FrameExtractError';
    this.code = code;
  }
}

function mapYtDlpError(stderr: string): FrameErrorCode {
  const lower = stderr.toLowerCase();
  if (lower.includes('private') || lower.includes('age')) return 'video-private-or-age-restricted';
  if (lower.includes('region') || lower.includes('geo')) return 'video-region-restricted';
  if (lower.includes('live')) return 'video-live-stream';
  if (lower.includes('not found') || lower.includes('404')) return 'video-not-found';
  if (lower.includes('unavailable') || lower.includes('removed') || lower.includes('not available')) {
    return 'video-unavailable';
  }
  return 'yt-dlp-failed';
}

/**
 * Default runner: spawn with shell:false, binary stdout collect, capped
 * stderr, timeout escalates SIGTERM to SIGKILL after FRAME_KILL_GRACE_MS.
 */
export function defaultFrameRunner(
  command: string,
  argv: readonly string[],
  options: { env: Record<string, string>; timeoutMs: number; signal?: AbortSignal | undefined },
): Promise<{ code: number | null; stdout: Uint8Array; stderr: string; timedOut: boolean }> {
  return new Promise((resolve, reject) => {
    if (options.signal?.aborted) {
      reject(new Error('Aborted'));
      return;
    }
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(command, [...argv], {
        shell: false,
        env: options.env,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (error) {
      reject(error);
      return;
    }
    const chunks: Uint8Array[] = [];
    let stdoutBytes = 0;
    let stdoutCapped = false;
    let stderr = '';
    let settled = false;
    let timedOut = false;
    let killTimer: NodeJS.Timeout | undefined;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
      killTimer = setTimeout(() => {
        try {
          child.kill('SIGKILL');
        } catch {
          // Child already gone.
        }
      }, FRAME_KILL_GRACE_MS);
    }, options.timeoutMs);
    const onAbort = (): void => {
      clearTimeout(timer);
      if (killTimer !== undefined) clearTimeout(killTimer);
      child.kill('SIGTERM');
      if (!settled) {
        settled = true;
        reject(new Error('Aborted'));
      }
    };
    if (options.signal !== undefined) options.signal.addEventListener('abort', onAbort, { once: true });
    const stdoutPipe = child.stdout;
    if (stdoutPipe === null) {
      clearTimeout(timer);
      reject(new Error('frame spawn has no stdout pipe'));
      return;
    }
    stdoutPipe.on('data', (chunk: Buffer) => {
      if (stdoutCapped) return;
      stdoutBytes += chunk.byteLength;
      if (stdoutBytes > FRAME_MAX_BYTES) {
        stdoutCapped = true;
        chunks.length = 0;
        return;
      }
      chunks.push(new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength));
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr = `${stderr}${chunk.toString('utf8')}`.slice(-4096);
    });
    child.on('error', (error: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      if (killTimer !== undefined) clearTimeout(killTimer);
      options.signal?.removeEventListener('abort', onAbort);
      if (settled) return;
      settled = true;
      if (error.code === 'ENOENT') {
        resolve({ code: 127, stdout: new Uint8Array(0), stderr: '', timedOut: false });
        return;
      }
      reject(error);
    });
    child.on('close', (code: number | null) => {
      clearTimeout(timer);
      if (killTimer !== undefined) clearTimeout(killTimer);
      options.signal?.removeEventListener('abort', onAbort);
      if (settled) return;
      settled = true;
      if (options.signal?.aborted) {
        reject(new Error('Aborted'));
        return;
      }
      if (stdoutCapped) {
        resolve({ code, stdout: new Uint8Array(0), stderr: 'frame-over-byte-ceiling', timedOut });
        return;
      }
      const total = chunks.reduce((sum, part) => sum + part.byteLength, 0);
      const stdout = new Uint8Array(total);
      let at = 0;
      for (const part of chunks) {
        stdout.set(part, at);
        at += part.byteLength;
      }
      resolve({ code, stdout, stderr, timedOut });
    });
  });
}

export interface YoutubeStreamInfo {
  durationSec?: number | undefined;
  title?: string | undefined;
  streamUrl: string;
}

export interface FrameExtractOptions {
  env?: Record<string, string | undefined> | undefined;
  signal?: AbortSignal | undefined;
  runner?: FrameRunner | undefined;
}

/** Single yt-dlp call for duration + title + stream URL (bounded). */
export async function readYoutubeStreamInfo(
  url: string,
  options: FrameExtractOptions = {},
): Promise<YoutubeStreamInfo> {
  if (!isYoutubeFetchVideoUrl(url)) throw new FrameExtractError('unsupported-video-url');
  const runner = options.runner ?? defaultFrameRunner;
  const { command, argv } = buildYtDlpStreamArgv(url);
  let result: { code: number | null; stdout: Uint8Array; stderr: string; timedOut: boolean };
  try {
    result = await runner(command, argv, {
      env: buildFrameChildEnv(options.env ?? process.env),
      timeoutMs: FRAME_PER_TIMEOUT_MS,
      ...(options.signal !== undefined ? { signal: options.signal } : {}),
    });
  } catch (error) {
    if (error instanceof Error && error.message === 'Aborted') throw error;
    throw new FrameExtractError('frame-binary-missing');
  }
  if (options.signal?.aborted) throw new Error('Aborted');
  if (result.timedOut) throw new FrameExtractError('frame-extract-timeout');
  if (result.code === 127) throw new FrameExtractError('frame-binary-missing');
  if (result.code !== 0) throw new FrameExtractError(mapYtDlpError(result.stderr));
  const lines = Buffer.from(result.stdout).toString('utf8').split(/\r?\n/);
  const rawDuration = lines[0]?.trim() ?? '';
  const title = lines[1]?.trim() || undefined;
  const streamUrl = lines[2]?.trim() || lines[1]?.trim() || '';
  if (!streamUrl || !/^https?:\/\//.test(streamUrl)) {
    throw new FrameExtractError(mapYtDlpError(result.stderr));
  }
  const parsed = rawDuration && rawDuration !== 'NA' ? Number.parseFloat(rawDuration) : NaN;
  return {
    streamUrl,
    ...(title ? { title } : {}),
    ...(Number.isFinite(parsed) ? { durationSec: parsed } : {}),
  };
}

/** Duration only (bounded); wraps the single stream-info call. */
export async function readYoutubeDurationSec(
  url: string,
  options: FrameExtractOptions = {},
): Promise<number | undefined> {
  return (await readYoutubeStreamInfo(url, options)).durationSec;
}

export interface KeyframeExtractOptions extends FrameExtractOptions {
  /** Reject-not-clamp: must be an integer in [1, VIDEO_MAX_KEYFRAMES]. */
  count?: number | undefined;
}

function timestampsForDuration(durationSec: number | undefined, count: number): number[] {
  if (durationSec !== undefined && Number.isFinite(durationSec) && durationSec > count) {
    const out: number[] = [];
    for (let i = 0; i < count; i += 1) {
      out.push(Math.max(0, (durationSec * (i + 1)) / (count + 1)));
    }
    return out;
  }
  return Array.from({ length: count }, (_, i) => 5 + i * 10);
}

/**
 * Extract up to `count` JPEG keyframes (default VIDEO_MAX_KEYFRAMES). One
 * ffmpeg process per keyframe, sequential, under FRAMES_TOTAL_TIMEOUT_MS
 * total. Throws FrameExtractError with a fixed code (never stderr text).
 */
export async function extractYoutubeKeyframes(
  url: string,
  options: KeyframeExtractOptions = {},
): Promise<VideoKeyframe[]> {
  const count = options.count ?? VIDEO_MAX_KEYFRAMES;
  if (!Number.isInteger(count) || count < 1 || count > VIDEO_MAX_KEYFRAMES) {
    throw new FrameExtractError('yt-dlp-failed');
  }
  if (!isYoutubeFetchVideoUrl(url)) throw new FrameExtractError('unsupported-video-url');
  const runner = options.runner ?? defaultFrameRunner;
  const env = buildFrameChildEnv(options.env ?? process.env);
  const info = await readYoutubeStreamInfo(url, { ...options, env: options.env ?? process.env });
  const timestamps = timestampsForDuration(info.durationSec, count);
  const deadline = Date.now() + FRAMES_TOTAL_TIMEOUT_MS;
  const frames: VideoKeyframe[] = [];
  for (const seconds of timestamps) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      if (frames.length > 0) return frames;
      throw new FrameExtractError('frame-extract-timeout');
    }
    const { command, argv } = buildFfmpegFrameArgv(info.streamUrl, seconds);
    let result: { code: number | null; stdout: Uint8Array; stderr: string; timedOut: boolean };
    try {
      result = await runner(command, argv, {
        env,
        timeoutMs: Math.min(FRAME_PER_TIMEOUT_MS, remaining),
        ...(options.signal !== undefined ? { signal: options.signal } : {}),
      });
    } catch (error) {
      if (error instanceof Error && error.message === 'Aborted') throw error;
      throw new FrameExtractError('frame-binary-missing');
    }
    if (options.signal?.aborted) throw new Error('Aborted');
    if (result.timedOut) {
      if (frames.length > 0) return frames;
      throw new FrameExtractError('frame-extract-timeout');
    }
    if (result.code === 127) throw new FrameExtractError('frame-binary-missing');
    if (result.code !== 0 || result.stdout.byteLength === 0) {
      if (frames.length > 0) return frames;
      throw new FrameExtractError('ffmpeg-failed');
    }
    if (result.stdout.byteLength > FRAME_MAX_BYTES) {
      if (frames.length > 0) return frames;
      throw new FrameExtractError('ffmpeg-failed');
    }
    frames.push({
      timestampMs: Math.round(seconds * 1000),
      bytes: result.stdout,
      mimeType: 'image/jpeg',
    });
  }
  return frames;
}
