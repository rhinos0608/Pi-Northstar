# ADR 0004: Scrapling + BM25 + Embedding + RRF Hybrid Search Integration

## Status

Accepted — 2026-07-16

## Context

Pi-Northstar `fetch` tool (routed through `semanticCrawl` in `src/native-tools.ts`) is named "semantic_crawl" but uses zero semantic techniques. The tool has four critical gaps:

1. **No JS rendering** — `fetchReadablePage()` (line 547) uses plain `fetchText()`, returns empty content on SPA/JS-heavy sites. No stealth/anti-bot headers, no fingerprint spoofing, no Cloudflare bypass.
2. **No real BM25** — `scoreText()` (line 591) is boolean term-inclusion count: `query.toLowerCase().split(/\W+/).filter(Boolean).reduce((score, term) => score + (lower.includes(term) ? 1 : 0), 0)`. This produces inflated scores for long documents containing terms anywhere, not BM25 with TF saturation and IDF weighting.
3. **No semantic search** — despite the tool name and description mentioning "semantically retrieve relevant passages", the pipeline is purely lexical boolean matching.
4. **No stealth/anti-bot** — no proxy rotation, Cloudflare bypass, or user-agent rotation.

Existing architecture that works well and should be reused:
- `src/fusion.ts` — `rrfMerge()` is clean, tested, handles dedup and cross-list score accumulation. Ready for hybrid fusion.
- `src/http.ts` — `validatePublicHttpUrl`, `fetchText`, `stripHtml` work correctly for static pages.
- `src/native-tools.ts` — `semanticCrawl` pipeline structure (URL discovery → page fetch → chunk → score → rank) is sound but each step is naive.

The `.env.example` already has `EMBEDDING_SIDECAR_*` scaffolding (for external OpenAI embeddings), and `src/cli-backend.ts` already forwards these env vars to the CLI subprocess. `src/local-config.ts` maps `embeddingSidecar.*` config keys.

Pi-Northstar has a minimal-dependency philosophy (5 npm deps: pi-ai, mcp-sdk, agent-browser, tsx, typebox). Any solution must respect this.

## Decision

**Add a four-layer hybrid search pipeline behind the existing `fetch` tool with graceful degradation at each layer:**

### Layer 1: BM25 Ranking — Pure TypeScript, zero dependencies

Implement Okapi BM25 from scratch (~200 lines) in `src/bm25.ts`:
- `BM25Index` class: inverted index, IDF computation, term-frequency saturation
- Parameters: `k1=1.5`, `b=0.75` (standard defaults)
- Tokenizer: lowercase, `/\p{L}+|\p{N}+/gu` (Unicode-aware: preserves non-ASCII words and splits on underscore), min length 2, English stopword filter (stopwords list inline, ~150 words, no external file)
- No stemming initially (add later if quality gap proven)
- Replaces `scoreText()` boolean term-inclusion count
- In-memory only; sufficient for typical `semanticCrawl` scope (< 10K chunks)

### Layer 2: Text Chunking — Sentence-boundary-aware

Replace naive 2000-char slicing (`chunkText()` line 585) with sentence-boundary-aware chunking in `src/chunker.ts` (~60 lines):
- Split on sentence boundaries (`.`, `!`, `?`, `\n\n`)
- Configurable chunk size (default 512 tokens ≈ 2048 chars)
- Configurable overlap (default 128 tokens ≈ 512 chars)
- Preserve paragraph boundaries

### Layer 3: Embedding Sidecar — Python FastAPI subprocess

Python HTTP sidecar with sentence-transformers for vector embeddings:
- Package: `sidecar/app.py` (~100 lines) — FastAPI app with `/v1/embeddings` (POST) and `/v1/health` (GET)
- Default model: `all-MiniLM-L6-v2` (384 dimensions, 22MB download, fast CPU inference)
- GPU auto-detection with CPU fallback
- `sidecar/requirements.txt`: `fastapi`, `uvicorn`, `sentence-transformers`

TypeScript side:
- `src/embedding-client.ts` (~80 lines) — HTTP client to sidecar, with health check, retry, timeout
- `src/vector-index.ts` (~70 lines) — In-memory cosine similarity index
- `src/sidecar-manager.ts` (~100 lines) — Python subprocess lifecycle: start, health-poll, stop, auto-restart with exponential backoff

**Alternative considered for Phase 4**: `@huggingface/transformers` npm package (ONNX runtime) would eliminate Python dependency entirely but is slower on CPU and adds a large npm dependency. Keep as optional future path.

### Layer 4: RRF Fusion — Reuse existing

Reuse `src/fusion.ts` `rrfMerge()` directly. Pass two ranked lists:
```ts
rrfMerge([bm25Ranking, vecRanking], { keyFn: chunk => chunk.id })
```
No changes needed to `fusion.ts`.

### Scrapling Python Bridge — Page Fetching

