# Strict Contracts, Search Ledger, and Portable Graph Adapters Implementation Plan

> **For agentic workers:** Implement task-by-task. Each worker owns only listed files. Stop and contact supervisor before crossing ownership boundaries.

**Goal:** Make public tool schemas match runtime contracts, suppress repeated search work, prove graph portability with a secure SPARQL adapter, and enforce nine-tool surface budget.

**Approach:** Keep model-facing tool names unchanged. Generate strict schemas from contract vocabulary, add session-memory search-attempt state at long-lived extension layer, then extract provider-native graph adapter seam before adding SPARQL. Use no universal query AST and add no dependency.

**Riskiest assumption:** SPARQL query/probe/schema can share graph envelope while pagination and native syntax remain adapter-specific.

## Decisions approved

- SPARQL endpoint is operator-configured with optional bearer token.
- SPARQL query supports SELECT/ASK only; SERVICE and update forms reject before dispatch.
- DQL keeps opaque pagination. SPARQL v1 returns one bounded response without cursor.
- Search ledger is memory-only, bounded, abort-safe, and blocks repeated failures after bounded retries.
- Browser schema uses Northstar runtime vocabulary: ten locators and five verbs.
- Web reject-on-overflow and social clamp-on-overflow remain unchanged.
- Public surface budget is nine tools; future domains require profiles or retrieval/describe redesign.
- Workers run sequentially with exclusive file ownership. Shared integration files are reserved for integration workers.

## Global constraints

- No new dependency.
- No new public tool.
- Runtime validation remains defense-in-depth.
- Existing DQL cursors remain valid.
- `kg` stays Diffbot-only.
- No provider query language translation and no universal graph AST.
- No secret, endpoint credential, raw upstream error, or query result persisted by ledger.
- Operator SPARQL endpoint may be loopback; URL remains env-only and redirects reject.
- Tests precede behavior changes where harness permits.
- No commits, merges, pushes, or destructive git operations.

## Task 1: Public schema builder

**Outcome:** Strict reusable TypeBox schemas exist without changing registration yet.

**Files:**
- Create: `src/public-tool-schemas.ts`
- Create: `test/public-tool-schemas.test.ts`

**Interfaces:**
- Produces builders for web_search, social, desktop, graph, and browser parameters.
- Consumes exported contract enums, bounds, and selector specs.

**Checks:**
- Red/green: `node --import tsx --test test/public-tool-schemas.test.ts`
- Type: `npm run typecheck`

## Task 2: Browser semantic runtime parity

**Outcome:** Runtime rejects fields disallowed by strict semanticAction schema.

**Files:**
- Modify: `src/browser/browser-policy.ts`
- Create: `test/browser/browser-semantic-contract.test.ts`

**Checks:**
- `node --import tsx --test test/browser/browser-semantic-contract.test.ts test/browser/browser-policy.test.ts test/browser/agent-browser.test.ts`

## Task 3: Desktop action runtime parity

**Outcome:** Runtime enforces action-specific target and payload requirements represented by public schema.

**Files:**
- Modify: `src/desktop/desktop-contract.ts`
- Modify: `src/desktop/desktop-policy.ts`
- Create: `test/desktop/desktop-action-contract.test.ts`

**Checks:**
- `node --import tsx --test test/desktop/desktop-action-contract.test.ts test/desktop/desktop-contract.test.ts test/desktop/desktop-policy.test.ts test/desktop/desktop-tools.test.ts`

## Task 4: Search-attempt ledger core

**Outcome:** Pure bounded state machine coalesces in-flight requests, suppresses completed near-duplicates, and blocks repeated failures without storing result bodies.

**Files:**
- Create: `src/web/web-search-ledger.ts`
- Create: `test/web/web-search-ledger.test.ts`

**Checks:**
- `node --import tsx --test test/web/web-search-ledger.test.ts`

## Task 5: Graph contract widening

**Outcome:** Graph contract recognizes dql and sparql while preserving v1 envelope and DQL cursor compatibility.

