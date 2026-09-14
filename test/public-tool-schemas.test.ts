import assert from 'node:assert/strict';
import { test } from 'node:test';
import Value from 'typebox/value';
import { buildGithubParameters } from '../src/github/github.js';
import { buildFetchRoute } from '../src/index.js';
import { buildBrowserParameters, buildDesktopParameters, buildGraphParameters, buildKgParameters, buildSocialParameters, buildWebSearchParameters } from '../src/public-tool-schemas.js';
import { validateKgEnhance, validateKgNlp, validateKgSearch } from '../src/knowledge/knowledge-contract.js';

test('web_search schema accepts single, batch, and agent branches', () => {
  const schema = buildWebSearchParameters();
  assert.equal(Value.Check(schema, { query: 'pi coding agent' }), true);
  assert.equal(Value.Check(schema, { queries: ['a', 'b'] }), true);
  assert.equal(Value.Check(schema, { query: 'report', mode: 'agent' }), true);
});

test('web_search schema enforces exactly-one-of query/queries and agent rules', () => {
  const schema = buildWebSearchParameters();
  assert.equal(Value.Check(schema, { query: 'a', queries: ['b'] }), false);
  assert.equal(Value.Check(schema, {}), false);
  assert.equal(Value.Check(schema, { query: 'a', mode: 'agent', cursor: 'c' }), false);
  assert.equal(Value.Check(schema, { query: 'a', mode: 'agent', queries: ['b'] }), false);
  assert.equal(Value.Check(schema, { unknownField: 1, query: 'a' }), false);
});

test('web_search schema mirrors internal bounds', () => {
  const schema = buildWebSearchParameters();
  assert.equal(Value.Check(schema, { query: 'a', limit: 20 }), true);
  assert.equal(Value.Check(schema, { query: 'a', limit: 21 }), false);
  assert.equal(Value.Check(schema, { query: 'a', category: 'research', limit: 21 }), true);
  assert.equal(Value.Check(schema, { query: 'a', category: 'research', limit: 30 }), true);
  assert.equal(Value.Check(schema, { query: 'a', category: 'research', limit: 31 }), false);
  assert.equal(Value.Check(schema, { query: 'a', limit: 31 }), false);
  assert.equal(Value.Check(schema, { query: 'a', limit: 0 }), false);
  assert.equal(Value.Check(schema, { query: 'a', limit: 1.5 }), false);
  assert.equal(Value.Check(schema, { query: 'a', yearFrom: 2000.5 }), false);
  assert.equal(Value.Check(schema, { query: 'a', cursor: 'opaque' }), false);
  assert.equal(Value.Check(schema, { query: '' }), false);
  assert.equal(Value.Check(schema, { queries: [] }), false);
  assert.equal(Value.Check(schema, { queries: Array.from({ length: 9 }, (_, i) => `q${i}`) }), false);
  assert.equal(Value.Check(schema, { query: 'a', yearFrom: 1899 }), false);
  assert.equal(Value.Check(schema, { query: 'a', recency: 'decade' }), false);
  assert.equal(Value.Check(schema, { query: 'a', knowledge: {} }), false);
  assert.equal(Value.Check(schema, { query: 'a', knowledge: { facts: true } }), true);
  assert.equal(Value.Check(schema, { query: 'a', category: 'video', limit: 20 }), true);
  assert.equal(Value.Check(schema, { query: 'a', category: 'video', limit: 21 }), false);
});

test('web_search research continuation requires single query + exact source + cursor', () => {
  const schema = buildWebSearchParameters();
  // Valid continuation: single query, category research, one exact source, cursor.
  assert.equal(Value.Check(schema, { query: 'a', category: 'research', source: 'arxiv', cursor: 'opaque' }), true);
  assert.equal(Value.Check(schema, { query: 'a', category: 'research', source: 'arxiv', cursor: 'opaque', limit: 30 }), true);
  assert.equal(Value.Check(schema, { query: 'a', category: 'research', source: 'arxiv', cursor: 'opaque', limit: 31 }), false);
  // Invalid combos: cursor alone, without source, with aggregate source,
  // with batch queries, with agent mode, empty cursor, wrong category.
  assert.equal(Value.Check(schema, { query: 'a', cursor: 'opaque' }), false);
  assert.equal(Value.Check(schema, { query: 'a', category: 'research', cursor: 'opaque' }), false);
  assert.equal(Value.Check(schema, { query: 'a', category: 'research', source: 'all', cursor: 'opaque' }), false);
  assert.equal(Value.Check(schema, { queries: ['a'], category: 'research', source: 'arxiv', cursor: 'opaque' }), false);
  assert.equal(Value.Check(schema, { query: 'a', mode: 'agent', cursor: 'opaque' }), false);
  assert.equal(Value.Check(schema, { query: 'a', category: 'research', source: 'arxiv', cursor: '' }), false);
  assert.equal(Value.Check(schema, { query: 'a', category: 'news', cursor: 'opaque' }), false);
  assert.equal(Value.Check(schema, { query: 'a', category: 'research', source: 'nope', cursor: 'opaque' }), false);
});

