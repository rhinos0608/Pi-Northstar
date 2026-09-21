import assert from 'node:assert/strict';
import test from 'node:test';
import { mapGithubRepoCommandResult } from '../../src/commands/github-repo-handler.js';
import { createCommandContext } from '../../src/commands/command-context.js';

test('github.repo maps fallback/readme warnings to degraded command outcome', () => {
  const result = mapGithubRepoCommandResult({
    content: [{ type: 'text', text: 'repo' }],
    details: { entities: [{ kind: 'repo' }], warnings: ['optional README unavailable'], northstar: { status: 'degraded', request: { source: 'github-api' }, sources: [{ backend: 'github-api' }], data: { kind: 'entities', entities: [] } } },
  }, createCommandContext({ surface: 'cli', env: {}, invocationId: 'repo-test' }));
  assert.equal(result.commandId, 'github.repo');
  assert.equal(result.outcome, 'degraded');
  assert.equal(result.invocationId, 'repo-test');
});
