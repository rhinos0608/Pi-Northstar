# Native Graph Access Design

**Date:** 2026-09-11
**Status:** Approved
**Owner:** Pi

## Goal

Add a capability-shaped `graph` tool that exposes native graph-query power without weakening portable `kg` semantics or publishing provider-branded tools.

## Core decision

> Tool shell portable → query language native → results provider-faithful.

- `kg` remains portable entity search, enhancement, normalization, alignment, and text analysis.
- `graph` becomes native graph escape hatch for query execution, cardinality probes, and schema discovery.
- Query languages remain sovereign. Northstar will not invent a common graph predicate AST.
- Provider selection derives internally from language capability. `provider` is not a v1 input.
- Provider identity remains output provenance.

## Non-goals

- Crawl creation, jobs, watching, pause/restart/delete, or other provider control-plane operations.
- Provider-branded public tools.
- Ask/chat wrappers.
- Duplicate extraction, web-search, enhancement, or NLP tools.
- CSV, XLS, XLSX, or other export surfaces.
- Model-facing concurrency, cache, quota, refresh, or worker controls.
- Hidden graph-to-search or graph-to-browser calls.
- A provider-neutral graph query AST.
- Changes to `kg` requests, routing, cursors, or `pi-northstar.knowledge-result` v1.

## Public tool

One tool named `graph`, represented semantically as a discriminated union:

```ts
type GraphRequest =
  | {
      action: 'query';
      language: 'dql';
      query: string;
      pageSize?: number;
      cursor?: string;
    }
  | {
      action: 'probe';
      language: 'dql';
      queries: string[];
    }
  | {
      action: 'schema';
      language: 'dql';
      view: 'types' | 'fields' | 'search' | 'describe';
      name?: string;
      query?: string;
      includeDeprecated?: boolean;
    };
```

V1 bounds:

- `query`: non-empty, at most 50,000 characters.
- `pageSize`: integer 1..100, default 10.
- `cursor`: opaque base64url, at most 4,096 characters.
- `queries`: 1..32 non-empty strings, each at most 50,000 characters.
- Probe concurrency: fixed internal ceiling 8; not caller-configurable.
- Schema `view=describe` requires `name`; `view=search` requires `query`; other views reject irrelevant selectors.

`pageSize` means maximum top-level result items requested for one provider response page. It never rewrites or augments native query text. Exact item meaning remains query-language/result-shape specific.

## Query semantics

`graph.query` supports full provider-native JSON query results, including rows, facets, aggregates, projections, traversals, and object reports. It deliberately excludes export formats.

Result data:

```ts
interface GraphQueryData {
  kind: 'query';
  shape: 'rows' | 'facets' | 'aggregate' | 'scalar' | 'object';
  result: JsonValue;
}
```

Shape is structural metadata, not normalization:

- `rows`: provider response explicitly contains a row collection.
- `facets`: provider response explicitly marks facet/bucket output.
- `aggregate`: provider response explicitly marks aggregate/report output.
- `scalar`: primary provider result is a JSON primitive.
- `object`: valid result not safely classifiable above.

Classification uses explicit response structure and documented provider markers. It never infers shape from query text. Ambiguity falls back to `object`.

Provider result remains intact inside `result`, subject only to validation and safety bounds. No field renaming, entity normalization, ranking, alignment, or provider reconciliation occurs.

## Probe semantics

`graph.probe` is deliberately narrower than `graph.query`:

> Execute bounded entity/countable queries for validation and cardinality estimation.

Each successful item guarantees a non-negative integer `hits`:

```ts
type GraphProbeItem =
  | { query: string; status: 'ok'; hits: number }
  | { query: string; status: 'error'; error: GraphError };
```

Facets, aggregates, reports, exports, crawl collections, and provider constructs without reliable size-zero cardinality are unsupported. Known unsupported syntax rejects before dispatch where reliable; otherwise missing/invalid count semantics produce a per-item error. One failed query does not discard successful siblings. Output order matches input order. No automatic retries.

## Schema semantics

`graph.schema` supports read-only ontology discovery:

- `types`: list available entity types.
- `fields`: list fields, optionally scoped by `name` when contract allows.
- `search`: search schema names/descriptions using `query`.
- `describe`: describe one named type, enum, taxonomy, composite, or field.

Result data includes epistemic freshness only:

```ts
interface GraphSchemaData {
  kind: 'schema';
  result: GraphSchemaResult;
  meta?: {
    fetchedAt?: string;
    stale?: boolean;
  };
}
```

No caller refresh control exists. Diffbot ontology cache policy:

- Persist validated ontology snapshot under `~/.pi-northstar/cache/` because Northstar CLI dispatch uses a fresh child process per tool call.
- Freshness TTL: 24 hours.
- Fresh cache: return it with `stale: false`.
- Missing/stale cache: transparently attempt network retrieval.
- Stale cache plus retrieval failure: return cached result with `stale: true`, `status: partial`, and safe upstream error.
- No cache plus retrieval failure: return `status: error`.
- Cache writes are atomic; malformed cache is ignored, never trusted.