test('web_search schema narrows source/knowledge to their branches', () => {
  const schema = buildWebSearchParameters();
  // source is research-only: plain single/batch branches carry no source.
  assert.equal(Value.Check(schema, { query: 'a', source: 'arxiv' }), false);
  assert.equal(Value.Check(schema, { queries: ['a'], source: 'arxiv' }), false);
  assert.equal(Value.Check(schema, { query: 'a', category: 'news', source: 'arxiv' }), false);
  // knowledge is web-only: research branches carry no knowledge.
  assert.equal(Value.Check(schema, { query: 'a', category: 'research', knowledge: { facts: true } }), false);
  assert.equal(Value.Check(schema, { queries: ['a'], category: 'research', knowledge: { facts: true } }), false);
  // Each field still validates on its home branch.
  assert.equal(Value.Check(schema, { query: 'a', category: 'research', source: 'arxiv' }), true);
  assert.equal(Value.Check(schema, { query: 'a', knowledge: { facts: true } }), true);
});

test('graph schema accepts dql and sparql query/probe/schema branches', () => {
  const schema = buildGraphParameters();
  assert.equal(Value.Check(schema, { action: 'query', language: 'dql', query: 'type:Organization' }), true);
  assert.equal(Value.Check(schema, { action: 'query', language: 'dql', query: 'type:Person', pageSize: 100, cursor: 'opaque' }), true);
  assert.equal(Value.Check(schema, { action: 'query', language: 'sparql', query: 'SELECT * WHERE { ?s ?p ?o }' }), true);
  assert.equal(Value.Check(schema, { action: 'probe', language: 'dql', queries: ['type:Person'] }), true);
  assert.equal(Value.Check(schema, { action: 'probe', language: 'sparql', queries: ['SELECT * WHERE { ?s ?p ?o }'] }), true);
  assert.equal(Value.Check(schema, { action: 'schema', language: 'dql', view: 'types' }), true);
  assert.equal(Value.Check(schema, { action: 'schema', language: 'sparql', view: 'describe', name: 'Person' }), true);
});

test('graph schema rejects sparql pagination and view selector misuse', () => {
  const schema = buildGraphParameters();
  assert.equal(Value.Check(schema, { action: 'query', language: 'sparql', query: 'SELECT * WHERE { ?s ?p ?o }', pageSize: 10 }), false);
  assert.equal(Value.Check(schema, { action: 'query', language: 'sparql', query: 'SELECT * WHERE { ?s ?p ?o }', cursor: 'x' }), false);
  assert.equal(Value.Check(schema, { action: 'query', language: 'dql', query: 'type:Person', pageSize: 101 }), false);
  assert.equal(Value.Check(schema, { action: 'query', language: 'dql', query: 'type:Person', pageSize: 1.5 }), false);
  assert.equal(Value.Check(schema, { action: 'schema', language: 'sparql', view: 'describe', name: 'x'.repeat(2001) }), false);
  assert.equal(Value.Check(schema, { action: 'query', language: 'dql', query: '' }), false);
  assert.equal(Value.Check(schema, { action: 'probe', language: 'dql', queries: [] }), false);
  assert.equal(Value.Check(schema, { action: 'schema', language: 'dql', view: 'types', name: 'Person' }), false);
  assert.equal(Value.Check(schema, { action: 'schema', language: 'dql', view: 'search' }), false);
  assert.equal(Value.Check(schema, { action: 'schema', language: 'dql', view: 'describe' }), false);
  assert.equal(Value.Check(schema, { action: 'schema', language: 'dql', view: 'fields', query: 'x' }), false);
  assert.equal(Value.Check(schema, { action: 'schema', language: 'graphql', view: 'types' }), false);
  assert.equal(Value.Check(schema, { action: 'query', language: 'dql', query: 'type:Person', extra: 1 }), false);
});

