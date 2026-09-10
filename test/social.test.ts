// Tests for the Stage 2 central social integrator (src/social.ts).
// Canonical-only: unknown/legacy action names throw unsupported_action before
// dispatch, selectors/limits validate against the registry, cursor pinning
// never switches backends, retryable failures fall through, valid empty pages
// stop selection, normalized pages schema-validate before success, and
// success carries the Pi-owned northstar envelope.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  SOCIAL_CANONICAL_ACTIONS,
  SocialError,
  encodeSocialCursor,
  socialCursorFingerprint,
  type SocialAction,
  type SocialAuthTier,
  type SocialBackendPlan,
  type SocialPageV1,
  type SocialPaginationMode,
  type SocialPlatform,
  type SocialPlatformWorker,
  type SocialRequest,
} from '../src/social-contract.js';
import {
  executeSocial,
  SOCIAL_BACKEND_REGISTRY,
  type ExecuteSocialOptions,
} from '../src/social.js';

interface PlanSpec {
  backend: string;
  authTier: SocialAuthTier;
  pagination: SocialPaginationMode;
  payload?: unknown;
  failWith?: SocialError;
}

interface StubHarness {
  worker: SocialPlatformWorker;
  plansCalls: number;
  executes: string[];
}

function emptyPage(_plan: SocialBackendPlan, request: SocialRequest): SocialPageV1 {
  return {
    entities: [],
    pagination: { supported: false, limit: request.limit, returned: 0, hasMore: false },
    partial: false,
    warnings: [],
  };
}

function postPage(plan: SocialBackendPlan, request: SocialRequest, title: string): SocialPageV1 {
  return {
    entities: [
      {
        version: 1,
        kind: 'social_post',
        id: `${request.platform}:social_post:1`,
        platformId: '1',
        platform: request.platform,
        backend: plan.backend,
        url: 'https://example.com/p/1',
        contentType: 'post',
        title,
        text: `${title} body`,
      },
    ],
    pagination: { supported: false, limit: request.limit, returned: 1, hasMore: false },
    partial: false,
    warnings: [],
  };
}

function stubWorker(platform: SocialPlatform, specs: PlanSpec[], page: (plan: SocialBackendPlan, request: SocialRequest) => SocialPageV1 = emptyPage): StubHarness {
  const harness: StubHarness = {
    plansCalls: 0,
    executes: [],
    worker: {
      platforms: [platform],
      async plans(_request: SocialRequest): Promise<readonly SocialBackendPlan[]> {
        harness.plansCalls += 1;
        return specs.map(
          (spec): SocialBackendPlan => ({
            backend: spec.backend,
            authTier: spec.authTier,
            pagination: spec.pagination,
            execute: async () => {
              harness.executes.push(spec.backend);
              if (spec.failWith !== undefined) throw spec.failWith;
              return spec.payload ?? {};
            },
          }),
        );
      },
      normalize(request: SocialRequest, plan: SocialBackendPlan): SocialPageV1 {
        return page(plan, request);
      },
    },
  };
  return harness;
}

function optionsFor(harness: StubHarness, platform: SocialPlatform): ExecuteSocialOptions {
  return { env: {}, workers: { [platform]: harness.worker } as Partial<Record<SocialPlatform, SocialPlatformWorker>> };
}

async function socialErrorOf(code: string, run: () => Promise<unknown>): Promise<SocialError> {
  try {
    await run();
  } catch (error) {
    assert.ok(error instanceof SocialError, `expected SocialError, got ${String(error)}`);
    assert.equal(error.code, code);
    return error;
  }
  throw new Error(`expected SocialError(${code}) but nothing was thrown`);
}

// ── Canonical validation: no aliases ──

test('canonical calls carry no requestedAction metadata', async () => {
  const harness = stubWorker('twitter', [{ backend: 'twitter-cli', authTier: 'cookie', pagination: 'none' }]);
  const result = await executeSocial(
    { platform: 'twitter', action: 'get_feed' },
    optionsFor(harness, 'twitter'),
  );
  const details = result.details as Record<string, unknown>;
  assert.equal(details.action, 'get_feed');
  assert.equal(details.canonicalAction, 'get_feed');
  assert.equal('requestedAction' in details, false);
  const northstar = details.northstar as { request: Record<string, unknown> };
  assert.equal(northstar.request.action, 'get_feed');
  assert.equal('requestedAction' in northstar.request, false);
});

