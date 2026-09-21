import assert from 'node:assert/strict';
import test from 'node:test';
import { createCommandContext } from '../../src/commands/command-context.js';
import {
  executeGithubReleases,
  mapGithubReleasesCommandResult,
} from '../../src/commands/github-releases-handler.js';
import { runCommand } from '../../src/cli/cli.js';

function jsonResponse(body: unknown, status = 200, link: string | null = null): Response {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (link !== null) headers.link = link;
  return new Response(JSON.stringify(body), { status, headers });
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

function ctx(surface = 'cli') {
  return createCommandContext({ surface, env: {}, invocationId: `releases-${surface}` });
}

const release = {
  id: 2, tag_name: 'v1.0.0', name: 'one', published_at: '2024-05-01T00:00:00Z',
  html_url: 'https://github.com/octo/kit/releases/tag/v1.0.0', body: 'notes',
};

// ── Outcome mapping ──

test('github.releases maps success/degraded/partial/empty statuses', () => {
  for (const [status, outcome] of [
    ['ok', 'success'],
    ['degraded', 'degraded'],
    ['partial', 'partial'],
    ['empty', 'empty'],
  ] as const) {
    const result = mapGithubReleasesCommandResult(
      {
        content: [{ type: 'text', text: 'releases' }],
        details: {
          entities: [],
          northstar: { status, request: { source: 'github-api' }, sources: [{ backend: 'github-api' }], data: { kind: 'entities' } },
        },
      },
      ctx(),
    );
    assert.equal(result.commandId, 'github.releases');
    assert.equal(result.outcome, outcome);
    assert.equal(result.trust, 'external');
    assert.equal(result.resolvedSurface, 'github.releases');
  }
});

// ── Handler execution: tag/latest-vs-list dual mode ──

test('github.releases tag mode fetches the tag endpoint', async () => {
  const seen: string[] = [];
  const result = await withFetch(
    async (input) => {
      seen.push(String(input));
      return jsonResponse(release);
    },
    () => executeGithubReleases({ owner: 'octo', repo: 'kit', tag: 'v1.0.0' }, ctx('pi')),
  );
  assert.ok(seen.some((url) => url.includes('/releases/tags/v1.0.0')));
  const command = (result.details as Record<string, unknown>).northstarCommand as { commandId: string };
  assert.equal(command.commandId, 'github.releases');
});

test('github.releases latest mode fetches the latest endpoint', async () => {
  const seen: string[] = [];
  await withFetch(
    async (input) => {
      seen.push(String(input));
      return jsonResponse(release);
    },
    () => executeGithubReleases({ owner: 'octo', repo: 'kit', latest: true }, ctx()),
  );
  assert.ok(seen.some((url) => /\/releases\/latest$/.test(url)));
});

test('github.releases list mode pages the collection endpoint', async () => {
  const seen: string[] = [];
  const result = await withFetch(
    async (input) => {
      seen.push(String(input));
      return jsonResponse([release]);
    },
    () => executeGithubReleases({ owner: 'octo', repo: 'kit', limit: 5 }, ctx()),
  );
  assert.ok(seen.some((url) => /\/releases\?/.test(url) && url.includes('per_page=5')));
  const entities = (result.details as Record<string, unknown>).entities as Array<{ kind: string }>;
  assert.equal(entities[0]?.kind, 'release');
});

// ── Contract semantics preserved ──

test('github.releases rejects out-of-range limit instead of clamping', async () => {
  await assert.rejects(
    executeGithubReleases({ owner: 'octo', repo: 'kit', limit: 51 }, ctx()),
    (error: unknown) => (error as { code?: string }).code === 'invalid_request',
  );
});

test('github.releases rejects a cursor pinned to another action', async () => {
  const { encodeGithubCursor, githubCursorFingerprint } = await import('../../src/github/github-contract.js');
  const fingerprint = githubCursorFingerprint({ action: 'commits', owner: 'octo', repo: 'kit', limit: 20 });
  const cursor = encodeGithubCursor({ action: 'commits', backend: 'github-api', fingerprint, state: { page: 2 } });
  await assert.rejects(
    executeGithubReleases({ owner: 'octo', repo: 'kit', cursor }, ctx()),
    (error: unknown) => (error as { code?: string }).code === 'cursor_invalid',
  );
});

test('github.releases rejects a list cursor reused with a tag selector', async () => {
  const { encodeGithubCursor, githubCursorFingerprint } = await import('../../src/github/github-contract.js');
  const fingerprint = githubCursorFingerprint({ action: 'releases', owner: 'octo', repo: 'kit', limit: 20 });
  const cursor = encodeGithubCursor({ action: 'releases', backend: 'github-api', fingerprint, state: { page: 2 } });
  await assert.rejects(
    executeGithubReleases({ owner: 'octo', repo: 'kit', tag: 'v1.0.0', cursor }, ctx()),
    (error: unknown) => (error as { code?: string }).code === 'cursor_invalid',
  );
});

test('github.releases rejects a list cursor reused with latest', async () => {
  const { encodeGithubCursor, githubCursorFingerprint } = await import('../../src/github/github-contract.js');
  const fingerprint = githubCursorFingerprint({ action: 'releases', owner: 'octo', repo: 'kit', limit: 20 });
  const cursor = encodeGithubCursor({ action: 'releases', backend: 'github-api', fingerprint, state: { page: 2 } });
  await assert.rejects(
    executeGithubReleases({ owner: 'octo', repo: 'kit', latest: true, cursor }, ctx()),
    (error: unknown) => (error as { code?: string }).code === 'cursor_invalid',
  );
});

test('github.releases surfaces auth failure as terminal', async () => {
  await withFetch(
    async () => new Response('unauthorized', { status: 401 }),
    () => assert.rejects(
      executeGithubReleases({ owner: 'octo', repo: 'kit' }, ctx()),
      (error: unknown) => (error as { code?: string }).code === 'authentication_required',
    ),
  );
});

test('github.releases maps abort to cancelled', async () => {
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    executeGithubReleases({ owner: 'octo', repo: 'kit' }, createCommandContext({ surface: 'cli', env: {}, signal: controller.signal })),
    (error: unknown) => (error as { commandResult?: { outcome?: string } }).commandResult?.outcome === 'cancelled',
  );
});