test('desktop schema accepts all nine contract actions with their fields', () => {
  const schema = buildDesktopParameters();
  assert.equal(Value.Check(schema, { action: 'status' }), true);
  assert.equal(Value.Check(schema, { action: 'list_apps', timeoutMs: 5000 }), true);
  assert.equal(Value.Check(schema, { action: 'list_windows' }), true);
  assert.equal(Value.Check(schema, { action: 'observe_window', pid: 123, windowId: 'w1' }), true);
  assert.equal(Value.Check(schema, { action: 'observe_window', pid: 123, windowId: 'w1', includeScreenshot: true }), true);
  assert.equal(Value.Check(schema, { action: 'wait', pid: 123, windowId: 'w1', predicate: { text: 'Save' } }), true);
  assert.equal(Value.Check(schema, { action: 'click', pid: 123, windowId: 'w1', stateId: 's1', x: 10, y: 20 }), true);
  assert.equal(Value.Check(schema, { action: 'type_text', pid: 123, windowId: 'w1', stateId: 's1', text: 'hello' }), true);
  assert.equal(Value.Check(schema, { action: 'press_key', pid: 123, windowId: 'w1', stateId: 's1', key: 'Enter' }), true);
  assert.equal(Value.Check(schema, { action: 'scroll', pid: 123, windowId: 'w1', stateId: 's1', deltaY: -100 }), true);
});

test('desktop schema enforces per-action required fields and rejects extras', () => {
  const schema = buildDesktopParameters();
  assert.equal(Value.Check(schema, { action: 'observe_window', pid: 123 }), false);
  assert.equal(Value.Check(schema, { action: 'click', pid: 123, windowId: 'w1' }), false);
  assert.equal(Value.Check(schema, { action: 'type_text', pid: 123, windowId: 'w1', stateId: 's1' }), false);
  assert.equal(Value.Check(schema, { action: 'press_key', pid: 123, windowId: 'w1', stateId: 's1' }), false);
  assert.equal(Value.Check(schema, { action: 'status', pid: 123 }), false);
  assert.equal(Value.Check(schema, { action: 'click', pid: 123, windowId: 'w1', stateId: 's1', text: 'nope' }), false);
  assert.equal(Value.Check(schema, { action: 'observe_window', pid: 123, windowId: 'w1', stateId: 's1' }), false);
  assert.equal(Value.Check(schema, { action: 'click', pid: 123, windowId: 'w1', stateId: 's1', bogus: 1 }), false);
  assert.equal(Value.Check(schema, { action: 'click', pid: -5, windowId: 'w1', stateId: 's1' }), false);
  assert.equal(Value.Check(schema, { action: 'click', pid: 123, windowId: 'w1', stateId: 's'.repeat(201) }), false);
  assert.equal(Value.Check(schema, { action: 'type_text', pid: 123, windowId: 'w1', stateId: 's1', text: '' }), false);
  assert.equal(Value.Check(schema, { action: 'click', pid: 123, windowId: 'w1', stateId: 's1', timeoutMs: 60001 }), false);
  assert.equal(Value.Check(schema, { action: 'click', pid: 123, windowId: 'w1', stateId: 's1', x: 100001 }), false);
  assert.equal(Value.Check(schema, {}), false);
});

test('social schema accepts canonical platform/action selectors and url derivation', () => {
  const schema = buildSocialParameters();
  assert.equal(Value.Check(schema, { platform: 'twitter', action: 'search', query: 'pi agent' }), true);
  assert.equal(Value.Check(schema, { platform: 'twitter', action: 'get_post', postId: '123' }), true);
  assert.equal(Value.Check(schema, { platform: 'twitter', action: 'get_post', url: 'https://x.com/user/status/123' }), true);
  assert.equal(Value.Check(schema, { platform: 'reddit', action: 'get_community', community: 'rust' }), true);
  assert.equal(Value.Check(schema, { platform: 'v2ex', action: 'get_topic', topic: '12345' }), true);
  assert.equal(Value.Check(schema, { platform: 'twitter', action: 'get_feed' }), true);
  assert.equal(Value.Check(schema, { platform: 'twitter', action: 'search', query: 'x', limit: 100 }), true);
});

