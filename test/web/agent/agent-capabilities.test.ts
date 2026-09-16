import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  formatCapabilitiesForPrompt,
  gatherActionAdmissibility,
  MAX_CAPABILITIES_PROMPT_BYTES,
  resolveEffectiveCapabilities,
  snapshotForJob,
  type CliProbe,
  type EffectiveCapabilitiesSnapshot,
} from '../../../src/web/agent/agent-capabilities.js';

const EMPTY_ENV: Record<string, string | undefined> = {};

function env(overrides: Record<string, string | undefined>): Record<string, string | undefined> {
  return { ...overrides };
}

const probeFalse: CliProbe = async () => false;

function cliProbe(present: readonly string[]): CliProbe {
  return async (cmd: string) => present.includes(cmd);
}

test('web/research/github always usable full on empty env', async () => {
  const snap = await resolveEffectiveCapabilities(EMPTY_ENV, { probe: probeFalse });
  assert.equal(snap.web.usable, true);
  assert.equal(snap.web.quality, 'full');
  assert.equal(snap.research.usable, true);
  assert.equal(snap.research.quality, 'full');
  assert.equal(snap.github.usable, true);
  assert.equal(snap.github.quality, 'full');
});

test('youtube gate matrix: machine truth preserved but never usable (no executor surface)', async () => {
  // Wave 9 (D4): the snapshot is machine ∧ executor lanes. Machine backends
  // and reasons stay observable; usable is always false for video.
  const full = await resolveEffectiveCapabilities(env({ YOUTUBE_API_KEY: 'k' }), { probe: probeFalse });
  assert.equal(full.video.youtube.quality, 'unavailable');
  assert.equal(full.video.youtube.usable, false);
  assert.equal(full.video.youtube.backend, 'youtube-data-api');
  assert.match(full.video.youtube.reason ?? '', /no executor tool surface/);
  assert.match(full.video.youtube.reason ?? '', /YOUTUBE_API_KEY present/);

  const degraded = await resolveEffectiveCapabilities(env({ YOUTUBE_COOKIE: 'c' }), { probe: probeFalse });
  assert.equal(degraded.video.youtube.quality, 'unavailable');
  assert.equal(degraded.video.youtube.usable, false);
  assert.equal(degraded.video.youtube.backend, 'youtube-transcript');
  assert.match(degraded.video.youtube.reason ?? '', /no executor tool surface/);

  const off = await resolveEffectiveCapabilities(EMPTY_ENV, { probe: probeFalse });
  assert.equal(off.video.youtube.quality, 'unavailable');
  assert.equal(off.video.youtube.usable, false);
  assert.match(off.video.youtube.reason ?? '', /oEmbed/);
});

test('youtube key wins over cookie at the machine layer (snapshot still unusable)', async () => {
  const snap = await resolveEffectiveCapabilities(env({ YOUTUBE_API_KEY: 'k', YOUTUBE_COOKIE: 'c' }), { probe: probeFalse });
  assert.equal(snap.video.youtube.backend, 'youtube-data-api');
  assert.match(snap.video.youtube.reason ?? '', /machine full/);
  assert.equal(snap.video.youtube.usable, false);
});

test('bilibili matrix: probe pass + cookie full, probe pass no cookie degraded, probe fail unavailable', async () => {
  const biliOnly = cliProbe(['bili']);
  const full = await resolveEffectiveCapabilities(env({ BILIBILI_SESSDATA: 's' }), { probe: biliOnly });
  assert.equal(full.video.bilibili.quality, 'unavailable');
  assert.equal(full.video.bilibili.usable, false);
  assert.equal(full.video.bilibili.backend, 'bili-cli');
  assert.match(full.video.bilibili.reason ?? '', /no executor tool surface/);

  const degraded = await resolveEffectiveCapabilities(EMPTY_ENV, { probe: biliOnly });
  assert.equal(degraded.video.bilibili.quality, 'unavailable');
  assert.equal(degraded.video.bilibili.usable, false);
  assert.match(degraded.video.bilibili.reason ?? '', /subtitles degraded/);

  const off = await resolveEffectiveCapabilities(env({ BILIBILI_SESSDATA: 's' }), { probe: probeFalse });
  assert.equal(off.video.bilibili.quality, 'unavailable');
  assert.equal(off.video.bilibili.usable, false);
});

