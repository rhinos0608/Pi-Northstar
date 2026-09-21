import assert from 'node:assert/strict';
import test from 'node:test';
import { createCommandContext } from '../../src/commands/command-context.js';
import {
  executeResearchPaper,
  RESEARCH_PAPER_COMMAND,
} from '../../src/commands/research-paper-handler.js';
import { callNativeTool } from '../../src/native-tools.js';
import { resolvePaperIdentity, extractDoi } from '../../src/research/research-paper.js';

function stubFetch(handler: (url: string, init?: RequestInit) => Response | Promise<Response>): () => void {
  const saved = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => handler(String(input), init)) as typeof fetch;
  return () => { globalThis.fetch = saved; };
}

const OPENALEX_WORK_PAYLOAD = {
  id: 'https://openalex.org/W2741809807',
  display_name: 'Attention Is All You Need',
  doi: 'https://doi.org/10.48550/arxiv.1706.03762',
  publication_year: 2017,
  cited_by_count: 95000,
  authorships: [
    { author: { id: 'https://openalex.org/A1', display_name: 'Ashish Vaswani' } },
    { author: { id: 'https://openalex.org/A2', display_name: 'Noam Shazeer' } },
  ],
  primary_location: {
    source: { display_name: 'NeurIPS' },
  },
  abstract_inverted_index: {
    The: [0],
    dominant: [1],
    sequence: [2],
    transduction: [3],
    models: [4],
  },
};

const S2_PAPER_PAYLOAD = {
  paperId: '649def34f8be52c8b66281af98ae884c09aef38b',
  title: 'Attention is All you Need',
  abstract: 'The dominant sequence transduction models are based on complex recurrent or convolutional neural networks.',
  year: 2017,
  venue: 'NeurIPS',
  citationCount: 95000,
  authors: [
    { authorId: '1', name: 'Ashish Vaswani' },
    { authorId: '2', name: 'Noam Shazeer' },
  ],
  externalIds: {
    DOI: '10.48550/arxiv.1706.03762',
    ArXiv: '1706.03762',
  },
};

const ARXIV_ATOM_XML = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom" xmlns:opensearch="http://a9.com/-/spec/opensearch/1.1/">
  <opensearch:totalResults>1</opensearch:totalResults>
  <entry>
    <id>http://arxiv.org/abs/1706.03762v7</id>
    <published>2017-06-12T20:07:07Z</published>
    <title>Attention Is All You Need</title>
    <summary>The dominant sequence transduction models are based on complex recurrent or convolutional neural networks.</summary>
    <author><name>Ashish Vaswani</name></author>
    <author><name>Noam Shazeer</name></author>
  </entry>