test('social schema rejects missing selectors, cross-action fields, and overflow', () => {
  const schema = buildSocialParameters();
  assert.equal(Value.Check(schema, { platform: 'twitter', action: 'search' }), false);
  assert.equal(Value.Check(schema, { platform: 'twitter', action: 'get_post' }), false);
  assert.equal(Value.Check(schema, { platform: 'twitter', action: 'get_profile' }), false);
  assert.equal(Value.Check(schema, { platform: 'twitter', action: 'get_profile', url: 'https://x.com/ada' }), true);
  assert.equal(Value.Check(schema, { platform: 'twitter', action: 'search', query: 'x', topic: 't' }), false);
  assert.equal(Value.Check(schema, { platform: 'twitter', action: 'get_comment_replies', postId: '1' }), false);
  assert.equal(Value.Check(schema, { platform: 'twitter', action: 'search', query: 'x', limit: 101 }), false);
  assert.equal(Value.Check(schema, { platform: 'twitter', action: 'search', query: 'x', limit: 0 }), false);
  assert.equal(Value.Check(schema, { platform: 'twitter', action: 'search', query: 'x', limit: 1.5 }), false);
  assert.equal(Value.Check(schema, { platform: 'twitter', action: 'nope', query: 'x' }), false);
  assert.equal(Value.Check(schema, { platform: 'tumblr', action: 'search', query: 'x' }), false);
  assert.equal(Value.Check(schema, { platform: 'twitter', action: 'search', query: 'x', bogus: 1 }), false);
});

test('social schema advertises aux fields only where honored, with closed vocabularies', () => {
  const schema = buildSocialParameters();
  // Honored fields with valid values pass.
  assert.equal(Value.Check(schema, { platform: 'twitter', action: 'search', query: 'x', sort: 'latest' }), true);
  assert.equal(Value.Check(schema, { platform: 'twitter', action: 'search', query: 'x', timeRange: '2026-01-01' }), true);
  assert.equal(Value.Check(schema, { platform: 'twitter', action: 'get_feed', feedVariant: 'following' }), true);
  assert.equal(Value.Check(schema, { platform: 'reddit', action: 'search', query: 'x', sort: 'comments', timeRange: 'week' }), true);
  assert.equal(Value.Check(schema, { platform: 'reddit', action: 'get_thread', postId: 'a', includeReplies: false }), true);
  assert.equal(Value.Check(schema, { platform: 'reddit', action: 'get_community_posts', community: 'rust', sort: 'rising' }), true);
  // Out-of-vocab values reject at the schema.
  assert.equal(Value.Check(schema, { platform: 'twitter', action: 'search', query: 'x', sort: 'bogus' }), false);
  assert.equal(Value.Check(schema, { platform: 'twitter', action: 'search', query: 'x', timeRange: 'last week' }), false);
  assert.equal(Value.Check(schema, { platform: 'reddit', action: 'search', query: 'x', sort: 'bogus' }), false);
  assert.equal(Value.Check(schema, { platform: 'reddit', action: 'get_community_posts', community: 'rust', sort: 'best' }), false);
  assert.equal(Value.Check(schema, { platform: 'twitter', action: 'get_feed', feedVariant: 'top' }), false);
  // Unhonored fields are not advertised per action.
  assert.equal(Value.Check(schema, { platform: 'twitter', action: 'get_profile', user: 'ada', sort: 'top' }), false);
  assert.equal(Value.Check(schema, { platform: 'reddit', action: 'get_post', postId: 'a', sort: 'hot' }), false);
  assert.equal(Value.Check(schema, { platform: 'v2ex', action: 'get_topic', topic: '1', sort: 'hot' }), false);
  assert.equal(Value.Check(schema, { platform: 'facebook', action: 'get_feed', feedVariant: 'top' }), false);
  assert.equal(Value.Check(schema, { platform: 'reddit', action: 'get_thread', postId: 'a', includeReplies: 'yes' }), false);
});

