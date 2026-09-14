import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { loadSearchMcpEnvironment, resolveSparqlConfig } from '../../src/setup/local-config.js';
import { findProvider, liveAuthSnapshot, providerSummary, sparqlStatus } from '../../src/setup/providers.js';
import { buildCliEnvironment, CliSearchBackend } from '../../src/cli/cli-backend.js';
import { buildServerParameters } from '../../src/process/mcp-client.js';

const ENDPOINT = 'https://sparql.example.org/sparql';
const TOKEN = 'SENTINEL_SPARQL_TOKEN_abc123xyz';

test('local-config maps sparql endpoint/token from JSON without overriding env', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pi-sparql-config-'));
  const path = join(dir, 'config.json');
  await writeFile(path, JSON.stringify({ sparql: { endpoint: ENDPOINT, token: TOKEN } }));
  const base = { PI_SEARCH_ENV_PATH: join(dir, 'missing.env'), SEARCH_MCP_CONFIG_PATH: path };
  const env = loadSearchMcpEnvironment(base);
  assert.equal(env.GRAPH_SPARQL_ENDPOINT, ENDPOINT);
  assert.equal(env.GRAPH_SPARQL_TOKEN, TOKEN);
  const override = loadSearchMcpEnvironment({ ...base, GRAPH_SPARQL_ENDPOINT: 'https://env.example/sparql' });
  assert.equal(override.GRAPH_SPARQL_ENDPOINT, 'https://env.example/sparql');
  assert.equal(override.GRAPH_SPARQL_TOKEN, TOKEN);
});

test('resolveSparqlConfig trims and accepts http/https including loopback', () => {
  const ok = resolveSparqlConfig({ GRAPH_SPARQL_ENDPOINT: `  ${ENDPOINT}  `, GRAPH_SPARQL_TOKEN: TOKEN });
  assert.equal(ok.configured, true);
  assert.equal(ok.endpoint, ENDPOINT);
  assert.equal(ok.endpointHost, 'sparql.example.org');
  assert.equal(ok.token, TOKEN);
  assert.equal(ok.error, undefined);
  const loopback = resolveSparqlConfig({ GRAPH_SPARQL_ENDPOINT: 'http://127.0.0.1:8890/sparql' });
  assert.equal(loopback.configured, true);
  assert.equal(loopback.endpointHost, '127.0.0.1:8890');
  const blank = resolveSparqlConfig({});
  assert.equal(blank.configured, false);
  assert.equal(blank.error, undefined);
});

test('resolveSparqlConfig rejects invalid endpoint with unsupported_option and no secret echo', () => {
  for (const bad of [
    'ftp://sparql.example.org/sparql',
    'https://user:pass@sparql.example.org/sparql',
    'not a url',
    'file:///etc/passwd',
  ]) {
    const out = resolveSparqlConfig({ GRAPH_SPARQL_ENDPOINT: bad, GRAPH_SPARQL_TOKEN: TOKEN });
    assert.equal(out.configured, false);
    assert.equal(out.error?.code, 'unsupported_option');
    assert.ok(out.error?.message);
    assert.equal(out.error?.message.includes(TOKEN), false, 'error must not echo token');
    assert.equal(out.error?.message.includes('user'), false, 'error must not echo credentials');
    assert.equal(out.error?.message.includes('pass'), false, 'error must not echo credentials');
  }
});