Replace `fetchReadablePage()` with Scrapling Python subprocess bridge in `src/scrapling-bridge.ts` (~200 lines):
- Python subprocess via `child_process.execFile` with inline script or persistent session
- Support three fetcher modes: `Fetcher` (fast HTTP), `DynamicFetcher` (JS rendering), `StealthyFetcher` (Cloudflare bypass + anti-fingerprinting)
- Session reuse: create session object once per `semanticCrawl` call, reuse across fetches
- **Graceful degradation**: when Scrapling unavailable (Python not installed, script fails), fall back to existing `fetchText()` path. Tools always work, just better with Scrapling.

**Why not Docker bridge?** Docker adds 2-5s cold start per invocation plus image management overhead. Subprocess with persistent session avoids this. User installs Scrapling Python package once.

**Why not MCP server?** Scrapling's API surface (Spider, custom `page_action`) is wider than what MCP tool listing exposes. Direct subprocess preserves full API.

**Why not CLI subprocess per fetch?** Persistent session avoids Python import overhead per request (~1-3s saved).

### Integration Point

All changes plug into `semanticCrawl()` in `src/native-tools.ts`:
```
fetch tool (with query)
  → buildFetchRoute() — unchanged
  → semanticCrawl() — enhanced pipeline:
      1. URL discovery: all configured search backends queried in parallel, RRF-fused, deduplicated. Scrapling spider available as supplementary discovery source.
      2. Page fetch: Scrapling bridge (JS rendering + stealth)
         → Fallback: plain fetchText() if Scrapling unavailable
      3. Content extraction: Scrapling get_all_text() or stripHtml()
      4. Chunking: chunkText() → new sentence-boundary-aware chunker
      5. Index:
         a. BM25Index.add(chunkId, chunkText)
         b. EmbeddingClient.embed(chunkText) → VectorIndex.add(chunkId, vector)
      6. Query:
         a. BM25Index.search(query, topK*2) → ranked list A
         b. EmbeddingClient.embed(query) → VectorIndex.search(vector, topK*2) → ranked list B
         c. rrfMerge([A, B]) → fused topK results
```

### Environment Variables

```
PI_SEARCH_SCRAPLING_ENABLED=1          # Enable Scrapling bridge (0 to disable)
PI_SEARCH_SCRAPLING_FETCHER=stealthy   # fetcher|dynamic|stealthy
PI_SEARCH_SCRAPLING_SOLVE_CLOUDFLARE=1 # Auto-solve Cloudflare challenges
PI_SEARCH_SCRAPLING_PROXY=             # Proxy URL for Scrapling
PI_SEARCH_EMBEDDING_ENABLED=1          # Enable embedding sidecar (1 to enable)
PI_SEARCH_EMBEDDING_MODEL=all-MiniLM-L6-v2  # sentence-transformers model name
PI_SEARCH_EMBEDDING_DIMENSIONS=384     # Expected vector dimensions
```

Note: existing `EMBEDDING_SIDECAR_*` vars are for external OpenAI-compatible API (used by GitHub code_search). New vars use `PI_SEARCH_EMBEDDING_*` prefix to avoid collision. The embedding sidecar is a local Python service, not an external API.

## Alternatives Considered

1. **Docker bridge for Scrapling** — rejected. Adds 2-5s cold start per invocation, Docker daemon dependency, image management complexity. Subprocess with persistent session avoids all this.

2. **MCP server for Scrapling** — rejected. MCP tool listing limits API surface (no Spider, no custom `page_action`). Direct subprocess preserves full Python API.

3. **CLI subprocess per fetch (no session reuse)** — rejected. Python import/LiteLoader overhead per request (~1-3s). Persistent session amortizes this.

4. **`@huggingface/transformers` npm package for embeddings** — deferred to optional Phase 4. Eliminates Python dependency but slower CPU inference and adds large npm dependency (~150MB ONNX models). Kept as alternate path.

5. **External embedding API only (OpenAI, etc.)** — rejected for default. Adds API key dependency, latency, and cost. Local `all-MiniLM-L6-v2` is free, fast (22MB model), and private. Users can still use existing `EMBEDDING_SIDECAR_*` for external APIs.

6. **BM25 via npm package (`minisearch`, `flexsearch`, etc.)** — rejected. Adds dependency for ~200 lines of well-understood algorithm. BM25 Okapi is a standard formula with no maintenance burden.

7. **Stemming in BM25 tokenizer** — deferred. Adds complexity for marginal gain. Evaluate after real-world quality data.

## Consequences

### Positive

- True semantic search replaces misleading "semantic_crawl" name
- BM25 provides mathematically sound lexical ranking (TF saturation, IDF weighting)
- JS rendering captures SPA content that currently returns empty
- Stealth/anti-bot bypass enables crawling protected sites
- Zero new npm dependencies for core BM25+chunker (Phase 1 delivers immediate value)
- Graceful degradation at every layer: Scrapling unavailable → fallback fetch; sidecar unavailable → BM25-only
- Reuses proven `rrfMerge` without changes
- Local embedding model is free, private, fast