test('legacy action spellings are rejected before dispatch', async () => {
  const cases: Array<{ platform: SocialPlatform; action: string }> = [
    { platform: 'twitter', action: 'read' },
    { platform: 'twitter', action: 'post' },
    { platform: 'reddit', action: 'subreddit' },
    { platform: 'xiaohongshu', action: 'note' },
    { platform: 'v2ex', action: 'topic' },
    { platform: 'twitter', action: 'post_tweet' },
  ];
  for (const { platform, action } of cases) {
    const harness = stubWorker(platform, [{ backend: 'twitter-cli', authTier: 'cookie', pagination: 'none' }]);
    await socialErrorOf('unsupported_action', () =>
      executeSocial({ platform, action }, optionsFor(harness, platform)),
    );
    assert.equal(harness.plansCalls, 0);
    assert.deepEqual(harness.executes, []);
  }
});

test('selector requirements reject before dispatch', async () => {
  const harness = stubWorker('reddit', [{ backend: 'OpenCLI', authTier: 'anonymous', pagination: 'none' }]);
  await socialErrorOf('invalid_request', () =>
    executeSocial({ platform: 'reddit', action: 'get_community_posts' }, optionsFor(harness, 'reddit')),
  );
  assert.equal(harness.plansCalls, 0);
});

test('canonical selectors satisfy validation', async () => {
  const harness = stubWorker('reddit', [{ backend: 'OpenCLI', authTier: 'anonymous', pagination: 'none' }]);
  const result = await executeSocial(
    { platform: 'reddit', action: 'get_community_posts', community: 'python' },
    optionsFor(harness, 'reddit'),
  );
  assert.equal((result.details as Record<string, unknown>).backend, 'OpenCLI');
});

// ── Instagram safety ──

test('instagram canonical post-detail spellings stay unadvertised', async () => {
  const harness = stubWorker('instagram', [{ backend: 'opencli', authTier: 'cookie', pagination: 'none' }]);
  for (const action of ['get_post', 'get_thread', 'get_comments', 'get_feed']) {
    await socialErrorOf(
      'unsupported_action',
      () => executeSocial({ platform: 'instagram', action, postId: 'abc' }, optionsFor(harness, 'instagram')),
    );
  }
  assert.equal(harness.plansCalls, 0);
});

test('unknown actions throw unsupported_action before dispatch', async () => {
  const harness = stubWorker('twitter', [{ backend: 'twitter-cli', authTier: 'cookie', pagination: 'none' }]);
  await socialErrorOf('unsupported_action', () =>
    executeSocial({ platform: 'twitter', action: 'post_tweet' }, optionsFor(harness, 'twitter')),
  );
  assert.equal(harness.plansCalls, 0);
});

// ── Backend selection: cookie → anonymous → API key ──

test('auth tier order beats declaration order, failures fall through', async () => {
  const harness = stubWorker('reddit', [
    { backend: 'reddit-oauth', authTier: 'api_key', pagination: 'none' },
    { backend: 'OpenCLI', authTier: 'anonymous', pagination: 'none' },
    {
      backend: 'reddit-cookie',
      authTier: 'cookie',
      pagination: 'none',
      failWith: new SocialError('upstream_error', 'cookie flaked'),
    },
  ]);
  const result = await executeSocial(
    { platform: 'reddit', action: 'search', query: 'x' },
    optionsFor(harness, 'reddit'),
  );
  assert.deepEqual(harness.executes, ['reddit-cookie', 'OpenCLI']);
  assert.equal((result.details as Record<string, unknown>).backend, 'OpenCLI');
});

test('cursor-capable backends are preferred for initial listing requests', async () => {
  const harness = stubWorker('reddit', [
    { backend: 'OpenCLI', authTier: 'anonymous', pagination: 'none' },
    { backend: 'rdt-cli', authTier: 'anonymous', pagination: 'cursor' },
  ]);
  await executeSocial({ platform: 'reddit', action: 'search', query: 'x' }, optionsFor(harness, 'reddit'));
  assert.deepEqual(harness.executes, ['rdt-cli']);
});

