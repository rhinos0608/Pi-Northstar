import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  assertFrameArgvAllowed,
  buildFfmpegFrameArgv,
  buildFrameChildEnv,
  buildYtDlpStreamArgv,
  defaultFrameRunner,
  extractYoutubeKeyframes,
  FORBIDDEN_FRAME_ARGV_TOKENS,
  isVideoFramesOptIn,
  isYoutubeFetchVideoUrl,
  readYoutubeStreamInfo,
  VIDEO_FRAMES_ENV_VAR,
  VIDEO_MAX_KEYFRAMES,
  FrameExtractError,
  type FrameRunner,
} from '../../src/media-vision/frame-extract.js';

const YT_URL = 'https://www.youtube.com/watch?v=dQw4w9WgXcQ';

function okRunner(
  stdout: string,
  calls: Array<{ command: string; argv: readonly string[] }>,
): FrameRunner {
  return async (command, argv, options) => {
    assert.ok(options.env, 'runner must receive a sanitized env');
    calls.push({ command, argv: [...argv] });
    return { code: 0, stdout: Buffer.from(stdout), stderr: '', timedOut: false };
  };
}

test('frame-extract: opt-in is exact-string PI_VISION_FETCH_VIDEO_FRAMES=1', () => {
  assert.equal(isVideoFramesOptIn({ [VIDEO_FRAMES_ENV_VAR]: '1' }), true);
  assert.equal(isVideoFramesOptIn({}), false);
  assert.equal(isVideoFramesOptIn({ [VIDEO_FRAMES_ENV_VAR]: 'true' }), false);
  assert.equal(isVideoFramesOptIn({ [VIDEO_FRAMES_ENV_VAR]: '' }), false);
});

test('frame-extract: youtube URL gate accepts watch/shorts, rejects rest', () => {
  assert.equal(isYoutubeFetchVideoUrl('https://www.youtube.com/watch?v=abc'), true);
  assert.equal(isYoutubeFetchVideoUrl('https://youtube.com/shorts/abc'), true);
  assert.equal(isYoutubeFetchVideoUrl('https://youtu.be/abc'), true);
  assert.equal(isYoutubeFetchVideoUrl('https://www.youtube.com/embed/abc'), false);
  assert.equal(isYoutubeFetchVideoUrl('https://evil-youtube.com/watch?v=abc'), false);
  assert.equal(isYoutubeFetchVideoUrl('https://example.com/video.mp4'), false);
  assert.equal(isYoutubeFetchVideoUrl('file:///tmp/clip.mp4'), false);
  assert.equal(isYoutubeFetchVideoUrl('not a url'), false);
});

test('frame-extract: yt-dlp argv is fixed with --no-config, ffmpeg argv pipes a single JPEG', () => {
  const ytdlp = buildYtDlpStreamArgv(YT_URL);
  assert.equal(ytdlp.command, 'yt-dlp');
  assert.ok(ytdlp.argv.includes('--no-config'), '--no-config must always be present');
  assert.ok(ytdlp.argv.includes('--no-cache-dir'));
  assert.ok(ytdlp.argv.includes('--no-playlist'));
  assert.ok(ytdlp.argv.includes('--print'));
  assert.ok(ytdlp.argv.includes('urls'));
  assert.equal(ytdlp.argv[ytdlp.argv.length - 1], YT_URL);

  const ffmpeg = buildFfmpegFrameArgv('https://example.com/stream', 12.5);
  assert.equal(ffmpeg.command, 'ffmpeg');
  assert.deepEqual(
    ffmpeg.argv,
    ['-nostdin', '-hide_banner', '-loglevel', 'error', '-ss', '12.5', '-i',
      'https://example.com/stream', '-frames:v', '1', '-f', 'image2pipe', '-vcodec', 'mjpeg', 'pipe:1'],
  );
});

test('frame-extract: forbidden flag list never emitted on any branch', () => {
  for (const argv of [buildYtDlpStreamArgv(YT_URL).argv, buildFfmpegFrameArgv('https://example.com/s', 1).argv]) {
    for (const forbidden of FORBIDDEN_FRAME_ARGV_TOKENS) {
      assert.ok(!argv.includes(forbidden), `argv must never contain ${forbidden}`);
    }
    assertFrameArgvAllowed(argv);
  }
  for (const forbidden of FORBIDDEN_FRAME_ARGV_TOKENS) {
    assert.throws(() => assertFrameArgvAllowed(['yt-dlp', forbidden]), /forbidden token/);
  }
  // No argv passthrough API: builders take URLs/seconds only, never raw flags.
  assert.equal(extractYoutubeKeyframes.length, 1, 'only (url, options?); no argv param');
});

