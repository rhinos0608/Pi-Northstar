# Native Graph Access Implementation Plan

> **For agentic workers:** Implement task-by-task in order. Use test-first development for behavior. Do not commit. Preserve pre-existing worktree changes. Approved design: `docs/plans/2026-09-11-native-graph-design.md`.

**Goal:** Add one read-only `graph` tool with native-language query, countable-query probe, and ontology/schema discovery while preserving provider-faithful results and leaving portable `kg` unchanged.

**Approach:** Introduce a strict graph contract and cursor codec, a Diffbot graph adapter over existing secure transport, a small graph orchestration module, and additive registration/capability/docs wiring. No new dependency, provider input, provider-branded tool, export, crawl, Ask, or hidden composition.

**Riskiest assumption:** Diffbot DQL and ontology responses expose stable structural markers sufficient to classify result shape and map ontology data without query-text inference. Adapter fixture tests must fail closed to `object` or typed errors when markers differ.

## Decisions to review

All product decisions are approved in `docs/plans/2026-09-11-native-graph-design.md`:

- Public shell is `graph`; actions are `query`, `probe`, `schema`.
- `language: 'dql'` is required; provider is internal and output-only provenance.
- Query result is provider-faithful JSON plus structural `shape`.
- `pageSize` is transport-page size, not query rewriting.
- Probe accepts countable/entity-returning queries only and preserves per-query failures.
- Schema cache refresh is automatic; no refresh control.
- `kg` and `pi-northstar.knowledge-result` v1 remain untouched.

Late change to any item above changes public contract and requires user approval.

## Known unknowns

1. **Exact ontology payload markers**
   Default: implement against official ontology endpoint and fixtures extracted from authoritative documentation/client behavior. Pivot signal: live/documented payload cannot support typed `types/fields/search/describe`; contain by retaining raw validated ontology internally and returning `contract_invalid_response` rather than guessing.

2. **Aggregate response markers**
   Default: classify only explicit documented aggregate/report markers. Anything ambiguous is `shape: 'object'`. No query parsing.

3. **Rate-limit retry metadata shape**
   Default: expose `retryAfter` only when parsed from a valid numeric response header/status path already available at transport boundary. Missing metadata stays absent.

## Global constraints

- Node `>=24`, TypeScript `5.9`, TypeBox `1.3`; zero new npm dependencies.
- Reuse `src/diffbot-transport.ts`; no alternate HTTP client or host override.
- Public `graph` operation is read-only. No crawl/control-plane calls.
- No provider input, exports, Ask, duplicate fetch/search/NLP, or hidden cross-tool calls.
- Existing `kg` schema, implementation, envelope, and tests remain behaviorally unchanged.
- Upstream response bound remains 1 MB. Recursive JSON bounds: depth 32, 1,000 keys/object, 10,000 items/array.
- Query length max 50,000; query batch max 32; internal probe concurrency max 8; page size 1..100 default 10; cursor max 4,096.
- Token and upstream content never appear in logs or unsafe errors.
- No paid same-provider retries.
- All external text is untrusted-content framed.
- No commit, push, merge, migration, or destructive action.

## File structure

### Create

- `src/graph-contract.ts` — public request/result/error types, runtime validation, bounded `JsonValue`, envelope validation/building, cursor codec/fingerprint.
- `src/diffbot-graph.ts` — Diffbot DQL query/probe/schema adapter and structural shape classification; only module aware of Diffbot graph payload details.
- `src/graph-schema-cache.ts` — validated 24-hour ontology cache, atomic persistence, stale fallback metadata.
- `src/graph-tools.ts` — language-capability routing, action orchestration, text rendering, public `BackendCallResult` assembly.
- `test/graph-contract.test.ts`
- `test/diffbot-graph.test.ts`
- `test/graph-schema-cache.test.ts`
- `test/graph-tools.test.ts`

### Modify

- `src/native-tools.ts` — add thin `graph` dispatch only; no graph logic.
- `src/index.ts` — register `graph` tool using action-discriminated schema and guidance.
- `src/capabilities.ts` — add `graph` public tool/channel and Diffbot graph backends.
- `src/providers.ts` — add `graph` to Diffbot channel membership/description without changing primary channel behavior.
- `src/untrusted-content.ts` — add `graph` to external tool names.
- `test/index.test.ts` — tool schema/description regression tests.
- `test/capabilities.test.ts` — graph capability truth tests.
- `test/native-tools.test.ts` — dispatch boundary test if not fully covered by `graph-tools.test.ts`.
- `test/untrusted-content.test.ts` — graph framing registration.
- `README.md`, `SKILL.md` — graph usage, boundaries, privacy, and agent-controlled research sequence.

