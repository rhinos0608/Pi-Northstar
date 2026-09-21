import assert from 'node:assert/strict';
import test from 'node:test';
import { createCommandContext } from '../../src/commands/command-context.js';
import {
  executeGithubRuns,
  mapGithubRunsCommandResult,
} from '../../src/commands/github-runs-handler.js';
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
  return createCommandContext({ surface, env: {}, invocationId: `runs-${surface}` });
}

const run = {
  id: 99,
  run_number: 7,
  name: 'CI',
  status: 'completed',
  conclusion: 'success',
  head_branch: 'main',
  head_sha: 'abc1234def',
  event: 'push',
  html_url: 'https://github.com/octo/kit/actions/runs/99',
  created_at: '2024-02-02T00:00:00Z',
  actor: { login: 'dev' },
};

const job = {
  id: 5,
  run_id: 99,
  name: 'build',
  status: 'completed',
  conclusion: 'success',
  html_url: 'https://github.com/octo/kit/actions/runs/99/jobs/5',
};

// ── Outcome mapping ──

test('github.runs maps success/degraded/partial/empty statuses', () => {
  for (const [status, outcome] of [
    ['ok', 'success'],
    ['degraded', 'degraded'],
    ['partial', 'partial'],
    ['empty', 'empty'],
  ] as const) {
    const result = mapGithubRunsCommandResult(
      {
        content: [{ type: 'text', text: 'runs' }],
        details: {
          entities: [],
          northstar: { status, request: { source: 'github-api' }, sources: [{ backend: 'github-api' }], data: { kind: 'entities' } },
        },
      },
      ctx(),
    );
    assert.equal(result.commandId, 'github.runs');
    assert.equal(result.outcome, outcome);
    assert.equal(result.trust, 'external');
    assert.equal(result.resolvedSurface, 'github.runs');
  }
});

// ── Handler execution: number × jobs × workflow/ref/status/author matrix ──

test('github.runs number mode fetches the single-run endpoint', async () => {
  const seen: string[] = [];
  const result = await withFetch(
    async (input) => {
      seen.push(String(input));
      return jsonResponse(run);
    },
    () => executeGithubRuns({ owner: 'octo', repo: 'kit', number: 99 }, ctx('pi')),
  );
  assert.ok(seen.some((url) => url.includes('/actions/runs/99')), `run number must reach upstream: ${seen.join(' ')}`);
  const command = (result.details as Record<string, unknown>).northstarCommand as { commandId: string };
  assert.equal(command.commandId, 'github.runs');
  const entities = (result.details as Record<string, unknown>).entities as Array<{ kind: string; run_id: number }>;
  assert.equal(entities[0]?.kind, 'workflow_run');
  assert.equal(entities[0]?.run_id, 99);
});

test('github.runs number+jobs mode fetches the run jobs endpoint', async () => {
  const seen: string[] = [];
  const result = await withFetch(
    async (input) => {
      seen.push(String(input));
      return jsonResponse({ jobs: [job] });
    },
    () => executeGithubRuns({ owner: 'octo', repo: 'kit', number: 99, jobs: true }, ctx()),
  );
  assert.ok(seen.some((url) => url.includes('/actions/runs/99/jobs')), `jobs must reach the run jobs endpoint: ${seen.join(' ')}`);
  const entities = (result.details as Record<string, unknown>).entities as Array<{ kind: string; job_id: number; run_id: number }>;
  assert.equal(entities[0]?.kind, 'workflow_job');
  assert.equal(entities[0]?.job_id, 5);
  assert.equal(entities[0]?.run_id, 99);
});

test('github.runs list mode forwards workflow/branch/status/author selectors', async () => {
  const seen: string[] = [];
  const result = await withFetch(
    async (input) => {
      seen.push(String(input));
      return jsonResponse({ workflow_runs: [run] });
    },
    () => executeGithubRuns(
      { owner: 'octo', repo: 'kit', workflow: 'ci.yml', branch: 'main', status: 'completed', author: 'dev' },
      ctx(),
    ),
  );
  const url = seen.find((candidate) => candidate.includes('/actions/workflows/ci.yml/runs'));
  assert.ok(url, `workflow selector must scope the list endpoint: ${seen.join(' ')}`);
  assert.ok(url.includes('branch=main'), `--branch dropped: ${url}`);
  assert.ok(url.includes('status=completed'), `--status dropped: ${url}`);
  assert.ok(url.includes('actor=dev'), `--author dropped: ${url}`);
  const entities = (result.details as Record<string, unknown>).entities as Array<{ kind: string }>;
  assert.equal(entities[0]?.kind, 'workflow_run');
});

// ── Contract semantics preserved ──