test('non-retryable failures stop immediately', async () => {
  const harness = stubWorker('reddit', [
    {
      backend: 'rdt-cli',
      authTier: 'anonymous',
      pagination: 'none',
      failWith: new SocialError('permission_denied', 'private'),
    },
    { backend: 'OpenCLI', authTier: 'anonymous', pagination: 'none' },
  ]);
  await socialErrorOf('permission_denied', () =>
    executeSocial({ platform: 'reddit', action: 'search', query: 'x' }, optionsFor(harness, 'reddit')),
  );
  assert.deepEqual(harness.executes, ['rdt-cli']);
});

test('valid empty results stop selection', async () => {
  const harness = stubWorker(
    'reddit',
    [
      { backend: 'OpenCLI', authTier: 'anonymous', pagination: 'none' },
      { backend: 'rdt-cli', authTier: 'anonymous', pagination: 'none' },
    ],
    (plan, request) => emptyPage(plan, request),
  );
  const result = await executeSocial(
    { platform: 'reddit', action: 'search', query: 'nothing-matches' },
    optionsFor(harness, 'reddit'),
  );
  assert.deepEqual(harness.executes, ['rdt-cli']);
  const details = result.details as { northstar?: { status?: string } };
  assert.equal(details.northstar?.status, 'empty');
});

test('malformed payloads fall through without synthetic entities', async () => {
  const harness = stubWorker('reddit', [
    {
      backend: 'rdt-cli',
      authTier: 'anonymous',
      pagination: 'none',
      failWith: new SocialError('malformed_upstream', 'not json'),
    },
    { backend: 'OpenCLI', authTier: 'anonymous', pagination: 'none' },
  ]);
  const result = await executeSocial(
    { platform: 'reddit', action: 'search', query: 'x' },
    optionsFor(harness, 'reddit'),
  );
  assert.deepEqual(harness.executes, ['rdt-cli', 'OpenCLI']);
  assert.equal((result.details as Record<string, unknown>).backend, 'OpenCLI');
});

test('invalid normalized pages fall through, never surfacing raw payloads', async () => {
  const harness: StubHarness = {
    plansCalls: 0,
    executes: [],
    worker: {
      platforms: ['reddit'],
      async plans(): Promise<readonly SocialBackendPlan[]> {
        harness.plansCalls += 1;
        return [
          {
            backend: 'rdt-cli',
            authTier: 'anonymous',
            pagination: 'none',
            execute: async () => {
              harness.executes.push('rdt-cli');
              return {};
            },
          },
          {
            backend: 'OpenCLI',
            authTier: 'anonymous',
            pagination: 'none',
            execute: async () => {
              harness.executes.push('OpenCLI');
              return {};
            },
          },
        ];
      },
      normalize(request: SocialRequest, plan: SocialBackendPlan): SocialPageV1 {
        if (plan.backend === 'rdt-cli') {
          return { entities: [{ kind: 'bogus' }], pagination: { supported: false, limit: 1, returned: 1, hasMore: false }, partial: false, warnings: [] } as unknown as SocialPageV1;
        }
        return emptyPage(plan, request);
      },
    },
  };
  const result = await executeSocial(
    { platform: 'reddit', action: 'search', query: 'x' },
    optionsFor(harness, 'reddit'),
  );
  assert.deepEqual(harness.executes, ['rdt-cli', 'OpenCLI']);
  assert.equal((result.details as Record<string, unknown>).backend, 'OpenCLI');
});

test('exhausted backends report backend_unavailable with per-backend causes', async () => {
  const harness = stubWorker('twitter', [
    {
      backend: 'twitter-cli',
      authTier: 'cookie',
      pagination: 'none',
      failWith: new SocialError('backend_unavailable', 'not installed'),
    },
    {
      backend: 'opencli-twitter',
      authTier: 'cookie',
      pagination: 'none',
      failWith: new SocialError('rate_limited', 'slow down'),
    },
  ]);
  const error = await socialErrorOf('backend_unavailable', () =>
    executeSocial({ platform: 'twitter', action: 'search', query: 'x' }, optionsFor(harness, 'twitter')),
  );
  assert.match(error.message, /twitter-cli/);
  assert.match(error.message, /opencli-twitter/);
});

// ── Cursor pinning ──