---

### Task 1: Lock public graph contract

**Outcome:** Requests and result envelopes have one runtime-validated interpretation before any HTTP implementation exists.

**Files:**
- Create: `src/graph-contract.ts`
- Create: `test/graph-contract.test.ts`

**Interfaces:**
- Produces `GraphRequest`, action-specific validated inputs, `GraphResult`, `GraphError`, `GraphQueryShape`, `JsonValue`, envelope builder/validator, cursor encode/decode/fingerprint helpers.
- Cursor payload binds schema version, action, language, provider, query fingerprint, page size, adapter version, and primitive pagination state.

**Checks:**
- Red signal: `node --import tsx --test test/graph-contract.test.ts` fails because module/contracts do not exist.
- Green signal: focused suite passes valid action variants and rejects unknown keys, cross-action fields, missing schema selectors, bounds violations, malformed results, recursive JSON overflow, hostile cursors, and every cursor-binding mismatch.

- [ ] Define `GRAPH_RESULT_SCHEMA='pi-northstar.graph-result'`, version 1, stable errors, shapes, and action data variants.
- [ ] Validate semantic discriminated union even if registration schema uses JSON Schema `anyOf`.
- [ ] Implement strict `pageSize`, cursor, query, batch, and schema-view validation.
- [ ] Implement bounded recursive `JsonValue` validation without truncation.
- [ ] Implement opaque cursor codec and deterministic request fingerprint.
- [ ] Run focused test and `npm run typecheck`.

---

### Task 2: Implement Diffbot graph adapter and schema cache

**Outcome:** Provider-specific HTTP and ontology behavior is isolated, bounded, abortable, redacted, and fixture-tested.

**Files:**
- Create: `src/diffbot-graph.ts`
- Create: `src/graph-schema-cache.ts`
- Create: `test/diffbot-graph.test.ts`
- Create: `test/graph-schema-cache.test.ts`
- Read/reuse unchanged: `src/diffbot-transport.ts`, `src/http.ts`

**Interfaces:**
- Consumes validated graph inputs and existing `diffbotFetch`.
- Produces adapter outcomes for query/probe/schema; never emits `BackendCallResult` directly.
- Adapter metadata: provider `diffbot`, languages `['dql']`, adapter cursor version 1.

**Checks:**
- Red signal: focused adapter/cache tests fail because no adapter exists.
- Green signal: `node --import tsx --test test/diffbot-graph.test.ts test/graph-schema-cache.test.ts` passes fixture, transport, cache, and boundary cases.

- [ ] Query `POST https://kg.diffbot.com/kg/v3/dql` with body `{type:'query', query, size, from}`; token remains transport-owned and absent from body.
- [ ] Preserve validated provider result under `result`; classify using explicit payload markers only. Ambiguous valid object → `object`.
- [ ] Emit continuation state only for proven row responses; never for facets/aggregate/scalar/object.
- [ ] Probe each validated query with size-zero count semantics using fixed worker pool 8; keep input order and per-query errors; reject known non-countable forms and any response without finite non-negative integer `hits`.
- [ ] Map 401/403, 429, caller abort, malformed response, oversize response, and other transport failures to graph error taxonomy without raw-body/token leakage.
- [ ] Retrieve ontology through fixed Diffbot host/path verified from authoritative source before coding endpoint constant.
- [ ] Store validated cache at `~/.pi-northstar/cache/diffbot-ontology-v1.json`; atomic temp-write + rename; directory/file permissions follow existing local state conventions.
- [ ] Implement 24-hour freshness, stale fallback, malformed-cache rejection, `fetchedAt`, and `stale` semantics.
- [ ] Test redirect rejection through existing transport, 1 MB bound, abort, error-envelope handling, redaction sentinels, rows/facets/aggregate/scalar/object, probe partial failure/order/concurrency, and cache paths.
- [ ] Run focused tests and `npm run typecheck`.

---

### Task 3: Add graph orchestration and cursor flow

**Outcome:** One capability-routed module executes graph actions and returns validated, framed Northstar tool results.

**Files:**
- Create: `src/graph-tools.ts`
- Create: `test/graph-tools.test.ts`

**Interfaces:**
- Consumes raw public args, environment, signal, graph contract, and adapter interface.
- Produces `BackendCallResult` with concise text plus `details.graph: GraphResult`.
- V1 language registry maps `dql` to configured Diffbot adapter; no provider input.

**Checks:**
- Red signal: orchestration test fails because no public graph caller exists.
- Green signal: `node --import tsx --test test/graph-tools.test.ts` passes action routing, auth absence, provenance, pagination, cursor mismatch, partial probe, stale schema, and envelope fail-closed cases.

