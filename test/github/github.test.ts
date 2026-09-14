import assert from 'node:assert/strict';
import { test } from 'node:test';
import Value from 'typebox/value';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { GITHUB_ACTIONS } from '../../src/github/github-contract.js';
import { registerGitHubTool } from '../../src/github/github.js';

function branchAction(branch: any): unknown {
  if (branch.properties?.action?.const !== undefined) return branch.properties.action.const;
  for (const part of branch.anyOf ?? []) {
    const found = branchAction(part);
    if (found !== undefined) return found;
  }
  for (const part of branch.allOf ?? []) {
    const found = part.properties?.action?.const as unknown;
    if (found !== undefined) return found;
  }
  return undefined;
}

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
  assert.deepEqual(request.anyOf.map((branch: any) => branchAction(branch)).sort(), [...GITHUB_ACTIONS].sort());
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

test('github schema rejects schema-valid-but-runtime-invalid numerics and paths', async () => {
  const schema = (await captureGitHubTool()).parameters;
  const common = { owner: 'octo', repo: 'kit' };
  const pathsOf = (n: number): string[] => Array.from({ length: n }, (_, i) => `src/f${i}.ts`);
  // file selector is XOR: exactly one of path / paths (paths 1-10 entries).
  assert.equal(Value.Check(schema, { request: { action: 'file', ...common, path: 'src/a.ts' } }), true);
  assert.equal(Value.Check(schema, { request: { action: 'file', ...common, paths: pathsOf(1) } }), true);
  assert.equal(Value.Check(schema, { request: { action: 'file', ...common, paths: pathsOf(10) } }), true);
  assert.equal(Value.Check(schema, { request: { action: 'file', ...common, path: 'src/a.ts', paths: pathsOf(10) } }), false);
  assert.equal(Value.Check(schema, { request: { action: 'file', ...common, paths: pathsOf(11) } }), false);
  assert.equal(Value.Check(schema, { request: { action: 'file', ...common, paths: [] } }), false);
  // limit/perPage: positive integers within per-action caps (trending 1-25, others 1-50).
  assert.equal(Value.Check(schema, { request: { action: 'issues', ...common, limit: 50 } }), true);
  assert.equal(Value.Check(schema, { request: { action: 'issues', ...common, limit: 51 } }), false);
  assert.equal(Value.Check(schema, { request: { action: 'issues', ...common, limit: 0 } }), false);
  assert.equal(Value.Check(schema, { request: { action: 'issues', ...common, limit: -1 } }), false);
  assert.equal(Value.Check(schema, { request: { action: 'issues', ...common, limit: 1.5 } }), false);
  assert.equal(Value.Check(schema, { request: { action: 'issues', ...common, perPage: 50 } }), true);
  assert.equal(Value.Check(schema, { request: { action: 'issues', ...common, perPage: 51 } }), false);
  assert.equal(Value.Check(schema, { request: { action: 'issues', ...common, perPage: 1.5 } }), false);
  assert.equal(Value.Check(schema, { request: { action: 'trending', limit: 25 } }), true);
  assert.equal(Value.Check(schema, { request: { action: 'trending', limit: 26 } }), false);
  assert.equal(Value.Check(schema, { request: { action: 'trending', perPage: 26 } }), false);
  // labels: capped at 10 entries to mirror runtime validateLabels (GITHUB_LABELS_MAX).
  const labelsOf = (n: number): string[] => Array.from({ length: n }, (_, i) => `label-${i}`);
  assert.equal(Value.Check(schema, { request: { action: 'issues', ...common, labels: labelsOf(10) } }), true);
  assert.equal(Value.Check(schema, { request: { action: 'issues', ...common, labels: labelsOf(11) } }), false);
  assert.equal(Value.Check(schema, { request: { action: 'pulls', ...common, labels: labelsOf(11) } }), false);
  // number: positive integer, no upper cap.
  assert.equal(Value.Check(schema, { request: { action: 'issues', ...common, number: 1 } }), true);
  assert.equal(Value.Check(schema, { request: { action: 'issues', ...common, number: 0 } }), false);
  assert.equal(Value.Check(schema, { request: { action: 'issues', ...common, number: -3 } }), false);
  assert.equal(Value.Check(schema, { request: { action: 'issues', ...common, number: 1.5 } }), false);
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