test('frame-extract: child env carries no cookie/proxy/secret keys (sentinel check)', () => {
  process.env.TEST_SECRET_TOKEN = 'sentinel-value';
  process.env.MY_COOKIE_JAR = 'sentinel-cookie';
  try {
    const env = buildFrameChildEnv();
    assert.equal(env.TEST_SECRET_TOKEN, undefined);
    assert.equal(env.MY_COOKIE_JAR, undefined);
    assert.equal(env.GITHUB_TOKEN, undefined);
    const fromParent = buildFrameChildEnv({ PATH: '/usr/bin', GITHUB_TOKEN: 'x', HTTPS_PROXY: 'http://x' });
    assert.equal(fromParent.PATH, '/usr/bin');
    assert.equal(fromParent.GITHUB_TOKEN, undefined);
    assert.equal(fromParent.HTTPS_PROXY, undefined);
  } finally {
    delete process.env.TEST_SECRET_TOKEN;
    delete process.env.MY_COOKIE_JAR;
  }
});

test('frame-extract: keyframe ceiling rejects (reject-not-clamp)', async () => {
  await assert.rejects(() => extractYoutubeKeyframes(YT_URL, { count: VIDEO_MAX_KEYFRAMES + 1 }), FrameExtractError);
  await assert.rejects(() => extractYoutubeKeyframes(YT_URL, { count: 0 }), FrameExtractError);
  await assert.rejects(() => extractYoutubeKeyframes(YT_URL, { count: 1.5 }), FrameExtractError);
  assert.equal(VIDEO_MAX_KEYFRAMES, 12);
});

test('frame-extract: non-youtube URL rejects before any spawn', async () => {
  let calls = 0;
  const runner: FrameRunner = async () => {
    calls += 1;
    return { code: 0, stdout: new Uint8Array(0), stderr: '', timedOut: false };
  };
  await assert.rejects(() => extractYoutubeKeyframes('https://example.com/x.mp4', { runner }), /unsupported-video-url/);
  assert.equal(calls, 0);
});

test('frame-extract: stream info parses duration/title/urls; missing URL maps to fixed error', async () => {
  const calls: Array<{ command: string; argv: readonly string[] }> = [];
  const info = await readYoutubeStreamInfo(YT_URL, {
    runner: okRunner('123.5\nSome Title\nhttps://example.com/stream\n', calls),
  });
  assert.equal(info.durationSec, 123.5);
  assert.equal(info.title, 'Some Title');
  assert.equal(info.streamUrl, 'https://example.com/stream');
  assert.equal(calls[0]?.command, 'yt-dlp');
  assert.ok(calls[0]?.argv.includes('--no-config'));

  await assert.rejects(
    () => readYoutubeStreamInfo(YT_URL, { runner: okRunner('NA\nNA\n', []) }),
    /yt-dlp-failed/,
  );
});

test('frame-extract: yt-dlp failure maps to fixed strings, never stderr echo', async () => {
  const failing = (stderr: string): FrameRunner => async () => ({ code: 1, stdout: new Uint8Array(0), stderr, timedOut: false });
  await assert.rejects(() => readYoutubeStreamInfo(YT_URL, { runner: failing('ERROR: Private video') }), /video-private-or-age-restricted/);
  await assert.rejects(() => readYoutubeStreamInfo(YT_URL, { runner: failing('This video is available in another region') }), /video-region-restricted/);
  await assert.rejects(() => readYoutubeStreamInfo(YT_URL, { runner: failing('live stream recording') }), /video-live-stream/);
  await assert.rejects(() => readYoutubeStreamInfo(YT_URL, { runner: failing('Video unavailable') }), /video-unavailable/);
  await assert.rejects(() => readYoutubeStreamInfo(YT_URL, { runner: failing('HTTP Error 404: Not Found') }), /video-not-found/);
  await assert.rejects(() => readYoutubeStreamInfo(YT_URL, { runner: failing('weird blowup with secret=xyz') }), /yt-dlp-failed/);
  try {
    await readYoutubeStreamInfo(YT_URL, { runner: failing('weird blowup with secret=xyz') });
  } catch (error) {
    assert.ok(!(error as Error).message.includes('secret=xyz'), 'stderr must never echo');
  }
});

