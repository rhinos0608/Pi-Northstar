import assert from 'node:assert/strict';
import { test } from 'node:test';
import Value from 'typebox/value';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { GITHUB_ACTIONS } from '../../src/github/github-contract.js';
import { registerGitHubTool } from '../../src/github/github.js';

interface CapturedTool {
  name: string;
  parameters: { properties: Record<string, any> };
  execute: (id: string, params: unknown) => Promise<unknown>;
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

test('github tool nests canonical action union under request', async () => {
  const tool = await captureGitHubTool();
  assert.equal(tool.name, 'github');
  const request = tool.parameters.properties.request;
  assert.equal(request.anyOf?.length, GITHUB_ACTIONS.length);
  assert.deepEqual(request.anyOf.map((branch: any) => branch.properties?.action?.const ?? branch.allOf?.[0]?.properties?.action?.const).sort(), [...GITHUB_ACTIONS].sort());
});

test('anthropic object flattening preserves nested github action union', async () => {
  const parameters = (await captureGitHubTool()).parameters as any;
  const flattened = { type: 'object', properties: parameters.properties ?? {}, required: parameters.required ?? [] };
  assert.ok(flattened.properties.request.anyOf?.length === GITHUB_ACTIONS.length);
});

test('github schema validates every action and rejects cross-action fields', async () => {
  const schema = (await captureGitHubTool()).parameters;
  const common = { owner: 'octo', repo: 'kit' };
  const requests = [
    { action: 'repo', ...common }, { action: 'file', ...common, path: 'src/a.ts' },
    { action: 'tree', ...common }, { action: 'search', query: 'x' }, { action: 'trending' },
    { action: 'issues', ...common }, { action: 'pulls', ...common }, { action: 'releases', ...common },
    { action: 'commits', ...common }, { action: 'search_repos', query: 'x' },
    { action: 'workflows', ...common }, { action: 'runs', ...common },
  ];
  for (const request of requests) assert.equal(Value.Check(schema, { request }), true, request.action);
  assert.equal(Value.Check(schema, { request: { action: 'commits', labels: ['bug'], ...common } }), false);
  assert.equal(Value.Check(schema, { request: { action: 'file', ...common } }), false);
});

test('github schema exposes per-action selectors, caps, and cursor', async () => {
  const tool = await captureGitHubTool();
  const request = tool.parameters.properties.request;
  const props = request.anyOf[0].allOf?.flatMap((part: any) => Object.keys(part.properties ?? {})) ?? Object.keys(request.anyOf[0].properties ?? {});
  assert.ok(props.includes('owner') && props.includes('repo'));
  assert.ok(props.includes('path') === false);
  const all = request.anyOf.flatMap((branch: any) => Object.values(branch.properties ?? branch.allOf?.[0]?.properties ?? {}));
  assert.ok(all.some((p: any) => p.enum?.length === 3));
  assert.ok(all.some((p: any) => p.maxLength === 4096));
  // Dropped pre-Stage-5 selectors stay out of schema.
  const serialized = JSON.stringify(request);
  for (const removed of ['raw', 'offset', 'byteOffset', 'byteLimit', 'maxFiles', 'topK']) assert.equal(serialized.includes(`\"${removed}\"`), false);
});
