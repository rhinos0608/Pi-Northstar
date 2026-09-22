import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { runFetchVideoAnalysis } from '../../src/media-vision/video-analysis.js';
import type { FrameRunner } from '../../src/media-vision/frame-extract.js';
import {
  isGeminiVideoEnabled,
  mimeForVideoPath,
  queryVideoWithGeminiFiles,
} from '../../src/media-vision/gemini.js';
import {
  admitLocalVideoFile,
  buildFfmpegLocalFrameArgv,
  buildFfprobeDurationArgv,
  extractLocalVideoFrames,
  formatLocalFrameTimestamp,
  isLocalVideoFile,
  LOCAL_FRAME_MAX_BYTES,
  parseLocalTimestampSpec,
  parseVideoTimestamp,
  resolveLocalVideoMaxBytes,
  timestampsForLocalRequest,
  toLocalFramePayload,
} from '../../src/media-vision/video-local.js';

function tempVideo(name = 'clip.mp4', bytes = 16): string {
  const dir = mkdtempSync(join(tmpdir(), 'video-local-'));
  const path = join(dir, name);
  writeFileSync(path, Buffer.alloc(bytes, 1));
  return path;
}

const okRunner: FrameRunner = async (command) => {
  if (command === 'ffprobe') {
    return { code: 0, stdout: new Uint8Array(Buffer.from('60\n')), stderr: '', timedOut: false };
  }
  return { code: 0, stdout: new Uint8Array([0xff, 0xd8, 0xff]), stderr: '', timedOut: false };
};

test('video-local: timestamp parsing (secs/MM:SS/H:MM:SS/range)', () => {
  assert.equal(parseVideoTimestamp('90'), 90);
  assert.equal(parseVideoTimestamp('01:30'), 90);
  assert.equal(parseVideoTimestamp('1:02:03'), 3723);
  assert.equal(parseVideoTimestamp('nope'), null);
  assert.equal(parseVideoTimestamp('01:99'), null);
  const range = parseLocalTimestampSpec('00:10-00:20');
  assert.deepEqual(range, { kind: 'range', startSec: 10, endSec: 20 });
  assert.throws(() => parseLocalTimestampSpec('00:20-00:10'), /video-invalid-timestamp/);
  assert.throws(() => parseLocalTimestampSpec('junk'), /video-invalid-timestamp/);
});

test('video-local: timestamp spacing rules', () => {
  // Range: evenly spaced across [start, end].
  assert.deepEqual(
    timestampsForLocalRequest(undefined, { kind: 'range', startSec: 10, endSec: 20 }, 3),
    [10, 15, 20],
  );
  // Single + frames: 5s intervals.
  assert.deepEqual(
    timestampsForLocalRequest(undefined, { kind: 'single', seconds: 30 }, 3),
    [30, 35, 40],
  );
  // Single exact thumb.
  assert.deepEqual(timestampsForLocalRequest(undefined, { kind: 'single', seconds: 7 }, 1), [7]);
  // Frames-only: full-duration sample via ffprobe duration.
  assert.deepEqual(timestampsForLocalRequest(60, null, 3), [15, 30, 45]);
});

test('video-local: isLocalVideoFile detects paths + file://, rejects remote', () => {
  const path = tempVideo();
  assert.equal(isLocalVideoFile(path), true);
  assert.equal(isLocalVideoFile(`file://${path}`), true);
  assert.equal(isLocalVideoFile('https://example.com/clip.mp4'), false);
  assert.equal(isLocalVideoFile('https://www.youtube.com/watch?v=x'), false);
  assert.equal(isLocalVideoFile('/nope/missing.mp4'), false);
  assert.equal(isLocalVideoFile('/tmp/notes.txt'), false);
  assert.equal(isLocalVideoFile('--snap.mp4'), false);
});

