import assert from 'node:assert/strict';
import test from 'node:test';
import type { BackendCallResult } from '../../src/backend.js';
import { createCommandContext } from '../../src/commands/command-context.js';
import {
  executeSocialSearch,
  mapSocialSearchCommandResult,
  setSocialSearchExecutor,
  SOCIAL_SEARCH_COMMAND,
} from '../../src/commands/social-search-handler.js';
import { buildNorthstarResult, type NorthstarResultV1 } from '../../src/result-contract.js';
import { SocialError } from '../../src/social/social-contract.js';

function ctx(env: Record<string, string | undefined> = {}) {
  return createCommandContext({ surface: 'cli', env, invocationId: 'social-search-test' });
}

type CommandFailure = {
  commandResult?: {
    outcome: string;
    commandId: string;
    error: { code: string; message: string; retryable: boolean };
  };
};

async function fails(
  args: Record<string, unknown>,
  env: Record<string, string | undefined> = {},
): Promise<NonNullable<CommandFailure['commandResult']>> {
  try {
    await executeSocialSearch(args, ctx(env));
  } catch (error) {
    const command = (error as CommandFailure).commandResult;
    assert.ok(command, 'expected a commandResult on failure');
    return command;
  }
  assert.fail('expected executeSocialSearch to throw');
}

function entity(id: string) {
  return {
    entityVersion: 1 as const,
    kind: 'social_post' as const,
    id,
    source: 'twitter',
    title: 'T',
    url: 'https://x.com/u/status/1',
  };
}

function envelopeFor(status: 'ok' | 'empty' | 'partial' | 'degraded' | 'error'): NorthstarResultV1 {
  if (status === 'partial') {
    return buildNorthstarResult({
      request: { tool: 'social', channel: 'twitter', action: 'search', source: 'fake' },
      outcomes: [
        { source: 'twitter', backend: 'fake', entities: [entity('twitter:social_post:1')] },
        {
          source: 'twitter',
          backend: 'fake-2',
          error: { code: 'backend_http_error', message: 'boom', retryable: true },
        },
      ],
      pagination: { supported: false, limit: 1, hasMore: false },
    });
  }
  if (status === 'degraded') {
    return buildNorthstarResult({
      request: { tool: 'social', channel: 'twitter', action: 'search', source: 'fake' },
      outcomes: [{ source: 'twitter', backend: 'fake', entities: [entity('twitter:social_post:1')], degraded: true }],
      pagination: { supported: false, limit: 1, hasMore: false },
    });
  }
  if (status === 'error') {
    return buildNorthstarResult({
      request: { tool: 'social', channel: 'twitter', action: 'search', source: 'fake' },
      outcomes: [
        {
          source: 'twitter',
          backend: 'fake',
          error: { code: 'backend_unavailable', message: 'down', retryable: true },
        },
      ],
      pagination: { supported: false, limit: 0, hasMore: false },
    });
  }
  return buildNorthstarResult({
    request: { tool: 'social', channel: 'twitter', action: 'search', source: 'fake' },
    outcomes: [
      {
        source: 'twitter',
        backend: 'fake',
        ...(status === 'ok' ? { entities: [entity('twitter:social_post:1')] } : { entities: [] }),
      },
    ],
    pagination: { supported: false, limit: 1, hasMore: false },
  });
}

function stubResult(envelope: NorthstarResultV1): BackendCallResult {
  return { content: [{ type: 'text', text: 'fake' }], details: { northstar: envelope } };
}

// ── Outcome mapping ──

test('social.search maps envelope statuses to command outcomes', () => {
  for (const [status, outcome] of [
    ['ok', 'success'],
    ['empty', 'empty'],
    ['partial', 'partial'],
    ['degraded', 'degraded'],
    ['error', 'failed'],
  ] as const) {
    const result = mapSocialSearchCommandResult(envelopeFor(status), ctx());
    assert.equal(result.commandId, SOCIAL_SEARCH_COMMAND);
    assert.equal(result.outcome, outcome);
    assert.equal(result.trust, 'external');
    assert.equal(result.resolvedSurface, SOCIAL_SEARCH_COMMAND);
  }
});

// ── Success stamp + forwarding ──

test('social.search stamps northstarCommand and forwards canonical args', async () => {
  const seen: Array<{ args: Record<string, unknown> }> = [];
  setSocialSearchExecutor(async (args) => {
    seen.push({ args });
    return stubResult(envelopeFor('ok'));
  });
  try {
    const result = await executeSocialSearch(
      { platform: 'twitter', action: 'search', query: 'cats', limit: 10 },
      ctx(),
    );
    const details = result.details as Record<string, unknown>;
    const command = details.northstarCommand as { commandId: string; outcome: string };
    assert.equal(command.commandId, SOCIAL_SEARCH_COMMAND);
    assert.equal(command.outcome, 'success');
    assert.equal(seen.length, 1);
    assert.deepEqual(seen[0]?.args, {
      platform: 'twitter',
      action: 'search',
      query: 'cats',
      limit: 10,
    });
  } finally {
    setSocialSearchExecutor(undefined);
  }
});

test('social.search defaults missing action to search', async () => {
  const seen: Array<Record<string, unknown>> = [];
  setSocialSearchExecutor(async (args) => {
    seen.push(args);
    return stubResult(envelopeFor('empty'));
  });
  try {
    const result = await executeSocialSearch({ platform: 'reddit', query: 'cats' }, ctx());
    const command = (result.details as Record<string, unknown>).northstarCommand as { outcome: string };
    assert.equal(command.outcome, 'empty');
    assert.equal(seen[0]?.action, 'search');
  } finally {
    setSocialSearchExecutor(undefined);
  }
});

