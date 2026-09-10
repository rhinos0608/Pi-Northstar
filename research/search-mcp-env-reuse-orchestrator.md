# Research: search-mcp Config & Platform Env Patterns — Reuse & Orchestrator Design

> SUPERSEDED (Stage 2): per-platform cookie/token env injection described below was
> removed. Stage 2 social workers run CLI-owned authenticated sessions; twitter-cli
> no longer receives TWITTER_AUTH_TOKEN/TWITTER_CT0 and xhs no longer derives
> XHS_COOKIE. Only genuine Pi cookie-jar consumers (Reddit, Bilibili) derive cookie env.

## Summary

Existing search/platform MCP servers follow a near-universal pattern: credentials as `UPPER_SNAKE_CASE` env vars, optional `config.json` bridge, and no built-in orchestrator — each MCP server is a single-purpose process. This extension's `local-config.ts` already maps an external `config.json` to env vars, mirroring the `search-mcp` CLI's own bridge. A minimal in-house orchestrator should be a **channel-aware router + ordered backend fallback** (already partially implemented in `reach-tools.ts`), not a full multi-process MCP supervisor. The embedding/LLM sidecar and browser CDP/profile configs follow the same env-var patterns as search API keys.

## Findings

### 1. Brave Search MCP Server — Cleanest Ref for Single-Service MCP Config
Brave Search MCP uses `BRAVE_API_KEY` as required env var, plus generic server-config vars (`BRAVE_MCP_TRANSPORT`, `BRAVE_MCP_PORT`, `BRAVE_MCP_LOG_LEVEL`, `BRAVE_MCP_ENABLED_TOOLS`, `BRAVE_MCP_DISABLED_TOOLS`). CLI flags mirror env vars; `dotenv` loads `.env` at module init. Transport defaults to stdio (for Claude Desktop) with optional HTTP/SSE. [Source](https://deepwiki.com/brave/brave-search-mcp-server/8.1-environment-variables)

**Relevance**: Confirms `BRAVE_API_KEY` as the canonical env-var name (already adopted in `local-config.ts:9`). Permissions (enabled/disabled tools) are server-side — this extension should not replicate that filter.

### 2. Tavily MCP — Remote-first, OAuth, Session Attribution
Tavily MCP uses `TAVILY_API_KEY` (or `tv-ly-` prefixed key). Also supports remote MCP URL (`https://mcp.tavily.com/mcp/?tavilyApiKey=...`), OAuth flow for Claude Code, and `DEFAULT_PARAMETERS` env var for default search behavior. Session/user attribution via `X-Session-Id` (auto) and `X-Human-Id` (optional). [Source](https://docs.tavily.com/documentation/mcp)

**Relevance**: `TAVILY_API_KEY` already adopted in `local-config.ts:11`. The remote-MCP pattern and session attribution are not needed — this extension is a local stdio bridge, not a network proxy.

### 3. Exa MCP — Remote-first, Tool Sets, Agent Tools
Exa MCP uses `EXA_API_KEY` and offers remote URL (`https://mcp.exa.ai/mcp`) or local `npx exa-mcp-server` with `EXA_API_KEY` env var. Tool categories: web search (default on), advanced search (opt in), Exa Agent tools (opt in). [Source](https://github.com/exa-labs/exa-mcp-server)

**Relevance**: `EXA_API_KEY` already adopted (`local-config.ts:9`). Exa's tool-set enablement via query params (`?tools=...`) is orthogonal — this extension's approach of per-tool routing is correct.

### 4. Reddit MCP Servers — Standardized Env Vars Across Implementations
Two independent Reddit MCP servers (`reddit-mcp-server` by jordanburke, `mcp-reddit` by adhikasp) both use `REDDIT_CLIENT_ID`, `REDDIT_CLIENT_SECRET`, `REDDIT_USER_AGENT`. [Source 1](https://deepwiki.com/adhikasp/mcp-reddit/7.1-environment-variables), [Source 2](https://github.com/jordanburke/reddit-mcp-server)

**Relevance**: All three Reddit env vars already adopted in `local-config.ts:12-14`. This is the correct, de facto standard naming.

### 5. YouTube MCP / yt-dlp — YOUTUBE_API_KEY Pattern
YouTube MCP servers use `YOUTUBE_API_KEY` for Data API access. This extension uses yt-dlp CLI for subtitle extraction, which requires no API key — only YouTube needs the key for search. Pattern: `YOUTUBE_API_KEY` already in `local-config.ts:15`. [Source](https://space-cadet.github.io/yt-mcp/)

### 6. crawl4ai MCP — Endpoint + Bearer Token
Two crawl4ai MCP implementations (`stgmt/crawl4ai-mcp` and `coleam00/mcp-crawl4ai-rag`) both use `CRAWL4AI_ENDPOINT` / `CRAWL4AI_BASE_URL` + optional `CRAWL4AI_BEARER_TOKEN` / `CRAWL4AI_API_TOKEN`. [Source 1](https://github.com/stgmt/crawl4ai-mcp), [Source 2](https://deepwiki.com/coleam00/mcp-crawl4ai-rag/7.1-environment-variables)

**Relevance**: `CRAWL4AI_BASE_URL` and `CRAWL4AI_API_TOKEN` already adopted (`local-config.ts:21-22`). The endpoint+token pattern is identical across both implementations — confirming the naming as de facto standard.

### 7. deepResearch — Base URL + Model + API Token + Worker Config
Config items: `DEEP_RESEARCH_BASE_URL`, `DEEP_RESEARCH_WORKER_BASE_URL`, `DEEP_RESEARCH_API_TOKEN`, `DEEP_RESEARCH_MODEL`, `DEEP_RESEARCH_WORKER_MODEL`. All adopted in `local-config.ts:23-27`. This is a rich config surface with separate model selection for the main loop vs. worker subtasks. [Source: Inferred from local-config.ts mappings]

**Relevance**: The worker/main split is unique among search platforms. The orchestrator should respect this by allowing per-task model/token overrides.

### 8. Embedding Sidecar — Provider + Base URL + Token + Dimensions + Model
Config items: `EMBEDDING_SIDECAR_PROVIDER`, `EMBEDDING_SIDECAR_BASE_URL`, `EMBEDDING_SIDECAR_API_TOKEN`, `EMBEDDING_SIDECAR_DIMENSIONS`, `EMBEDDING_SIDECAR_CODE_MODEL`. This follows the MCP Context Server pattern of `EMBEDDING_PROVIDER` + per-provider API key + `EMBEDDING_MODEL` + `EMBEDDING_DIM`. [Source: `local-config.ts:28-31`], [Source: MCP Context Server embedding config](https://deepwiki.com/alex-feel/mcp-context-server/7.7-embedding-provider-settings)

**Relevance**: The dimension + separate code model pattern suggests the orchestrator should pass `target_dimensions` when calling embedding APIs, and allow model override per embedding task.

### 9. LLM Proxy — Provider + Token + Base URL
Config items: `SEARCH_LLM_PROVIDER`, `SEARCH_LLM_API_TOKEN`, `SEARCH_LLM_BASE_URL`. This mirrors the embedding sidecar pattern but for LLM inference (used by the `search-mcp` backend for summarization/reranking). [Source: `local-config.ts:33-35`]

**Relevance**: Clear boundary — embedding sidecar is for vectorization, LLM proxy is for inference. The orchestrator should not mix these.

### 10. Browser Profile/CDP Config — Executable Path + Proxy + CDP Endpoint + Profile Dir
Config items: `BROWSER_EXECUTABLE_PATH`, `BROWSER_PROXY_SERVER`, `BROWSER_CDP_ENDPOINT`, `BROWSER_PROFILE_DIR`. This matches the Playwright/CDP MCP server pattern of `CHROME_PATH`, `CHROME_CDP`, `REMOTE_DEBUGGING_PORT`. [Source: `local-config.ts:38-41`], [Source: browser-use-mcp-server](https://deepwiki.com/co-browser/browser-use-mcp-server/2.1-environment-configuration)

**Relevance**: The CDP endpoint + profile dir pattern is used by Playwright MCP and browser-use MCP. The orchestrator must pass these to the `search-mcp` backend for browser-based tasks (crawl4ai/deepResearch with browser).

### 11. Channel-Aware Routing + Ordered Fallback (Existing Pattern in reach-tools.ts)
The `reach-tools.ts` already implements the core orchestrator pattern:
- **Channel definitions** with `family`, `tier`, `backends[]` array (native first, external fallback)
- **Ordered candidate probing** — `runFirstUsable()` tries backends in priority order, skips uninstalled (exit 127), reports fallback chain
- **Backend override** via `{CHANNEL}_BACKEND` or `PI_SEARCH_{CHANNEL}_BACKEND` env vars
- **Per-platform env injection** — `externalEnvironment()` filters allowed env vars per command (e.g., twitter-cli gets `TWITTER_AUTH_TOKEN`/`TWITTER_CT0`, opencli gets `OPENCLI_*`)
- **Hybrid routing** — native endpoints (DuckDuckGo, Wikipedia, arXiv, V2EX API) run in-process; external CLIs (yt-dlp, twitter-cli, opencli, rdt-cli, bili-cli) are spawned as child processes

**Relevance**: This is the existing orchestrator. The gap is that the `search-mcp` backend path (MCP client mode in `backend.ts:20`) bypasses this channel-aware routing entirely — it delegates everything to the external `search-mcp` CLI process.

### 12. Config Bridge Pattern — External JSON → Env Var Mapping
`local-config.ts` reads `~/search-mcp/config.json` and maps nested keys to env vars. This bridges a unified config file to the per-platform env-var convention. The `SEARCH_MCP_CONFIG_PATH` env var overrides the default path. `SEARCH_MCP_FORWARD_ENV_JSON` allows extra env vars to pass through. [Source: `local-config.ts:44-56`, `mcp-client.ts:124-148`]

**Relevance**: This bridge is the single source of truth for config. Any orchestrator should read from the same merged env map, not re-parse config.json independently.

## Sources

### Kept:
- **Brave Search MCP Server Environment Variables** (deepwiki.com) — canonical ref for Brave env vars, transport config, tool permissions. [Source](https://deepwiki.com/brave/brave-search-mcp-server/8.1-environment-variables)
- **Tavily MCP Server Docs** (docs.tavily.com) — remote MCP, OAuth, session attribution patterns. [Source](https://docs.tavily.com/documentation/mcp)
- **Exa MCP Server** (github.com/exa-labs) — tool-set opt-in, remote-first MCP, agent tools. [Source](https://github.com/exa-labs/exa-mcp-server)
- **crawl4ai-mcp** (github.com/stgmt) — CRAWL4AI_ENDPOINT + CRAWL4AI_BEARER_TOKEN pattern. [Source](https://github.com/stgmt/crawl4ai-mcp)
- **mcp-crawl4ai-rag Environment Variables** (deepwiki.com) — full env-var category breakdown. [Source](https://deepwiki.com/coleam00/mcp-crawl4ai-rag/7.1-environment-variables)
- **mcp-reddit Environment Variables** (deepwiki.com) — REDDIT_CLIENT_ID/SECRET/REFRESH_TOKEN standard. [Source](https://deepwiki.com/adhikasp/mcp-reddit/7.1-environment-variables)
- **Reddit MCP Server** (github.com/jordanburke) — full Reddit env var set including auth modes. [Source](https://github.com/jordanburke/reddit-mcp-server)
- **MCP Context Server Embedding Provider Settings** (deepwiki.com) — EMBEDDING_PROVIDER/MODEL/DIM patterns. [Source](https://deepwiki.com/alex-feel/mcp-context-server/7.7-embedding-provider-settings)
- **browser-use-mcp-server Environment Configuration** (deepwiki.com) — CHROME_PATH, CDP, env patterns. [Source](https://deepwiki.com/co-browser/browser-use-mcp-server/2.1-environment-configuration)
- **local-config.ts / reach-tools.ts** (this codebase) — existing config bridge and channel router. [Source](src/local-config.ts), [Source](src/reach-tools.ts)

### Dropped:
- **one-search-mcp** — npm page 403; no public GitHub found. Not usable as reference.
- **MCP orchestration patterns (generic)** — too abstract. The concrete patterns here (channel definitions, ordered fallback, env injection) are already superior.
- **Smithery deployment config** — platform-specific, not relevant to in-house orchestrator.
- **mcp-remote proxy** — network proxy pattern, not useful for local stdio-only extension.

## Gaps

- **No known reference for a unified multi-channel MCP orchestrator** that wraps multiple external MCP servers. Most orchestrators (e.g., Chaining MCP) operate at the prompt/workflow level, not at the tool-routing level. This extension's channel-router approach appears to be novel.
- **The external `search-mcp` CLI's internal architecture is unknown** — no public docs/GitHub for the `search-mcp` npm package. The config.json key names were reverse-engineered from `local-config.ts` mappings.
- **Cost tracking and rate-limit awareness** — no MCP server surveyed exposes cost-per-call or rate-limit headers to the orchestrator. This extension's `tier` field in channel definitions is a start but not integrated yet.
- **OllamaSearch config items** (`OLLAMA_SEARCH_BASE_URL`, `OLLAMA_SEARCH_API_KEY`) mapped in `local-config.ts:36-37` — no public MCP server uses this exact pattern. Probably internal to `search-mcp` CLI.
- **No surveyed MCP server uses separate model selection for main vs. worker** — the deepResearch worker/main split is unique.

## Recommended Minimal In-House Orchestrator Design

**Do not build a multi-process MCP supervisor.** The existing `reach-tools.ts` channel definitions + `runFirstUsable()` fallback + `externalEnvironment()` env injection covers 90% of the need. Three gaps to close:

1. **Unify the two routing paths.** Currently `index.ts` calls `createSearchBackend()` which either goes to MCP client (external `search-mcp` CLI) or CLI backend (`CliSearchBackend` → `callReachTool` → native+external CLIs). These should be unified: the channel definitions in `reach-tools.ts` should be the single routing table, and the `search-mcp` MCP client should be one more backend candidate (tier 1, alongside native tier 0).

2. **Add per-channel model/token override passthrough.** The config bridge already maps `DEEP_RESEARCH_MODEL`, `DEEP_RESEARCH_WORKER_MODEL`, `SEARCH_LLM_PROVIDER`, `EMBEDDING_SIDECAR_PROVIDER`. The orchestrator should forward these as-is to the chosen backend. No need to parse or interpret them — just set them in the subprocess env.

3. **Add browser/CDP env injection rule** matching the existing `externalEnvironment()` pattern. Currently `externalEnvironment()` in `reach-tools.ts:593-606` does not include `BROWSER_EXECUTABLE_PATH`, `BROWSER_CDP_ENDPOINT`, `BROWSER_PROFILE_DIR`, or `BROWSER_PROXY_SERVER`. Add these to the allowed set for commands that need browser contexts (opencli, crawl4ai, deepResearch).

No new dependencies needed. The `SearchBackend` interface in `backend.ts` is already abstract enough to wrap both MCP client and CLI paths. The channel definitions + backend probe logic in `reach-tools.ts` is the orchestrator — just extend it.

### Config File Dependency Graph (Current State)

```
search-mcp/config.json
  └─ mapped by local-config.ts → env vars
       ├─ BRAVE_API_KEY        → MCP client (external search-mcp CLI)
       ├─ EXA_API_KEY          → MCP client
       ├─ TAVILY_API_KEY       → MCP client
       ├─ GITHUB_TOKEN         → MCP client + native github()
       ├─ REDDIT_CLIENT_*      → search-mcp CLI (opencli/rdt-cli)
       ├─ YOUTUBE_API_KEY      → search-mcp CLI (yt-dlp)
       ├─ CRAWL4AI_BASE_URL    → search-mcp CLI
       ├─ DEEP_RESEARCH_BASE_URL → search-mcp CLI (deepResearch worker)
       ├─ BROWSER_*            → search-mcp CLI (CDP/proxy)
       ├─ EMBEDDING_SIDECAR_*  → search-mcp CLI (vectorization)
       └─ SEARCH_LLM_*         → search-mcp CLI (inference)
```

The orchestrator (reach-tools.ts) reads env vars → spawns child processes. The `search-mcp` CLI (external npm package) reads the same env vars for its own backends. This means the config bridge already serves both paths. The only missing link is that the in-process native tools do not have access to the LLM/embedding/browser config — they fall through to DuckDuckGo and in-process fetch. This is acceptable: native tier-0 tools are minimal fallbacks; full capability requires the external `search-mcp` CLI or channel-specific CLIs.

### Minimal Orchestrator Flow (Recommended)

```
User Tool Call (e.g., social, video)
  → index.ts → callSearchMcpTool(client, ...)
    → backend.ts → createSearchBackend(env)
      └─ SEARCH_BACKEND=mcp? → SearchMcpClient (external search-mcp CLI)
      └─ default → CliSearchBackend → reach-tools.ts
        → channel definitions (family, tier, backends[])
        → ordered candidate probing (native tier 0 → external tier 1+)
        → run command with environment injection
        → return text result
```

**Change**: Make `CliSearchBackend` the primary path always, and treat `search-mcp` CLI as one fallback candidate in the channel definitions, not a wholly separate backend path. This removes the `SEARCH_BACKEND` mode switch and unifies routing.

## Supervisor coordination

None needed. Design is implementable entirely within existing codebase patterns. Key files to touch: `reach-tools.ts` (add browser/CDP env vars to `externalEnvironment()`), `backend.ts` (remove `SEARCH_BACKEND` mode switch or make it a hint, not a gate), `index.ts` (simplify `createSearchBackend` call).