test('video-local: size gate defaults 50MB, permits lower-only override, rejects with actionable error', () => {
  assert.equal(resolveLocalVideoMaxBytes({}), 50 * 1024 * 1024);
  assert.equal(resolveLocalVideoMaxBytes({ PI_VISION_VIDEO_MAX_SIZE_MB: '10' }), 10 * 1024 * 1024);
  assert.equal(
    resolveLocalVideoMaxBytes({ PI_VISION_VIDEO_MAX_SIZE_MB: '100' }),
    50 * 1024 * 1024,
    'operator override must not raise the code-owned default ceiling',
  );
  const path = tempVideo('big.mp4', 32);
  // '0' is not a positive int so the default applies and the tiny file passes.
  assert.equal(admitLocalVideoFile(path, {}).byteLength, 32);
  const over = tempVideo('over.mp4', 2 * 1024 * 1024);
  assert.throws(() => admitLocalVideoFile(over, { PI_VISION_VIDEO_MAX_SIZE_MB: '1' }), (error: unknown) => {
    assert.match((error as Error).message, /timestamp.*frames.*compress/s);
    return true;
  });
});

test('video-local: fixed argv uses shell:false-safe array, no forbidden tokens', () => {
  const { command, argv } = buildFfmpegLocalFrameArgv('/tmp/c.mp4', 12.5);
  assert.equal(command, 'ffmpeg');
  assert.deepEqual(argv.slice(0, 7), ['-nostdin', '-hide_banner', '-loglevel', 'error', '-ss', '12.5', '-i']);
  assert.ok(argv.includes('mjpeg') && argv.at(-1) === 'pipe:1');
  assert.equal(buildFfprobeDurationArgv('/tmp/c.mp4').command, 'ffprobe');
  assert.ok(LOCAL_FRAME_MAX_BYTES === 5 * 1024 * 1024);
});

test('video-local: extract frames + payload shape {data, mimeType, timestamp}', async () => {
  const path = tempVideo();
  const frames = await extractLocalVideoFrames(path, {
    env: {},
    timestamp: '00:10',
    frames: 2,
    runner: okRunner,
  });
  assert.equal(frames.length, 2);
  assert.equal(frames[0]?.timestampMs, 10_000);
  assert.equal(frames[1]?.timestampMs, 15_000);
  const payload = toLocalFramePayload(frames[0]!);
  assert.equal(payload.mimeType, 'image/jpeg');
  assert.equal(payload.timestamp, '00:10');
  assert.ok(payload.data.length > 0);
  assert.equal(formatLocalFrameTimestamp(90_000), '01:30');
});

test('video-local: timestamp beyond duration rejects before wasted ffmpeg', async () => {
  const path = tempVideo();
  await assert.rejects(
    extractLocalVideoFrames(path, { env: {}, timestamp: '10:00', runner: okRunner }),
    /video-timestamp-out-of-range/,
  );
});

test('video-local: analysis routes local files through vision tiers, no transcript', async () => {
  const path = tempVideo('scene.mov');
  let describes = 0;
  const out = await runFetchVideoAnalysis(path, {
    env: {
      PI_VISION_FETCH_VIDEO_FRAMES: '1',
      PI_VISION_OPENAI_COMPAT_BASE_URL: 'https://example.com/v1',
      PI_VISION_OPENAI_COMPAT_MODEL: 'm',
    },
    runner: okRunner,
    describeImage: async () => {
      describes += 1;
      return { text: 'a red car' };
    },
  });
  assert.ok(describes > 0, 'local frames described through existing tier');
  assert.match(out.text, /a red car/);
  assert.match(out.text, /scene\.mov/);
  assert.ok(out.warnings.includes('transcript-unavailable-local-file'));
  assert.equal(out.degraded, false);
});

test('video-local: analysis without opt-in spawns nothing', async () => {
  const path = tempVideo();
  let spawns = 0;
  const runner: FrameRunner = async () => {
    spawns += 1;
    return { code: 0, stdout: new Uint8Array(0), stderr: '', timedOut: false };
  };
  const out = await runFetchVideoAnalysis(path, { env: {}, runner });
  assert.equal(spawns, 0);
  assert.ok(out.warnings.includes('video-frames-opt-in-absent'));
});