function cursorFor(platform: SocialPlatform, action: SocialAction, backend: string, extra: Record<string, unknown> = {}): string {
  const fingerprint = socialCursorFingerprint({ platform, action, limit: 20, ...extra });
  return encodeSocialCursor({ platform, action, backend, fingerprint, state: { after: 't3_abc' } });
}

test('cursor pins the issuing backend and never switches', async () => {
  const harness = stubWorker('reddit', [
    { backend: 'reddit-cookie', authTier: 'cookie', pagination: 'cursor' },
    { backend: 'rdt-cli', authTier: 'anonymous', pagination: 'cursor' },
  ]);
  const cursor = cursorFor('reddit', 'get_trending', 'rdt-cli');
  const result = await executeSocial(
    { platform: 'reddit', action: 'get_trending', cursor },
    optionsFor(harness, 'reddit'),
  );
  assert.deepEqual(harness.executes, ['rdt-cli']);
  assert.equal((result.details as Record<string, unknown>).backend, 'rdt-cli');
});

test('cursor selector changes are cursor_mismatch', async () => {
  const harness = stubWorker('reddit', [{ backend: 'rdt-cli', authTier: 'anonymous', pagination: 'cursor' }]);
  const cursor = cursorFor('reddit', 'get_trending', 'rdt-cli', { query: 'rust' });
  await socialErrorOf('cursor_mismatch', () =>
    executeSocial({ platform: 'reddit', action: 'get_trending', cursor }, optionsFor(harness, 'reddit')),
  );
  assert.deepEqual(harness.executes, []);
});

test('cursor for a backend with no declared plan is backend_unavailable', async () => {
  const harness = stubWorker('reddit', [{ backend: 'rdt-cli', authTier: 'anonymous', pagination: 'cursor' }]);
  const cursor = cursorFor('reddit', 'get_trending', 'reddit-cookie');
  await socialErrorOf('backend_unavailable', () =>
    executeSocial({ platform: 'reddit', action: 'get_trending', cursor }, optionsFor(harness, 'reddit')),
  );
  assert.deepEqual(harness.executes, []);
});

test('malformed cursors are cursor_invalid', async () => {
  const harness = stubWorker('reddit', [{ backend: 'rdt-cli', authTier: 'anonymous', pagination: 'cursor' }]);
  await socialErrorOf('cursor_invalid', () =>
    executeSocial({ platform: 'reddit', action: 'get_trending', cursor: 'not-a-cursor!!' }, optionsFor(harness, 'reddit')),
  );
  assert.deepEqual(harness.executes, []);
});

// ── Registry gating ──

test('plans absent from the registry never execute', async () => {
  const harness = stubWorker('twitter', [{ backend: 'unregistered-backend', authTier: 'cookie', pagination: 'none' }]);
  await socialErrorOf('backend_unavailable', () =>
    executeSocial({ platform: 'twitter', action: 'search', query: 'x' }, optionsFor(harness, 'twitter')),
  );
  assert.deepEqual(harness.executes, []);
});

test('every advertised action has a registry backend and every backend op is advertised', () => {
  const platforms = Object.keys(SOCIAL_CANONICAL_ACTIONS) as SocialPlatform[];
  for (const platform of platforms) {
    for (const action of SOCIAL_CANONICAL_ACTIONS[platform]) {
      const backends = SOCIAL_BACKEND_REGISTRY.filter(
        (entry) =>
          entry.platforms.includes(platform) &&
          entry.capability.operations.some((operation) => operation.action === action),
      );
      assert.ok(backends.length > 0, `${platform} ${action} has no registry backend`);
    }
  }
  for (const entry of SOCIAL_BACKEND_REGISTRY) {
    for (const platform of entry.platforms) {
      for (const operation of entry.capability.operations) {
        assert.ok(
          (SOCIAL_CANONICAL_ACTIONS[platform] as readonly string[]).includes(operation.action),
          `${entry.capability.name} declares unadvertised ${platform} op ${operation.action}`,
        );
      }
    }
  }
});

// ── Additive envelope ──