test('github.runs rejects out-of-range limit instead of clamping', async () => {
  await assert.rejects(
    executeGithubRuns({ owner: 'octo', repo: 'kit', limit: 51 }, ctx()),
    (error: unknown) => (error as { code?: string }).code === 'invalid_request',
  );
});

test('github.runs rejects an unknown status instead of clamping', async () => {
  await assert.rejects(
    executeGithubRuns({ owner: 'octo', repo: 'kit', status: 'bogus' }, ctx()),
    (error: unknown) => (error as { code?: string }).code === 'invalid_request',
  );
});

test('github.runs rejects jobs without a run number', async () => {
  await assert.rejects(
    executeGithubRuns({ owner: 'octo', repo: 'kit', jobs: true }, ctx()),
    (error: unknown) => (error as { code?: string }).code === 'invalid_request',
  );
});

test('github.runs rejects a files flag owned by pulls', async () => {
  await assert.rejects(
    executeGithubRuns({ owner: 'octo', repo: 'kit', number: 99, files: true }, ctx()),
    (error: unknown) => (error as { code?: string }).code === 'invalid_request',
  );
});

test('github.runs rejects a cursor pinned to another action', async () => {
  const { encodeGithubCursor, githubCursorFingerprint } = await import('../../src/github/github-contract.js');
  const fingerprint = githubCursorFingerprint({ action: 'workflows', owner: 'octo', repo: 'kit', limit: 20 });
  const cursor = encodeGithubCursor({ action: 'workflows', backend: 'github-api', fingerprint, state: { page: 2 } });
  await assert.rejects(
    executeGithubRuns({ owner: 'octo', repo: 'kit', cursor }, ctx()),
    (error: unknown) => (error as { code?: string }).code === 'cursor_invalid',
  );
});

test('github.runs rejects a cursor reused with different result-shaping selectors', async () => {
  const { encodeGithubCursor, githubCursorFingerprint } = await import('../../src/github/github-contract.js');
  const base = { action: 'runs' as const, owner: 'octo', repo: 'kit', limit: 20 };
  for (const variant of [
    { workflow: 'ci.yml' },
    { branch: 'main' },
    { status: 'completed' },
    { author: 'dev' },
    { number: 99 },
    { number: 99, jobs: true },
  ] as const) {
    const cursor = encodeGithubCursor({ action: 'runs', backend: 'github-api', fingerprint: githubCursorFingerprint(base), state: { page: 2 } });
    await assert.rejects(
      executeGithubRuns({ owner: 'octo', repo: 'kit', ...variant, cursor }, ctx()),
      (error: unknown) => (error as { code?: string }).code === 'cursor_invalid',
      `cursor must fail closed when ${Object.keys(variant).join('+')} changes`,
    );
  }
});

test('github.runs rejects a list cursor reused with a run number', async () => {
  const { encodeGithubCursor, githubCursorFingerprint } = await import('../../src/github/github-contract.js');
  const fingerprint = githubCursorFingerprint({ action: 'runs', owner: 'octo', repo: 'kit', limit: 20 });
  const cursor = encodeGithubCursor({ action: 'runs', backend: 'github-api', fingerprint, state: { page: 2 } });
  await assert.rejects(
    executeGithubRuns({ owner: 'octo', repo: 'kit', number: 99, cursor }, ctx()),
    (error: unknown) => (error as { code?: string }).code === 'cursor_invalid',
  );
});

test('github.runs surfaces rate limit as terminal with retry metadata', async () => {
  await withFetch(
    async () => new Response('limited', { status: 429 }),
    () => assert.rejects(
      executeGithubRuns({ owner: 'octo', repo: 'kit' }, ctx()),
      (error: unknown) => (error as { code?: string }).code === 'rate_limited',
    ),
  );
});

test('github.runs surfaces auth failure as terminal', async () => {
  await withFetch(
    async () => new Response('denied', { status: 401 }),
    () => assert.rejects(
      executeGithubRuns({ owner: 'octo', repo: 'kit' }, ctx()),
      (error: unknown) => (error as { code?: string }).code === 'authentication_required',
    ),
  );
});

test('github.runs maps abort to cancelled', async () => {
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    executeGithubRuns({ owner: 'octo', repo: 'kit' }, createCommandContext({ surface: 'cli', env: {}, signal: controller.signal })),
    (error: unknown) => (error as { commandResult?: { outcome?: string } }).commandResult?.outcome === 'cancelled',
  );
});

// ── CLI: every advertised selector reaches the domain (accept-then-drop probes) ──

