import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  AGGREGATE_RESEARCH_SOURCE,
  backendCapability,
  canonicalActionsFor,
  CHANNEL_CAPABILITIES,
  channelCapability,
  cookieImportProviders,
  inferPlatformFromUrl,
  isResearchSource,
  mediaPlatforms,
  RESEARCH_SOURCE_CAPABILITIES,
  researchSourceCapability,
  researchSourceIds,
  setupChannelNames,
  SOCIAL_BACKEND_PREFERENCE,
  socialCanonicalActions,
  socialPlatforms,
} from '../src/capabilities.js';
import { GITHUB_ACTIONS } from '../src/github-contract.js';
import {
  SOCIAL_CANONICAL_ACTIONS,
  SOCIAL_PLATFORMS,
  selectorSpecFor,
  type SocialPlatform,
} from '../src/social-contract.js';

const AVAILABLE_SOCIAL_IDS = ['v2ex', 'twitter', 'reddit', 'xiaohongshu', 'facebook', 'instagram', 'linkedin'] as const;

// ── Registry invariants ──

test('channel ids are unique', () => {
  const ids = CHANNEL_CAPABILITIES.map((channel) => channel.id);
  assert.equal(new Set(ids).size, ids.length);
});

test('backend ids are unique within each channel and channel+backend pairs are globally unique', () => {
  const pairs = new Set<string>();
  for (const channel of CHANNEL_CAPABILITIES) {
    const ids = channel.backends.map((backend) => backend.id);
    assert.equal(new Set(ids).size, ids.length, `duplicate backend in channel ${channel.id}`);
    for (const id of ids) {
      const pair = `${channel.id}/${id}`;
      assert.ok(!pairs.has(pair), `duplicate channel/backend pair ${pair}`);
      pairs.add(pair);
    }
  }
});

test('canonical actions are unique per channel and carry no alias machinery', () => {
  for (const channel of CHANNEL_CAPABILITIES) {
    const canonical = new Set(channel.actions.map((action) => action.action));
    assert.equal(canonical.size, channel.actions.length, `duplicate canonical action in ${channel.id}`);
    for (const action of channel.actions) {
      assert.ok(!('aliases' in action), `${channel.id}: action ${action.action} carries legacy alias machinery`);
      assert.equal(action.readOnly, true);
    }
  }
});

test('every backend action exists canonically in its channel', () => {
  for (const channel of CHANNEL_CAPABILITIES) {
    const canonical = new Set(channel.actions.map((action) => action.action));
    for (const backend of channel.backends) {
      for (const action of backend.actions) {
        assert.ok(canonical.has(action), `${channel.id}/${backend.id}: action ${action} is not canonical`);
      }
    }
  }
});

test('all registered actions are read-only', () => {
  for (const channel of CHANNEL_CAPABILITIES) {
    for (const action of channel.actions) {
      assert.equal(action.readOnly, true);
    }
  }
});

test('planned channels expose no working backends or actions', () => {
  for (const channel of CHANNEL_CAPABILITIES) {
    if (channel.availability === 'planned') {
      assert.deepEqual(channel.backends, [], `${channel.id} planned but has backends`);
      assert.deepEqual(channel.actions, [], `${channel.id} planned but has actions`);
    }
  }
});

test('available channels except browser declare actions', () => {
  for (const channel of CHANNEL_CAPABILITIES) {
    if (channel.availability === 'available' && channel.id !== 'browser') {
      assert.ok(channel.actions.length > 0, `${channel.id} available without actions`);
    }
  }
});

// ── Bidirectional registry invariants (capabilities ↔ social-contract) ──

test('available social channels are exactly the canonical platforms', () => {
  const availableSocial = CHANNEL_CAPABILITIES
    .filter((channel) => channel.family === 'social' && channel.availability === 'available')
    .map((channel) => channel.id)
    .sort();
  assert.deepEqual(availableSocial, [...AVAILABLE_SOCIAL_IDS].sort());
  assert.deepEqual(
    [...SOCIAL_PLATFORMS].sort(),
    [...AVAILABLE_SOCIAL_IDS].sort(),
  );
});

test('social channel actions equal the canonical action table in both directions', () => {
  for (const id of AVAILABLE_SOCIAL_IDS) {
    const platform = id as SocialPlatform;
    const registry = [...canonicalActionsFor(id)].sort();
    const contract = [...SOCIAL_CANONICAL_ACTIONS[platform]].sort();
    assert.deepEqual(registry, contract, `${id}: registry actions diverge from canonical table`);
    assert.deepEqual([...socialCanonicalActions(platform)].sort(), contract);
    for (const action of contract) {
      assert.ok(!action.startsWith('get_') || action.length > 4, `${id}: empty canonical action`);
    }
  }
});

