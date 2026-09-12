import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { GITHUB_ACTIONS } from '../src/github-contract.js';
import { registerGitHubTool } from '../src/github.js';

interface CapturedTool {
  name: string;
  parameters: { properties: Record<string, unknown> };
}

async function captureGitHubTool(): Promise<CapturedTool> {
  const previous = process.env.PI_SEARCH_BOOTSTRAP;
  process.env.PI_SEARCH_BOOTSTRAP = 'off';
  let captured: CapturedTool | undefined;
  const pi = {
    on: () => {},
    registerTool: (def: { name: string; parameters: unknown }) => {
      if (def.name === 'github') captured = def as CapturedTool;
    },
    registerCommand: () => {},
  };
  try {
    registerGitHubTool(pi as unknown as ExtensionAPI, { callTool: async () => ({}), close: async () => {} }, {});
  } finally {
    if (previous === undefined) delete process.env.PI_SEARCH_BOOTSTRAP;
    else process.env.PI_SEARCH_BOOTSTRAP = previous;
  }
  assert.ok(captured, 'github tool must be registered');
  return captured;
}

test('github tool keeps the canonical name and action enum', async () => {
  const tool = await captureGitHubTool();
  assert.equal(tool.name, 'github');
  const action = tool.parameters.properties.action as { enum: string[] };
  assert.deepEqual([...(action.enum ?? [])].sort(), [...GITHUB_ACTIONS].sort());
  for (const legacy of ['list_dir', 'code_search']) {
    assert.equal(action.enum?.includes(legacy), false, `schema must not advertise legacy ${legacy}`);
  }
});

test('github schema exposes per-action selectors, caps, and cursor', async () => {
  const tool = await captureGitHubTool();
  const props = tool.parameters.properties;
  for (const param of [
    'owner', 'repo', 'repository', 'path', 'paths', 'branch', 'ref',
    'query', 'language', 'limit', 'perPage', 'number', 'sha', 'since',
    'state', 'labels', 'tag', 'latest', 'files', 'author', 'recursive',
    'includeReadme', 'cursor', 'workflow', 'status', 'jobs',
  ]) {
    assert.ok(param in props, `github schema must expose ${param}`);
  }
  const state = props.state as { enum: string[] };
  assert.deepEqual([...(state.enum ?? [])].sort(), ['all', 'closed', 'open']);
  const cursor = props.cursor as { maxLength: number };
  assert.equal(cursor.maxLength, 4096);
  // Dropped pre-Stage-5 selectors stay out of the schema.
  for (const removed of ['raw', 'offset', 'byteOffset', 'byteLimit', 'maxFiles', 'topK']) {
    assert.equal(removed in props, false, `github schema must not expose ${removed}`);
  }
});
