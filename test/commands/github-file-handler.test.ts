import assert from 'node:assert/strict';
import test from 'node:test';
import { executeGithubFile } from '../../src/commands/github-file-handler.js';
import { createCommandContext } from '../../src/commands/command-context.js';

function response(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

test('github.file handler uses canonical REST file semantics and maps result additively', async () => {
  const original = globalThis.fetch;
  const calls: string[] = [];
  globalThis.fetch = (async (input) => {
    calls.push(String(input));
    return response({ path: 'README.md', content: Buffer.from('hello').toString('base64'), encoding: 'base64', size: 5 });
  }) as typeof fetch;
  try {
    const result = await executeGithubFile({ action: 'file', owner: 'octo', repo: 'kit', path: 'README.md' }, createCommandContext({ surface: 'pi', env: {}, invocationId: 'test-invocation' }));
    const details = result.details as Record<string, unknown>;
    assert.equal(calls[0], 'https://api.github.com/repos/octo/kit/contents/README.md');
    assert.ok(details.northstarCommand);
    assert.equal((details.northstarCommand as { commandId: string }).commandId, 'github.file');
  } finally {
    globalThis.fetch = original;
  }
});