test('social backend coverage is complete: every canonical action has a backend', () => {
  for (const id of AVAILABLE_SOCIAL_IDS) {
    const channel = channelCapability(id);
    assert.ok(channel);
    const covered = new Set(channel.backends.flatMap((backend) => backend.actions));
    for (const action of SOCIAL_CANONICAL_ACTIONS[id as SocialPlatform]) {
      assert.ok(covered.has(action), `${id}: canonical action ${action} has no backend`);
    }
  }
});

test('backend preference lists exactly the declared backends per platform', () => {
  for (const id of AVAILABLE_SOCIAL_IDS) {
    const channel = channelCapability(id);
    assert.ok(channel);
    assert.deepEqual(
      [...SOCIAL_BACKEND_PREFERENCE[id as SocialPlatform]].sort(),
      channel.backends.map((backend) => backend.id).sort(),
      `${id}: preference order diverges from declared backends`,
    );
  }
});

test('preference order puts scoped cookie backends before anonymous before optional-key', () => {
  assert.equal(SOCIAL_BACKEND_PREFERENCE.reddit[0], 'reddit-cookie');
  assert.equal(SOCIAL_BACKEND_PREFERENCE.reddit[SOCIAL_BACKEND_PREFERENCE.reddit.length - 1], 'reddit-oauth');
  assert.equal(SOCIAL_BACKEND_PREFERENCE.v2ex[0], 'v2ex-legacy-api');
});

test('every canonical social action has selector coverage', () => {
  for (const platform of SOCIAL_PLATFORMS) {
    for (const action of SOCIAL_CANONICAL_ACTIONS[platform]) {
      const spec = selectorSpecFor(platform, action);
      assert.ok(spec !== undefined, `${platform}/${action}: no selector spec`);
    }
  }
});

test('registry never advertises instagram post-detail actions', () => {
  const instagram = canonicalActionsFor('instagram');
  for (const forbidden of ['get_post', 'get_thread', 'get_comments', 'get_feed']) {
    assert.ok(!instagram.includes(forbidden), `instagram must not advertise ${forbidden}`);
  }
});

// ── Exact-domain host inference ──

test('inferPlatformFromUrl matches exact and subdomain hosts only', () => {
  const allowed = ['twitter', 'reddit', 'youtube'];
  assert.equal(inferPlatformFromUrl('https://twitter.com/user/status/1', allowed), 'twitter');
  assert.equal(inferPlatformFromUrl('https://x.com/user/status/1', allowed), 'twitter');
  assert.equal(inferPlatformFromUrl('https://www.twitter.com/user', allowed), 'twitter');
  assert.equal(inferPlatformFromUrl('https://mobile.twitter.com/user', allowed), 'twitter');
  assert.equal(inferPlatformFromUrl('https://www.reddit.com/r/llm/', allowed), 'reddit');
  assert.equal(inferPlatformFromUrl('https://redd.it/abc123', allowed), 'reddit');
  assert.equal(inferPlatformFromUrl('https://www.youtube.com/watch?v=abc', allowed), 'youtube');
  assert.equal(inferPlatformFromUrl('https://youtu.be/abc', allowed), 'youtube');
});

test('inferPlatformFromUrl rejects lookalike hosts', () => {
  const allowed = ['twitter', 'reddit', 'instagram'];
  assert.equal(inferPlatformFromUrl('https://evil-twitter.com/post', allowed), undefined);
  assert.equal(inferPlatformFromUrl('https://twitter.com.evil.com/post', allowed), undefined);
  assert.equal(inferPlatformFromUrl('https://reddit.com.fake.example/x', allowed), undefined);
  assert.equal(inferPlatformFromUrl('https://notareddit.com/x', allowed), undefined);
  assert.equal(inferPlatformFromUrl('not a url', allowed), undefined);
});

test('inferPlatformFromUrl respects the allowed platform filter', () => {
  assert.equal(inferPlatformFromUrl('https://twitter.com/user', ['reddit']), undefined);
  assert.equal(inferPlatformFromUrl('https://twitter.com/user', ['twitter']), 'twitter');
});

// ── Public vocabularies match currently advertised surfaces ──

test('social platforms match the currently registered public enum', () => {
  assert.deepEqual(socialPlatforms(), ['v2ex', 'twitter', 'reddit', 'xiaohongshu', 'facebook', 'instagram', 'linkedin']);
});