test('bilibili env-hint inference without probe (machine hint kept, snapshot unusable)', async () => {
  const hinted = await resolveEffectiveCapabilities(env({ BILI_CLI_PRESENT: '1' }));
  assert.equal(hinted.video.bilibili.usable, false);
  assert.equal(hinted.video.bilibili.quality, 'unavailable');
  assert.match(hinted.video.bilibili.reason ?? '', /machine degraded/);
  const noHint = await resolveEffectiveCapabilities(EMPTY_ENV);
  assert.equal(noHint.video.bilibili.usable, false);
});

test('probe throw counts as CLI absent', async () => {
  const throwing: CliProbe = async () => {
    throw new Error('ENOENT');
  };
  const snap = await resolveEffectiveCapabilities(env({ BILI_CLI_PRESENT: '1' }), { probe: throwing });
  assert.equal(snap.video.bilibili.usable, false);
});

test('kg gate: DIFFBOT_TOKEN only', async () => {
  const off = await resolveEffectiveCapabilities(EMPTY_ENV, { probe: probeFalse });
  assert.equal(off.kg.usable, false);
  assert.equal(off.kg.quality, 'unavailable');
  const on = await resolveEffectiveCapabilities(env({ DIFFBOT_TOKEN: 't' }), { probe: probeFalse });
  assert.equal(on.kg.usable, true);
  assert.equal(on.kg.quality, 'full');
  assert.equal(on.kg.backend, 'diffbot-dql');
});

test('graph gate: DQL full, SPARQL degraded, neither unavailable', async () => {
  const off = await resolveEffectiveCapabilities(EMPTY_ENV, { probe: probeFalse });
  assert.equal(off.graph.quality, 'unavailable');
  const sparql = await resolveEffectiveCapabilities(env({ GRAPH_SPARQL_ENDPOINT: 'https://example.com/sparql' }), { probe: probeFalse });
  assert.equal(sparql.graph.usable, true);
  assert.equal(sparql.graph.quality, 'degraded');
  assert.equal(sparql.graph.backend, 'sparql');
  const dql = await resolveEffectiveCapabilities(
    env({ DIFFBOT_TOKEN: 't', GRAPH_SPARQL_ENDPOINT: 'https://example.com/sparql' }),
    { probe: probeFalse },
  );
  assert.equal(dql.graph.quality, 'full');
});

test('social: v2ex always usable; reddit cookie full; reddit CLI-only degraded; unknown CLIs unavailable', async () => {
  const snap = await resolveEffectiveCapabilities(EMPTY_ENV, { probe: probeFalse });
  assert.equal(snap.social.length, 7);
  // Wave 9 (D4): no social lane is a usable specialist choice this cycle —
  // not even keyless v2ex. Machine backends stay observable.
  for (const entry of snap.social) assert.equal(entry.usable, false);
  const v2ex = snap.social.find((e) => e.action === 'social.search:v2ex');
  assert.equal(v2ex?.quality, 'unavailable');
  assert.equal(v2ex?.backend, 'v2ex-legacy-api');
  assert.match(v2ex?.reason ?? '', /no executor tool surface/);
  const twitter = snap.social.find((e) => e.action === 'social.search:twitter');
  assert.equal(twitter?.usable, false);

  const reddit = await resolveEffectiveCapabilities(env({ REDDIT_COOKIE: 'c' }), { probe: probeFalse });
  assert.equal(reddit.social.find((e) => e.action === 'social.search:reddit')?.usable, false);
  assert.equal(reddit.social.find((e) => e.action === 'social.search:reddit')?.backend, 'reddit-cookie');

  const oauth = await resolveEffectiveCapabilities(
    env({ REDDIT_CLIENT_ID: 'i', REDDIT_CLIENT_SECRET: 's', REDDIT_USER_AGENT: 'u' }),
    { probe: probeFalse },
  );
  assert.equal(oauth.social.find((e) => e.action === 'social.search:reddit')?.usable, false);
  assert.match(oauth.social.find((e) => e.action === 'social.search:reddit')?.reason ?? '', /OAuth trio present/);

  const cliOnly = await resolveEffectiveCapabilities(EMPTY_ENV, { probe: cliProbe(['opencli']) });
  assert.equal(cliOnly.social.find((e) => e.action === 'social.search:reddit')?.usable, false);
  assert.equal(cliOnly.social.find((e) => e.action === 'social.search:twitter')?.usable, false);
  assert.equal(cliOnly.social.find((e) => e.action === 'social.search:linkedin')?.usable, false);
  assert.match(cliOnly.social.find((e) => e.action === 'social.search:twitter')?.reason ?? '', /twitter CLI session present/);
});