test('video-gemini: flag exact-1 only, default off', () => {
  assert.equal(isGeminiVideoEnabled({}), false);
  assert.equal(isGeminiVideoEnabled({ PI_VISION_VIDEO_GEMINI: '1' }), true);
  assert.equal(isGeminiVideoEnabled({ PI_VISION_VIDEO_GEMINI: 'true' }), false);
  assert.equal(isGeminiVideoEnabled({ PI_VISION_VIDEO_GEMINI: '' }), false);
  assert.equal(mimeForVideoPath('/tmp/c.mp4'), 'video/mp4');
  assert.equal(mimeForVideoPath('/tmp/c.webm'), 'video/webm');
  assert.equal(mimeForVideoPath('/tmp/notes.txt'), undefined);
});

function mockFilesFetch(calls: string[], queryText = 'a man pours coffee'): typeof fetch {
  const seenPolls = { count: 0 };
  return (async (url: string | URL | Request, init?: RequestInit) => {
    const target = String(url);
    const method = (init?.method ?? 'GET').toUpperCase();
    calls.push(method + ' ' + target.split('?')[0]);
    const json = async (): Promise<unknown> => {
      if (method === 'POST' && target === 'https://generativelanguage.googleapis.com/upload-session/s') return { file: { name: 'files/abc', uri: 'https://x/files/abc' } };
      if (method === 'GET') {
        seenPolls.count += 1;
        return seenPolls.count >= 2 ? { state: 'ACTIVE' } : { state: 'PROCESSING' };
      }
      if (target.includes(':generateContent')) {
        return { candidates: [{ content: { parts: [{ text: queryText }] } }] };
      }
      return {};
    };
    const headers =
      method === 'POST' && target.includes('/upload/')
        ? { get: () => 'https://generativelanguage.googleapis.com/upload-session/s' }
        : { get: () => null };
    return { ok: true, status: 200, headers, json } as unknown as Response;
  }) as typeof fetch;
}

const developerConfig = { model: 'gemini-2.0-flash', auth: { kind: 'developer' } } as const;

test('video-gemini: disabled flag makes zero fetch calls', async () => {
  const calls: string[] = [];
  const out = await queryVideoWithGeminiFiles(new Uint8Array([1, 2, 3]), '/tmp/c.mp4', 'p', developerConfig, {
    env: {},
    fetchImpl: mockFilesFetch(calls),
    sleep: async () => {},
  });
  assert.equal(out.ok, false);
  assert.deepEqual(calls, []);
});

test('video-gemini: flag on but no key makes zero fetch calls', async () => {
  const calls: string[] = [];
  const out = await queryVideoWithGeminiFiles(new Uint8Array([1, 2, 3]), '/tmp/c.mp4', 'p', developerConfig, {
    env: { PI_VISION_VIDEO_GEMINI: '1' },
    fetchImpl: mockFilesFetch(calls),
    sleep: async () => {},
  });
  assert.equal(out.ok, false);
  if (!out.ok) assert.equal(out.reason, 'unconfigured');
  assert.deepEqual(calls, []);
});

test('video-gemini: full lifecycle uploads, polls ACTIVE, queries, DELETEs', async () => {
  const calls: string[] = [];
  const out = await queryVideoWithGeminiFiles(new Uint8Array([1, 2, 3]), '/tmp/c.mp4', 'p', developerConfig, {
    env: { PI_VISION_VIDEO_GEMINI: '1', GEMINI_API_KEY: 'test-key' },
    fetchImpl: mockFilesFetch(calls),
    sleep: async () => {},
  });
  assert.equal(out.ok, true);
  if (out.ok) {
    assert.match(out.text, /pours coffee/);
    assert.ok(out.warnings.includes('video-gemini-files'));
  }
  assert.ok(calls[0]?.startsWith('POST'), 'resumable start first');
  assert.ok(calls.includes('POST https://generativelanguage.googleapis.com/upload-session/s'), 'resumable byte upload POST');
  assert.ok(calls.some((call) => call.startsWith('POST') && call.includes(':generateContent')), 'prompt + file URI query');
  assert.ok(calls.at(-1)?.startsWith('DELETE'), 'cleanup last');
});