test('browser semanticAction accepts closed locators/verbs with nth-index and fill-value rules', () => {
  const schema = buildBrowserParameters();
  assert.equal(Value.Check(schema, { action: 'semanticAction', semanticAction: { locator: 'role', query: 'Sign in', verb: 'click' } }), true);
  assert.equal(Value.Check(schema, { action: 'semanticAction', semanticAction: { locator: 'nth', query: 'item', index: 2, verb: 'click' } }), true);
  assert.equal(Value.Check(schema, { action: 'semanticAction', semanticAction: { locator: 'textbox', query: 'x', verb: 'click' } }), false);
  assert.equal(Value.Check(schema, { action: 'semanticAction', semanticAction: { locator: 'role', query: 'Name', verb: 'fill', value: 'Ada' } }), true);
  assert.equal(Value.Check(schema, { action: 'semanticAction', semanticAction: { locator: 'role', query: 'Name', verb: 'click', value: 'Ada' } }), false);
  assert.equal(Value.Check(schema, { action: 'semanticAction', semanticAction: { locator: 'role', query: 'Name', verb: 'fill' } }), false);
  assert.equal(Value.Check(schema, { action: 'semanticAction', semanticAction: { locator: 'text', query: 'x', index: 0, verb: 'click' } }), false);
  assert.equal(Value.Check(schema, { action: 'semanticAction', semanticAction: { locator: 'nth', query: 'x', verb: 'click' } }), false);
  assert.equal(Value.Check(schema, { action: 'semanticAction', semanticAction: { locator: 'role', query: 'x', verb: 'click', name: 'button' } }), true);
  assert.equal(Value.Check(schema, { action: 'semanticAction', semanticAction: { locator: 'text', query: 'x', verb: 'click', name: 'button' } }), false);
  assert.equal(Value.Check(schema, { action: 'semanticAction', semanticAction: { locator: 'role', query: 'x', verb: 'type' } }), false);
  assert.equal(Value.Check(schema, { action: 'semanticAction', semanticAction: { locator: 'role', query: '', verb: 'click' } }), false);
});

test('README tool examples validate against registered schemas (no drift)', () => {
  // github requires the request envelope; the flat form crashes execute.
  const github = buildGithubParameters();
  assert.equal(Value.Check(github, { request: { action: 'releases', repository: 'owner/repo' } }), true);
  assert.equal(Value.Check(github, { action: 'releases', repository: 'owner/repo' }), false);
  // fetch read-query examples route via the 5-branch union (no mode/source).
  // Single url+query enters the canonical fetch dispatcher (singular ranking
  // branch), never the removed agentic_browse native symbol.
  const readQuery = buildFetchRoute({ url: 'https://example.com', query: 'pricing tiers' });
  assert.equal(readQuery.tool, 'fetch');
  const multiQuery = buildFetchRoute({ urls: ['https://example.com'], query: 'How does React concurrent rendering work?' });
  assert.equal(multiQuery.tool, 'fetch');
  assert.throws(() => buildFetchRoute({ mode: 'crawl', query: 'pricing tiers' } as never));
  // graph stays flat (no envelope); pin the README forms.
  const graph = buildGraphParameters();
  assert.equal(Value.Check(graph, { action: 'query', language: 'dql', query: 'type:Organization name:"Acme"' }), true);
  assert.equal(Value.Check(graph, { action: 'schema', language: 'dql', view: 'types' }), true);
});

test('browser parameters keep bounded action branches and reject unknown fields', () => {
  const schema = buildBrowserParameters();
  assert.equal(Value.Check(schema, { action: 'navigate', url: 'https://example.com' }), true);
  assert.equal(Value.Check(schema, { action: 'click', selector: '#ok' }), true);
  assert.equal(Value.Check(schema, { action: 'wait', waitMs: 120000 }), true);
  assert.equal(Value.Check(schema, { action: 'wait', waitMs: 120001 }), false);
  assert.equal(Value.Check(schema, { action: 'batch', batch: { commands: [{ args: ['open', 'https://example.com'] }] } }), true);
  assert.equal(Value.Check(schema, { action: 'batch', batch: { commands: [] } }), false);
  assert.equal(Value.Check(schema, { action: 'navigate' }), false);
  assert.equal(Value.Check(schema, { action: 'navigate', url: 'https://example.com', bogus: 1 }), false);
  assert.equal(Value.Check(schema, { action: 'dance' }), false);
});