test('frame-extract: missing binary maps to frame-binary-missing', async () => {
  const enoent: FrameRunner = async () => ({ code: 127, stdout: new Uint8Array(0), stderr: '', timedOut: false });
  await assert.rejects(() => extractYoutubeKeyframes(YT_URL, { runner: enoent }), /frame-binary-missing/);
});

test('frame-extract: per-frame timeout maps to frame-extract-timeout', async () => {
  const calls: Array<{ command: string; argv: readonly string[] }> = [];
  const runner: FrameRunner = async (command) => {
    calls.push({ command, argv: [] });
    if (command === 'yt-dlp') return { code: 0, stdout: Buffer.from('60\nT\nhttps://example.com/s\n'), stderr: '', timedOut: false };
    return { code: 0, stdout: new Uint8Array(0), stderr: '', timedOut: true };
  };
  await assert.rejects(() => extractYoutubeKeyframes(YT_URL, { runner, count: 1 }), /frame-extract-timeout/);
});

test('frame-extract: ffmpeg failure/empty output maps to ffmpeg-failed', async () => {
  const runner: FrameRunner = async (command) => {
    if (command === 'yt-dlp') return { code: 0, stdout: Buffer.from('60\nT\nhttps://example.com/s\n'), stderr: '', timedOut: false };
    return { code: 1, stdout: new Uint8Array(0), stderr: 'boom', timedOut: false };
  };
  await assert.rejects(() => extractYoutubeKeyframes(YT_URL, { runner, count: 1 }), /ffmpeg-failed/);
});

test('frame-extract: keyframes carry timestampMs + jpeg bytes', async () => {
  const runner: FrameRunner = async (command) => {
    if (command === 'yt-dlp') return { code: 0, stdout: Buffer.from('90\nT\nhttps://example.com/s\n'), stderr: '', timedOut: false };
    return { code: 0, stdout: new Uint8Array([0xff, 0xd8, 0xff]), stderr: '', timedOut: false };
  };
  const frames = await extractYoutubeKeyframes(YT_URL, { runner, count: 2 });
  assert.equal(frames.length, 2);
  assert.equal(frames[0]?.mimeType, 'image/jpeg');
  assert.ok((frames[0]?.timestampMs ?? 0) < (frames[1]?.timestampMs ?? 0), 'timestamps spread across duration');
  assert.ok((frames[0]?.bytes.byteLength ?? 0) > 0);
});

test('frame-extract: abort propagates Aborted', async () => {
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    () => extractYoutubeKeyframes(YT_URL, { signal: controller.signal, count: 1 }),
    /Aborted/,
  );
});

test('frame-extract: default runner times out a hung child (SIGTERM->SIGKILL)', async () => {
  const started = Date.now();
  await assert.rejects(
    () =>
      defaultFrameRunner(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
        env: buildFrameChildEnv(),
        timeoutMs: 100,
      }).then((result) => {
        if (result.timedOut) throw new FrameExtractError('frame-extract-timeout');
        return result;
      }),
    /frame-extract-timeout/,
  );
  assert.ok(Date.now() - started < 15_000, 'kill escalation must bound the run');
});

test('frame-extract: assertFrameArgvAllowed rejects --flag=value and --flag:value smuggling', () => {
  for (const token of ['--cookies=/tmp/x', '--cookies-from-browser=chrome', '--proxy=http://127.0.0.1:9']) {
    assert.throws(() => assertFrameArgvAllowed(['yt-dlp', token]), /forbidden token/);
  }
  for (const token of ['--username:u', '--password:p', '--netrc:x', '--config-location:/tmp/c']) {
    assert.throws(() => assertFrameArgvAllowed(['yt-dlp', token]), /forbidden token/);
  }
  // Exact -c stays banned; lookalikes that are not the flag pass.
  assert.throws(() => assertFrameArgvAllowed(['ffmpeg', '-c']), /forbidden token/);
  assertFrameArgvAllowed(['ffmpeg', '-nostdin', '-hide_banner']);
  assertFrameArgvAllowed(['yt-dlp', '--no-config', '--cookieshop']);
});