test('sparql provider status is configured/host-only with no token exposure', () => {
  const desc = findProvider('sparql');
  assert.ok(desc, 'sparql descriptor must exist');
  assert.deepEqual([...desc.envKeys].sort(), ['GRAPH_SPARQL_ENDPOINT', 'GRAPH_SPARQL_TOKEN'].sort());
  const live = sparqlStatus({ GRAPH_SPARQL_ENDPOINT: ENDPOINT, GRAPH_SPARQL_TOKEN: TOKEN });
  assert.equal(live.configured, true);
  assert.equal(live.endpointHost, 'sparql.example.org');
  assert.ok(!JSON.stringify(live).includes(TOKEN), 'status must never expose token');
  assert.deepEqual(live.keyNames, ['GRAPH_SPARQL_ENDPOINT']);
  assert.equal(sparqlStatus({ GRAPH_SPARQL_TOKEN: TOKEN }).configured, false, 'token alone must not count');
  assert.equal(sparqlStatus({}).configured, false);
  assert.equal(sparqlStatus({ GRAPH_SPARQL_ENDPOINT: 'ftp://x' }).configured, false);
  const snap = liveAuthSnapshot({ GRAPH_SPARQL_ENDPOINT: ENDPOINT, GRAPH_SPARQL_TOKEN: TOKEN });
  assert.equal(snap.sparql?.configured, true);
  assert.deepEqual(snap.sparql?.keyNames, ['GRAPH_SPARQL_ENDPOINT']);
  const summary = providerSummary({ GRAPH_SPARQL_ENDPOINT: ENDPOINT, GRAPH_SPARQL_TOKEN: TOKEN });
  const row = summary.find((p) => p.provider === 'sparql');
  assert.ok(row);
  assert.equal(row.configured, true);
  assert.deepEqual(row.keyNames, ['GRAPH_SPARQL_ENDPOINT']);
  assert.ok(!JSON.stringify(summary).includes(TOKEN), 'summary must never expose token');
});

test('cli backend never forwards sparql credentials to unrelated child processes', () => {
  const env = buildCliEnvironment({ GRAPH_SPARQL_ENDPOINT: ENDPOINT, GRAPH_SPARQL_TOKEN: TOKEN });
  assert.equal(env.GRAPH_SPARQL_ENDPOINT, undefined);
  assert.equal(env.GRAPH_SPARQL_TOKEN, undefined);
  const empty = buildCliEnvironment({ PATH: '/usr/bin' });
  assert.equal(empty.GRAPH_SPARQL_ENDPOINT, undefined);
  assert.equal(empty.GRAPH_SPARQL_TOKEN, undefined);
});

test('env-only SPARQL config survives default CLI subprocess for the graph tool', async () => {
  const scoped = buildCliEnvironment({ GRAPH_SPARQL_ENDPOINT: ENDPOINT, GRAPH_SPARQL_TOKEN: TOKEN }, 'graph');
  assert.equal(scoped.GRAPH_SPARQL_ENDPOINT, ENDPOINT);
  assert.equal(scoped.GRAPH_SPARQL_TOKEN, TOKEN);
  const unrelated = buildCliEnvironment({ GRAPH_SPARQL_ENDPOINT: ENDPOINT, GRAPH_SPARQL_TOKEN: TOKEN }, 'web_search');
  assert.equal(unrelated.GRAPH_SPARQL_ENDPOINT, undefined);
  assert.equal(unrelated.GRAPH_SPARQL_TOKEN, undefined);
  // End-to-end through the default CLI subprocess path with env-only config
  // (no .env, no JSON): an invalid forwarded endpoint must surface as
  // unsupported_option in the child; a lost endpoint would be auth_required.
  const dir = await mkdtemp(join(tmpdir(), 'pi-sparql-cli-e2e-'));
  const backend = new CliSearchBackend({
    PATH: process.env.PATH,
    PI_SEARCH_ENV_PATH: join(dir, 'missing.env'),
    SEARCH_MCP_CONFIG_PATH: join(dir, 'missing.json'),
    GRAPH_SPARQL_ENDPOINT: 'ftp://sparql.invalid/sparql',
  });
  try {
    const result = await backend.callTool(
      'graph',
      { action: 'query', language: 'sparql', query: 'SELECT * WHERE { ?s ?p ?o }' },
      { timeout: 120_000 },
    );
    const graph = (result.details as { graph?: { errors?: Array<{ code?: string }> } } | undefined)?.graph;
    assert.ok(graph, 'graph envelope expected from CLI child');
    assert.equal(graph.errors?.[0]?.code, 'unsupported_option');
  } finally {
    await backend.close();
  }
});

test('mcp client forwards sparql endpoint and token by default without unrelated secrets', () => {
  const params = buildServerParameters({
    PATH: '/usr/bin',
    GRAPH_SPARQL_ENDPOINT: ENDPOINT,
    GRAPH_SPARQL_TOKEN: TOKEN,
    DATABASE_URL: 'secret',
  });
  assert.equal(params.env?.GRAPH_SPARQL_ENDPOINT, ENDPOINT);
  assert.equal(params.env?.GRAPH_SPARQL_TOKEN, TOKEN);
  assert.equal(params.env?.DATABASE_URL, undefined);
});
