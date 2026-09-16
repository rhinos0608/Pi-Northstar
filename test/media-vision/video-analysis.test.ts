import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runFetchVideoAnalysis } from '../../src/media-vision/video-analysis.js';
import { VIDEO_MAX_KEYFRAMES, type VideoKeyframe } from '../../src/media-vision/pipeline-video.js';
import type { FrameRunner } from '../../src/media-vision/frame-extract.js';

const YT_URL = 'https://www.youtube.com/watch?v=dQw4w9WgXcQ';

function frame(timestampMs: number): VideoKeyframe {
  return { timestampMs, bytes: new Uint8Array([0xff, 0xd8]), mimeType: 'image/jpeg' };
}

const silentRunner: FrameRunner = async () => {
  throw new Error('must not spawn');
};

test('video-analysis: env unset spawns nothing and returns evidence-only', async () => {
  let spawns = 0;
  const runner: FrameRunner = async () => {
    spawns += 1;
    return { code: 0, stdout: new Uint8Array(0), stderr: '', timedOut: false };
  };
  const out = await runFetchVideoAnalysis(YT_URL, {
    env: {},
    runner,
    transcript: async () => 'hello transcript',
    streamInfo: async () => ({ durationSec: 60, title: 'T' }),
  });
  assert.equal(spawns, 0);
  assert.ok(out.warnings.includes('video-frames-opt-in-absent'));
  assert.equal(out.keyframes, 0);
  assert.equal(out.synthesized, false);
  assert.equal(out.degraded, false);
  assert.match(out.text, /hello transcript/);
});

test('video-analysis: opt-in without an eligible tier is evidence-only with warnings', async () => {
  let spawns = 0;
  const runner: FrameRunner = async () => {
    spawns += 1;
    return { code: 0, stdout: new Uint8Array(0), stderr: '', timedOut: false };
  };
  const out = await runFetchVideoAnalysis(YT_URL, {
    env: { PI_VISION_FETCH_VIDEO_FRAMES: '1' },
    runner,
    transcript: async () => 't',
    streamInfo: async () => ({}),
  });
  assert.equal(spawns, 0);
  assert.ok(out.warnings.includes('video-frames-no-vision-tier'));
  assert.equal(out.keyframes, 0);
  // Keyframes were requested (opt-in) but no tier can describe them.
  assert.equal(out.degraded, true);
});

test('video-analysis: tier failure degrades without broadening (eligibleTiersAfterFailure)', async () => {
  let openaiCalls = 0;
  const out = await runFetchVideoAnalysis(YT_URL, {
    env: {
      PI_VISION_FETCH_VIDEO_FRAMES: '1',
      PI_VISION_OPENAI_COMPAT_BASE_URL: 'https://example.com/v1',
      PI_VISION_OPENAI_COMPAT_MODEL: 'm',
    },
    transcript: async () => 't',
    streamInfo: async () => ({}),
    keyframes: async () => [frame(1000)],
    openaiFetch: (async () => {
      openaiCalls += 1;
      throw new Error('tier down');
    }) as never,
  });
  // One call for the keyframe describe, one for the synthesis attempt; both fail.
  assert.equal(openaiCalls, 2);
  // OpenAI tier failed, gemini unconfigured: no keyframe evidence, no invented tier.
  assert.equal(out.keyframes, 0);
  assert.ok(out.warnings.includes('keyframe-1000-vision-empty'));
  assert.ok(out.warnings.includes('synthesis-unavailable'));
  assert.equal(out.synthesized, false);
});

test('video-analysis: keyframes beyond 12 truncate with warning', async () => {
  const many = Array.from({ length: VIDEO_MAX_KEYFRAMES + 2 }, (_, i) => frame(i * 1000));
  const out = await runFetchVideoAnalysis(YT_URL, {
    env: {
      PI_VISION_FETCH_VIDEO_FRAMES: '1',
      PI_VISION_OPENAI_COMPAT_BASE_URL: 'https://example.com/v1',
      PI_VISION_OPENAI_COMPAT_MODEL: 'm',
    },
    transcript: async () => 't',
    streamInfo: async () => ({}),
    keyframes: async () => many,
    describeImage: async (f) => ({ text: `seen at ${f.timestampMs}` }),
  });
  assert.equal(out.keyframes, VIDEO_MAX_KEYFRAMES);
  assert.ok(out.warnings.includes('keyframe-ceiling-12-excess-ignored'));
  assert.equal(out.degraded, false);
});

test('video-analysis: empty transcript warns, keyframe extract failure degrades', async () => {
  const out = await runFetchVideoAnalysis(YT_URL, {
    env: {
      PI_VISION_FETCH_VIDEO_FRAMES: '1',
      PI_VISION_OPENAI_COMPAT_BASE_URL: 'https://example.com/v1',
      PI_VISION_OPENAI_COMPAT_MODEL: 'm',
    },
    transcript: async () => '   ',
    streamInfo: async () => ({}),
    keyframes: async () => {
      throw new Error('nope');
    },
  });
  assert.ok(out.warnings.includes('transcript-empty'));
  assert.ok(out.warnings.includes('keyframe-extract-failed'));
  assert.equal(out.degraded, true);
});

test('video-analysis: synthesis override attaches without touching keyframe counts', async () => {
  const out = await runFetchVideoAnalysis(YT_URL, {
    env: {
      PI_VISION_FETCH_VIDEO_FRAMES: '1',
      PI_VISION_OPENAI_COMPAT_BASE_URL: 'https://example.com/v1',
      PI_VISION_OPENAI_COMPAT_MODEL: 'm',
    },
    transcript: async () => 'spoken words',
    streamInfo: async () => ({ durationSec: 10 }),
    keyframes: async () => [frame(1000)],
    describeImage: async () => ({ text: 'a cat' }),
    synthesize: async () => ({ text: 'digest', model: 'm' }),
  });
  assert.equal(out.synthesized, true);
  assert.deepEqual(out.synthesis, { text: 'digest', model: 'm' });
  assert.equal(out.keyframes, 1);
  assert.match(out.text, /spoken words/);
  assert.match(out.text, /a cat/);
  assert.ok(!out.text.includes('digest'), 'synthesis must not merge into evidence text');
  void silentRunner;
});

test('video-analysis: synthesis configured without frames opt-in spawns zero yt-dlp processes', async () => {
  let spawns = 0;
  const runner: FrameRunner = async () => {
    spawns += 1;
    return { code: 0, stdout: new Uint8Array(0), stderr: '', timedOut: false };
  };
  const out = await runFetchVideoAnalysis(YT_URL, {
    env: {
      PI_VISION_OPENAI_COMPAT_BASE_URL: 'https://example.com/v1',
      PI_VISION_OPENAI_COMPAT_MODEL: 'm',
    },
    runner,
    transcript: async () => 'spoken words here',
    synthesize: async () => ({ text: 'digest', model: 'm' }),
  });
  assert.equal(spawns, 0, 'no yt-dlp/ffmpeg invocation without the exact-1 opt-in');
  assert.ok(out.warnings.includes('video-frames-opt-in-absent'));
  assert.match(out.text, /spoken words here/);
  assert.equal(out.synthesized, true);
  assert.equal(out.keyframes, 0);
});
