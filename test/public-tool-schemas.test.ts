import assert from 'node:assert/strict';
import { test } from 'node:test';
import Value from 'typebox/value';
import { buildGithubParameters } from '../src/github/github.js';
import { buildFetchRoute } from '../src/index.js';
import { buildBrowserParameters, buildDesktopParameters, buildGraphParameters, buildSocialParameters, buildWebSearchParameters } from '../src/public-tool-schemas.js';

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
  // fetch crawl examples route via the request envelope with mode + source.
  const crawlUrl = buildFetchRoute({ mode: 'crawl', source: { type: 'url', url: 'https://example.com', followLinks: true }, query: 'pricing tiers' });
  assert.equal(crawlUrl.tool, 'semantic_crawl');
  const crawlSearch = buildFetchRoute({ mode: 'crawl', source: { type: 'search', searchQuery: 'React 18 concurrent rendering' }, query: 'How does React concurrent rendering work?' });
  assert.equal(crawlSearch.tool, 'semantic_crawl');
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

test('web_search route rejects research + includeContent/recency/domains loudly', async () => {
  const { buildSearchRoute } = await import('../src/web/web-search-route.js');
  assert.throws(() => buildSearchRoute({ query: 'a', category: 'research', includeContent: true } as never), /includeContent/);
  assert.throws(() => buildSearchRoute({ query: 'a', category: 'research', recency: 'week' } as never), /recency/);
  assert.throws(() => buildSearchRoute({ query: 'a', category: 'research', domains: ['example.com'] } as never), /domains/);
  // Plain search still routes with the filters.
  const routed = buildSearchRoute({ query: 'a', includeContent: true, recency: 'week', domains: ['example.com'] });
  assert.equal(routed.tool, 'web_search');
});