test('media platforms include youtube, bilibili, and rss', () => {
  assert.deepEqual(mediaPlatforms(), ['rss', 'youtube', 'bilibili']);
});

test('research sources include every advertised source id', () => {
  assert.deepEqual(researchSourceIds(), [
    'semantic_scholar', 'openalex', 'pubmed', 'stackoverflow', 'datacite', 'ror',
    'gdelt', 'wikipedia', 'wikidata', 'arxiv', 'crossref', 'hackernews',
  ]);
  assert.ok(isResearchSource('all'));
  assert.ok(isResearchSource('openalex'));
  assert.ok(!isResearchSource('duckduckgo'));
});

test('research source registry entries carry backend and pagination metadata', () => {
  const openalex = researchSourceCapability('openalex');
  assert.ok(openalex);
  assert.equal(openalex.backend, 'openalex-api');
  assert.equal(openalex.pagination, 'cursor');
  assert.equal(openalex.yearFilter, 'supported');
  assert.equal(researchSourceCapability('nonexistent'), undefined);
  assert.ok(RESEARCH_SOURCE_CAPABILITIES.every((source) => source.backend.length > 0));
  assert.notEqual(researchSourceIds()[0], AGGREGATE_RESEARCH_SOURCE);
});

test('gdelt marks the STARTDATETIME year filter supported while wikipedia stays unsupported', () => {
  const gdelt = researchSourceCapability('gdelt');
  assert.ok(gdelt);
  assert.equal(gdelt.yearFilter, 'supported');
  assert.equal(gdelt.pagination, 'unsupported');

  const wikipedia = researchSourceCapability('wikipedia');
  assert.ok(wikipedia);
  assert.equal(wikipedia.yearFilter, 'unsupported');
  assert.equal(wikipedia.pagination, 'unsupported');
});

// ── Canonical action vocabulary (no aliases) ──

test('canonicalActionsFor lists canonical vocabulary without legacy spellings', () => {
  const redditActions = canonicalActionsFor('reddit');
  assert.ok(redditActions.includes('get_feed'));
  assert.ok(redditActions.includes('get_trending'));
  for (const legacy of ['feed', 'hot', 'popular', 'read', 'subreddit', 'all']) {
    assert.ok(!redditActions.includes(legacy), `reddit must not advertise legacy spelling ${legacy}`);
  }
  assert.deepEqual([...canonicalActionsFor('linkedin')].sort(), ['get_feed', 'get_profile', 'get_user_posts', 'search']);
});

// ── Capability lookup helpers ──

test('channelCapability and backendCapability resolve registry entries', () => {
  const youtube = channelCapability('youtube');
  assert.ok(youtube);
  assert.equal(youtube.tier, 1);
  assert.deepEqual(youtube.domains, ['youtube.com', 'youtu.be']);

  const dataApi = backendCapability('youtube', 'youtube-data-api');
  assert.ok(dataApi);
  assert.deepEqual(dataApi.actions, ['search', 'details', 'hot']);
  assert.deepEqual(dataApi.auth?.allOf, ['YOUTUBE_API_KEY']);
  assert.equal(backendCapability('youtube', 'nonexistent'), undefined);
  assert.equal(channelCapability('nonexistent'), undefined);
});

test('cookieImportProviders only lists operational cookie-consuming providers', () => {
  const providers = cookieImportProviders();
  assert.ok(providers.includes('reddit'));
  assert.ok(providers.includes('bilibili'));
  // Twitter/Xiaohongshu workers authenticate through CLI-owned local session
  // stores and never consume imported Pi cookie-jar state: never import.
  // Facebook/Instagram/LinkedIn only run through OpenCLI, which
  // authenticates with its own Chrome session and cannot consume stored
  // cookies: never import.
  for (const nonImporting of ['twitter', 'xiaohongshu', 'facebook', 'instagram', 'linkedin']) {
    assert.ok(!providers.includes(nonImporting), `${nonImporting} must not import unused cookies`);
  }
  assert.ok(!providers.includes('github'));
  assert.deepEqual([...providers].sort(), ['bilibili', 'reddit', 'youtube']);
});