// ── Strict input gate ──

test('social.search rejects legacy spellings as unsupported_action pre-dispatch', async () => {
  setSocialSearchExecutor(async () => {
    assert.fail('no dispatch on unsupported action');
    throw new Error('unreachable');
  });
  try {
    for (const action of ['read', 'post', 'subreddit', 'note', 'topic', 'video', 'get_post', 'feed']) {
      const command = await fails({ platform: 'twitter', action, query: 'x' });
      assert.equal(command.error.code, 'unsupported_action', `action ${action}`);
    }
  } finally {
    setSocialSearchExecutor(undefined);
  }
});

test('social.search rejects unknown fields, bad platform, and bad cursor without dispatch', async () => {
  let dispatched = 0;
  setSocialSearchExecutor(async () => {
    dispatched += 1;
    return stubResult(envelopeFor('ok'));
  });
  try {
    assert.equal((await fails({ platform: 'twitter', query: 'x', limit: 5, extra: 1 })).error.code, 'invalid_request');
    assert.equal((await fails({ platform: 'nope', query: 'x' })).error.code, 'invalid_request');
    assert.equal((await fails({ query: 'x' })).error.code, 'invalid_request');
    assert.equal((await fails({ platform: 'twitter', query: 'x', cursor: 42 })).error.code, 'invalid_request');
    assert.equal((await fails({ platform: 'twitter', action: 42, query: 'x' })).error.code, 'invalid_request');
    assert.equal(dispatched, 0);
  } finally {
    setSocialSearchExecutor(undefined);
  }
});

test('social.search rejects out-of-range limits instead of clamping', async () => {
  let dispatched = 0;
  setSocialSearchExecutor(async () => {
    dispatched += 1;
    return stubResult(envelopeFor('ok'));
  });
  try {
    for (const limit of [0, 101, 250, 2.5, Number.NaN, '10']) {
      const command = await fails({ platform: 'twitter', query: 'x', limit });
      assert.equal(command.error.code, 'invalid_request', `limit ${String(limit)}`);
      assert.match(command.error.message, /limit must be an integer 1\.\.100/);
    }
    assert.equal(dispatched, 0);
  } finally {
    setSocialSearchExecutor(undefined);
  }
});

test('social.search rejection messages never echo credential-shaped values', async () => {
  setSocialSearchExecutor(async () => {
    assert.fail('no dispatch on rejection');
    throw new Error('unreachable');
  });
  try {
    const secret = 'SECRET-test-cookie-value';
    const command = await fails({ platform: 'twitter', query: secret, limit: 999 });
    assert.equal(command.error.code, 'invalid_request');
    assert.ok(!command.error.message.includes(secret), 'limit message must not echo the query');
  } finally {
    setSocialSearchExecutor(undefined);
  }
});

// ── Terminality ──

test('social.search auth failure is terminal and never echoes the token', async () => {
  const token = 'TOKEN-test-auth-value';
  setSocialSearchExecutor(async () => {
    throw new SocialError('authentication_required', 'auth failed', { platform: 'twitter' });
  });
  try {
    const command = await fails({ platform: 'twitter', query: 'x' }, { FAKE_TOKEN: token });
    assert.equal(command.outcome, 'failed');
    assert.equal(command.error.code, 'authentication_required');
    assert.equal(command.error.retryable, false);
    assert.equal(command.error.message, 'auth failed');
    assert.ok(!command.error.message.includes(token), 'handler must not append credential material');
  } finally {
    setSocialSearchExecutor(undefined);
  }
});

test('social.search rate limit and cursor errors stay terminal with codes preserved', async () => {
  for (const code of ['rate_limited', 'cursor_invalid', 'cursor_mismatch'] as const) {
    setSocialSearchExecutor(async () => {
      throw new SocialError(code, `${code} happened`, { platform: 'twitter' });
    });
    try {
      const command = await fails({ platform: 'twitter', query: 'x' });
      assert.equal(command.outcome, 'failed');
      assert.equal(command.error.code, code);
    } finally {
      setSocialSearchExecutor(undefined);
    }
  }
});

test('social.search maps abort to cancelled without dispatch', async () => {
  const controller = new AbortController();
  controller.abort();
  let dispatched = 0;
  setSocialSearchExecutor(async () => {
    dispatched += 1;
    return stubResult(envelopeFor('ok'));
  });
  try {
    try {
      await executeSocialSearch({ platform: 'twitter', query: 'x' }, { ...ctx(), signal: controller.signal });
    } catch (error) {
      assert.equal((error as CommandFailure).commandResult?.outcome, 'cancelled');
      assert.equal(dispatched, 0);
      return;
    }
    assert.fail('expected cancellation to throw');
  } finally {
    setSocialSearchExecutor(undefined);
  }
});

test('social.search without a canonical envelope fails malformed_upstream', async () => {
  setSocialSearchExecutor(async () => ({ content: [], details: {} }));
  try {
    const command = await fails({ platform: 'twitter', query: 'x' });
    assert.equal(command.error.code, 'malformed_upstream');
  } finally {
    setSocialSearchExecutor(undefined);
  }
});