test('social reasons deterministic across runs', async () => {
  const a = await resolveEffectiveCapabilities(EMPTY_ENV, { probe: probeFalse });
  const b = await resolveEffectiveCapabilities(EMPTY_ENV, { probe: probeFalse });
  assert.deepEqual(
    a.social.map((e) => e.reason),
    b.social.map((e) => e.reason),
  );
});

test('snapshotForJob frozen deeply', () => {
  const snap = snapshotForJob(env({ YOUTUBE_API_KEY: 'k', DIFFBOT_TOKEN: 't' }));
  assert.equal(Object.isFrozen(snap), true);
  assert.equal(Object.isFrozen(snap.video), true);
  assert.equal(Object.isFrozen(snap.video.youtube), true);
  assert.equal(Object.isFrozen(snap.social), true);
  assert.equal(Object.isFrozen(snap.social[0]), true);
  assert.equal(Object.isFrozen(snap.executorSupportedLanes), true);
  assert.deepEqual([...snap.executorSupportedLanes], ['research', 'github', 'kg']);
  assert.equal(snap.video.youtube.quality, 'unavailable');
  assert.equal(snap.video.youtube.usable, false);
  assert.equal(snap.kg.quality, 'full');
});

test('prompt format deterministic, one line per vertical, byte-capped', () => {
  const snap = snapshotForJob(EMPTY_ENV);
  const a = formatCapabilitiesForPrompt(snap);
  const b = formatCapabilitiesForPrompt(snapshotForJob(EMPTY_ENV));
  assert.equal(a, b);
  const lines = a.split('\n');
  assert.equal(lines.length, 8);
  assert.match(lines[0] ?? '', /^web: full/);
  assert.match(lines[2] ?? '', /^video\.youtube: unavailable/);
  assert.match(lines[4] ?? '', /^social: 0\/7 usable/);
  assert.ok(Buffer.byteLength(a, 'utf8') <= MAX_CAPABILITIES_PROMPT_BYTES);
});