test('youtube transcript is an unofficial keyless backend; data-api never claims transcript', () => {
  const transcript = backendCapability('youtube', 'youtube-transcript');
  assert.ok(transcript);
  assert.equal(transcript.mode, 'native');
  assert.equal(transcript.quality, 'degraded');
  assert.deepEqual([...transcript.actions], ['transcript']);
  assert.match(String(transcript.note), /unofficial/i);
  assert.match(String(transcript.note), /never yt-dlp/i);
  const dataApi = backendCapability('youtube', 'youtube-data-api');
  assert.ok(dataApi);
  assert.ok(!dataApi.actions.includes('transcript'), 'captions endpoints are OAuth-only, not API-key');
  assert.ok(canonicalActionsFor('youtube').includes('transcript'));
  const provider = channelCapability('youtube')?.provider;
  assert.ok(provider);
  assert.equal(provider.consumesCookie, true);
  assert.deepEqual([...provider.cookieDomains], ['youtube.com']);
  assert.equal(provider.loginFlow, 'browser_cookie');
});

test('twitter and xiaohongshu are CLI-owned sessions with no Pi credential claims', () => {
  for (const id of ['twitter', 'xiaohongshu'] as const) {
    const channel = channelCapability(id);
    assert.ok(channel?.provider);
    assert.equal(channel.provider.consumesCookie, false);
    assert.equal(channel.provider.loginFlow, 'cli_login');
    assert.deepEqual([...channel.provider.envKeys], []);
  }
  const twitter = channelCapability('twitter');
  assert.ok(twitter);
  assert.match(String(twitter.provider?.setup), /twitter-cli/);
  for (const backend of twitter.backends) {
    for (const key of [...(backend.auth?.anyOf ?? []), ...(backend.auth?.allOf ?? [])]) {
      assert.ok(key !== 'TWITTER_AUTH_TOKEN' && key !== 'TWITTER_CT0', `${twitter.id}/${backend.id} must not claim ${key} unlocks the worker`);
    }
  }
});

test('linkedin is an available OpenCLI Chrome-session channel with no cookie import', () => {
  const linkedin = channelCapability('linkedin');
  assert.ok(linkedin);
  assert.equal(linkedin.availability, 'available');
  assert.deepEqual([...canonicalActionsFor('linkedin')].sort(), ['get_feed', 'get_profile', 'get_user_posts', 'search']);
  assert.deepEqual(linkedin.backends.map((backend) => backend.id), ['opencli']);
  const linkedinBackend = backendCapability('linkedin', 'opencli');
  assert.ok(linkedinBackend);
  assert.deepEqual([...linkedinBackend.actions].sort(), ['get_feed', 'get_profile', 'get_user_posts', 'search']);
  assert.equal(linkedin.provider?.loginFlow, 'cli_login');
  assert.equal(linkedin.provider?.consumesCookie, false);
  assert.ok(!cookieImportProviders().includes('linkedin'));
});

test('setupChannelNames retains the legacy install_channels name set', () => {
  const names = new Set(setupChannelNames());
  for (const legacy of ['web', 'github', 'rss', 'v2ex', 'twitter', 'reddit', 'xiaohongshu', 'facebook', 'instagram', 'linkedin', 'youtube', 'bilibili', 'research']) {
    assert.ok(names.has(legacy), `missing legacy channel ${legacy}`);
  }
});

test('github channel advertises the Stage 5 canonical action set', () => {
  const expected = ['repo', 'file', 'tree', 'search', 'search_repos', 'trending', 'issues', 'pulls', 'releases', 'commits'];
  assert.deepEqual([...canonicalActionsFor('github')].sort(), [...expected].sort());
  assert.deepEqual([...canonicalActionsFor('github')].sort(), [...GITHUB_ACTIONS].sort(), 'registry must equal contract vocabulary');
  const backend = backendCapability('github', 'github-api');
  assert.ok(backend);
  assert.deepEqual([...backend.actions].sort(), [...expected].sort());
  assert.equal(backend.mode, 'native');
  assert.equal(backend.quality, 'full');
  assert.equal(backend.auth?.required, false);
  assert.deepEqual([...(backend.auth?.anyOf ?? [])], ['GITHUB_TOKEN', 'GH_TOKEN']);
  assert.match(String(backend.note), /list_dir and code_search legacy spellings are unsupported/);
  for (const legacy of ['list_dir', 'code_search']) {
    assert.ok(!canonicalActionsFor('github').includes(legacy), `github must not advertise legacy spelling ${legacy}`);
  }
  const provider = channelCapability('github')?.provider;
  assert.ok(provider);
  assert.deepEqual([...provider.envKeys], ['GITHUB_TOKEN', 'GH_TOKEN']);
  assert.equal(provider.consumesCookie, false);
  assert.deepEqual([...provider.cookieDomains], []);
});
