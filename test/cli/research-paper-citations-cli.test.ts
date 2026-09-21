import assert from 'node:assert/strict';
import test from 'node:test';
import { runCommand } from '../../src/cli/cli.js';

function stubFetch(handler: (url: string) => Response | Promise<Response>): () => void {
  const saved = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request) => handler(String(input))) as typeof fetch;
  return () => { globalThis.fetch = saved; };
}

const OPENALEX_WORK = {
  id: 'https://openalex.org/W2741809807',
  display_name: 'Attention Is All You Need',
  doi: 'https://doi.org/10.48550/arxiv.1706.03762',
  publication_year: 2017,
  cited_by_count: 95000,
  authorships: [{ author: { id: 'https://openalex.org/A1', display_name: 'Ashish Vaswani' } }],
  primary_location: { source: { display_name: 'NeurIPS' } },
  abstract_inverted_index: { The: [0], dominant: [1], models: [2] },
};

const OPENALEX_CITATIONS = {
  meta: { count: 1, page: 1, per_page: 10 },
  results: [
    {
      id: 'https://openalex.org/W100',
      display_name: 'BERT: Pre-training of Deep Bidirectional Transformers',
      publication_year: 2018,
      cited_by_count: 65000,
      authorships: [{ author: { id: 'https://openalex.org/A10', display_name: 'Jacob Devlin' } }],
    },
  ],
};

test('CLI research paper and citations expose help grammar', async () => {
  for (const args of [['research', 'paper', '--help'], ['research', 'paper', '-h']]) {
    const help = await runCommand(args, {});
    assert.equal(help.ok, true, args.join(' '));
    assert.equal((help.data as { commandId: string }).commandId, 'research.paper');
    assert.match((help.data as { usage: string }).usage, /northstar research paper ID_OR_URL/);
  }

  for (const args of [['research', 'citations', '--help'], ['research', 'citations', '-h']]) {
    const help = await runCommand(args, {});
    assert.equal(help.ok, true, args.join(' '));
    assert.equal((help.data as { commandId: string }).commandId, 'research.citations');
    assert.match((help.data as { usage: string }).usage, /northstar research citations ID/);
  }
});

test('CLI capabilities includes research.paper and research.citations', async () => {
  const caps = (await runCommand(['capabilities'], {})).data as string[];
  assert.ok(caps.includes('research.paper'));
  assert.ok(caps.includes('research.citations'));
});

test('CLI research paper strictly rejects malformed usage', async () => {
  for (const args of [
    ['research', 'paper'],
    ['research', 'paper', 'W1', 'W2'],
    ['research', 'paper', 'W1', '--bogus'],
    ['research', 'paper', 'W1', '--json', '--agent'],
    ['research', 'paper', 'W1', '--source'],
    ['research', 'paper', 'W1', '--source', 'openalex', '--source', 'semantic_scholar'],
  ]) {
    const result = await runCommand(args, {});
    assert.equal(result.ok, false, args.join(' '));
  }
});

test('CLI research citations strictly rejects malformed usage', async () => {
  for (const args of [
    ['research', 'citations'],
    ['research', 'citations', 'W1', 'W2'],
    ['research', 'citations', 'W1', '--bogus'],
    ['research', 'citations', 'W1', '--json', '--agent'],
    ['research', 'citations', 'W1', '--limit'],
    ['research', 'citations', 'W1', '--limit', '0'],
    ['research', 'citations', 'W1', '--limit', '99'],
    ['research', 'citations', 'W1', '--limit', 'abc'],
    ['research', 'citations', 'W1', '--limit', '5', '--limit', '10'],
    ['research', 'citations', 'W1', '--cursor'],
    ['research', 'citations', 'W1', '--cursor', 'a', '--cursor', 'b'],
  ]) {
    const result = await runCommand(args, {});
    assert.equal(result.ok, false, args.join(' '));
  }
});

test('CLI research paper renders human, json, and agent modes', async () => {
  const restore = stubFetch(() => new Response(JSON.stringify(OPENALEX_WORK), { status: 200 }));
  try {
    const human = await runCommand(['research', 'paper', 'W2741809807'], {});
    assert.equal(human.ok, true);
    assert.match(String(human.data), /research\.paper: success/);
    assert.match(String(human.data), /Attention Is All You Need/);
    assert.match(String(human.data), /NeurIPS/);

    const json = await runCommand(['research', 'paper', 'W2741809807', '--json'], {});
    assert.equal(json.ok, true);
    const parsed = JSON.parse(String(json.data)) as { commandId: string; outcome: string };
    assert.equal(parsed.commandId, 'research.paper');
    assert.equal(parsed.outcome, 'success');

    const agent = await runCommand(['research', 'paper', 'W2741809807', '--agent'], {});
    assert.equal(agent.ok, true);
    const agentParsed = JSON.parse(String(agent.data)) as { commandId: string; trust: string };
    assert.equal(agentParsed.commandId, 'research.paper');
    assert.equal(agentParsed.trust, 'external');
  } finally {
    restore();
  }
});

test('CLI research citations renders human, json, and agent modes', async () => {
  const restore = stubFetch(() => new Response(JSON.stringify(OPENALEX_CITATIONS), { status: 200 }));
  try {
    const human = await runCommand(['research', 'citations', 'W2741809807'], {});
    assert.equal(human.ok, true);
    assert.match(String(human.data), /research\.citations: success/);
    assert.match(String(human.data), /BERT: Pre-training of Deep Bidirectional Transformers/);

    const json = await runCommand(['research', 'citations', 'W2741809807', '--json'], {});
    assert.equal(json.ok, true);
    const parsed = JSON.parse(String(json.data)) as { commandId: string; outcome: string };
    assert.equal(parsed.commandId, 'research.citations');
    assert.equal(parsed.outcome, 'success');

    const agent = await runCommand(['research', 'citations', 'W2741809807', '--agent'], {});
    assert.equal(agent.ok, true);
    const agentParsed = JSON.parse(String(agent.data)) as { commandId: string; trust: string };
    assert.equal(agentParsed.commandId, 'research.citations');
    assert.equal(agentParsed.trust, 'external');
  } finally {
    restore();
  }
});

test('CLI research paper and citations return ok: false on not found / error', async () => {
  const restore = stubFetch(() => new Response('Not Found', { status: 404 }));
  try {
    const paper = await runCommand(['research', 'paper', 'W00000'], {});
    assert.equal(paper.ok, false);

    const citations = await runCommand(['research', 'citations', 'W00000'], {});
    assert.equal(citations.ok, false);
  } finally {
    restore();
  }
});