test('success carries a Pi-owned northstar envelope with canonical action', async () => {
  const harness = stubWorker('reddit', [{ backend: 'OpenCLI', authTier: 'anonymous', pagination: 'none' }], (plan, request) =>
    postPage(plan, request, 'Cookie post'),
  );
  const result = await executeSocial(
    { platform: 'reddit', action: 'get_thread', postId: 'abc123' },
    optionsFor(harness, 'reddit'),
  );
  const details = result.details as Record<string, unknown>;
  assert.equal(details.platform, 'reddit');
  assert.equal(details.action, 'get_thread');
  assert.equal(details.canonicalAction, 'get_thread');
  assert.equal(details.backend, 'OpenCLI');
  const northstar = details.northstar as {
    schema: string;
    version: number;
    status: string;
    request: Record<string, unknown>;
    data: { kind: string; entities: Array<Record<string, unknown>> };
    sources: Array<Record<string, unknown>>;
    errors: unknown[];
    notes: unknown[];
  };
  assert.equal(northstar.schema, 'pi-northstar.result');
  assert.equal(northstar.version, 1);
  assert.equal(northstar.status, 'ok');
  assert.equal(northstar.request.tool, 'social');
  assert.equal(northstar.request.channel, 'reddit');
  assert.equal(northstar.request.action, 'get_thread');
  assert.equal('requestedAction' in northstar.request, false);
  assert.equal(northstar.data.kind, 'entities');
  assert.equal(northstar.data.entities.length, 1);
  assert.equal(northstar.data.entities[0]?.kind, 'social_post');
  assert.deepEqual(northstar.sources, [{ source: 'reddit', backend: 'OpenCLI', status: 'ok', count: 1 }]);
  assert.deepEqual(northstar.errors, []);
});

test('profile entities map to social_account in the envelope', async () => {
  const harness: StubHarness = {
    plansCalls: 0,
    executes: [],
    worker: {
      platforms: ['twitter'],
      async plans(): Promise<readonly SocialBackendPlan[]> {
        harness.plansCalls += 1;
        return [{
          backend: 'twitter-cli',
          authTier: 'cookie',
          pagination: 'none',
          execute: async () => {
            harness.executes.push('twitter-cli');
            return {};
          },
        }];
      },
      normalize(request: SocialRequest, plan: SocialBackendPlan): SocialPageV1 {
        return {
          entities: [{
            version: 1,
            kind: 'social_account',
            id: 'twitter:social_account:naval',
            platformId: 'naval',
            platform: 'twitter',
            backend: plan.backend,
            url: 'https://x.com/naval',
            handle: 'naval',
            displayName: 'Naval',
            bio: 'founder',
          }],
          pagination: { supported: false, limit: request.limit, returned: 1, hasMore: false },
          partial: false,
          warnings: [],
        };
      },
    },
  };
  const result = await executeSocial(
    { platform: 'twitter', action: 'get_profile', user: 'naval' },
    optionsFor(harness, 'twitter'),
  );
  const northstar = (result.details as Record<string, unknown>).northstar as {
    data: { kind: string; entities: Array<Record<string, unknown>> };
  };
  assert.equal(northstar.data.entities[0]?.kind, 'social_account');
  assert.equal(northstar.data.entities[0]?.title, '@naval');
});

// ── Platform inference and defaults ──

test('v2ex omits to get_trending by default', async () => {
  const harness = stubWorker('v2ex', [{ backend: 'v2ex-legacy-api', authTier: 'anonymous', pagination: 'none' }]);
  const result = await executeSocial({ platform: 'v2ex' }, optionsFor(harness, 'v2ex'));
  assert.equal((result.details as Record<string, unknown>).canonicalAction, 'get_trending');
});

test('lookalike hosts never infer a platform', async () => {
  const harness = stubWorker('twitter', [{ backend: 'twitter-cli', authTier: 'cookie', pagination: 'none' }]);
  await socialErrorOf('invalid_request', () =>
    executeSocial({ url: 'https://twitter.com.evil.example/1', action: 'search', query: 'x' }, optionsFor(harness, 'twitter')),
  );
  assert.equal(harness.plansCalls, 0);
});

test('exact and subdomain hosts infer the platform', async () => {
  const harness = stubWorker('twitter', [{ backend: 'twitter-cli', authTier: 'cookie', pagination: 'none' }]);
  const result = await executeSocial(
    { url: 'https://x.com/naval/status/123', action: 'get_post' },
    optionsFor(harness, 'twitter'),
  );
  assert.equal((result.details as Record<string, unknown>).platform, 'twitter');
  assert.equal((result.details as Record<string, unknown>).canonicalAction, 'get_post');
});
