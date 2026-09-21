import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { test } from 'node:test';
import { callGithubTool } from '../../src/github/github-domain.js';
import type { GithubCloneRunner } from '../../src/github/github-clone.js';

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
}

async function withFetch<T>(mock: typeof fetch, run: () => Promise<T>): Promise<T> {
  const saved = globalThis.fetch;
  globalThis.fetch = mock;
  try { return await run(); } finally { globalThis.fetch = saved; }
}

function northstarStatus(result: { details?: unknown }): string {
  return ((result.details as { northstar?: { status?: string } }).northstar?.status) ?? '';
}

test('clone to REST fallback is degraded', async () => {
  const result = await withFetch(
    async () => jsonResponse({ tree: [{ path: 'README.md', type: 'blob', sha: 'abc1234' }], truncated: false }),
    () => callGithubTool({ action: 'tree', owner: 'o', repo: 'r' }, { env: {}, cloneRunner: async () => { throw new Error('clone unavailable'); } }),
  );
  assert.equal(northstarStatus(result), 'degraded');
});

test('gh-absent informational git clone is not degraded', async () => {
  const runner: GithubCloneRunner = async (command, argv, _options) => {
    if (command === 'gh') {
      const error = new Error('gh missing') as NodeJS.ErrnoException;
      error.code = 'ENOENT';
      throw error;
    }
    const destination = argv[argv.length - 1] as string;
    await mkdir(`${destination}/.git`, { recursive: true });
    await writeFile(`${destination}/.git/HEAD`, 'ref: refs/heads/main\n');
    await writeFile(`${destination}/README.md`, 'clone content\n');
    return { stdout: '', stderr: '', code: 0 };
  };
  const result = await callGithubTool({ action: 'tree', owner: 'o', repo: 'r' }, { env: {}, cloneRunner: runner });
  assert.equal(northstarStatus(result), 'ok');
});
