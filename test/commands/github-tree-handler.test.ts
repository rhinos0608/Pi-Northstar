import assert from 'node:assert/strict';
import test from 'node:test';
import { mapGithubTreeCommandResult } from '../../src/commands/github-tree-handler.js';
import { createCommandContext } from '../../src/commands/command-context.js';

test('github.tree preserves partial truncation and canonical action identity', () => {
  const result = mapGithubTreeCommandResult({
    content: [{ type: 'text', text: 'tree' }],
    details: { northstar: { status: 'partial', request: { source: 'github-api' }, sources: [{ backend: 'github-api' }], data: { entries: [{ path: 'src' }] } } },
  }, createCommandContext({ surface: 'cli', env: {}, invocationId: 'tree-test' }));
  assert.equal(result.commandId, 'github.tree');
  assert.equal(result.outcome, 'partial');
  assert.deepEqual(result.data, { entries: [{ path: 'src' }] });
});