## Result envelope

```ts
interface GraphResult {
  schema: 'pi-northstar.graph-result';
  version: 1;
  status: 'ok' | 'empty' | 'partial' | 'error';
  language: 'dql';
  source: { provider: string };
  data: GraphQueryData | GraphProbeData | GraphSchemaData;
  pagination?: {
    hasMore: boolean;
    nextCursor?: string;
  };
  errors: GraphError[];
  notes: string[];
}
```

Dynamic `JsonValue` is allowed only under `GraphQueryData.result`. Upstream response remains bounded by existing 1 MB `diffbotFetch`/`safeResponseJson` limit. Recursive validation additionally rejects values exceeding depth 32, 1,000 keys per object, or 10,000 items per array. Oversized results fail as `response_too_large`; no semantic truncation.

Text rendering is concise and action-specific. Full structured envelope remains available in tool details. All external text uses Northstar untrusted-content framing.

## Pagination and cursor invariants

Pagination is emitted only when adapter can prove row continuation semantics. Facet, aggregate, scalar, and opaque object results do not receive cursors.

Opaque cursor binds:

- graph result schema version;
- action;
- language;
- internally selected provider;
- query fingerprint;
- page size;
- adapter cursor version;
- provider pagination state.

Changing any bound request field rejects with `cursor_invalid`. Cursor payload is treated as hostile and every field is validated. Cursor never selects provider.

## Internal capability seam

```ts
interface GraphAdapter {
  readonly provider: string;
  readonly languages: readonly string[];

  query(input: GraphQueryInput, context: GraphContext): Promise<GraphQueryOutcome>;
  probe(input: GraphProbeInput, context: GraphContext): Promise<GraphProbeOutcome>;
  schema(input: GraphSchemaInput, context: GraphContext): Promise<GraphSchemaOutcome>;
}
```

Routing selects a configured adapter supporting requested language. V1 maps `dql` to Diffbot. Future collisions between implementations are handled as language/dialect capability design when real; v1 does not expose `provider` or speculative dialect fields.

Diffbot implementation reuses `src/diffbot-transport.ts`: fixed hosts, token redaction, manual redirect rejection, bounded bodies, timeout, AbortSignal, and HTTP-200 error-envelope detection. `@diffbot/typescript` remains an authoritative semantic reference, not a runtime dependency.

## Error model

Stable graph errors:

- `invalid_input`
- `unsupported_option`
- `auth_required`
- `rate_limited`
- `upstream_error`
- `transport_invalid_response`
- `contract_invalid_response`
- `response_too_large`
- `cursor_invalid`
- `operation_aborted`

Errors contain safe bounded messages, `retryable`, and optional safe `retryAfter`. They never include tokens, request headers, raw upstream bodies, or unredacted sensitive values. HTTP 401/403 map to `auth_required`; 429 maps to `rate_limited`; caller abort maps to `operation_aborted`.

## Agent-controlled composition

Northstar documents, but does not automate:

```text
graph schema/query/probe
  → entity identifiers and structured relationships
  → web_search/fetch for evidence and recency
  → social/media/github/browser for specialist evidence
  → agent synthesis
```

Every external call remains visible and caller-controlled for cost, privacy, and research-depth decisions.

## Compatibility

- `graph` is additive.
- Existing `kg`, `web_search`, `fetch`, social, media, GitHub, and browser schemas stay unchanged.
- Existing knowledge envelope stays version 1.
- No behavior when `DIFFBOT_TOKEN` is absent except explicit `auth_required` from a requested graph call.
- Provider identity appears in provenance only, never as v1 routing input.

## Verification requirements

- Runtime request-union validation and invalid-combination tests.
- Provider-faithful fixtures for rows, facets, aggregates, scalar, and object fallback.
- Probe count invariant, partial failure, ordering, and concurrency ceiling.
- Cursor round-trip and every binding mismatch.
- Schema cache fresh/stale/malformed/atomic-write paths and freshness metadata.
- 1 MB response bound plus recursive JSON depth/key/array bounds.
- Auth, rate-limit, abort, redirect, malformed-response, and redaction tests.
- Tool registration, capability registry, and untrusted-content framing tests.
- Existing `kg` tests unchanged and passing.

## Authoritative references

- Official Pi package: https://github.com/diffbot/diffbot-pi
- Official TypeScript client: https://github.com/diffbot/diffbot-typescript
- DQL API: https://www.diffbot.com/docs/dql/post
- Ontology: https://docs.diffbot.com/docs/ontology
- Existing portable KG design: `docs/plans/2026-09-11-diffbot-kg-design.md`
