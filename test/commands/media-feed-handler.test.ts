import assert from 'node:assert/strict';
import test from 'node:test';
import { createCommandContext } from '../../src/commands/command-context.js';
import {
  executeMediaFeed,
  mapMediaFeedCommandResult,
  MEDIA_FEED_COMMAND,
} from '../../src/commands/media-feed-handler.js';
import { buildNorthstarResult } from '../../src/result-contract.js';

function ctx(env: Record<string, string | undefined> = {}) {
  return createCommandContext({ surface: 'cli', env, invocationId: 'media-feed-test' });
}

type CommandFailure = {
  commandResult?: {
    outcome: string;
    commandId: string;
    error: { code: string; message: string; retryable: boolean };
  };
};

type CommandIdentity = {
  commandId: string;
  outcome: string;
  error?: { code: string; message: string };
};

async function fails(args: Record<string, unknown>): Promise<NonNullable<CommandFailure['commandResult']>> {
  try {
    await executeMediaFeed(args, ctx());
  } catch (error) {
    const command = (error as CommandFailure).commandResult;
    assert.ok(command, 'expected a commandResult on failure');
    return command;
  }
  assert.fail('expected executeMediaFeed to throw');
}

async function withFetch<T>(
  mock: (url: string) => Response | Promise<Response>,
  fn: (seen: string[]) => Promise<T>,
): Promise<T> {
  const saved = globalThis.fetch;
  const seen: string[] = [];
  globalThis.fetch = (async (input: string | URL | Request) => {
    seen.push(String(input));
    return mock(String(input));
  }) as typeof fetch;
  try {
    return await fn(seen);
  } finally {
    globalThis.fetch = saved;
  }
}

const FEED_URL = 'https://www.youtube.com/feeds/videos.xml?channel_id=UCtest';

const FEED_XML =
  '<?xml version="1.0"?><rss><channel>' +
  '<item><title>Post One</title><link>https://www.youtube.com/watch?v=p1</link></item>' +
  '<item><title>Post Two</title><link>https://www.youtube.com/watch?v=p2</link></item>' +
  '</channel></rss>';

// ── Outcome mapping ──

test('media.feed maps envelope statuses to command outcomes', () => {
  for (const [status, outcome] of [
    ['ok', 'success'],
    ['empty', 'empty'],
  ] as const) {
    const envelope = buildNorthstarResult({
      request: { tool: 'media', channel: 'rss', action: 'feed', source: 'native-rss-atom' },
      outcomes:
        status === 'empty'
          ? [{ source: 'rss', backend: 'native-rss-atom', entities: [] }]
          : [
              {
                source: 'rss',
                backend: 'native-rss-atom',
                entities: [
                  {
                    entityVersion: 1,
                    kind: 'feed_entry',
                    id: 'rss:e1',
                    source: 'rss',
                    title: 'Post One',
                    url: 'https://www.youtube.com/watch?v=p1',
                  },
                ],
              },
            ],
      pagination: { supported: false, limit: 2, hasMore: false },
    });
    const result = mapMediaFeedCommandResult(envelope, ctx());
    assert.equal(result.commandId, MEDIA_FEED_COMMAND);
    assert.equal(result.outcome, outcome);
    assert.equal(result.trust, 'external');
    assert.equal(result.resolvedSurface, MEDIA_FEED_COMMAND);
  }
});

// ── Native RSS acquisition ──

test('media.feed serves native rss entries with command stamp', async () => {
  await withFetch(async (url) => {
    assert.match(url, /^https:\/\/www\.youtube\.com\/feeds\//);
    return new Response(FEED_XML, { status: 200, headers: { 'content-type': 'application/rss+xml' } });
  }, async (seen) => {
    const result = await executeMediaFeed({ url: FEED_URL }, ctx());
    const details = result.details as Record<string, unknown>;
    assert.equal(details.backend, 'native-rss-atom');
    const items = details.items as Array<{ kind?: string; title?: string }>;
    assert.equal(items.length, 2);
    assert.equal(items[0]?.kind, 'feed_entry');
    assert.equal(items[0]?.title, 'Post One');
    const command = details.northstarCommand as CommandIdentity;
    assert.equal(command.commandId, MEDIA_FEED_COMMAND);
    assert.equal(command.outcome, 'success');
    assert.equal(seen.length, 1);
  });
});

test('media.feed upstream failure is terminal with no generic-web fallback', async () => {
  await withFetch(async (url) => {
    assert.match(url, /^https:\/\/www\.youtube\.com\/feeds\//);
    throw new Error('socket hangup');
  }, async (seen) => {
    const command = await fails({ url: FEED_URL });
    assert.equal(command.outcome, 'failed');
    assert.equal(command.error.code, 'backend_unavailable');
    assert.equal(seen.length, 1);
  });
});

// ── Strict input gate ──

test('media.feed rejects missing url without dispatch', async () => {
  await withFetch(async () => {
    assert.fail('no fetch on validation failure');
  }, async (seen) => {
    assert.equal((await fails({})).error.code, 'invalid_request');
    assert.equal((await fails({ platform: 'rss' })).error.code, 'invalid_request');
    assert.equal(seen.length, 0);
  });
});

test('media.feed rejects non-rss channels and non-feed actions', async () => {
  await withFetch(async () => {
    assert.fail('no fetch on rejection');
  }, async (seen) => {
    assert.equal(
      (await fails({ platform: 'youtube', url: FEED_URL })).error.code,
      'unsupported_action',
    );
    assert.equal((await fails({ url: FEED_URL, id: 'x' })).error.code, 'invalid_request');
    assert.equal((await fails({ url: FEED_URL, action: 'search' })).error.code, 'unsupported_action');
    assert.equal(seen.length, 0);
  });
});

test('media.feed rejects out-of-range limits instead of clamping', async () => {
  await withFetch(async () => {
    assert.fail('no fetch on limit rejection');
  }, async (seen) => {
    for (const limit of [0, 51, 99, 2.5, Number.NaN, '10']) {
      const command = await fails({ url: FEED_URL, limit });
      assert.equal(command.error.code, 'invalid_request', `limit ${String(limit)}`);
      assert.match(command.error.message, /limit must be an integer 1\.\.50/);
    }
    assert.equal(seen.length, 0);
  });
});

test('media.feed rejects cursors and unknown fields', async () => {
  await withFetch(async () => {
    assert.fail('no fetch on rejection');
  }, async (seen) => {
    assert.equal((await fails({ url: FEED_URL, cursor: 'AAAA' })).error.code, 'pagination_not_supported');
    assert.equal((await fails({ url: FEED_URL, id: 'x' })).error.code, 'invalid_request');
    assert.equal(seen.length, 0);
  });
});

// ── Cancellation ──

test('media.feed maps abort to cancelled', async () => {
  const controller = new AbortController();
  controller.abort();
  await withFetch(async () => {
    assert.fail('aborted calls dispatch nothing');
  }, async (seen) => {
    try {
      await executeMediaFeed({ url: FEED_URL }, { ...ctx(), signal: controller.signal });
    } catch (error) {
      assert.equal((error as CommandFailure).commandResult?.outcome, 'cancelled');
      assert.equal(seen.length, 0);
      return;
    }
    assert.fail('expected cancellation to throw');
  });
});