test('web_search research branches drop includeContent/recency/domains (no silent drop)', () => {
  const schema = buildWebSearchParameters();
  // Plain branches keep the filters.
  assert.equal(Value.Check(schema, { query: 'a', includeContent: true }), true);
  assert.equal(Value.Check(schema, { query: 'a', recency: 'week' }), true);
  assert.equal(Value.Check(schema, { query: 'a', domains: ['example.com'] }), true);
  // Research branches reject them: route/backend take query/source/limit/yearFrom/cursor only.
  assert.equal(Value.Check(schema, { query: 'a', category: 'research', includeContent: true }), false);
  assert.equal(Value.Check(schema, { query: 'a', category: 'research', recency: 'week' }), false);
  assert.equal(Value.Check(schema, { query: 'a', category: 'research', domains: ['example.com'] }), false);
  assert.equal(Value.Check(schema, { queries: ['a'], category: 'research', includeContent: true }), false);
  assert.equal(Value.Check(schema, { query: 'a', category: 'research', source: 'arxiv', cursor: 'opaque', recency: 'week' }), false);
  // yearFrom stays honored everywhere.
  assert.equal(Value.Check(schema, { query: 'a', category: 'research', yearFrom: 2020 }), true);
});

test('graph schema sparql-only filter accepts sparql and rejects dql branches', () => {
  const schema = buildGraphParameters(['sparql']);
  assert.equal(Value.Check(schema, { action: 'query', language: 'sparql', query: 'SELECT * WHERE { ?s ?p ?o }' }), true);
  assert.equal(Value.Check(schema, { action: 'probe', language: 'sparql', queries: ['SELECT * WHERE { ?s ?p ?o }'] }), true);
  assert.equal(Value.Check(schema, { action: 'schema', language: 'sparql', view: 'types' }), true);
  assert.equal(Value.Check(schema, { action: 'query', language: 'dql', query: 'type:Person' }), false);
  assert.equal(Value.Check(schema, { action: 'probe', language: 'dql', queries: ['type:Person'] }), false);
  assert.equal(Value.Check(schema, { action: 'schema', language: 'dql', view: 'types' }), false);
});

test('graph schema dql-only filter accepts dql and rejects sparql branches', () => {
  const schema = buildGraphParameters(['dql']);
  assert.equal(Value.Check(schema, { action: 'query', language: 'dql', query: 'type:Person' }), true);
  assert.equal(Value.Check(schema, { action: 'probe', language: 'dql', queries: ['type:Person'] }), true);
  assert.equal(Value.Check(schema, { action: 'schema', language: 'dql', view: 'types' }), true);
  assert.equal(Value.Check(schema, { action: 'query', language: 'sparql', query: 'SELECT * WHERE { ?s ?p ?o }' }), false);
  assert.equal(Value.Check(schema, { action: 'probe', language: 'sparql', queries: ['SELECT * WHERE { ?s ?p ?o }'] }), false);
  assert.equal(Value.Check(schema, { action: 'schema', language: 'sparql', view: 'types' }), false);
});

test('web_search route rejects research + includeContent/recency/domains loudly', async () => {
  const { buildSearchRoute } = await import('../src/web/web-search-route.js');
  assert.throws(() => buildSearchRoute({ query: 'a', category: 'research', includeContent: true } as never), /includeContent/);
  assert.throws(() => buildSearchRoute({ query: 'a', category: 'research', recency: 'week' } as never), /recency/);
  assert.throws(() => buildSearchRoute({ query: 'a', category: 'research', domains: ['example.com'] } as never), /domains/);
  // Plain search still routes with the filters.
  const routed = buildSearchRoute({ query: 'a', includeContent: true, recency: 'week', domains: ['example.com'] });
  assert.equal(routed.tool, 'web_search');
});

test('kg schema pins search language dql with integer limit bounds', () => {
  const schema = buildKgParameters();
  assert.equal(Value.Check(schema, { action: 'search', query: 'type:Person', language: 'dql' }), true);
  assert.equal(Value.Check(schema, { action: 'search', query: 'type:Person', language: 'dql', limit: 10 }), true);
  assert.equal(Value.Check(schema, { action: 'search', query: 'type:Person', language: 'dql', limit: 10, providers: ['diffbot'], maxProviders: 2 }), true);
  assert.equal(Value.Check(schema, { action: 'search', query: 'type:Person' }), false);
  assert.equal(Value.Check(schema, { action: 'search', query: 'type:Person', language: 'sparql' }), false);
  assert.equal(Value.Check(schema, { action: 'search', query: 'type:Person', language: 'dql', limit: 0 }), false);
  assert.equal(Value.Check(schema, { action: 'search', query: 'type:Person', language: 'dql', limit: 51 }), false);
  assert.equal(Value.Check(schema, { action: 'search', query: 'type:Person', language: 'dql', limit: 2.5 }), false);
  assert.equal(Value.Check(schema, { action: 'search', query: '', language: 'dql' }), false);
  assert.equal(Value.Check(schema, { action: 'search', query: 'type:Person', language: 'dql', nativeOptions: {} }), false);
});

