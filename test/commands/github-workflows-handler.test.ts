import assert from 'node:assert/strict';
import test from 'node:test';
import { createCommandContext } from '../../src/commands/command-context.js';
import {
  executeGithubWorkflows,
  mapGithubWorkflowsCommandResult,
} from '../../src/commands/github-workflows-handler.js';
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
  return createCommandContext({ surface, env: {}, invocationId: `workflows-${surface}` });
}

const workflow = {
  id: 42,
  name: 'CI',
  path: '.github/workflows/ci.yml',
  state: 'active',
  html_url: 'https://github.com/octo/kit/blob/main/.github/workflows/ci.yml',
};

// ── Outcome mapping ──

test('github.workflows maps success/degraded/partial/empty statuses', () => {
  for (const [status, outcome] of [
    ['ok', 'success'],
    ['degraded', 'degraded'],
    ['partial', 'partial'],
    ['empty', 'empty'],
  ] as const) {
    const result = mapGithubWorkflowsCommandResult(
      {
        content: [{ type: 'text', text: 'workflows' }],
        details: {
          entities: [],
          northstar: { status, request: { source: 'github-api' }, sources: [{ backend: 'github-api' }], data: { kind: 'entities' } },
        },
      },
      ctx(),
    );
    assert.equal(result.commandId, 'github.workflows');
    assert.equal(result.outcome, outcome);
    assert.equal(result.trust, 'external');
    assert.equal(result.resolvedSurface, 'github.workflows');
  }
});

// ── Handler execution: id-vs-list dual mode ──

test('github.workflows id mode fetches the single-workflow endpoint', async () => {
  const seen: string[] = [];
  const result = await withFetch(
    async (input) => {
      seen.push(String(input));
      return jsonResponse(workflow);
    },
    () => executeGithubWorkflows({ owner: 'octo', repo: 'kit', workflow: 'ci.yml' }, ctx('pi')),
  );
  assert.ok(seen.some((url) => url.includes('/actions/workflows/ci.yml')), `workflow id must reach upstream: ${seen.join(' ')}`);
  const command = (result.details as Record<string, unknown>).northstarCommand as { commandId: string };
  assert.equal(command.commandId, 'github.workflows');
  const entities = (result.details as Record<string, unknown>).entities as Array<{ kind: string; workflow_id: number }>;
  assert.equal(entities[0]?.kind, 'workflow');
  assert.equal(entities[0]?.workflow_id, 42);
});

test('github.workflows list mode fetches the workflows list', async () => {
  const seen: string[] = [];
  const result = await withFetch(
    async (input) => {
      seen.push(String(input));
      return jsonResponse({ workflows: [workflow] });
    },
    () => executeGithubWorkflows({ owner: 'octo', repo: 'kit', limit: 5 }, ctx()),
  );
  const url = seen.find((candidate) => candidate.includes('/actions/workflows'));
  assert.ok(url?.includes('per_page=5'), `limit must reach upstream: ${url}`);
  const entities = (result.details as Record<string, unknown>).entities as Array<{ kind: string }>;
  assert.equal(entities[0]?.kind, 'workflow');
});

// ── Contract semantics preserved ──

test('github.workflows rejects out-of-range limit instead of clamping', async () => {
  await assert.rejects(
    executeGithubWorkflows({ owner: 'octo', repo: 'kit', limit: 51 }, ctx()),
    (error: unknown) => (error as { code?: string }).code === 'invalid_request',
  );
});

test('github.workflows rejects a jobs flag owned by runs', async () => {
  await assert.rejects(
    executeGithubWorkflows({ owner: 'octo', repo: 'kit', jobs: true }, ctx()),
    (error: unknown) => (error as { code?: string }).code === 'invalid_request',
  );
});

test('github.workflows rejects a cursor pinned to another action', async () => {
  const { encodeGithubCursor, githubCursorFingerprint } = await import('../../src/github/github-contract.js');
  const fingerprint = githubCursorFingerprint({ action: 'runs', owner: 'octo', repo: 'kit', limit: 20 });
  const cursor = encodeGithubCursor({ action: 'runs', backend: 'github-api', fingerprint, state: { page: 2 } });
  await assert.rejects(
    executeGithubWorkflows({ owner: 'octo', repo: 'kit', cursor }, ctx()),
    (error: unknown) => (error as { code?: string }).code === 'cursor_invalid',
  );
});

test('github.workflows rejects a list cursor reused with a workflow id', async () => {
  const { encodeGithubCursor, githubCursorFingerprint } = await import('../../src/github/github-contract.js');
  const fingerprint = githubCursorFingerprint({ action: 'workflows', owner: 'octo', repo: 'kit', limit: 20 });
  const cursor = encodeGithubCursor({ action: 'workflows', backend: 'github-api', fingerprint, state: { page: 2 } });
  await assert.rejects(
    executeGithubWorkflows({ owner: 'octo', repo: 'kit', workflow: 'ci.yml', cursor }, ctx()),
    (error: unknown) => (error as { code?: string }).code === 'cursor_invalid',
  );
});