</feed>`;

const PUBMED_ESUMMARY_JSON = {
  result: {
    uids: ['3372278'],
    '3372278': {
      uid: '3372278',
      pubdate: '1988 May',
      source: 'Nature',
      title: 'A novel protein kinase from yeast.',
      authors: [{ name: 'Smith A' }, { name: 'Jones B' }],
      articleids: [
        { idtype: 'pubmed', value: '3372278' },
        { idtype: 'doi', value: '10.1038/3372278a0' },
      ],
    },
  },
};

const CROSSREF_WORK_JSON = {
  message: {
    DOI: '10.1038/nature12373',
    URL: 'http://dx.doi.org/10.1038/nature12373',
    title: ['Nanometre-scale thermometry in a living cell'],
    author: [{ given: 'G.', family: 'Kucsko' }],
    'container-title': ['Nature'],
    issued: { 'date-parts': [[2013]] },
    'is-referenced-by-count': 500,
    abstract: '<jats:p>Measurement of temperature at the submicrometre scale.</jats:p>',
  },
};

const DATACITE_WORK_JSON = {
  data: {
    attributes: {
      doi: '10.5061/dryad.8515',
      url: 'https://datadryad.org/stash/dataset/doi:10.5061/dryad.8515',
      titles: [{ title: 'Data from: Ecological consequences of extinction' }],
      creators: [{ name: 'Dirzo, Rodolfo' }],
      publicationYear: 2014,
      descriptions: [{ description: 'Ecological consequences of defaunation.', descriptionType: 'Abstract' }],
    },
  },
};

test('extractDoi extracts DOIs from bare strings, URLs, and doi prefixes', () => {
  assert.equal(extractDoi('10.1038/nature12373'), '10.1038/nature12373');
  assert.equal(extractDoi('doi:10.1038/nature12373'), '10.1038/nature12373');
  assert.equal(extractDoi('https://doi.org/10.1038/nature12373'), '10.1038/nature12373');
  assert.equal(extractDoi('http://dx.doi.org/10.1038/nature12373'), '10.1038/nature12373');
  assert.equal(extractDoi('not-a-doi'), undefined);
});

test('resolvePaperIdentity resolves candidate follow-up IDs and URLs', () => {
  // DOI
  assert.deepEqual(resolvePaperIdentity('10.1038/nature12373'), { ok: true, identity: { source: 'openalex', id: '10.1038/nature12373' } });
  assert.deepEqual(resolvePaperIdentity('https://doi.org/10.1038/nature12373'), { ok: true, identity: { source: 'openalex', id: '10.1038/nature12373' } });

  // OpenAlex
  assert.deepEqual(resolvePaperIdentity('W2741809807'), { ok: true, identity: { source: 'openalex', id: 'W2741809807' } });
  assert.deepEqual(resolvePaperIdentity('openalex:W2741809807'), { ok: true, identity: { source: 'openalex', id: 'W2741809807' } });
  assert.deepEqual(resolvePaperIdentity('https://openalex.org/W2741809807'), { ok: true, identity: { source: 'openalex', id: 'W2741809807' } });

  // Semantic Scholar
  assert.deepEqual(resolvePaperIdentity('649def34f8be52c8b66281af98ae884c09aef38b'), { ok: true, identity: { source: 'semantic_scholar', id: '649def34f8be52c8b66281af98ae884c09aef38b' } });
  assert.deepEqual(resolvePaperIdentity('s2:649def34f8be52c8b66281af98ae884c09aef38b'), { ok: true, identity: { source: 'semantic_scholar', id: '649def34f8be52c8b66281af98ae884c09aef38b' } });
  assert.deepEqual(resolvePaperIdentity('https://www.semanticscholar.org/paper/649def34f8be52c8b66281af98ae884c09aef38b'), { ok: true, identity: { source: 'semantic_scholar', id: '649def34f8be52c8b66281af98ae884c09aef38b' } });

  // arXiv
  assert.deepEqual(resolvePaperIdentity('2106.09685'), { ok: true, identity: { source: 'arxiv', id: '2106.09685' } });
  assert.deepEqual(resolvePaperIdentity('arxiv:2106.09685'), { ok: true, identity: { source: 'arxiv', id: '2106.09685' } });
  assert.deepEqual(resolvePaperIdentity('https://arxiv.org/abs/2106.09685'), { ok: true, identity: { source: 'arxiv', id: '2106.09685' } });

  // PubMed
  assert.deepEqual(resolvePaperIdentity('pmid:3372278'), { ok: true, identity: { source: 'pubmed', id: '3372278' } });
  assert.deepEqual(resolvePaperIdentity('https://pubmed.ncbi.nlm.nih.gov/3372278'), { ok: true, identity: { source: 'pubmed', id: '3372278' } });

  // Crossref
  assert.deepEqual(resolvePaperIdentity('https://api.crossref.org/works/10.1038/nature12373'), { ok: true, identity: { source: 'crossref', id: '10.1038/nature12373' } });

  // DataCite
  assert.deepEqual(resolvePaperIdentity('https://api.datacite.org/dois/10.5061/dryad.8515'), { ok: true, identity: { source: 'datacite', id: '10.5061/dryad.8515' } });

  // Generic non-academic URL rejects without generic-web substitution
  const generic = resolvePaperIdentity('https://example.com/some/article');
  assert.equal(generic.ok, false);
  assert.match((generic as { message: string }).message, /not a recognized research candidate identity/);
});

test('research.paper rejects missing ID/URL and source:all strictly', async () => {
  const ctx = createCommandContext({ surface: 'test', env: {} });

  await assert.rejects(
    async () => executeResearchPaper({ idOrUrl: '   ' }, ctx),
    (err: Error & { code?: string }) => err.code === 'invalid_input',
  );

  const allRes = await executeResearchPaper({ idOrUrl: '10.1038/nature12373', source: 'all' }, ctx);
  const allCmd = (allRes.details as Record<string, unknown>).northstarCommand as { outcome: string; error?: { code: string } };
  assert.equal(allCmd.outcome, 'failed');
  assert.equal(allCmd.error?.code, 'invalid_input');

  const unknownRes = await executeResearchPaper({ idOrUrl: '10.1038/nature12373', source: 'duckduckgo' }, ctx);
  const unknownCmd = (unknownRes.details as Record<string, unknown>).northstarCommand as { outcome: string; error?: { code: string } };
  assert.equal(unknownCmd.outcome, 'failed');
  assert.equal(unknownCmd.error?.code, 'invalid_input');
});

test('research.paper surfaces unsupported sources without touching the network', async () => {
  const ctx = createCommandContext({ surface: 'test', env: {} });
  let networkTouched = false;
  const restore = stubFetch(() => {
    networkTouched = true;
    return new Response('{}', { status: 200 });
  });

  try {
    for (const source of ['gdelt', 'hackernews', 'stackoverflow', 'ror', 'wikidata', 'wikipedia']) {
      const res = await executeResearchPaper({ idOrUrl: '10.1038/nature12373', source }, ctx);
      const cmd = (res.details as Record<string, unknown>).northstarCommand as { outcome: string; error?: { code: string; message: string } };
      assert.equal(cmd.outcome, 'failed');
      assert.equal(cmd.error?.code, 'unsupported_action');
      assert.match(cmd.error?.message ?? '', new RegExp(`${source} does not support the "paper" action`));
    }
    assert.equal(networkTouched, false, 'network must not be touched for unsupported sources');
  } finally {
    restore();
  }
});

test('research.paper fetches full metadata via OpenAlex with reconstructed abstract', async () => {
  const ctx = createCommandContext({ surface: 'test', env: {} });
  const urls: string[] = [];
  const restore = stubFetch((url) => {
    urls.push(url);
    return new Response(JSON.stringify(OPENALEX_WORK_PAYLOAD), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  });

  try {
    const res = await executeResearchPaper({ idOrUrl: 'W2741809807' }, ctx);
    assert.equal(urls.length, 1);
    assert.match(urls[0]!, /api\.openalex\.org\/works\/W2741809807/);

    const cmd = (res.details as Record<string, unknown>).northstarCommand as {
      outcome: string;
      data: { kind: string; entities: Array<Record<string, unknown>> };
    };
    assert.equal(cmd.outcome, 'success');
    const entity = cmd.data.entities[0]!;
    assert.equal(entity.title, 'Attention Is All You Need');
    assert.equal(entity.year, 2017);
    assert.equal(entity.venue, 'NeurIPS');
    assert.equal((entity.metrics as { citations?: number })?.citations, 95000);
    assert.equal(entity.abstract, 'The dominant sequence transduction models');
  } finally {
    restore();
  }
});

test('research.paper fetches metadata via Semantic Scholar', async () => {
  const ctx = createCommandContext({ surface: 'test', env: {} });
  const urls: string[] = [];
  const restore = stubFetch((url) => {
    urls.push(url);
    return new Response(JSON.stringify(S2_PAPER_PAYLOAD), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  });

  try {
    const res = await executeResearchPaper({ idOrUrl: '649def34f8be52c8b66281af98ae884c09aef38b' }, ctx);
    assert.equal(urls.length, 1);
    assert.match(urls[0]!, /api\.semanticscholar\.org\/graph\/v1\/paper\/649def34f8be52c8b66281af98ae884c09aef38b/);

    const cmd = (res.details as Record<string, unknown>).northstarCommand as {
      outcome: string;
      data: { kind: string; entities: Array<Record<string, unknown>> };
    };
    assert.equal(cmd.outcome, 'success');
    const entity = cmd.data.entities[0]!;
    assert.equal(entity.title, 'Attention is All you Need');
    assert.equal(entity.year, 2017);
    assert.equal((entity.metrics as { citations?: number })?.citations, 95000);
  } finally {
    restore();
  }
});

test('research.paper fetches metadata via arXiv Atom API', async () => {
  const ctx = createCommandContext({ surface: 'test', env: {} });
  const urls: string[] = [];
  const restore = stubFetch((url) => {
    urls.push(url);
    return new Response(ARXIV_ATOM_XML, {
      status: 200,
      headers: { 'content-type': 'application/xml' },
    });
  });

  try {
    const res = await executeResearchPaper({ idOrUrl: '1706.03762' }, ctx);
    assert.equal(urls.length, 1);
    assert.match(urls[0]!, /export\.arxiv\.org\/api\/query\?id_list=1706\.03762/);

    const cmd = (res.details as Record<string, unknown>).northstarCommand as {
      outcome: string;
      data: { kind: string; entities: Array<Record<string, unknown>> };
    };
    assert.equal(cmd.outcome, 'success');
    const entity = cmd.data.entities[0]!;
    assert.equal(entity.title, 'Attention Is All You Need');
    assert.equal(entity.year, 2017);
    assert.match(String(entity.abstract), /The dominant sequence transduction models/);
  } finally {
    restore();
  }
});

test('research.paper fetches metadata via PubMed, Crossref, and DataCite', async () => {
  const ctx = createCommandContext({
    surface: 'test',
    env: {},
    // Stubbed fetch still runs production DNS preflight; keep fixture independent of host DNS.
    lookup: async () => [{ address: '93.184.216.34', family: 4 }],
  });

  // PubMed
  let restore = stubFetch(() => new Response(JSON.stringify(PUBMED_ESUMMARY_JSON), { status: 200 }));
  try {
    const res = await executeResearchPaper({ idOrUrl: '3372278', source: 'pubmed' }, ctx);
    const cmd = (res.details as Record<string, unknown>).northstarCommand as {
      outcome: string;
      data: { entities: Array<Record<string, unknown>> };
    };
    assert.equal(cmd.outcome, 'success');
    assert.equal(cmd.data.entities[0]!.title, 'A novel protein kinase from yeast.');
  } finally {
    restore();
  }

  // Crossref
  restore = stubFetch(() => new Response(JSON.stringify(CROSSREF_WORK_JSON), { status: 200 }));
  try {
    const res = await executeResearchPaper({ idOrUrl: '10.1038/nature12373', source: 'crossref' }, ctx);
    const cmd = (res.details as Record<string, unknown>).northstarCommand as {
      outcome: string;
      data: { entities: Array<Record<string, unknown>> };
    };
    assert.equal(cmd.outcome, 'success');
    assert.equal(cmd.data.entities[0]!.title, 'Nanometre-scale thermometry in a living cell');
  } finally {
    restore();
  }

  // DataCite
  restore = stubFetch(() => new Response(JSON.stringify(DATACITE_WORK_JSON), { status: 200 }));
  try {
    const res = await executeResearchPaper({ idOrUrl: '10.5061/dryad.8515', source: 'datacite' }, ctx);
    const cmd = (res.details as Record<string, unknown>).northstarCommand as {
      outcome: string;
      data: { entities: Array<Record<string, unknown>> };
    };
    assert.equal(cmd.outcome, 'success');
    assert.equal(cmd.data.entities[0]!.title, 'Data from: Ecological consequences of extinction');
  } finally {
    restore();
  }
});

test('research.paper maps 404, rate limits, and abort correctly', async () => {
  const ctx = createCommandContext({ surface: 'test', env: {} });

  // 404 -> not_found
  let restore = stubFetch(() => new Response('Not Found', { status: 404 }));
  try {
    const res = await executeResearchPaper({ idOrUrl: 'W0000000000' }, ctx);
    const cmd = (res.details as Record<string, unknown>).northstarCommand as {
      outcome: string;
      error?: { code: string; retryable: boolean };
    };
    assert.equal(cmd.outcome, 'failed');
    assert.equal(cmd.error?.code, 'not_found');
    assert.equal(cmd.error?.retryable, false);
  } finally {
    restore();
  }

  // 429 -> rate_limited, retryable: true
  restore = stubFetch(() => new Response('Too Many Requests', { status: 429 }));
  try {
    const res = await executeResearchPaper({ idOrUrl: 'W2741809807' }, ctx);
    const cmd = (res.details as Record<string, unknown>).northstarCommand as {
      outcome: string;
      error?: { code: string; retryable: boolean };
    };
    assert.equal(cmd.outcome, 'failed');
    assert.equal(cmd.error?.code, 'rate_limited');
    assert.equal(cmd.error?.retryable, true);
  } finally {
    restore();
  }

  // Abort -> cancelled
  const controller = new AbortController();
  controller.abort();
  const abortedCtx = createCommandContext({ surface: 'test', env: {}, signal: controller.signal });
  await assert.rejects(
    async () => executeResearchPaper({ idOrUrl: 'W2741809807' }, abortedCtx),
    (err: Error & { commandResult?: { outcome: string } }) => err.commandResult?.outcome === 'cancelled',
  );
});

test('callNativeTool routes research paper through the command handler', async () => {
  const restore = stubFetch(() => new Response(JSON.stringify(OPENALEX_WORK_PAYLOAD), { status: 200 }));
  try {
    const res = await callNativeTool('research', { action: 'paper', idOrUrl: 'W2741809807' });
    const cmd = (res.details as Record<string, unknown>).northstarCommand as {
      commandId: string;
      outcome: string;
    };
    assert.equal(cmd.commandId, RESEARCH_PAPER_COMMAND);
    assert.equal(cmd.outcome, 'success');
  } finally {
    restore();
  }
});
