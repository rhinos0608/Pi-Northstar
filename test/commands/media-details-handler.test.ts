import assert from 'node:assert/strict';
import test from 'node:test';
import { createCommandContext } from '../../src/commands/command-context.js';
import {
  executeMediaDetails,
  mapMediaDetailsCommandResult,
  MEDIA_DETAILS_COMMAND,
} from '../../src/commands/media-details-handler.js';
import { buildNorthstarResult } from '../../src/result-contract.js';

function ctx(env: Record<string, string | undefined> = {}) {
  return createCommandContext({ surface: 'cli', env, invocationId: 'media-details-test' });
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

async function fails(
  args: Record<string, unknown>,
  env: Record<string, string | undefined> = {},
): Promise<NonNullable<CommandFailure['commandResult']>> {
  try {
    await executeMediaDetails(args, ctx(env));
  } catch (error) {
    const command = (error as CommandFailure).commandResult;
    assert.ok(command, 'expected a commandResult on failure');
    return command;
  }
  assert.fail('expected executeMediaDetails to throw');
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

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function youtubeOnly(seen: string[]): void {
  for (const url of seen) {
    const host = new URL(url).hostname;
    assert.ok(
      host === 'www.youtube.com' || host === 'www.googleapis.com',
      `platform-native host only, got ${host}`,
    );
  }
}

// ── Outcome mapping ──

test('media.details maps envelope statuses to command outcomes', () => {
  for (const [status, outcome] of [
    ['ok', 'success'],
    ['empty', 'empty'],
    ['partial', 'partial'],
    ['degraded', 'degraded'],
  ] as const) {
    const envelope =
      status === 'partial' || status === 'degraded'
        ? {
            request: { tool: 'media', channel: 'youtube', action: 'details', source: 'youtube-data-api' },
            status,
            data: {
              kind: 'entities',
              entities: [
                {
                  entityVersion: 1,
                  kind: 'video',
                  id: 'youtube:v1',
                  source: 'youtube',
                  title: 'T',
                  url: 'https://www.youtube.com/watch?v=v1',
                },
              ],
            },
            sources: [{ source: 'youtube', backend: 'youtube-data-api', status, count: 1 }],
            errors: [],
            pagination: { supported: false, limit: 1, hasMore: false },
            notes: [],
          }
        : buildNorthstarResult({
            request: { tool: 'media', channel: 'youtube', action: 'details', source: 'youtube-data-api' },
            outcomes:
              status === 'empty'
                ? [{ source: 'youtube', backend: 'youtube-data-api', entities: [] }]
                : [
                    {
                      source: 'youtube',
                      backend: 'youtube-data-api',
                      entities: [
                        {
                          entityVersion: 1,
                          kind: 'video',
                          id: 'youtube:v1',
                          source: 'youtube',
                          title: 'T',
                          url: 'https://www.youtube.com/watch?v=v1',
                        },
                      ],
                    },
                  ],
            pagination: { supported: false, limit: 1, hasMore: false },
          });
    const result = mapMediaDetailsCommandResult(
      envelope as unknown as Parameters<typeof mapMediaDetailsCommandResult>[0],
      ctx(),
    );
    assert.equal(result.commandId, MEDIA_DETAILS_COMMAND);
    assert.equal(result.outcome, outcome);
    assert.equal(result.trust, 'external');
    assert.equal(result.resolvedSurface, MEDIA_DETAILS_COMMAND);
  }
});

// ── Keyless degraded details (oEmbed fallback) ──

test('media.details serves keyless youtube details via degraded oEmbed with command stamp', async () => {
  await withFetch(async (url) => {
    assert.match(url, /^https:\/\/www\.youtube\.com\/oembed/);
    return json({ title: 'Keyless Video', author_name: 'chan', author_url: 'https://www.youtube.com/@chan' });
  }, async (seen) => {
    const result = await executeMediaDetails({ platform: 'youtube', id: 'dQw4w9WgXcQ' }, ctx());
    const details = result.details as Record<string, unknown>;
    assert.equal(details.backend, 'youtube-oembed');
    const command = details.northstarCommand as CommandIdentity;
    assert.equal(command.commandId, MEDIA_DETAILS_COMMAND);
    assert.equal(command.outcome, 'degraded');
    youtubeOnly(seen);
  });
});

// ── Strict input gate ──

test('media.details rejects missing selectors without dispatch', async () => {
  await withFetch(async () => {
    assert.fail('no fetch on validation failure');
  }, async (seen) => {
    assert.equal((await fails({ platform: 'youtube' })).error.code, 'invalid_request');
    assert.equal((await fails({})).error.code, 'invalid_request');
    assert.equal(seen.length, 0);
  });
});

test('media.details rejects legacy video/subtitle spellings as unsupported_action', async () => {
  await withFetch(async () => {
    assert.fail('no fetch on unsupported action');
  }, async (seen) => {
    for (const action of ['video', 'subtitle', 'search', 'feed']) {
      const command = await fails({ platform: 'youtube', action, id: 'x' });
      assert.equal(command.error.code, 'unsupported_action', `action ${action}`);
    }
    assert.equal(seen.length, 0);
  });
});

test('media.details rejects out-of-range limits instead of clamping', async () => {
  await withFetch(async () => {
    assert.fail('no fetch on limit rejection');
  }, async (seen) => {
    for (const limit of [0, 51, 99, 2.5, Number.NaN, '10']) {
      const command = await fails({ platform: 'youtube', id: 'x', limit });
      assert.equal(command.error.code, 'invalid_request', `limit ${String(limit)}`);
      assert.match(command.error.message, /limit must be an integer 1\.\.50/);
    }
    // Bilibili caps at the contract default of 25.
    assert.match(
      (await fails({ platform: 'bilibili', id: 'BV1xx411c7mD', limit: 26 })).error.message,
      /1\.\.25/,
    );
    assert.equal(seen.length, 0);
  });
});

test('media.details rejects unknown fields, cursors, and non-youtube/bilibili channels', async () => {
  await withFetch(async () => {
    assert.fail('no fetch on rejection');
  }, async (seen) => {
    assert.equal(
      (await fails({ platform: 'youtube', id: 'x', query: 'cats' })).error.code,
      'invalid_request',
    );
    const cursor = await fails({ platform: 'youtube', id: 'x', cursor: 'AAAA' });
    assert.equal(cursor.error.code, 'pagination_not_supported');
    assert.equal(
      (await fails({ platform: 'rss', url: 'https://www.youtube.com/feeds/x' })).error.code,
      'unsupported_action',
    );
    assert.equal(seen.length, 0);
  });
});

// ── Auth terminality + zero credential echo ──

test('media.details keyed auth failure is terminal and never echoes the key', async () => {
  const key = 'BADKEY-9f8e7d6c5b4a';
  await withFetch(async (url) => {
    if (url.includes('www.googleapis.com')) {
      return new Response('forbidden', { status: 401 });
    }
    assert.fail(`auth failure must not fall back, got fetch ${url}`);
  }, async (seen) => {
    const command = await fails({ platform: 'youtube', id: 'x' }, { YOUTUBE_API_KEY: key });
    assert.equal(command.outcome, 'failed');
    assert.equal(command.error.code, 'authentication_required');
    assert.equal(command.error.retryable, false);
    assert.ok(!command.error.message.includes(key), 'error must not echo the API key');
    youtubeOnly(seen);
  });
});

// ── Cancellation ──

test('media.details maps abort to cancelled', async () => {
  const controller = new AbortController();
  controller.abort();
  await withFetch(async () => {
    assert.fail('aborted calls dispatch nothing');
  }, async (seen) => {
    try {
      await executeMediaDetails(
        { platform: 'youtube', id: 'x' },
        { ...ctx(), signal: controller.signal },
      );
    } catch (error) {
      assert.equal((error as CommandFailure).commandResult?.outcome, 'cancelled');
      assert.equal(seen.length, 0);
      return;
    }
    assert.fail('expected cancellation to throw');
  });
});