test('cli github runs forwards --number to the single-run endpoint', async () => {
  const seen: string[] = [];
  const result = await withFetch(
    async (input) => {
      seen.push(String(input));
      return jsonResponse(run);
    },
    () => runCommand(['github', 'runs', 'octo/kit', '--number', '99'], {}),
  );
  assert.ok(seen.some((url) => url.includes('/actions/runs/99')), 'CLI --number must reach the domain');
  assert.equal(result.ok, true);
});

test('cli github runs forwards --jobs with --number to the jobs endpoint', async () => {
  const seen: string[] = [];
  const result = await withFetch(
    async (input) => {
      seen.push(String(input));
      return jsonResponse({ jobs: [job] });
    },
    () => runCommand(['github', 'runs', 'octo/kit', '--number', '99', '--jobs'], {}),
  );
  assert.ok(seen.some((url) => url.includes('/actions/runs/99/jobs')), 'CLI --jobs must reach the domain jobs endpoint');
  assert.equal(result.ok, true);
});

test('cli github runs forwards every list selector upstream', async () => {
  const seen: string[] = [];
  const result = await withFetch(
    async (input) => {
      seen.push(String(input));
      return jsonResponse({ workflow_runs: [run] });
    },
    () => runCommand(['github', 'runs', 'octo/kit', '--workflow', 'ci.yml', '--branch', 'main', '--status', 'completed', '--author', 'dev'], {}),
  );
  const url = seen.find((candidate) => candidate.includes('/actions/workflows/ci.yml/runs'));
  assert.ok(url, 'CLI list selectors must reach the workflow-scoped domain endpoint');
  assert.ok(url.includes('branch=main'), `--branch dropped: ${url}`);
  assert.ok(url.includes('status=completed'), `--status dropped: ${url}`);
  assert.ok(url.includes('actor=dev'), `--author dropped: ${url}`);
  assert.equal(result.ok, true);
});

test('cli github runs forwards --limit and --cursor', async () => {
  const { encodeGithubCursor, githubCursorFingerprint } = await import('../../src/github/github-contract.js');
  const seen: string[] = [];
  await withFetch(
    async (input) => {
      seen.push(String(input));
      return jsonResponse({ workflow_runs: [run] });
    },
    () => runCommand(['github', 'runs', 'octo/kit', '--limit', '5'], {}),
  );
  assert.ok(seen.some((url) => url.includes('per_page=5')), 'CLI --limit must reach the domain');
  seen.length = 0;
  const requestLimit = 5;
  const fingerprint = githubCursorFingerprint({ action: 'runs', owner: 'octo', repo: 'kit', limit: requestLimit });
  const cursor = encodeGithubCursor({ action: 'runs', backend: 'github-api', fingerprint, state: { page: 2 } });
  const link = '<https://api.github.com/repos/octo/kit/actions/runs?per_page=5&page=3>; rel="next"';
  const paged = await withFetch(
    async (input) => {
      seen.push(String(input));
      return jsonResponse({ workflow_runs: [run] }, 200, link);
    },
    () => runCommand(['github', 'runs', 'octo/kit', '--limit', String(requestLimit), '--cursor', cursor], {}),
  );
  assert.ok(seen.some((url) => url.includes('page=2')), 'CLI --cursor must reach the domain');
  assert.equal(paged.ok, true);
});

test('cli github runs rejects unknown and duplicate flags', async () => {
  assert.equal((await runCommand(['github', 'runs', 'octo/kit', '--bogus', 'x'], {})).error?.code, 'unknown_flag');
  assert.equal((await runCommand(['github', 'runs', 'octo/kit', '--number', '99', '--number', '99'], {})).error?.code, 'invalid_usage');
  assert.equal((await runCommand(['github', 'runs', 'octo/kit', '--jobs', '--jobs'], {})).error?.code, 'invalid_usage');
  assert.equal((await runCommand(['github', 'runs', 'octo/kit', '--status'], {})).error?.code, 'invalid_usage');
  assert.equal((await runCommand(['github', 'runs', 'not-a-slug'], {})).error?.code, 'invalid_usage');
});

// ── Bypass closure: native tool routes through the registry handler ──

test('github.runs native-tool call resolves through the command registry', async () => {
  const { callNativeTool } = await import('../../src/native-tools.js');
  const { commandSurface } = await import('../../src/commands/command-registry.js');
  assert.ok(commandSurface().includes('github.runs'));
  const result = await withFetch(
    async () => jsonResponse({ workflow_runs: [run] }),
    () => callNativeTool('github', { action: 'runs', owner: 'octo', repo: 'kit' }, { env: {} }),
  );
  const command = (result.details as Record<string, unknown>).northstarCommand as { commandId: string };
  assert.equal(command.commandId, 'github.runs');
});