test('video-gemini: query failure still DELETEs hosted file', async () => {
  const calls: string[] = [];
  const innerCalls: string[] = [];
  const inner = mockFilesFetch(innerCalls);
  const failing: typeof fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    const target = String(url);
    const method = (init?.method ?? 'GET').toUpperCase();
    calls.push(method + ' ' + target.split('?')[0]);
    if (target.includes(':generateContent')) {
      return { ok: false, status: 500, headers: { get: () => null }, json: async () => ({}) } as unknown as Response;
    }
    return inner(url, init);
  }) as typeof fetch;
  const out = await queryVideoWithGeminiFiles(new Uint8Array([1, 2, 3]), '/tmp/c.mp4', 'p', developerConfig, {
    env: { PI_VISION_VIDEO_GEMINI: '1', GEMINI_API_KEY: 'test-key' },
    fetchImpl: failing,
    sleep: async () => {},
  });
  assert.equal(out.ok, false);
  assert.ok(calls.at(-1)?.startsWith('DELETE'), 'cleanup in finally');
});

test('video-gemini: provider AbortError propagates instead of degrading to metadata-only', async () => {
  const path = tempVideo('abort.mp4');
  await assert.rejects(
    () => runFetchVideoAnalysis(path, {
      env: {
        PI_VISION_VIDEO_GEMINI: '1',
        PI_VISION_GEMINI_ENABLED: '1',
        GEMINI_API_KEY: 'test-key',
      },
      geminiVideo: async () => {
        const error = new Error('request cancelled');
        error.name = 'AbortError';
        throw error;
      },
    }),
    (error: unknown) => error instanceof Error && error.name === 'AbortError',
  );
});

test('video-gemini: analysis falls to Files API seam when local frames yield nothing', async () => {
  const path = tempVideo('scene.mp4');
  const out = await runFetchVideoAnalysis(path, {
    env: {
      PI_VISION_VIDEO_GEMINI: '1',
      PI_VISION_GEMINI_ENABLED: '1',
      GEMINI_API_KEY: 'test-key',
    },
    geminiVideo: async () => ({ ok: true as const, text: 'full-file summary', warnings: ['video-gemini-files'] }),
  });
  assert.match(out.text, /full-file summary/);
  assert.ok(out.warnings.includes('video-gemini-files'));
  assert.equal(out.degraded, false);
});

test('video-gemini: no API key falls to Web seam; no lease warns', async () => {
  const path = tempVideo('nowkey.mp4');
  const viaWeb = await runFetchVideoAnalysis(path, {
    env: { PI_VISION_VIDEO_GEMINI: '1' },
    geminiWebVideo: async () => ({ ok: true as const, text: 'web summary', warnings: ['last-resort-web-route'] }),
  });
  assert.match(viaWeb.text, /web summary/);
  assert.equal(viaWeb.degraded, false);
  const noLease = await runFetchVideoAnalysis(path, { env: { PI_VISION_VIDEO_GEMINI: '1' } });
  assert.ok(noLease.warnings.includes('gemini-web-lease-unavailable'));
  assert.equal(noLease.degraded, true, 'metadata-only local video after fallback failure must report degraded');
});

