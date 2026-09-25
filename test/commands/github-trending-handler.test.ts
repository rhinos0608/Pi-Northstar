import assert from 'node:assert/strict';
import test from 'node:test';
import { createCommandContext } from '../../src/commands/command-context.js';
import { commandHandler } from '../../src/commands/command-registry.js';
import {
  executeGithubTrending,
  mapGithubTrendingCommandResult,
} from '../../src/commands/github-trending-handler.js';

function textResponse(body: string, status = 200): Response {
  return new Response(body, { status, headers: { 'content-type': 'text/html' } });
}

type FetchMock = (input: string | URL | Request, init?: RequestInit) => Promise<Response> | Response;

async function withFetch<T>(mock: FetchMock, fn: () => Promise<T>): Promise<T> {
  const saved = globalThis.fetch;
  globalThis.fetch = mock as typeof fetch;
  try {
    return await fn();
  } finally {
    globalThis.fetch = saved;
  }
}

const TRENDING_HTML =
  '<html><body>' +
  '<h2><a href="/octo/kit">octo / kit</a></h2>' +
  '<h2><a href="/acme/pro">acme / pro</a></h2>' +
  '</body></html>';

function ctx(surface = 'cli') {
  return createCommandContext({ surface, env: {}, invocationId: `trending-${surface}` });
}

// ── Outcome mapping ──

test('github.trending maps success/degraded/partial/empty statuses', () => {
  for (const [status, outcome] of [
    ['ok', 'success'],
    ['degraded', 'degraded'],
    ['partial', 'partial'],
    ['empty', 'empty'],
  ] as const) {
    const result = mapGithubTrendingCommandResult(
      {
        content: [{ type: 'text', text: 'trending' }],
        details: {
          entities: [],
          northstar: { status, request: { source: 'github-api' }, sources: [{ backend: 'github-api' }], data: { kind: 'entities' } },
        },
      },
      ctx(),
    );
    assert.equal(result.commandId, 'github.trending');
    assert.equal(result.outcome, outcome);
    assert.equal(result.trust, 'external');
    assert.equal(result.resolvedSurface, 'github.trending');
  }
});

// ── Handler execution ──

test('github.trending handler scrapes repos and stamps command identity', async () => {
  const result = await withFetch(async () => textResponse(TRENDING_HTML), () =>
    executeGithubTrending({ since: 'daily', limit: 5 }, ctx('pi')),
  );
  const details = result.details as Record<string, unknown>;
  const command = details.northstarCommand as { commandId: string; outcome: string };
  assert.equal(command.commandId, 'github.trending');
  assert.equal(command.outcome, 'success');
  const entities = details.entities as Array<{ full_name: string }>;
  assert.deepEqual(entities.map((e) => e.full_name), ['octo/kit', 'acme/pro']);
});

test('github.trending language scopes the scrape URL instead of dropping', async () => {
  const seen: string[] = [];
  await withFetch(async (input) => {
    seen.push(String(input));
    return textResponse(TRENDING_HTML);
  }, () => executeGithubTrending({ language: 'python', since: 'daily', limit: 2 }, ctx('pi')));
  assert.equal(seen.length, 1);
  assert.equal(seen[0], 'https://github.com/trending/python?since=daily');
});

test('github.trending scrape failure degrades instead of throwing', async () => {
  const result = await withFetch(async () => textResponse('', 500), () =>
    executeGithubTrending({ limit: 5 }, ctx()),
  );
  const command = (result.details as Record<string, unknown>).northstarCommand as {
    commandId: string;
    outcome: string;
  };
  assert.equal(command.commandId, 'github.trending');
  assert.equal(command.outcome, 'degraded');
});

test('github.trending abort maps to cancelled, never degraded', async () => {
  const abortError = new DOMException('operation aborted', 'AbortError');
  try {
    await withFetch(
      async () => {
        throw abortError;
      },
      () => executeGithubTrending({ limit: 5 }, ctx()),
    );
    assert.fail('expected abort to throw');
  } catch (error) {
    const command = (error as { commandResult?: { outcome: string; error: { code: string } } })
      .commandResult;
    assert.equal(command?.outcome, 'cancelled');
    assert.equal(command?.error.code, 'cancelled');
  }
});

