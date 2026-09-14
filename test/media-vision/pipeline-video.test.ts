// Plan D Task D4 video-pipeline tests: metadata + transcript first (internal
// src/media/* shapes, injected), ≤12 timestamped keyframes after; no-ffmpeg
// path returns metadata + transcript only with warnings.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  VIDEO_MAX_KEYFRAMES,
  runVideoPipeline,
} from '../../src/media-vision/pipeline-video.js';
import { chunkVisionEvidence, rankVisionChunks } from '../../src/media-vision/pipeline-image.js';

function baseSeams() {
  return {
    async readMetadata() {
      return { title: 'Launch keynote', durationSec: 600 };
    },
    async readTranscript() {
      return [
        { timestampMs: 1000, text: 'Welcome to the launch event.' },
        { timestampMs: 61000, text: 'Our new chip is twice as fast.' },
      ];
    },
  };
}

test('metadata + transcript come first as extracted entries with timestamps', async () => {
  const result = await runVideoPipeline({
    ...baseSeams(),
    readKeyframes: undefined,
    describeKeyframe: undefined,
  });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  const kinds = result.evidence.map((e) => `${e.kind}:${e.sourceKind}`);
  assert.ok(kinds.includes('metadata:extracted'));
  assert.ok(kinds.filter((k) => k === 'transcript:extracted').length === 2);
  const stamps = result.evidence
    .filter((e) => e.kind === 'transcript')
    .map((e) => e.locator.timestampMs);
  assert.deepEqual(stamps, [1000, 61000]);
  assert.ok(result.warnings.includes('no-keyframe-source-metadata-transcript-only'));
});

test('keyframes add derived timestamped entries after transcript', async () => {
  const result = await runVideoPipeline({
    ...baseSeams(),
    async readKeyframes() {
      return [{ timestampMs: 5000, bytes: new Uint8Array([1]), mimeType: 'image/jpeg' }];
    },
    async describeKeyframe(frame) {
      assert.equal(frame.timestampMs, 5000);
      return { text: 'Stage with a large screen.' };
    },
  });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  const keyframes = result.evidence.filter((e) => e.kind === 'keyframe');
  assert.equal(keyframes.length, 1);
  assert.equal(keyframes[0]?.sourceKind, 'derived');
  assert.equal(keyframes[0]?.locator.timestampMs, 5000);
  const transcriptIdx = result.evidence.findIndex((e) => e.kind === 'transcript');
  const keyIdx = result.evidence.findIndex((e) => e.kind === 'keyframe');
  assert.ok(transcriptIdx >= 0 && keyIdx > transcriptIdx);
});

test('keyframe count caps at 12 with warning; excess ignored', async () => {
  let described = 0;
  const result = await runVideoPipeline({
    ...baseSeams(),
    async readKeyframes() {
      return Array.from({ length: 15 }, (_, i) => ({
        timestampMs: i * 1000,
        bytes: new Uint8Array([1]),
        mimeType: 'image/jpeg',
      }));
    },
    async describeKeyframe() {
      described += 1;
      return { text: 'frame' };
    },
  });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(described, VIDEO_MAX_KEYFRAMES);
  assert.ok(result.warnings.includes('keyframe-ceiling-12-excess-ignored'));
});

test('over-duration video rejects before any evidence', async () => {
  let transcripts = 0;
  const result = await runVideoPipeline({
    async readMetadata() {
      return { title: 'marathon', durationSec: 121 * 60 };
    },
    async readTranscript() {
      transcripts += 1;
      return [];
    },
  });
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.reason, 'over-duration-ceiling');
  assert.equal(transcripts, 0);
});

test('video evidence chunks rank through shared BM25 path', async () => {
  const result = await runVideoPipeline(baseSeams());
  assert.equal(result.ok, true);
  if (!result.ok) return;
  const chunked = chunkVisionEvidence(result.evidence);
  assert.ok(chunked.length >= 3);
  const ranked = rankVisionChunks(chunked, 'chip twice as fast');
  assert.ok((ranked[0]?.bm25Score ?? 0) > 0);
});