test('video-gemini: flag off keeps existing degraded behavior, zero extra calls', async () => {
  const path = tempVideo('off.mp4');
  let videoCalls = 0;
  let webCalls = 0;
  const out = await runFetchVideoAnalysis(path, {
    env: {},
    geminiVideo: async () => {
      videoCalls += 1;
      return { ok: true as const, text: 'x', warnings: [] };
    },
    geminiWebVideo: async () => {
      webCalls += 1;
      return { ok: true as const, text: 'x', warnings: [] };
    },
  });
  assert.equal(videoCalls, 0);
  assert.equal(webCalls, 0);
  assert.ok(out.warnings.includes('transcript-unavailable-local-file'));
  assert.equal(out.degraded, true, 'metadata-only local video must remain explicitly degraded');
});

test('video-gemini-web lease: production seam is fail-closed without owners', async () => {
  const { acquireGeminiWebLeaseFromChromeOwners, isGeminiWebLeaseUnavailableError } = await import(
    '../../src/media-vision/gemini-web.js'
  );
  // Disabled flag throws before any lease/browser work.
  await assert.rejects(acquireGeminiWebLeaseFromChromeOwners({}), /disabled/);
  // Enabled with no Chrome owners supplied still fails closed, never faking success.
  const err = await acquireGeminiWebLeaseFromChromeOwners({ PI_VISION_GEMINI_WEB_ENABLED: '1' }).then(
    () => null,
    (error: unknown) => error,
  );
  assert.ok(err instanceof Error);
  assert.ok(isGeminiWebLeaseUnavailableError(err));
  assert.match((err as Error).message, /gemini-web-lease-unavailable/);
  assert.equal(isGeminiWebLeaseUnavailableError(new Error('provider boom')), false);
});

test('video-gemini-web lease: throwing lease degrades with warning, never throws', async () => {
  const path = tempVideo('lease-throw.mp4');
  const out = await runFetchVideoAnalysis(path, {
    env: { PI_VISION_VIDEO_GEMINI: '1', PI_VISION_GEMINI_WEB_ENABLED: '1' },
    acquireGeminiWebLease: async () => {
      throw new Error('gemini-web-lease-unavailable: revoked mid-flight');
    },
  });
  assert.ok(out.warnings.includes('gemini-web-unavailable'));
  assert.equal(out.degraded, true, 'failed full-file lease leaves local video metadata-only');
});

test('video-gemini-web lease: injected mock lease answers through the fallback', async () => {
  const path = tempVideo('lease-inject.mp4');
  const seen: string[] = [];
  const out = await runFetchVideoAnalysis(path, {
    env: { PI_VISION_VIDEO_GEMINI: '1', PI_VISION_GEMINI_WEB_ENABLED: '1' },
    acquireGeminiWebLease: async () => ({
      origin: 'https://gemini.google.com',
      navigate: async (url: string) => {
        seen.push(url);
      },
      attachFile: async (filePath: string) => {
        seen.push(`file:${filePath}`);
      },
      evaluate: async <T>(script: string): Promise<T> => {
        seen.push(script.slice(0, 7));
        return 'injected web summary' as T;
      },
    }),
  });
  assert.match(out.text, /injected web summary/);
  assert.ok(out.warnings.includes('last-resort-web-route'));
  assert.equal(out.degraded, false);
  assert.ok(seen.some((entry) => entry.startsWith('https://gemini.google.com')));
  assert.ok(seen.some((entry) => entry.startsWith('file:')));
  assert.ok(seen.includes('prompt:'));
});

test('video-gemini-web lease: live fallback with no owners stays fail-closed', async () => {
  const path = tempVideo('lease-live-none.mp4');
  const out = await runFetchVideoAnalysis(path, {
    env: { PI_VISION_VIDEO_GEMINI: '1', PI_VISION_GEMINI_WEB_ENABLED: '1' },
  });
  assert.ok(
    out.warnings.includes('gemini-web-lease-unavailable') || out.warnings.includes('gemini-web-unavailable') || out.warnings.includes('gemini-web-cookie-unavailable'),
    `expected a lease warning, got ${JSON.stringify(out.warnings)}`,
  );
  assert.equal(out.degraded, true, 'no usable full-file fallback leaves local video metadata-only');
});
