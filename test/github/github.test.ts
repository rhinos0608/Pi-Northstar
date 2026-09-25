import assert from 'node:assert/strict';
import { test } from 'node:test';
import Value from 'typebox/value';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { GITHUB_ACTIONS, validateGithubActionFields, validateGithubRequest } from '../../src/github/github-contract.js';
import { registerGitHubTool } from '../../src/github/github.js';

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

test('github tool exposes a flat canonical action schema', async () => {
  const tool = await captureGitHubTool();
  assert.equal(tool.name, 'github');
  const props = tool.parameters.properties;
  assert.equal(props.request, undefined, 'legacy request envelope must be absent');
  assert.deepEqual([...(props.action?.enum ?? [])].sort(), [...GITHUB_ACTIONS].sort());
});

test('anthropic object flattening preserves direct github fields', async () => {
  const parameters = (await captureGitHubTool()).parameters as any;
  const flattened = { type: 'object', properties: parameters.properties ?? {}, required: parameters.required ?? [] };
  assert.ok(flattened.properties.action, 'action stays directly visible after object flattening');
  assert.equal(flattened.properties.request, undefined);
});

test('github flat schema validates every action while runtime owns cross-action rules', async () => {
  const schema = (await captureGitHubTool()).parameters;
  const common = { owner: 'octo', repo: 'kit' };
  const requests = [
    { action: 'repo', ...common }, { action: 'file', ...common, path: 'src/a.ts' },
    { action: 'tree', ...common }, { action: 'search', query: 'x' }, { action: 'trending' },
    { action: 'issues', ...common }, { action: 'pulls', ...common }, { action: 'releases', ...common },
    { action: 'commits', ...common }, { action: 'search_repos', query: 'x' },
    { action: 'workflows', ...common }, { action: 'runs', ...common },
  ];
  for (const request of requests) assert.equal(Value.Check(schema, request), true, request.action);
  assert.equal(Value.Check(schema, { action: 'commits', labels: ['bug'], ...common }), true);
  assert.throws(() => validateGithubActionFields({ action: 'commits', labels: ['bug'], ...common }, 'commits'), /labels/);
  assert.equal(Value.Check(schema, { action: 'file', ...common }), true);
  assert.throws(() => validateGithubRequest({ action: 'file', ...common } as never), /requires selector/);
  assert.equal(Value.Check(schema, { request: { action: 'repo', ...common } }), false);
});

test('github flat schema keeps scalar/array bounds while runtime owns action-specific caps', async () => {
  const schema = (await captureGitHubTool()).parameters;
  const common = { owner: 'octo', repo: 'kit' };
  const pathsOf = (n: number): string[] => Array.from({ length: n }, (_, i) => `src/f${i}.ts`);
  assert.equal(Value.Check(schema, { action: 'file', ...common, path: 'src/a.ts' }), true);
  assert.equal(Value.Check(schema, { action: 'file', ...common, paths: pathsOf(1) }), true);
  assert.equal(Value.Check(schema, { action: 'file', ...common, paths: pathsOf(10) }), true);
  assert.equal(Value.Check(schema, { action: 'file', ...common, path: 'src/a.ts', paths: pathsOf(10) }), true);
  assert.throws(() => validateGithubRequest({ action: 'file', ...common, path: 'src/a.ts', paths: pathsOf(10) } as never), /mutually exclusive/);
  assert.throws(() => validateGithubRequest({ action: 'file', ...common } as never), /requires selector/);
  assert.equal(Value.Check(schema, { action: 'file', ...common, paths: pathsOf(11) }), false);
  assert.equal(Value.Check(schema, { action: 'file', ...common, paths: [] }), false);

  assert.equal(Value.Check(schema, { action: 'issues', ...common, limit: 50 }), true);
  assert.equal(Value.Check(schema, { action: 'issues', ...common, limit: 51 }), false);
  assert.equal(Value.Check(schema, { action: 'issues', ...common, limit: 0 }), false);
  assert.equal(Value.Check(schema, { action: 'issues', ...common, limit: 1.5 }), false);
  assert.equal(Value.Check(schema, { action: 'issues', ...common, perPage: 50 }), true);
  assert.equal(Value.Check(schema, { action: 'issues', ...common, perPage: 51 }), false);
  assert.equal(Value.Check(schema, { action: 'trending', limit: 26 }), true, 'global schema bound admits; runtime owns trending cap 25');
  assert.throws(() => validateGithubRequest({ action: 'trending', limit: 26 } as never), /limit|25/);

  const labelsOf = (n: number): string[] => Array.from({ length: n }, (_, i) => `label-${i}`);
  assert.equal(Value.Check(schema, { action: 'issues', ...common, labels: labelsOf(10) }), true);
  assert.equal(Value.Check(schema, { action: 'issues', ...common, labels: labelsOf(11) }), false);
  assert.equal(Value.Check(schema, { action: 'pulls', ...common, labels: labelsOf(10) }), true);
  assert.throws(() => validateGithubRequest({ action: 'pulls', ...common, labels: labelsOf(10) } as never), /labels/);
  assert.equal(Value.Check(schema, { action: 'issues', ...common, labels: [''] }), false);
  assert.equal(Value.Check(schema, { action: 'issues', ...common, labels: ['   '] }), false);
  assert.equal(Value.Check(schema, { action: 'issues', ...common, labels: [' bug '] }), true);
  assert.equal(Value.Check(schema, { action: 'issues', ...common, labels: ['x'.repeat(51)] }), false);
  assert.equal(Value.Check(schema, { action: 'issues', ...common, labels: ['x'.repeat(50)] }), true);

  assert.equal(Value.Check(schema, { action: 'issues', ...common, number: 1 }), true);
  assert.equal(Value.Check(schema, { action: 'issues', ...common, number: 0 }), false);
  assert.equal(Value.Check(schema, { action: 'issues', ...common, number: 1.5 }), false);
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
      action: 'file', owner: 'octo', repo: 'kit',
      paths: Array.from({ length: 10 }, (_, index) => `src/${index}.ts`),
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

test('github flat schema exposes selectors, bounds, and cursor directly', async () => {
  const tool = await captureGitHubTool();
  const props = tool.parameters.properties;
  for (const key of ['action', 'owner', 'repo', 'repository', 'path', 'paths', 'query', 'limit', 'perPage', 'cursor']) {
    assert.ok(props[key], `github schema must expose ${key}`);
  }
  assert.deepEqual([...(props.action.enum ?? [])].sort(), [...GITHUB_ACTIONS].sort());
  assert.equal(props.cursor.maxLength, 4096);
  const serialized = JSON.stringify(tool.parameters);
  assert.equal(serialized.includes('$ref'), false, 'no $ref in github schema');
  assert.equal(serialized.includes('"request"'), false, 'no request envelope in github schema');
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
      await assert.rejects(tool.execute('call-x', request, undefined), pattern, JSON.stringify(request));
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