- [ ] Validate full request before adapter dispatch; invalid input causes zero paid calls.
- [ ] Select configured adapter by language capability. Missing token/requested execution → `auth_required` envelope.
- [ ] Build query/probe/schema data variants and statuses consistently.
- [ ] Bind query cursor to action/language/provider/query/pageSize/adapter version/state; reject all mismatches before HTTP.
- [ ] Render concise action-specific text without flattening provider result into fake entities.
- [ ] Wrap text as untrusted external evidence exactly once under existing hook behavior.
- [ ] Run focused test and `npm run typecheck`.

---

### Task 4: Register public tool and capability truth

**Outcome:** Pi exposes `graph` with discoverable action-specific schema while existing tools remain byte-for-byte contract compatible.

**Files:**
- Modify: `src/native-tools.ts`
- Modify: `src/index.ts`
- Modify: `src/capabilities.ts`
- Modify: `src/providers.ts`
- Modify: `src/untrusted-content.ts`
- Modify: `test/index.test.ts`
- Modify: `test/capabilities.test.ts`
- Modify: `test/native-tools.test.ts` if needed
- Modify: `test/untrusted-content.test.ts`

**Interfaces:**
- `native-tools` delegates `graph` to `graph-tools`; no implementation logic added there.
- Capability registry adds public tool name/channel `graph` with actions query/probe/schema and Diffbot-backed language capability.
- Existing Diffbot `kg` channel remains intact; provider descriptor gains additive graph membership.

**Checks:**
- Red signal: registration tests fail because `graph` is absent.
- Green signal: `node --import tsx --test test/index.test.ts test/capabilities.test.ts test/native-tools.test.ts test/untrusted-content.test.ts` proves schema, dispatch, capability metadata, and framing; existing `kg` assertions remain unchanged.

- [ ] Register `graph` using action-discriminated TypeBox schema when supported by Pi tool registration; preserve same runtime union validation regardless.
- [ ] Tool description states native language, provider-faithful results, probe countability, schema freshness, and no hidden composition.
- [ ] Add `graph` dispatch and external-content classification.
- [ ] Add graph capability without changing existing `diffbot`/`kg` action lists or web-search participation.
- [ ] Assert schema has no `provider`, `workers`, `refresh`, `format`, export, crawl, or Ask fields.
- [ ] Assert existing `kg`, `web_search`, and `fetch` property sets do not change.
- [ ] Run focused test and `npm run typecheck`.

---

### Task 5: Document research boundary and verify whole repository

**Outcome:** Users and agents understand when to use `kg` versus `graph`, with privacy/cost behavior explicit and no SDK/control-plane creep.

**Files:**
- Modify: `README.md`
- Modify: `SKILL.md`

**Interfaces:**
- Documents `kg` as portable entity abstraction.
- Documents `graph` as native-language query/probe/schema capability.
- Documents agent-controlled sequence: graph → web/fetch → specialist evidence → synthesis.

**Checks:**
- Red signal: documentation search finds no `graph` contract or boundaries.
- Green signal: repository checks pass and diff review contains no excluded public surfaces.

- [ ] Add one concise graph section with request examples for query, probe, and schema.
- [ ] State provider selection is internal and provider provenance appears in output.
- [ ] State Diffbot receives DQL/schema requests when configured; no hidden calls, retries, exports, or control-plane operations.
- [ ] Preserve existing Diffbot privacy and spend guidance without duplicating it.
- [ ] Run full verification below.

## Final verification gate

```bash
node --import tsx --test test/graph-contract.test.ts test/diffbot-graph.test.ts test/graph-schema-cache.test.ts test/graph-tools.test.ts
node --import tsx --test test/index.test.ts test/capabilities.test.ts test/native-tools.test.ts test/untrusted-content.test.ts
node --import tsx --test test/knowledge-contract.test.ts test/knowledge-domain.test.ts test/diffbot-kg.test.ts
npm test
npm run typecheck
git diff --check
git status --short
```

Expected success conditions:

- New graph suites pass.
- Existing portable KG suites pass unchanged.
- Full suite and typecheck pass.
- Diff has no whitespace errors.
- No staged files or commits created by implementation.
- Pre-existing user changes remain present and unmodified outside approved files.

## Excluded-surface review

Review changed public schemas/docs for these forbidden additions:

- provider input;
- `diffbot_*` public tool names;
- crawl/job/control operations;
- Ask/chat operations;
- CSV/XLS/XLSX/export controls;
- refresh/workers/cache/quota controls;
- hidden graph-to-retrieval calls;
- changes to existing `kg`, `web_search`, or `fetch` request contracts.

Any hit requires correction or renewed user approval before completion.
