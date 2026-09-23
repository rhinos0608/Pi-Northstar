import assert from 'node:assert/strict';
import { test } from 'node:test';
import Value from 'typebox/value';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { GITHUB_ACTIONS, validateGithubRequest } from '../../src/github/github-contract.js';
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
  execute: (id: string, params: unknown, signal?: AbortSignal) => Promise<unknown>;
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
  // Flat 12-branch schema keeps path/paths optional; XOR requiredness
  // (exactly one) enforced at runtime by validateGithubRequest.
  assert.equal(Value.Check(schema, { request: { action: 'file', ...common } }), true);
  assert.throws(() => validateGithubRequest({ action: 'file', ...common } as never), /requires selector/);
});

test('github schema rejects schema-valid-but-runtime-invalid numerics and paths', async () => {
  const schema = (await captureGitHubTool()).parameters;
  const common = { owner: 'octo', repo: 'kit' };
  const pathsOf = (n: number): string[] => Array.from({ length: n }, (_, i) => `src/f${i}.ts`);
  // file selector is XOR at runtime: exactly one of path / paths (paths 1-10 entries).
  // Schema admits all three selector shapes; runtime rejects neither/both.
  assert.equal(Value.Check(schema, { request: { action: 'file', ...common, path: 'src/a.ts' } }), true);
  assert.equal(Value.Check(schema, { request: { action: 'file', ...common, paths: pathsOf(1) } }), true);
  assert.equal(Value.Check(schema, { request: { action: 'file', ...common, paths: pathsOf(10) } }), true);
  assert.equal(Value.Check(schema, { request: { action: 'file', ...common, path: 'src/a.ts', paths: pathsOf(10) } }), true, 'both-together admits at schema; runtime XOR rejects');
  assert.throws(() => validateGithubRequest({ action: 'file', ...common, path: 'src/a.ts', paths: pathsOf(10) } as never), /mutually exclusive/);
  assert.throws(() => validateGithubRequest({ action: 'file', ...common } as never), /requires selector/);
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
  // Items mirror contract: non-empty, max GITHUB_LABEL_MAX.
  const labelsOf = (n: number): string[] => Array.from({ length: n }, (_, i) => `label-${i}`);
  assert.equal(Value.Check(schema, { request: { action: 'issues', ...common, labels: labelsOf(10) } }), true);
  assert.equal(Value.Check(schema, { request: { action: 'issues', ...common, labels: labelsOf(11) } }), false);
  assert.equal(Value.Check(schema, { request: { action: 'pulls', ...common, labels: labelsOf(11) } }), false);
  assert.equal(Value.Check(schema, { request: { action: 'issues', ...common, labels: [''] } }), false, 'empty label item rejects at schema');
  assert.equal(Value.Check(schema, { request: { action: 'issues', ...common, labels: ['   '] } }), false, 'whitespace-only label rejects at schema (runtime parity)');
  assert.equal(Value.Check(schema, { request: { action: 'issues', ...common, labels: ['\t'] } }), false, 'tab-only label rejects at schema (runtime parity)');
  assert.equal(Value.Check(schema, { request: { action: 'issues', ...common, labels: [' bug '] } }), true, 'padded label admits at schema; runtime trims downstream');
  assert.equal(Value.Check(schema, { request: { action: 'issues', ...common, labels: ['x'.repeat(51)] } }), false, 'overlong label item rejects at schema');
  assert.equal(Value.Check(schema, { request: { action: 'issues', ...common, labels: ['x'.repeat(50)] } }), true, 'max-length label item admits at schema');
  // number: positive integer, no upper cap.
  assert.equal(Value.Check(schema, { request: { action: 'issues', ...common, number: 1 } }), true);
  assert.equal(Value.Check(schema, { request: { action: 'issues', ...common, number: 0 } }), false);
  assert.equal(Value.Check(schema, { request: { action: 'issues', ...common, number: -3 } }), false);
  assert.equal(Value.Check(schema, { request: { action: 'issues', ...common, number: 1.5 } }), false);
});