test('github.workflows surfaces rate limit as terminal with retry metadata', async () => {
  await withFetch(
    async () => new Response('limited', { status: 429 }),
    () => assert.rejects(
      executeGithubWorkflows({ owner: 'octo', repo: 'kit' }, ctx()),
      (error: unknown) => (error as { code?: string }).code === 'rate_limited',
    ),
  );
});

test('github.workflows surfaces auth failure as terminal', async () => {
  await withFetch(
    async () => new Response('denied', { status: 401 }),
    () => assert.rejects(
      executeGithubWorkflows({ owner: 'octo', repo: 'kit' }, ctx()),
      (error: unknown) => (error as { code?: string }).code === 'authentication_required',
    ),
  );
});

test('github.workflows maps abort to cancelled', async () => {
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    executeGithubWorkflows({ owner: 'octo', repo: 'kit' }, createCommandContext({ surface: 'cli', env: {}, signal: controller.signal })),
    (error: unknown) => (error as { commandResult?: { outcome?: string } }).commandResult?.outcome === 'cancelled',
  );
});

// ── CLI: every advertised selector reaches the domain (accept-then-drop probes) ──

test('cli github workflows forwards --workflow to the single-workflow endpoint', async () => {
  const seen: string[] = [];
  const result = await withFetch(
    async (input) => {
      seen.push(String(input));
      return jsonResponse(workflow);
    },
    () => runCommand(['github', 'workflows', 'octo/kit', '--workflow', 'ci.yml'], {}),
  );
  assert.ok(seen.some((url) => url.includes('/actions/workflows/ci.yml')), 'CLI --workflow must reach the domain');
  assert.equal(result.ok, true);
});

test('cli github workflows forwards --limit and --cursor', async () => {
  const { encodeGithubCursor, githubCursorFingerprint } = await import('../../src/github/github-contract.js');
  const seen: string[] = [];
  await withFetch(
    async (input) => {
      seen.push(String(input));
      return jsonResponse({ workflows: [workflow] });
    },
    () => runCommand(['github', 'workflows', 'octo/kit', '--limit', '5'], {}),
  );
  assert.ok(seen.some((url) => url.includes('per_page=5')), 'CLI --limit must reach the domain');
  seen.length = 0;
  const requestLimit = 5;
  const fingerprint = githubCursorFingerprint({ action: 'workflows', owner: 'octo', repo: 'kit', limit: requestLimit });
  const cursor = encodeGithubCursor({ action: 'workflows', backend: 'github-api', fingerprint, state: { page: 2 } });
  const link = '<https://api.github.com/repos/octo/kit/actions/workflows?per_page=5&page=3>; rel="next"';
  const paged = await withFetch(
    async (input) => {
      seen.push(String(input));
      return jsonResponse({ workflows: [workflow] }, 200, link);
    },
    () => runCommand(['github', 'workflows', 'octo/kit', '--limit', String(requestLimit), '--cursor', cursor], {}),
  );
  assert.ok(seen.some((url) => url.includes('page=2')), 'CLI --cursor must reach the domain');
  assert.equal(paged.ok, true);
});

test('cli github workflows rejects unknown and duplicate flags', async () => {
  assert.equal((await runCommand(['github', 'workflows', 'octo/kit', '--bogus', 'x'], {})).error?.code, 'unknown_flag');
  assert.equal((await runCommand(['github', 'workflows', 'octo/kit', '--limit', '5', '--limit', '5'], {})).error?.code, 'invalid_usage');
  assert.equal((await runCommand(['github', 'workflows', 'octo/kit', '--workflow'], {})).error?.code, 'invalid_usage');
  assert.equal((await runCommand(['github', 'workflows', 'not-a-slug'], {})).error?.code, 'invalid_usage');
});

// ── Bypass closure: native tool routes through the registry handler ──

test('github.workflows native-tool call resolves through the command registry', async () => {
  const { callNativeTool } = await import('../../src/native-tools.js');
  const { commandSurface } = await import('../../src/commands/command-registry.js');
  assert.ok(commandSurface().includes('github.workflows'));
  const result = await withFetch(
    async () => jsonResponse({ workflows: [workflow] }),
    () => callNativeTool('github', { action: 'workflows', owner: 'octo', repo: 'kit' }, { env: {} }),
  );
  const command = (result.details as Record<string, unknown>).northstarCommand as { commandId: string };
  assert.equal(command.commandId, 'github.workflows');
});
