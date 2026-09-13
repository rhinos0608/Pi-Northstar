// Stage 8b write-gate wiring tests (src/social.ts pre-dispatch gate).
// - every platform/action in write vocab → denied when kill switch unset
// - with PI_SEARCH_SOCIAL_WRITE=1 → still denied by default empty allowlist
// - gate fires before worker plan construction (plansCalls 0, no executes)
// - dry-run preview shape via trySocialWrite unit path (no spawn/fetch)
// - read actions unaffected (search/get_post spot-checks with gate inserted)
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SOCIAL_PLATFORMS, SocialError } from '../../src/social/social-contract.js';
import { SOCIAL_WRITE_ACTIONS } from '../../src/social/social-write-contract.js';
import { trySocialWrite } from '../../src/social/social-write-policy.js';
import { executeSocial } from '../../src/social/social.js';
import type {
  SocialBackendPlan,
  SocialPageV1,
  SocialPlatform,
  SocialPlatformWorker,
  SocialRequest,
} from '../../src/social/social-contract.js';

const ENABLED = { PI_SEARCH_SOCIAL_WRITE: '1' };
const DISABLED: Record<string, string | undefined> = {};

function writeArgs(platform: string, action: string): Record<string, unknown> {
  switch (action) {
    case 'create_post':
      return { platform, action, payload: { text: 'hello preview' } };
    case 'add_comment':
      return { platform, action, postId: 'p1', payload: { text: 'nice post' } };
    case 'like':
      return { platform, action, postId: 'p1' };
    case 'follow':
      return { platform, action, user: 'someone' };
    default:
      return { platform, action };
  }
}

function stubWorker(platform: SocialPlatform, backend = 'twitter-cli'): {
  worker: SocialPlatformWorker;
  state: { plansCalls: number; executes: string[] };
} {
  const state = { plansCalls: 0, executes: [] as string[] };
  const worker: SocialPlatformWorker = {
    platforms: [platform],
    async plans(_request: SocialRequest): Promise<readonly SocialBackendPlan[]> {
      state.plansCalls += 1;
      return [
        {
          backend,
          authTier: 'anonymous',
          pagination: 'none',
          execute: async () => {
            state.executes.push(backend);
            return {};
          },
        },
      ];
    },
    normalize(_request: SocialRequest, plan: SocialBackendPlan): SocialPageV1 {
      return {
        entities: [
          {
            version: 1,
            kind: 'social_post',
            id: `${platform}:social_post:1`,
            platformId: '1',
            platform,
            backend: plan.backend,
            url: 'https://example.com/p/1',
            contentType: 'post',
            title: 'stub',
            text: 'stub body',
          },
        ],
        pagination: { supported: false, limit: _request.limit, returned: 1, hasMore: false },
        partial: false,
        warnings: [],
      };
    },
  };
  return { worker, state };
}

async function writeErrorOf(
  code: string,
  run: () => Promise<unknown>,
): Promise<SocialError> {
  try {
    await run();
  } catch (error) {
    assert.ok(error instanceof SocialError, `expected SocialError, got ${String(error)}`);
    assert.equal(error.code, code);
    return error;
  }
  throw new Error(`expected SocialError(${code}) but nothing was thrown`);
}

test('write vocab denied with social_write_disabled when kill switch unset', async () => {
  for (const platform of SOCIAL_PLATFORMS) {
    for (const action of SOCIAL_WRITE_ACTIONS) {
      const { worker, state } = stubWorker(platform);
      const error = await writeErrorOf(
        'permission_denied',
        () =>
          executeSocial(writeArgs(platform, action), {
            env: DISABLED,
            workers: { [platform]: worker } as Partial<Record<SocialPlatform, SocialPlatformWorker>>,
          }),
      );
      assert.ok(
        error.message.startsWith('social_write_disabled:'),
        `expected social_write_disabled prefix, got ${error.message}`,
      );
      assert.equal(state.plansCalls, 0, `${platform}/${action} must not construct plans`);
      assert.deepEqual(state.executes, []);
    }
  }
});

test('write vocab denied by empty allowlist with kill switch =1', async () => {
  for (const platform of SOCIAL_PLATFORMS) {
    for (const action of SOCIAL_WRITE_ACTIONS) {
      const { worker, state } = stubWorker(platform);
      const error = await writeErrorOf(
        'permission_denied',
        () =>
          executeSocial(writeArgs(platform, action), {
            env: ENABLED,
            workers: { [platform]: worker } as Partial<Record<SocialPlatform, SocialPlatformWorker>>,
          }),
      );
      assert.ok(
        error.message.startsWith('social_write_denied:'),
        `expected social_write_denied prefix, got ${error.message}`,
      );
      assert.equal(state.plansCalls, 0, `${platform}/${action} must not construct plans`);
      assert.deepEqual(state.executes, []);
    }
  }
});

test('dry-run preview shape: platform/action/target/textLength, no text echo', () => {
  const matrix = {
    twitter: ['like'],
    reddit: [],
    xiaohongshu: [],
    facebook: [],
    instagram: [],
    v2ex: [],
    linkedin: [],
  } as const;
  const result = trySocialWrite(
    { platform: 'twitter', action: 'like', postId: 'p1' } as never,
    ENABLED,
    { matrix: matrix as never },
  );
  assert.equal(result.status, 'dry_run');
  assert.equal(result.reason, 'dry_run_preview');
  assert.equal(result.preview?.platform, 'twitter');
  assert.equal(result.preview?.action, 'like');
  assert.equal(result.preview?.target, 'p1');
  assert.equal(result.preview?.textLength, 0);
  assert.ok(!('text' in (result.preview ?? {})), 'preview must not echo payload text');
});

test('read actions unaffected by gate: search + get_post still dispatch', async () => {
  const { worker, state } = stubWorker('twitter', 'twitter-cli');
  const search = await executeSocial(
    { platform: 'twitter', action: 'search', query: 'pi' },
    { env: DISABLED, workers: { twitter: worker } },
  );
  assert.equal(state.plansCalls, 1);
  assert.deepEqual(state.executes, ['twitter-cli']);
  assert.equal((search.details as Record<string, unknown>).action, 'search');

  const { worker: worker2, state: state2 } = stubWorker('reddit', 'OpenCLI');
  const post = await executeSocial(
    { platform: 'reddit', action: 'get_post', postId: 'abc' },
    { env: ENABLED, workers: { reddit: worker2 } },
  );
  assert.equal(state2.plansCalls, 1);
  assert.deepEqual(state2.executes, ['OpenCLI']);
  assert.equal((post.details as Record<string, unknown>).action, 'get_post');
});