**Files:**
- Modify: `src/graph/graph-contract.ts`
- Create: `test/graph/graph-language-contract.test.ts`

**Checks:**
- `node --import tsx --test test/graph/graph-language-contract.test.ts test/graph/graph-contract.test.ts`

## Task 6: Graph adapter types and Diffbot wrapper

**Outcome:** Provider-neutral orchestration interface exists; Diffbot implementation conforms without changing public dispatch.

**Files:**
- Create: `src/graph/graph-adapter.ts`
- Create: `src/diffbot/diffbot-graph-adapter.ts`
- Create: `test/diffbot/diffbot-graph-adapter.test.ts`

**Checks:**
- `node --import tsx --test test/diffbot/diffbot-graph-adapter.test.ts test/diffbot/diffbot-graph.test.ts`

## Task 7: SPARQL transport

**Outcome:** Bounded operator-owned HTTP transport handles optional bearer auth, rejects redirects, and redacts secrets.

**Files:**
- Create: `src/sparql/sparql-transport.ts`
- Create: `test/sparql/sparql-transport.test.ts`

**Checks:**
- `node --import tsx --test test/sparql/sparql-transport.test.ts`

## Task 8: SPARQL graph adapter

**Outcome:** SELECT/ASK query, SELECT cardinality probe, and four schema views implement GraphAdapter without query translation.

**Files:**
- Create: `src/sparql/sparql-graph.ts`
- Create: `test/sparql/sparql-graph.test.ts`

**Checks:**
- `node --import tsx --test test/sparql/sparql-graph.test.ts`

## Task 9: Configuration wiring

**Outcome:** SPARQL env reaches native/legacy backends and provider status without leaking secrets.

**Files:**
- Modify: `src/setup/local-config.ts`
- Modify: `src/setup/providers.ts`
- Modify: `src/cli/cli-backend.ts`
- Modify: `src/process/mcp-client.ts`
- Create: `test/setup/sparql-config.test.ts`

**Checks:**
- `node --import tsx --test test/setup/sparql-config.test.ts test/setup/local-config.test.ts test/setup/providers.test.ts test/cli/cli-backend.test.ts test/process/mcp-client.test.ts`

## Task 10: Public integration

**Outcome:** Strict schemas, ledger, adapter registry, independent graph/kg gating, and max-nine registration operate through extension.

**Files:**
- Modify: `src/index.ts`
- Modify: `src/graph/graph-tools.ts`
- Modify: `src/capabilities.ts`
- Modify: `test/index.test.ts`
- Modify: `test/index-integration.test.ts`
- Modify: `test/contract.test.ts`
- Modify: `test/graph/graph-tools.test.ts`
- Modify: `test/graph/graph-contract.test.ts`
- Create: `test/web/web-search-ledger-integration.test.ts`

**Checks:**
- `node --import tsx --test test/index.test.ts test/index-integration.test.ts test/contract.test.ts test/graph/graph-tools.test.ts test/web/web-search-ledger-integration.test.ts`
- `npm run typecheck`

## Task 11: Documentation

**Outcome:** Architecture, configuration, reference provenance, security boundaries, and surface-budget decision are durable.

**Files:**
- Create: `docs/adr/0006-strict-tool-contracts-and-portable-graph-adapters.md`
- Modify: `README.md`
- Modify: `.env.example`
- Modify: `AGENTS.md`

**Checks:**
- Cross-check documented commands and names with source.
- `grep`/read verification for stale paths and tool count.

## Task 12: CodeScene gate, review loop, and final gates

After Task 11, run CodeScene gate from installed truth (`cs version`, `cs delta main --output-format json --include-metadata --error-on-warnings`). Confirm flags with installed help; treat non-zero as failure, retain report without secrets. Dispatch narrow fix workers for confirmed complexity/health findings (exclusive files each). Then run three fresh read-only reviewers: contract correctness, SPARQL security, architecture/simplicity. Parent verifies every finding. One narrow fix worker applies accepted findings. Repeat review up to three rounds.

Final checks:

```bash
npm test
npm run typecheck
git diff --check
npm pack --dry-run
```