### Negative

- Python dependency for Scrapling bridge (user must `pip install scrapling`)
- Python dependency for embedding sidecar (user must `pip install fastapi uvicorn sentence-transformers`)
- Sidecar cold start: model download on first run (~22MB) + ~1-3s load time
- Two Python subprocesses to manage (sidecar lifecycle, Scrapling bridge)
- BM25 in-memory only; not suitable for persistent corpus > 100K chunks (out of scope)
- `StealthyFetcher` rate-limited (~3-8 req/s vs `Fetcher` ~20+ req/s)
- Scrapling Python process crash risk requires auto-restart logic

### Risks and Mitigations

| Risk | Mitigation |
|------|-----------|
| Scrapling Python not installed | Check on startup; graceful fallback to `fetchText()` |
| Sidecar port conflict | Use random available port; health check before use |
| BM25 memory for large corpora | In-memory fine for <10K chunks (typical `semanticCrawl` scope) |
| Embedding cold start (~1-3s) | Pre-warm model on sidecar start; keep sidecar alive |
| StealthyFetcher slower (~3-8 req/s) | Use Fetcher for static sites, StealthyFetcher only when needed |
| Python process crash | Auto-restart with exponential backoff; health check before each use |
| Sidecar model download blocks first run | Document pre-download command in README |
| Empty results from JS sites without Scrapling | Already broken today; Scrapling fixes this |

## Rollback

Each layer degrades independently:
- `PI_SEARCH_SCRAPLING_ENABLED=0` — disables Scrapling, falls back to `fetchText()`
- `PI_SEARCH_EMBEDDING_ENABLED=0` — disables semantic search, BM25-only ranking
- Both disabled → behavior identical to current `semanticCrawl` plus improved BM25+chunker

No database migrations, no persistent state, no file format changes. All indexes are ephemeral per-query.

## Verification

- `npm test` — existing test suite must continue passing
- `node --import tsx --test test/bm25.test.ts` — BM25 correctness (TF saturation, IDF, ranking order)
- `node --import tsx --test test/chunker.test.ts` — chunk boundaries, overlap, edge cases
- `node --import tsx --test test/embedding-client.test.ts` — mock sidecar HTTP responses
- `node --import tsx --test test/vector-index.test.ts` — cosine similarity correctness
- `node --import tsx --test test/sidecar-manager.test.ts` — lifecycle, health polling, crash recovery
- `node --import tsx --test test/scrapling-bridge.test.ts` — mock Python subprocess, fallback behavior
- `node --import tsx --test test/fusion.test.ts` — BM25+embedding RRF fusion tests
- `npm run typecheck` — no new type errors
- `npm audit --audit-level=high` — no new vulnerabilities (no new npm deps)
- Manual: `pip install scrapling fastapi uvicorn sentence-transformers` then run `PI_SEARCH_EMBEDDING_ENABLED=1 node --import tsx src/cli.ts call fetch '{"query":"test","url":"https://example.com"}'`

## Approval Checklist

- [ ] BM25 from scratch (zero deps) and sentence-boundary chunker approved
- [ ] Python subprocess for Scrapling bridge (not Docker/MCP) approved
- [ ] Python FastAPI sidecar for embeddings (not ONNX/@huggingface/transformers) approved
- [ ] Graceful degradation at each layer approved
- [ ] `PI_SEARCH_EMBEDDING_*` prefix (not `EMBEDDING_SIDECAR_*`) to avoid collision approved
- [ ] Ephemeral in-memory indexes (no persistence) approved
- [ ] Phase 1 delivery (BM25+chunker, zero risk, immediate value) approved

## References

- Research synthesis: [`../../.pi-subagents/artifacts/synthesis-scrapling-integration.md`](../../.pi-subagents/artifacts/synthesis-scrapling-integration.md)
- Existing `rrfMerge`: [`../../src/fusion.ts`](../../src/fusion.ts)
- Current `semanticCrawl`: [`../../src/native-tools.ts:149-174`](../../src/native-tools.ts)
- Current `scoreText`: [`../../src/native-tools.ts:591-594`](../../src/native-tools.ts)
- Current `chunkText`: [`../../src/native-tools.ts:585-589`](../../src/native-tools.ts)
- Existing env scaffolding: [`../../.env.example`](../../.env.example) — `EMBEDDING_SIDECAR_*` (lines 21-30)
- Existing config mapping: [`../../src/local-config.ts`](../../src/local-config.ts) — `embeddingSidecar.*` (lines 31-35)
- API/Interface spec: [`../specs/scrapling-hybrid-search-spec.md`](../specs/scrapling-hybrid-search-spec.md)
- Implementation plan: [`../plans/scrapling-hybrid-search-plan.md`](../plans/scrapling-hybrid-search-plan.md)