test('prompt format names backends and missing count', () => {
  const snap = snapshotForJob(env({ YOUTUBE_API_KEY: 'k' }));
  const text = formatCapabilitiesForPrompt(snap);
  assert.match(text, /video\.youtube: unavailable \(video\.youtube has no executor tool surface/);
  assert.match(text, /YOUTUBE_API_KEY present/);
  assert.match(text, /missing 7:/);
});

test('admissibility: always-on routes allowed', () => {
  const snap = snapshotForJob(EMPTY_ENV);
  for (const action of [{ kind: 'web_search' }, { kind: 'fetch' }, { kind: 'research_search' }, { kind: 'github' }] as const) {
    assert.deepEqual(gatherActionAdmissibility(action, snap), { allowed: true });
  }
});

test('admissibility: unavailable youtube denies with degrade-to-web', () => {
  const snap = snapshotForJob(EMPTY_ENV);
  const verdict = gatherActionAdmissibility({ kind: 'media_video', platform: 'youtube' }, snap);
  assert.equal(verdict.allowed, false);
  assert.equal(verdict.degradeTo, 'web');
  assert.match(verdict.reason ?? '', /specialist route unavailable: video\.youtube/);
});

test('admissibility: machine-capable youtube still denies (no executor surface)', () => {
  // Wave 9 (D4): cookie-degraded machine truth is not a usable specialist
  // lane — it degrades to web with fallback information in the reason.
  const snap = snapshotForJob(env({ YOUTUBE_COOKIE: 'c' }));
  const verdict = gatherActionAdmissibility({ kind: 'media_video', platform: 'youtube' }, snap);
  assert.equal(verdict.allowed, false);
  assert.equal(verdict.degradeTo, 'web');
  assert.match(verdict.reason ?? '', /specialist route unavailable: video\.youtube/);
  assert.match(verdict.reason ?? '', /no executor tool surface/);
});

test('admissibility: bilibili unavailable denies; degraded allows', () => {
  const off = snapshotForJob(EMPTY_ENV);
  const denied = gatherActionAdmissibility({ kind: 'media_video', platform: 'bilibili' }, off);
  assert.equal(denied.allowed, false);
  assert.equal(denied.degradeTo, 'web');
  const on = snapshotForJob(env({ BILI_CLI_PRESENT: '1' }));
  const allowed = gatherActionAdmissibility({ kind: 'media_video', platform: 'bilibili' }, on);
  assert.equal(allowed.allowed, false);
  assert.equal(allowed.degradeTo, 'web');
});

test('admissibility: kg/graph deny without token, graph degraded allows', () => {
  const off = snapshotForJob(EMPTY_ENV);
  assert.deepEqual(gatherActionAdmissibility({ kind: 'kg' }, off).allowed, false);
  assert.equal(gatherActionAdmissibility({ kind: 'kg' }, off).degradeTo, 'web');
  assert.equal(gatherActionAdmissibility({ kind: 'graph' }, off).allowed, false);
  const sparql = snapshotForJob(env({ GRAPH_SPARQL_ENDPOINT: 'https://example.com/sparql' }));
  const verdict = gatherActionAdmissibility({ kind: 'graph' }, sparql);
  assert.equal(verdict.allowed, true);
  assert.match(verdict.reason ?? '', /degraded/);
  const dql = snapshotForJob(env({ DIFFBOT_TOKEN: 't' }));
  assert.deepEqual(gatherActionAdmissibility({ kind: 'kg' }, dql), { allowed: true });
});

test('admissibility: social platform gating incl unknown platform and platform-less', () => {
  const snap = snapshotForJob(EMPTY_ENV);
  // Wave 9 (D4): no social platform is plannable this cycle — not even v2ex.
  const v2ex = gatherActionAdmissibility({ kind: 'social', platform: 'v2ex' }, snap);
  assert.equal(v2ex.allowed, false);
  assert.equal(v2ex.degradeTo, 'web');
  const twitter = gatherActionAdmissibility({ kind: 'social', platform: 'twitter' }, snap);
  assert.equal(twitter.allowed, false);
  assert.equal(twitter.degradeTo, 'web');
  const unknown = gatherActionAdmissibility({ kind: 'social', platform: 'myspace' }, snap);
  assert.equal(unknown.allowed, false);
  assert.equal(unknown.degradeTo, 'web');
  assert.match(unknown.reason ?? '', /unknown platform/);
  const any = gatherActionAdmissibility({ kind: 'social' }, snap);
  assert.equal(any.allowed, false);
  assert.equal(any.degradeTo, 'web');
});

test('admissibility uses provided snapshot, not ambient env', () => {
  const rich: EffectiveCapabilitiesSnapshot = snapshotForJob(
    env({ YOUTUBE_API_KEY: 'k', DIFFBOT_TOKEN: 't', GRAPH_SPARQL_ENDPOINT: 'https://example.com/s' }),
  );
  assert.equal(gatherActionAdmissibility({ kind: 'media_video', platform: 'youtube' }, rich).allowed, false);
  assert.equal(gatherActionAdmissibility({ kind: 'kg' }, rich).allowed, true);
});