test('registered github file uses command handler, guards output, and preserves command details', async () => {
  const originalFetch = globalThis.fetch;
  const fetchCalls: string[] = [];
  let genericBackendCalls = 0;
  const env = { PI_SEARCH_MAX_TOOL_OUTPUT_CHARS: '1000' };
  const tool = await (async () => {
    const previous = process.env.PI_SEARCH_BOOTSTRAP;
    process.env.PI_SEARCH_BOOTSTRAP = 'off';
    let captured: CapturedTool | undefined;
    const pi = {
      on: () => {},
      registerTool: (def: { name: string; parameters: unknown; execute: CapturedTool['execute'] }) => {
        if (def.name === 'github') captured = def as CapturedTool;
      },
      registerCommand: () => {},
    };
    try {
      registerGitHubTool(pi as unknown as ExtensionAPI, {
        callTool: async () => {
          genericBackendCalls += 1;
          throw new Error('generic backend must not be called for file');
        },
        close: async () => {},
      }, env);
    } finally {
      if (previous === undefined) delete process.env.PI_SEARCH_BOOTSTRAP;
      else process.env.PI_SEARCH_BOOTSTRAP = previous;
    }
    assert.ok(captured, 'github tool must be registered');
    return captured;
  })();

  globalThis.fetch = (async (input) => {
    fetchCalls.push(String(input));
    return new Response(JSON.stringify({
      path: 'src/a.ts',
      content: Buffer.from('x'.repeat(500)).toString('base64'),
      encoding: 'base64',
      size: 500,
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  try {
    const result = await tool.execute('file-call', {
      request: {
        action: 'file', owner: 'octo', repo: 'kit',
        paths: Array.from({ length: 10 }, (_, index) => `src/${index}.ts`),
      },
    });
    const content = (result as { content: Array<{ type: string; text: string }> }).content;
    const details = (result as { details: { details: Record<string, unknown> } }).details;
    assert.equal(genericBackendCalls, 0);
    assert.equal(fetchCalls.length, 10);
    assert.match(content[0]!.text, /\[context guard: output truncated/);
    assert.equal((details.details.northstarCommand as { commandId: string }).commandId, 'github.file');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('github schema exposes per-action selectors, caps, and cursor', async () => {
  const tool = await captureGitHubTool();
  const request = tool.parameters.properties.request;
  // Flat 12-branch schema: every branch is a single object (no allOf/Intersect).
  assert.equal(request.anyOf.length, 12);
  for (const branch of request.anyOf) assert.equal(branch.allOf, undefined);
  const props = Object.keys(request.anyOf[0].properties ?? {});
  assert.ok(props.includes('owner') && props.includes('repo'));
  assert.ok(props.includes('path') === false);
  const all = request.anyOf.flatMap((branch: any) => Object.values(branch.properties ?? {}));
  assert.ok(all.some((p: any) => p.enum?.length === 3));
  assert.ok(all.some((p: any) => p.maxLength === 4096));
  // Dropped pre-Stage-5 selectors stay out of schema.
  const serialized = JSON.stringify(request);
  assert.equal(serialized.includes('$ref'), false, 'no $ref in github schema');
  for (const removed of ['raw', 'offset', 'byteOffset', 'byteLimit', 'maxFiles', 'topK']) assert.equal(serialized.includes(`\"${removed}\"`), false);
});

test('github invalid requests reject before dispatch (zero backend dispatch)', async () => {
  const tool = await captureGitHubTool();
  const originalFetch = globalThis.fetch;
  let fetchCalls = 0;
  globalThis.fetch = (async () => { fetchCalls += 1; throw new Error('must not dispatch'); }) as unknown as typeof fetch;
  try {
    const corpus: Array<{ request: Record<string, unknown>; pattern: RegExp }> = [
      // Repo selector misuse.
      { request: { action: 'repo' }, pattern: /requires selector/ },
      { request: { action: 'repo', owner: 'o' }, pattern: /requires selector/ },
      { request: { action: 'repo', repository: 'not-a-slug' }, pattern: /owner\/repo/ },
      // Path XOR.
      { request: { action: 'file', owner: 'o', repo: 'r' }, pattern: /requires selector/ },
      { request: { action: 'file', owner: 'o', repo: 'r', path: 'a', paths: ['a'] }, pattern: /mutually exclusive/ },
      // Action-field misuse.
      { request: { action: 'pulls', owner: 'o', repo: 'r', labels: ['bug'] }, pattern: /labels/ },
      { request: { action: 'issues', owner: 'o', repo: 'r', latest: true }, pattern: /latest/ },
      { request: { action: 'issues', owner: 'o', repo: 'r', files: true }, pattern: /files/ },
      { request: { action: 'trending', jobs: true }, pattern: /jobs/ },
      // Wrong types.
      { request: { action: 'issues', owner: 'o', repo: 'r', number: '5' }, pattern: /number/ },
      { request: { action: 'releases', owner: 'o', repo: 'r', latest: 'yes' }, pattern: /latest/ },
      { request: { action: 'issues', owner: 'o', repo: 'r', limit: 0 }, pattern: /limit/ },
      // Unknown fields.
      { request: { action: 'repo', owner: 'o', repo: 'r', bogus: 1 }, pattern: /Unknown field/ },
      { request: { action: 'search', query: 'x', sha: 'abc1234' }, pattern: /Unknown field/ },
      // Repo selector XOR: repository alone or owner+repo, never mixed.
      { request: { action: 'repo', owner: 'o', repo: 'r', repository: 'o/r' }, pattern: /mutually exclusive/ },
      { request: { action: 'repo', owner: 'o', repository: 'o/r' }, pattern: /mutually exclusive/ },
      { request: { action: 'repo', repo: 'r', repository: 'o/r' }, pattern: /mutually exclusive/ },
      // Whitespace-only labels reject pre-dispatch (schema/runtime parity).
      { request: { action: 'issues', owner: 'o', repo: 'r', labels: ['   '] }, pattern: /labels/ },
      { request: { action: 'issues', owner: 'o', repo: 'r', labels: ['bug', ' '] }, pattern: /labels/ },
      // Present wrong-type optional strings reject pre-projection, no echo.
      { request: { action: 'tree', owner: 'o', repo: 'r', branch: 5 }, pattern: /branch must be a string/ },
      { request: { action: 'tree', owner: 'o', repo: 'r', ref: 5 }, pattern: /ref must be a string/ },
      { request: { action: 'tree', owner: 'o', repo: 'r', path: 5 }, pattern: /path must be a string/ },
      { request: { action: 'search', query: 'x', language: 5 }, pattern: /language must be a string/ },
    ];
    for (const { request, pattern } of corpus) {
      await assert.rejects(tool.execute('call-x', { request }, undefined), pattern, JSON.stringify(request));
    }
    assert.equal(fetchCalls, 0, 'no backend dispatch on invalid input');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('github empty repository string behaves as absent (empty-absent convention)', async () => {
  // repository:'' + owner/repo must behave as absent: no non-empty data
  // dropped, owner/repo still resolve. Non-empty mixes reject (pinned above).
  const { request } = validateGithubRequest({ action: 'repo', owner: 'o', repo: 'r', repository: '' } as never);
  assert.equal(request.owner, 'o');
  assert.equal(request.repo, 'r');
});