test('github.trending validation failures are terminal failed/invalid_request', async () => {
  for (const args of [{ since: 'hourly' }, { limit: 0 }, { limit: 100000 }]) {
    try {
      await executeGithubTrending(args, ctx());
      assert.fail(`expected rejection for ${JSON.stringify(args)}`);
    } catch (error) {
      const command = (error as { commandResult?: { outcome: string; error: { code: string } } })
        .commandResult;
      assert.equal(command?.outcome, 'failed');
      assert.equal(command?.error.code, 'invalid_request');
    }
  }
});

// ── Registry + Pi/native parity (bypass closure) ──

test('github.trending resolves through the command registry', () => {
  assert.equal(commandHandler('github.trending').commandId, 'github.trending');
});

test('native github trending routes through the handler, not raw dispatch', async () => {
  const { callNativeTool } = await import('../../src/native-tools.js');
  const result = await withFetch(async () => textResponse(TRENDING_HTML), () =>
    callNativeTool('github', { action: 'trending', since: 'weekly', limit: 2 }, { env: {} }),
  );
  const command = ((result.details as Record<string, unknown>).northstarCommand ?? {}) as {
    commandId?: string;
    outcome?: string;
  };
  assert.equal(command.commandId, 'github.trending');
  assert.equal(command.outcome, 'success');
});

test('Pi github trending routes through the handler', async () => {
  const { registerGitHubTool } = await import('../../src/github/github.js');
  let execute!: (id: string, params: unknown, signal?: AbortSignal) => Promise<unknown>;
  const pi = {
    on: () => {},
    registerTool: (def: { name: string; execute: typeof execute }) => {
      if (def.name === 'github') execute = def.execute;
    },
    registerCommand: () => {},
  };
  registerGitHubTool(pi as never, { callTool: async () => ({}), close: async () => {} } as never, {});
  const outcome = await withFetch(async () => textResponse(TRENDING_HTML), () =>
    execute('id', { action: 'trending', since: 'monthly', limit: 2 }),
  );
  const wrapped = (outcome as { details: { details: Record<string, unknown> } }).details;
  const command = wrapped.details.northstarCommand as { commandId: string; outcome: string };
  assert.equal(command.commandId, 'github.trending');
  assert.equal(command.outcome, 'success');
});

// ── CLI grammar ──

test('CLI github trending help, strict rejection, and success modes', async () => {
  const { runCommand } = await import('../../src/cli/cli.js');
  const help = await runCommand(['github', 'trending', '--help'], {});
  assert.equal(help.ok, true);
  assert.equal(
    (help.data as { commandId: string }).commandId,
    'github.trending',
  );
  assert.match((help.data as { usage: string }).usage, /northstar github trending/);

  for (const args of [
    ['github', 'trending', '--bogus'],
    ['github', 'trending', '--since'],
    ['github', 'trending', '--since', 'daily', '--since', 'weekly'],
    ['github', 'trending', '--limit'],
    ['github', 'trending', '--limit', 'abc'],
    ['github', 'trending', '--json', '--agent'],
    ['github', 'trending', 'extra-positional'],
  ]) {
    const rejected = await runCommand(args, {});
    assert.equal(rejected.ok, false, args.join(' '));
  }

  const invalid = await runCommand(['github', 'trending', '--since', 'hourly'], {});
  assert.equal(invalid.ok, false);
  assert.match(String((invalid.data as string) ?? ''), /invalid_request/);

  const human = await withFetch(async () => textResponse(TRENDING_HTML), () =>
    runCommand(['github', 'trending', '--since', 'daily', '--limit', '2'], {}),
  );
  assert.equal(human.ok, true);
  assert.match(String(human.data), /github\.trending: success/);

  const json = await withFetch(async () => textResponse(TRENDING_HTML), () =>
    runCommand(['github', 'trending', '--json'], {}),
  );
  assert.equal(json.ok, true);
  const parsed = JSON.parse(String(json.data));
  assert.equal(parsed.commandId, 'github.trending');
  assert.equal(parsed.outcome, 'success');
});
