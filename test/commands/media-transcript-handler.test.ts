import assert from 'node:assert/strict';
import test from 'node:test';
import { createCommandContext } from '../../src/commands/command-context.js';
import {
  executeMediaTranscript,
  mapMediaTranscriptCommandResult,
  MEDIA_TRANSCRIPT_COMMAND,
} from '../../src/commands/media-transcript-handler.js';
import { buildNorthstarResult } from '../../src/result-contract.js';

function ctx(env: Record<string, string | undefined> = {}) {
  return createCommandContext({ surface: 'cli', env, invocationId: 'media-transcript-test' });
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
    await executeMediaTranscript(args, ctx(env));
  } catch (error) {
    const command = (error as CommandFailure).commandResult;
    assert.ok(command, 'expected a commandResult on failure');
    return command;
  }
  assert.fail('expected executeMediaTranscript to throw');
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

function youtubeOnly(seen: string[]): void {
  for (const url of seen) {
    assert.equal(new URL(url).hostname, 'www.youtube.com', `platform-native host only, got ${url}`);
  }
}

// ── Outcome mapping (transcript backends are degraded by contract) ──

test('media.transcript maps envelope statuses to command outcomes', () => {
  for (const [status, outcome] of [
    ['ok', 'success'],
    ['empty', 'empty'],
    ['partial', 'partial'],
    ['degraded', 'degraded'],
  ] as const) {
    const envelope =
      status === 'partial' || status === 'degraded'
        ? {
            request: { tool: 'media', channel: 'youtube', action: 'transcript', source: 'youtube-transcript' },
            status,
            data: {
              kind: 'entities',
              entities: [
                {
                  entityVersion: 1,
                  kind: 'video',
                  id: 'abc123',
                  source: 'youtube',
                  title: 'Transcript for abc123',
                  url: 'https://www.youtube.com/watch?v=abc123',
                  snippet: 'hello world',
                },
              ],
            },
            sources: [{ source: 'youtube', backend: 'youtube-transcript', status, count: 1 }],
            errors: [],
            pagination: { supported: false, limit: 1, hasMore: false },
            notes: [],
          }
        : buildNorthstarResult({
            request: { tool: 'media', channel: 'youtube', action: 'transcript', source: 'youtube-transcript' },
            outcomes:
              status === 'empty'
                ? [{ source: 'youtube', backend: 'youtube-transcript', entities: [] }]
                : [
                    {
                      source: 'youtube',
                      backend: 'youtube-transcript',
                      entities: [
                        {
                          entityVersion: 1,
                          kind: 'video',
                          id: 'abc123',
                          source: 'youtube',
                          title: 'Transcript for abc123',
                          url: 'https://www.youtube.com/watch?v=abc123',
                          snippet: 'hello world',
                        },
                      ],
                    },
                  ],
            pagination: { supported: false, limit: 1, hasMore: false },
          });
    const result = mapMediaTranscriptCommandResult(
      envelope as unknown as Parameters<typeof mapMediaTranscriptCommandResult>[0],
      ctx(),
    );
    assert.equal(result.commandId, MEDIA_TRANSCRIPT_COMMAND);
    assert.equal(result.outcome, outcome);
    assert.equal(result.trust, 'external');
    assert.equal(result.resolvedSurface, MEDIA_TRANSCRIPT_COMMAND);
  }
});

// ── Degraded keyless transcript (watch page + timedtext, never yt-dlp) ──

const WATCH_HTML = `<html><body><script>ytInitialPlayerResponse = {"captionTracks": [{"baseUrl": "https://www.youtube.com/api/timedtext?v=abc123&lang=en", "languageCode": "en"}]};</script></body></html>`;

const TIMEDTEXT_XML = `<transcript><text start="0.0" dur="2.0">hello world</text><text start="2.0" dur="2.0">second line</text></transcript>`;

test('media.transcript serves degraded youtube captions with command stamp', async () => {
  await withFetch(async (url) => {
    if (url.startsWith('https://www.youtube.com/watch')) {
      return new Response(WATCH_HTML, { status: 200, headers: { 'content-type': 'text/html' } });
    }
    if (url.startsWith('https://www.youtube.com/api/timedtext')) {
      return new Response(TIMEDTEXT_XML, { status: 200, headers: { 'content-type': 'application/xml' } });
    }
    throw new Error(`unexpected fetch ${url}`);
  }, async (seen) => {
    const result = await executeMediaTranscript(
      { platform: 'youtube', url: 'https://www.youtube.com/watch?v=abc123' },
      ctx(),
    );
    const details = result.details as Record<string, unknown>;
    assert.equal(details.backend, 'youtube-transcript');
    const items = details.items as Array<{ kind?: string; videoId?: string; segments?: unknown[] }>;
    assert.equal(items[0]?.kind, 'video_transcript');
    assert.equal(items[0]?.videoId, 'abc123');
    assert.equal((items[0]?.segments as unknown[]).length, 2);
    const command = details.northstarCommand as CommandIdentity;
    assert.equal(command.commandId, MEDIA_TRANSCRIPT_COMMAND);
    assert.equal(command.outcome, 'degraded');
    youtubeOnly(seen);
  });
});

test('media.transcript without captions fails terminally without generic-web fallback', async () => {
  await withFetch(async (url) => {
    if (url.startsWith('https://www.youtube.com/watch')) {
      return new Response('<html><body>no player here</body></html>', {
        status: 200,
        headers: { 'content-type': 'text/html' },
      });
    }
    throw new Error(`unexpected fetch ${url}`);
  }, async (seen) => {
    const command = await fails({ platform: 'youtube', id: 'abc123' });
    assert.equal(command.outcome, 'failed');
    // Retryable caption fetch failure exhausts the single transcript plan and
    // surfaces as terminal backend_unavailable — never generic-web fallback.
    assert.equal(command.error.code, 'backend_unavailable');
    youtubeOnly(seen);
  });
});

// ── Strict input gate ──

test('media.transcript rejects legacy subtitle spelling and other actions', async () => {
  await withFetch(async () => {
    assert.fail('no fetch on unsupported action');
  }, async (seen) => {
    for (const action of ['subtitle', 'video', 'details', 'search']) {
      const command = await fails({ platform: 'youtube', action, id: 'x' });
      assert.equal(command.error.code, 'unsupported_action', `action ${action}`);
    }
    assert.equal(seen.length, 0);
  });
});

test('media.transcript rejects missing selectors, bad limits, cursors, and unknown fields', async () => {
  await withFetch(async () => {
    assert.fail('no fetch on validation failure');
  }, async (seen) => {
    assert.equal((await fails({ platform: 'youtube' })).error.code, 'invalid_request');
    for (const limit of [0, 51, 99, 2.5]) {
      const command = await fails({ platform: 'youtube', id: 'x', limit });
      assert.equal(command.error.code, 'invalid_request', `limit ${String(limit)}`);
      assert.match(command.error.message, /limit must be an integer 1\.\.50/);
    }
    assert.equal(
      (await fails({ platform: 'youtube', id: 'x', cursor: 'AAAA' })).error.code,
      'pagination_not_supported',
    );
    assert.equal(
      (await fails({ platform: 'youtube', id: 'x', query: 'cats' })).error.code,
      'invalid_request',
    );
    assert.equal(seen.length, 0);
  });
});

// ── Cancellation ──

test('media.transcript maps abort to cancelled', async () => {
  const controller = new AbortController();
  controller.abort();
  await withFetch(async () => {
    assert.fail('aborted calls dispatch nothing');
  }, async (seen) => {
    try {
      await executeMediaTranscript(
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