// ── CLI: every advertised selector reaches the domain (accept-then-drop probes) ──

test('cli github releases forwards --tag to the tag endpoint', async () => {
  const seen: string[] = [];
  await withFetch(
    async (input) => {
      seen.push(String(input));
      return jsonResponse(release);
    },
    () => runCommand(['github', 'releases', 'octo/kit', '--tag', 'v1.0.0'], {}),
  );
  assert.ok(seen.some((url) => url.includes('/releases/tags/v1.0.0')), 'CLI --tag must reach the domain');
});

test('cli github releases forwards --latest to the latest endpoint', async () => {
  const seen: string[] = [];
  await withFetch(
    async (input) => {
      seen.push(String(input));
      return jsonResponse(release);
    },
    () => runCommand(['github', 'releases', 'octo/kit', '--latest'], {}),
  );
  assert.ok(seen.some((url) => /\/releases\/latest$/.test(url)), 'CLI --latest must reach the domain');
});

test('cli github releases forwards --limit and --cursor to the list endpoint', async () => {
  const { encodeGithubCursor, githubCursorFingerprint } = await import('../../src/github/github-contract.js');
  const seen: string[] = [];
  const requestLimit = 5;
  const fingerprint = githubCursorFingerprint({ action: 'releases', owner: 'octo', repo: 'kit', limit: requestLimit });
  const cursor = encodeGithubCursor({ action: 'releases', backend: 'github-api', fingerprint, state: { page: 2 } });
  const link = '<https://api.github.com/repos/octo/kit/releases?per_page=5&page=3>; rel="next"';
  const result = await withFetch(
    async (input) => {
      seen.push(String(input));
      return jsonResponse([release], 200, link);
    },
    () => runCommand(['github', 'releases', 'octo/kit', '--limit', String(requestLimit), '--cursor', cursor], {}),
  );
  assert.ok(seen.some((url) => url.includes('per_page=5') && url.includes('page=2')), 'CLI --limit/--cursor must reach the domain');
  assert.equal(result.ok, true);
});

test('cli github releases rejects unknown and duplicate flags', async () => {
  assert.equal((await runCommand(['github', 'releases', 'octo/kit', '--bogus', 'x'], {})).error?.code, 'unknown_flag');
  assert.equal((await runCommand(['github', 'releases', 'octo/kit', '--limit', '5', '--limit', '5'], {})).error?.code, 'invalid_usage');
  assert.equal((await runCommand(['github', 'releases', 'octo/kit', '--latest', '--latest'], {})).error?.code, 'invalid_usage');
  assert.equal((await runCommand(['github', 'releases', 'octo/kit', '--tag'], {})).error?.code, 'invalid_usage');
  assert.equal((await runCommand(['github', 'releases', 'not-a-slug'], {})).error?.code, 'invalid_usage');
});

// ── Bypass closure: native tool routes through the registry handler ──

test('github.releases native-tool call resolves through the command registry', async () => {
  const { callNativeTool } = await import('../../src/native-tools.js');
  const { commandSurface } = await import('../../src/commands/command-registry.js');
  assert.ok(commandSurface().includes('github.releases'));
  const result = await withFetch(
    async () => jsonResponse([release]),
    () => callNativeTool('github', { action: 'releases', owner: 'octo', repo: 'kit' }, { env: {} }),
  );
  const command = (result.details as Record<string, unknown>).northstarCommand as { commandId: string };
  assert.equal(command.commandId, 'github.releases');
});
