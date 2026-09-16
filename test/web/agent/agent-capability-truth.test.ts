import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  gatherActionAdmissibility,
  snapshotForJob,
} from '../../../src/web/agent/agent-capabilities.js';
import {
  buildNativeGatherTools,
  EXECUTOR_SUPPORTED_SPECIALIST_LANES,
  gatherExecutor,
} from '../../../src/web/agent/agent-gather.js';
import { intentToGatherActionLike, type GatherIntent } from '../../../src/web/agent/agent-gather-intents.js';
import { admissibleGatherLanes } from '../../../src/web/agent/agent-policy.js';
import { createAgentState } from '../../../src/web/agent/agent-state.js';

// Wave 9 (D4) capability truth: advertised ⊆ executable.

const MACHINE_CAPABLE_ENV: Record<string, string | undefined> = {
  YOUTUBE_API_KEY: 'key',
  BILI_CLI_PRESENT: '1',
  BILIBILI_SESSDATA: 'sess',
  OPENCLI_PRESENT: '1',
  REDDIT_COOKIE: 'cookie',
  DIFFBOT_TOKEN: 'token',
};

test('(a) machine-capable social/video snapshot advertises no usable specialist lane', () => {
  const snap = snapshotForJob(MACHINE_CAPABLE_ENV);
  assert.equal(snap.video.youtube.usable, false);
  assert.equal(snap.video.bilibili.usable, false);
  assert.equal(snap.video.youtube.quality, 'unavailable');
  assert.equal(snap.video.bilibili.quality, 'unavailable');
  // Machine truth stays observable: backends name the real surfaces.
  assert.equal(snap.video.youtube.backend, 'youtube-data-api');
  assert.equal(snap.video.bilibili.backend, 'bili-cli');
  for (const entry of snap.social) {
    assert.equal(entry.usable, false, `${entry.action} must not be usable`);
    assert.equal(entry.quality, 'unavailable');
    assert.match(entry.reason ?? '', /no executor tool surface/);
  }
  // Degraded-to-web fallback information survives (deny path), not as a lane.
  const denied = gatherActionAdmissibility({ kind: 'social', platform: 'v2ex' }, snap);
  assert.equal(denied.allowed, false);
  assert.equal(denied.degradeTo, 'web');
});

test('(b) research/github/kg advertisement matches buildNativeGatherTools exactly', async () => {
  assert.deepEqual([...EXECUTOR_SUPPORTED_SPECIALIST_LANES], ['research', 'github', 'kg']);
  const tools = buildNativeGatherTools({
    search: async () => [],
    fetchText: async () => '',
    callNative: async () => ({}),
  });
  const provided = ['research', 'github', 'kg'].filter(
    (lane) => tools[lane as 'research' | 'github' | 'kg'] !== undefined,
  );
  assert.deepEqual(provided, [...EXECUTOR_SUPPORTED_SPECIALIST_LANES]);
  assert.equal(tools.social, undefined);
  assert.equal(tools.video, undefined);
  // Snapshot advertises exactly the executor set: research/github always on,
  // kg gated on DIFFBOT_TOKEN like the native surface it rides.
  const snap = snapshotForJob(MACHINE_CAPABLE_ENV);
  assert.deepEqual([...snap.executorSupportedLanes], [...EXECUTOR_SUPPORTED_SPECIALIST_LANES]);
  assert.equal(snap.research.usable, true);
  assert.equal(snap.github.usable, true);
  assert.equal(snap.kg.usable, true);
  assert.equal(snapshotForJob({}).kg.usable, false);
});

test('(c) executor emits no "no tool surface" warning for any advertised lane', async () => {
  const tools = buildNativeGatherTools({
    search: async () => [{ title: 'Fallback hit', url: 'https://example.com/fallback', snippet: 'words' }],
    fetchText: async () => 'Fallback body text with enough detail words to admit a passage here.',
    callNative: async (name) => {
      if (name === 'research') {
        return {
          details: {
            results: [
              {
                title: 'Study',
                url: 'https://example.com/paper',
                source: 'openalex',
                abstract: 'Study abstract with measured conclusions drawn here fully and clearly stated.',
              },
            ],
          },
        };
      }
      return {};
    },
  });
  const snapshot = snapshotForJob({ DIFFBOT_TOKEN: 'token' });
  const ctx = {
    snapshot,
    state: createAgentState({ goal: 'capability truth probe' }),
    counters: { searchesUsed: 0, fetchesUsed: 0 },
    tools,
  };
  const outcome = await gatherExecutor(
    [
      { kind: 'research_search', query: 'Acme Pro pricing academic studies' },
      { kind: 'github_search', scope: 'repo', query: 'Acme Pro launch repository' },
      { kind: 'kg_lookup', entityType: 'Organization', name: 'Acme Pro' },
      // Deferred lanes degrade via the snapshot gate — still warned, but never
      // via the tool-surface path.
      { kind: 'social_search', platform: 'v2ex', query: 'Acme Pro launch price discussion' },
      { kind: 'video_transcript', videoHint: 'Acme Pro launch keynote recording' },
    ] as GatherIntent[],
    1,
    ctx,
  );
  assert.ok(
    outcome.warnings.every((warning) => !warning.includes('no tool surface')),
    `unexpected tool-surface warning: ${outcome.warnings.join(' | ')}`,
  );
  assert.deepEqual(
    outcome.perAction.map((entry) => entry.degraded),
    [false, false, false, true, true],
  );
  assert.ok(
    outcome.admitted.some((entry) => entry.sourceRef.acquisitionRoute === 'research'),
    'research lane still admits through the native surface',
  );
});

test('(d) video intent cannot be planned: lane unadvertised, admissibility denies', () => {
  const snap = snapshotForJob(MACHINE_CAPABLE_ENV);
  const lanes = admissibleGatherLanes(snap);
  assert.ok(!lanes.includes('video'), 'video must not be an admissible lane');
  assert.ok(!lanes.includes('social'), 'social must not be an admissible lane');
  assert.deepEqual(lanes, ['web', 'research', 'github', 'kg']);
  // The intent contract still validates video_transcript (union untouched) —
  // it just maps to an inadmissible lane, so no plan can serve it.
  const intent: GatherIntent = { kind: 'video_transcript', videoHint: 'Acme Pro launch keynote recording' };
  const like = intentToGatherActionLike(intent);
  assert.deepEqual(like, { kind: 'media_video', platform: 'youtube' });
  const verdict = gatherActionAdmissibility(like, snap);
  assert.equal(verdict.allowed, false);
  assert.equal(verdict.degradeTo, 'web');
});
