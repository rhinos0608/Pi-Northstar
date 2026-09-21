import assert from 'node:assert/strict';
import test from 'node:test';
import { runCommand } from '../../src/cli/cli.js';

function stubFetch(handler: (url: string) => Response | Promise<Response>): () => void {
  const saved = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request) => handler(String(input))) as typeof fetch;
  return () => { globalThis.fetch = saved; };
}

const OPENALEX_WORKS = {
  results: [
    {
      id: 'https://openalex.org/W1',
      display_name: 'Attention Is All You Need',
      doi: 'https://doi.org/10.1/atten',
      publication_year: 2017,
      cited_by_count: 42,
      authorships: [],
    },
  ],
  meta: {},
};

test('CLI research search help exposes the migrated grammar', async () => {
  for (const args of [['research', 'search', '--help'], ['research', '--help'], ['research', 'search', '-h']]) {
    const help = await runCommand(args, {});
    assert.equal(help.ok, true, args.join(' '));
    assert.equal((help.data as { commandId: string }).commandId, 'research.search');
    assert.match((help.data as { usage: string }).usage, /northstar research search QUERY/);
  }
});

test('CLI research search registers domain and capability', async () => {
  assert.ok(((await runCommand(['domains'], {})).data as string[]).includes('research'));
  assert.ok(((await runCommand(['capabilities'], {})).data as string[]).includes('research.search'));
});

test('CLI research search rejects malformed use strictly', async () => {
  for (const args of [
    ['research', 'search'],
    ['research', 'search', 'a', 'b'],
    ['research', 'search', 'alpha', '--bogus'],
    ['research', 'search', 'alpha', '--json', '--agent'],
    ['research', 'search', 'alpha', '--limit'],
    ['research', 'search', 'alpha', '--limit', 'abc'],
    ['research', 'search', 'alpha', '--limit', '0'],
    ['research', 'search', 'alpha', '--limit', '3', '--limit', '4'],
    ['research', 'search', 'alpha', '--year-from'],
    ['research', 'search', 'alpha', '--year-from', 'abc'],
    ['research', 'search', 'alpha', '--year-from', '99'],
    ['research', 'search', 'alpha', '--source'],
    ['research', 'detail'],
  ]) {
    const result = await runCommand(args, {});
    assert.equal(result.ok, false, args.join(' '));
  }
  for (const args of [
    ['research', 'search', 'alpha', '--cursor'],
    ['research', 'search', 'alpha', '--cursor', 'x', '--cursor', 'y'],
  ]) {
    const result = await runCommand(args, {});
    assert.equal(result.ok, false, args.join(' '));
  }
});

test('CLI research search rejects unknown source and out-of-range limit', async () => {
  const source = await runCommand(['research', 'search', 'transformers', '--source', 'duckduckgo'], {});
  assert.equal(source.ok, false);
  const limit = await runCommand(['research', 'search', 'transformers', '--limit', '99'], {});
  assert.equal(limit.ok, false);
});

test('CLI research search renders human, json, and agent modes', async () => {
  const restore = stubFetch(() =>
    new Response(JSON.stringify(OPENALEX_WORKS), { status: 200, headers: { 'content-type': 'application/json' } }));
  try {
    const human = await runCommand(['research', 'search', 'transformers', '--source', 'openalex', '--limit', '3'], {});
    assert.equal(human.ok, true);
    assert.match(String(human.data), /research\.search: success/);
    const json = await runCommand(['research', 'search', 'transformers', '--source', 'openalex', '--json'], {});
    assert.equal(json.ok, true);
    const parsed = JSON.parse(String(json.data)) as { commandId: string; outcome: string };
    assert.equal(parsed.commandId, 'research.search');
    assert.equal(parsed.outcome, 'success');
    const agent = await runCommand(['research', 'search', 'transformers', '--source', 'openalex', '--agent'], {});
    assert.equal(agent.ok, true);
    const agentParsed = JSON.parse(String(agent.data)) as { commandId: string; trust: string };
    assert.equal(agentParsed.commandId, 'research.search');
    assert.equal(agentParsed.trust, 'external');
  } finally {
    restore();
  }
});
