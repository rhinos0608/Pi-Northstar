import assert from 'node:assert/strict';
import { test } from 'node:test';
import { validateGithubRequest, type GithubRequestInput } from '../../../src/github/github-request-contract.js';
import {
  actionSearchText,
  compileIntentArgs,
  intentRoute,
  intentToGatherActionLike,
  validateGatherIntent,
} from '../../../src/web/agent/agent-gather-intents.js';
import { validateKgEnhance } from '../../../src/knowledge/knowledge-contract.js';

test('validate accepts a valid web_search intent', () => {
  const r = validateGatherIntent({ kind: 'web_search', query: 'zebra migration corridors map' });
  assert.equal(r.ok, true);
  assert.ok(r.ok);
  assert.deepEqual(r.value, { kind: 'web_search', query: 'zebra migration corridors map' });
});

test('validate accepts web_search with limit', () => {
  const r = validateGatherIntent({ kind: 'web_search', query: 'zebra migration corridors map', limit: 12 });
  assert.ok(r.ok);
});

test('validate accepts each kind with its named fields', () => {
  const valid = [
    { kind: 'research_search', query: 'zebra migration corridors map', source: 'openalex', yearFrom: 2000, yearTo: 2024, limit: 10 },
    { kind: 'github_search', scope: 'repo', query: 'zebra migration tracker app' },
    { kind: 'github_search', scope: 'code', query: 'migration corridor model', repoHint: 'acme/tracker' },
    { kind: 'github_search', scope: 'issues', repoHint: 'acme/tracker' },
    { kind: 'github_search', scope: 'files', query: 'src/corridor.ts', repoHint: 'acme/tracker' },
    { kind: 'social_search', platform: 'reddit', query: 'zebra migration safari reports', sort: 'top' },
    { kind: 'video_transcript', videoHint: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ' },
    { kind: 'kg_lookup', entityType: 'Organization', name: 'Acme Pro', limit: 5 },
  ];
  for (const raw of valid) {
    const r = validateGatherIntent(raw);
    assert.ok(r.ok, `expected ok for ${JSON.stringify(raw)}: ${JSON.stringify(r)}`);
  }
});

test('validate enforces lossless github compiles: issues is a filter, files needs repo', () => {
  // 'issues' is a bounded listing filter with NO query field — the native
  // issues surface has no text selector, so any query key rejects instead of
  // silently dropping.
  assert.deepEqual(
    validateGatherIntent({ kind: 'github_search', scope: 'issues', query: 'corridor model bug report', repoHint: 'acme/tracker' }),
    { ok: false, reason: 'invalid_intent_shape' },
  );
  assert.deepEqual(validateGatherIntent({ kind: 'github_search', scope: 'issues', repoHint: 'acme/tracker' }), {
    ok: true,
    value: { kind: 'github_search', scope: 'issues', repoHint: 'acme/tracker' },
  });
  assert.deepEqual(validateGatherIntent({ kind: 'github_search', scope: 'issues', query: 'corridor model bug report' }), {
    ok: false,
    reason: 'invalid_intent_shape',
  });
  assert.deepEqual(validateGatherIntent({ kind: 'github_search', scope: 'issues' }), {
    ok: false,
    reason: 'invalid_intent_shape',
  });
  // Issues filter bounds mirror the native selectors.
  assert.ok(validateGatherIntent({ kind: 'github_search', scope: 'issues', repoHint: 'acme/tracker', state: 'closed' }).ok);
  assert.ok(
    validateGatherIntent({ kind: 'github_search', scope: 'issues', repoHint: 'acme/tracker', labels: ['bug', 'p1'], number: 42 })
      .ok,
  );
  for (const bad of [
    { kind: 'github_search', scope: 'issues', repoHint: 'acme/tracker', state: 'merged' },
    { kind: 'github_search', scope: 'issues', repoHint: 'acme/tracker', labels: 'bug' },
    { kind: 'github_search', scope: 'issues', repoHint: 'acme/tracker', labels: [] as string[] },
    { kind: 'github_search', scope: 'issues', repoHint: 'acme/tracker', labels: Array.from({ length: 11 }, (_, i) => `l${i}`) },
    { kind: 'github_search', scope: 'issues', repoHint: 'acme/tracker', number: 0 },
    { kind: 'github_search', scope: 'issues', repoHint: 'acme/tracker', number: 1.5 },
    // Filter keys belong to the issues scope only.
    { kind: 'github_search', scope: 'code', query: 'migration corridor model', state: 'open' },
    { kind: 'github_search', scope: 'repo', query: 'zebra migration tracker app', number: 3 },
  ]) {
    assert.deepEqual(validateGatherIntent(bad), { ok: false, reason: 'invalid_intent_shape' }, JSON.stringify(bad));
  }
  // 'files' compiles query to an exact native path — free text would misfetch.
  assert.deepEqual(
    validateGatherIntent({ kind: 'github_search', scope: 'files', query: 'find the corridor migration logic' }),
    { ok: false, reason: 'invalid_intent_shape' },
  );
  assert.deepEqual(validateGatherIntent({ kind: 'github_search', scope: 'files', query: 'corridor' }), {
    ok: false,
    reason: 'invalid_intent_shape',
  });
  assert.deepEqual(validateGatherIntent({ kind: 'github_search', scope: 'files', query: 'src/corridor.ts' }), {
    ok: false,
    reason: 'invalid_intent_shape',
  });
  for (const query of ['src/corridor.ts', '/abs/corridor.ts', 'corridor.ts', 'src/nested/corridor-model.ts']) {
    const r = validateGatherIntent({ kind: 'github_search', scope: 'files', query, repoHint: 'acme/tracker' });
    assert.ok(r.ok, `expected ok for ${query}: ${JSON.stringify(r)}`);
  }
  // 'files' compiles to a native file read that requires owner/repo — a
  // missing repoHint would fail at runtime, so validation rejects it.
  // 'repo' takes no native repo selector (search_repos) — repoHint with scope
  // 'repo' would silently drop, so validation rejects it (reject-never-clamp).
  assert.ok(validateGatherIntent({ kind: 'github_search', scope: 'repo', query: 'zebra migration tracker app' }).ok);
  assert.deepEqual(
    validateGatherIntent({ kind: 'github_search', scope: 'repo', query: 'zebra migration tracker app', repoHint: 'acme/tracker' }),
    { ok: false, reason: 'invalid_intent_shape' },
  );
});

test('validate rejects unknown kind with unknown_intent_kind', () => {
  assert.deepEqual(validateGatherIntent({ kind: 'graph_search', query: 'zebras migrate far away' }), {
    ok: false,
    reason: 'unknown_intent_kind',
  });
  assert.deepEqual(validateGatherIntent({ query: 'zebras migrate far away' }), {
    ok: false,
    reason: 'unknown_intent_kind',
  });
  assert.deepEqual(validateGatherIntent(null), { ok: false, reason: 'invalid_intent_shape' });
});

test('validate rejects extra keys per kind (exact-keys)', () => {
  const r = validateGatherIntent({ kind: 'web_search', query: 'zebra migration corridors map', source: 'openalex' });
  assert.deepEqual(r, { ok: false, reason: 'invalid_intent_shape' });
  const v = validateGatherIntent({ kind: 'video_transcript', videoHint: 'zebra migration documentary footage', limit: 3 });
  assert.deepEqual(v, { ok: false, reason: 'invalid_intent_shape' });
  const k = validateGatherIntent({ kind: 'kg_lookup', entityType: 'Organization', name: 'Acme Pro', platform: 'reddit' });
  assert.deepEqual(k, { ok: false, reason: 'invalid_intent_shape' });
});

test('validate rejects bad types and enum violations', () => {
  assert.deepEqual(validateGatherIntent({ kind: 'web_search', query: 42 }), {
    ok: false,
    reason: 'invalid_intent_shape',
  });
  assert.deepEqual(validateGatherIntent({ kind: 'github_search', scope: 'commits', query: 'zebra migration corridors map' }), {
    ok: false,
    reason: 'invalid_intent_shape',
  });
  assert.deepEqual(validateGatherIntent({ kind: 'social_search', platform: 'myspace', query: 'zebra migration corridors map' }), {
    ok: false,
    reason: 'invalid_intent_shape',
  });
  assert.deepEqual(validateGatherIntent({ kind: 'social_search', query: 'zebra migration corridors map' }), {
    ok: false,
    reason: 'invalid_intent_shape',
  });
  assert.deepEqual(validateGatherIntent({ kind: 'video_transcript' }), {
    ok: false,
    reason: 'invalid_intent_shape',
  });
});

test('validate enforces string bounds and limit ranges (reject-never-clamp)', () => {
  assert.deepEqual(validateGatherIntent({ kind: 'web_search', query: 'short' }), {
    ok: false,
    reason: 'invalid_intent_shape',
  });
  assert.deepEqual(validateGatherIntent({ kind: 'web_search', query: 'x'.repeat(513) }), {
    ok: false,
    reason: 'invalid_intent_shape',
  });
  assert.deepEqual(validateGatherIntent({ kind: 'web_search', query: 'zebra migration corridors map', limit: 0 }), {
    ok: false,
    reason: 'invalid_intent_shape',
  });
  assert.deepEqual(validateGatherIntent({ kind: 'web_search', query: 'zebra migration corridors map', limit: 21 }), {
    ok: false,
    reason: 'invalid_intent_shape',
  });
  assert.deepEqual(
    validateGatherIntent({ kind: 'research_search', query: 'zebra migration corridors map', yearFrom: 1899 }),
    { ok: false, reason: 'invalid_intent_shape' },
  );
  assert.deepEqual(
    validateGatherIntent({ kind: 'research_search', query: 'zebra migration corridors map', yearFrom: 2020, yearTo: 2010 }),
    { ok: false, reason: 'invalid_intent_shape' },
  );
  assert.deepEqual(
    validateGatherIntent({ kind: 'research_search', query: 'zebra migration corridors map', limit: 31 }),
    { ok: false, reason: 'invalid_intent_shape' },
  );
  assert.deepEqual(
    validateGatherIntent({ kind: 'kg_lookup', entityType: 'Organization', name: 'Acme Pro', limit: 11 }),
    { ok: false,
      reason: 'invalid_intent_shape' },
  );
});

test('validate rejects padded query strings', () => {
  assert.deepEqual(validateGatherIntent({ kind: 'web_search', query: '  zebra migration corridors map  ' }), {
    ok: false,
    reason: 'invalid_intent_shape',
  });
});

test('compile maps each kind to exact native tool args', () => {
  assert.deepEqual(compileIntentArgs({ kind: 'web_search', query: 'zebra query here' }), { query: 'zebra query here' });
  assert.deepEqual(compileIntentArgs({ kind: 'web_search', query: 'zebra query here', limit: 12 }), {
    query: 'zebra query here',
    limit: 12,
  });
  assert.deepEqual(
    compileIntentArgs({ kind: 'research_search', query: 'zebra query here', source: 'openalex', yearFrom: 2000, limit: 10 }),
    { action: 'academic', query: 'zebra query here', source: 'openalex', limit: 10, yearFrom: 2000 },
  );
  assert.deepEqual(compileIntentArgs({ kind: 'github_search', scope: 'repo', query: 'zebra query here' }), {
    action: 'search_repos',
    query: 'zebra query here',
  });
  assert.deepEqual(
    compileIntentArgs({ kind: 'github_search', scope: 'code', query: 'zebra query here', repoHint: 'acme/tracker' }),
    { action: 'search', query: 'zebra query here', repository: 'acme/tracker' },
  );
  assert.deepEqual(compileIntentArgs({ kind: 'github_search', scope: 'issues', repoHint: 'acme/tracker' }), {
    action: 'issues',
    repository: 'acme/tracker',
  });
  assert.deepEqual(
    compileIntentArgs({
      kind: 'github_search',
      scope: 'issues',
      repoHint: 'acme/tracker',
      state: 'open',
      labels: ['bug'],
      number: 7,
    }),
    { action: 'issues', repository: 'acme/tracker', state: 'open', labels: ['bug'], number: 7 },
  );
  assert.deepEqual(
    compileIntentArgs({ kind: 'github_search', scope: 'files', query: 'src/zebra.ts', repoHint: 'acme/tracker' }),
    { action: 'file', path: 'src/zebra.ts', repository: 'acme/tracker' },
  );
  assert.deepEqual(
    compileIntentArgs({ kind: 'social_search', platform: 'reddit', query: 'zebra query here', sort: 'top' }),
    { platform: 'reddit', action: 'search', query: 'zebra query here', sort: 'top' },
  );
  assert.deepEqual(
    compileIntentArgs({ kind: 'video_transcript', videoHint: 'https://www.youtube.com/watch?v=abc123XYZ99' }),
    { channel: 'youtube', action: 'transcript', url: 'https://www.youtube.com/watch?v=abc123XYZ99' },
  );
  assert.deepEqual(compileIntentArgs({ kind: 'video_transcript', videoHint: 'dQw4w9WgXcQ' }), {
    channel: 'youtube',
    action: 'transcript',
    id: 'dQw4w9WgXcQ',
  });
  assert.deepEqual(
    compileIntentArgs({ kind: 'kg_lookup', entityType: 'Organization', name: 'Acme Pro', limit: 5 }),
    {
      action: 'enhance',
      type: 'Organization',
      name: 'Acme Pro',
      maxEntities: 5,
    },
  );
  assert.deepEqual(compileIntentArgs({ kind: 'kg_lookup', entityType: 'Person', url: 'https://example.com/jane' }), {
    action: 'enhance',
    type: 'Person',
    url: 'https://example.com/jane',
  });
  assert.deepEqual(compileIntentArgs({ kind: 'kg_lookup', entityType: 'Person', id: 'kg-jane-1' }), {
    action: 'enhance',
    type: 'Person',
    id: 'kg-jane-1',
  });
});

test('intentRoute maps kinds to ledger routes', () => {
  assert.equal(intentRoute({ kind: 'web_search', query: 'zebra query here now' }), 'web');
  assert.equal(intentRoute({ kind: 'research_search', query: 'zebra query here now' }), 'research');
  assert.equal(intentRoute({ kind: 'github_search', scope: 'repo', query: 'zebra query here now' }), 'github');
  assert.equal(intentRoute({ kind: 'social_search', platform: 'reddit', query: 'zebra query here now' }), 'social');
  assert.equal(intentRoute({ kind: 'video_transcript', videoHint: 'zebra documentary footage here' }), 'video');
  assert.equal(intentRoute({ kind: 'kg_lookup', entityType: 'Organization', name: 'Acme Pro' }), 'kg');
});

test('kg_lookup: planner-era kg_search is rejected as an unknown kind', () => {
  assert.deepEqual(validateGatherIntent({ kind: 'kg_search', query: 'Acme Pro launch price entity' }), {
    ok: false,
    reason: 'unknown_intent_kind',
  });
});

test('kg_lookup: every selector shape validates, bad shapes fail closed', () => {
  const good = [
    { kind: 'kg_lookup', entityType: 'Person', name: 'Jane Doe' },
    { kind: 'kg_lookup', entityType: 'Organization', url: 'https://example.com/acme' },
    { kind: 'kg_lookup', entityType: 'Person', id: 'kg-jane-1' },
    { kind: 'kg_lookup', entityType: 'Organization', name: 'Acme Pro', url: 'https://example.com/acme', id: 'kg-acme-1', limit: 10 },
  ];
  for (const raw of good) {
    const validated = validateGatherIntent(raw);
    assert.equal(validated.ok, true, JSON.stringify(raw));
  }
  const bad = [
    // No entityType.
    { kind: 'kg_lookup', name: 'Acme Pro' },
    // entityType outside Person|Organization.
    { kind: 'kg_lookup', entityType: 'Place', name: 'Acme Pro' },
    // No selector at all.
    { kind: 'kg_lookup', entityType: 'Organization' },
    // Empty / padded selectors.
    { kind: 'kg_lookup', entityType: 'Person', name: '' },
    { kind: 'kg_lookup', entityType: 'Person', name: '  Jane  ' },
    // Free-text query key is not part of the contract.
    { kind: 'kg_lookup', entityType: 'Organization', query: 'Acme Pro launch price' },
    // Limit above the native enhance maxEntities cap.
    { kind: 'kg_lookup', entityType: 'Organization', name: 'Acme Pro', limit: 11 },
  ];
  for (const raw of bad) {
    assert.deepEqual(validateGatherIntent(raw), { ok: false, reason: 'invalid_intent_shape' }, JSON.stringify(raw));
  }
});

test('kg_lookup: every meaningful field round-trips to the native enhance call', () => {
  const cases = [
    { kind: 'kg_lookup', entityType: 'Person', name: 'Jane Doe' },
    { kind: 'kg_lookup', entityType: 'Organization', url: 'https://example.com/acme' },
    { kind: 'kg_lookup', entityType: 'Person', id: 'kg-jane-1' },
    { kind: 'kg_lookup', entityType: 'Organization', name: 'Acme Pro', url: 'https://example.com/acme', id: 'kg-acme-1', limit: 3 },
  ] as const;
  for (const raw of cases) {
    const validated = validateGatherIntent(raw);
    assert.ok(validated.ok, JSON.stringify(raw));
    if (!validated.ok) continue;
    assert.equal(validated.value.kind, 'kg_lookup');
    if (validated.value.kind !== 'kg_lookup') continue;
    const intent = validated.value;
    const args = compileIntentArgs(intent);
    assert.equal(args['action'], 'enhance');
    // Every validated selector reaches the native call verbatim or fails
    // the native validator: strip nothing silently.
    assert.equal(args['type'], intent.entityType);
    for (const key of ['name', 'url', 'id'] as const) {
      if (intent[key] !== undefined) assert.equal(args[key], intent[key]);
      else assert.ok(!(key in args));
    }
    if (intent.limit !== undefined) assert.equal(args['maxEntities'], intent.limit);
    const native = validateKgEnhance({ type: args['type'], ...Object.fromEntries(['name', 'url', 'id'].filter((key) => key in args).map((key) => [key, args[key]])), ...(typeof args['maxEntities'] === 'number' ? { maxEntities: args['maxEntities'] } : {}) });
    assert.equal(native.ok, true, JSON.stringify(args));
    if (native.ok) {
      assert.deepEqual(native.selectors, Object.fromEntries(['name', 'url', 'id'].filter((key) => key in args).map((key) => [key, args[key]])));
    }
    // The ledger dispatch text is the first selector — never a free query.
    assert.ok((actionSearchText(validated.value) as string).length > 0);
    assert.ok(!('query' in args));
  }
});

test('github_search: every meaningful field round-trips to the native call', () => {
  const cases = [
    { kind: 'github_search', scope: 'repo', query: 'zebra migration tracker app' },
    { kind: 'github_search', scope: 'code', query: 'migration corridor model' },
    { kind: 'github_search', scope: 'code', query: 'migration corridor model', repoHint: 'acme/tracker' },
    { kind: 'github_search', scope: 'issues', repoHint: 'acme/tracker' },
    { kind: 'github_search', scope: 'issues', repoHint: 'acme/tracker', state: 'open', labels: ['bug'], number: 7 },
    { kind: 'github_search', scope: 'files', query: 'src/corridor.ts', repoHint: 'acme/tracker' },
  ] as const;
  for (const raw of cases) {
    const validated = validateGatherIntent(raw);
    assert.ok(validated.ok, JSON.stringify(raw));
    if (!validated.ok) continue;
    assert.equal(validated.value.kind, 'github_search');
    if (validated.value.kind !== 'github_search') continue;
    const intent = validated.value;
    const args = compileIntentArgs(intent);
    // Every validated field reaches the native call verbatim or fails the
    // native validator: the compiled args must validate natively.
    const native = validateGithubRequest(args as unknown as GithubRequestInput);
    assert.deepEqual(
      { action: native.request.action, query: native.request.query, repository: args['repository'] },
      { action: args['action'], query: args['query'], repository: args['repository'] },
      JSON.stringify(args),
    );
    if (intent.scope === 'issues') {
      assert.equal(native.request.action, 'issues');
      assert.ok(!('query' in args), 'issues intent carries no query field');
      if (intent.state !== undefined) assert.equal(native.request.state, intent.state);
      if (intent.labels !== undefined) assert.deepEqual(native.request.labels, intent.labels);
      if (intent.number !== undefined) assert.equal(native.request.number, intent.number);
    }
    if (intent.scope === 'files') {
      assert.equal(native.request.action, 'file');
      assert.equal(native.request.path, intent.query);
    }
    // The ledger dispatch text is never empty (issues uses repoHint).
    assert.ok(actionSearchText(intent).length > 0);
  }
});

test('web_fetch: http and https urls validate with exact keys', () => {
  for (const url of ['https://example.com/paper-1', 'http://example.com/paper-1']) {
    const r = validateGatherIntent({ kind: 'web_fetch', url });
    assert.deepEqual(r, { ok: true, value: { kind: 'web_fetch', url } });
  }
});

test('web_fetch: non-url shapes fail closed (reject-never-clamp)', () => {
  const bad = [
    { kind: 'web_fetch' },
    { kind: 'web_fetch', url: '' },
    { kind: 'web_fetch', url: 'not a url at all here' },
    { kind: 'web_fetch', url: 'ftp://example.com/paper-1' },
    { kind: 'web_fetch', url: '  https://example.com/paper-1  ' },
    { kind: 'web_fetch', url: 'https://example.com/pa per-1' },
    { kind: 'web_fetch', url: 'https://example.com/' + 'x'.repeat(512) },
    { kind: 'web_fetch', url: 'https://example.com/paper-1', query: 'extra key here' },
    { kind: 'web_fetch', query: 'https://example.com/paper-1' },
    // Scheme with no host is not a URL.
    { kind: 'web_fetch', url: 'http://' },
    { kind: 'web_fetch', url: 'https://?q=1' },
    { kind: 'web_fetch', url: 'http:///path' },
    // Zero-width/bidi chars bypass the whitespace gate: reject, never strip.
    { kind: 'web_fetch', url: 'https://example.com\u200B/x' },
    { kind: 'web_fetch', url: 'https://example.com/\u202Ex' },
    { kind: 'web_fetch', url: 'https://example.com/x\uFEFF' },
  ];
  for (const raw of bad) {
    assert.deepEqual(validateGatherIntent(raw), { ok: false, reason: 'invalid_intent_shape' }, JSON.stringify(raw));
  }
});

test('web_fetch: routes to web, compiles losslessly, dispatches verbatim', () => {
  const intent = { kind: 'web_fetch', url: 'https://example.com/paper-1' } as const;
  assert.equal(intentRoute(intent), 'web');
  assert.deepEqual(intentToGatherActionLike(intent), { kind: 'fetch' });
  assert.equal(actionSearchText(intent), 'https://example.com/paper-1');
  assert.deepEqual(compileIntentArgs(intent), { url: 'https://example.com/paper-1' });
});