test('kg schema requires enhance type with selector and Person-only fields', () => {
  const schema = buildKgParameters();
  assert.equal(Value.Check(schema, { action: 'enhance', type: 'Person', name: 'Ada Lovelace' }), true);
  assert.equal(Value.Check(schema, { action: 'enhance', type: 'Person', employer: 'Analytical Engines' }), true);
  assert.equal(
    Value.Check(schema, { action: 'enhance', type: 'Person', name: 'Ada', fields: 'professional', maxEntities: 5, includeRelationships: true, includeEvidence: false, confidenceThreshold: 0.8 }),
    true,
  );
  assert.equal(Value.Check(schema, { action: 'enhance', type: 'Organization', name: 'Analytical Engines' }), true);
  assert.equal(Value.Check(schema, { action: 'enhance', name: 'Ada' }), false);
  assert.equal(Value.Check(schema, { action: 'enhance', type: 'Person' }), false);
  assert.equal(Value.Check(schema, { action: 'enhance', type: 'person', name: 'Ada' }), false);
  assert.equal(Value.Check(schema, { action: 'enhance', type: 'Organization', employer: 'Analytical Engines' }), false);
  assert.equal(Value.Check(schema, { action: 'enhance', type: 'Organization', title: 'CEO', name: 'Ada' }), false);
  assert.equal(Value.Check(schema, { action: 'enhance', type: 'Organization', school: 'MIT', name: 'Ada' }), false);
  assert.equal(Value.Check(schema, { action: 'enhance', type: 'Person', name: 'Ada', maxEntities: 0 }), false);
  assert.equal(Value.Check(schema, { action: 'enhance', type: 'Person', name: 'Ada', maxEntities: 11 }), false);
  assert.equal(Value.Check(schema, { action: 'enhance', type: 'Person', name: 'Ada', maxEntities: 2.5 }), false);
  assert.equal(Value.Check(schema, { action: 'enhance', type: 'Person', name: 'Ada', confidenceThreshold: 1.5 }), false);
  assert.equal(Value.Check(schema, { action: 'enhance', type: 'Person', name: 'Ada', fields: 'native' }), false);
});

test('kg schema bounds analyze_text length with ISO-ish language', () => {
  const schema = buildKgParameters();
  assert.equal(Value.Check(schema, { action: 'analyze_text', text: 'Ada built the first program.' }), true);
  assert.equal(
    Value.Check(schema, { action: 'analyze_text', text: 'Ada built it.', language: 'en', extractEntities: true, extractFacts: true, extractSentiment: false, extractTopics: true }),
    true,
  );
  assert.equal(Value.Check(schema, { action: 'analyze_text', text: 'x', language: 'auto' }), true);
  assert.equal(Value.Check(schema, { action: 'analyze_text', text: '' }), false);
  assert.equal(Value.Check(schema, { action: 'analyze_text', text: 'x'.repeat(100_001) }), false);
  assert.equal(Value.Check(schema, { action: 'analyze_text', text: 'x', language: 'english' }), false);
  assert.equal(Value.Check(schema, { action: 'analyze_text', text: 'x', language: 'EN' }), false);
  assert.equal(Value.Check(schema, { action: 'analyze_text', text: 'x', extractEntities: 'yes' }), false);
});

test('kg schema-accepted requests pass runtime validators (no drift)', () => {
  assert.equal(validateKgSearch({ query: 'type:Person', language: 'dql', limit: 10 }).ok, true);
  assert.equal(validateKgEnhance({ type: 'Person', name: 'Ada', fields: 'professional', maxEntities: 5, confidenceThreshold: 0.8 }).ok, true);
  assert.equal(validateKgEnhance({ type: 'Organization', name: 'Analytical Engines' }).ok, true);
  assert.equal(validateKgNlp({ text: 'Ada built it.', language: 'en', extractEntities: true }).ok, true);
  // Runtime still distrusts schema: blank query passes schema minLength but fails validation.
  assert.equal(validateKgSearch({ query: ' ', language: 'dql' }).ok, false);
});
