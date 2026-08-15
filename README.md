# Pi-Atlas

Pi extension that gives your agent real-world reach — web search, page reading, GitHub, social media, video, browser automation, and desktop control. Zero-config works out of the box; API keys unlock more power.

Underneath the seven tools is a small set of shared services — result fusion/ranking, layered config loading, a backend abstraction with retry and ordered fallback, and a reliability envelope around browser and desktop mutations. Each tool is a thin adapter over these services; see [Architecture](#architecture) for what's actually worth evaluating here.

## Architecture

### Shared services

| Service | File(s) | What it does |
|---|---|---|
| **Fusion & ranking** | `src/fusion.ts`, `src/bm25.ts`, `src/vector-index.ts` | Reciprocal rank fusion (RRF) merges rankings from multiple search backends, or from BM25 + embedding scoring in `fetch`; URL normalization dedupes across providers before fusion. |
| **Config loading** | `src/local-config.ts` | Merges process env, a package-local `.env` file, and an optional JSON config into one environment — process env always wins, so shell exports override everything. |
| **Backend abstraction & fallback** | `src/backend.ts`, `src/cli-backend.ts`, `src/mcp-client.ts`, `src/retry.ts` | `SearchBackend` is one interface with two implementations (native CLI, default; legacy MCP client). `retryWithBackoff` retries only genuinely transient failures — timeouts, connection resets, 5xx — with jittered exponential backoff. |
| **Reliability envelope — browser** | `src/browser-result.ts`, `src/session-page-state.ts`, `src/click-verification.ts`, `src/scroll-verification.ts`, `src/overlay-detection.ts` | Every result carries a structured `resultCategory`/`failureCategory`/`nextActions`; stale `@eN` refs are rejected before they reach the CLI; clicks are verified with a DOM event probe; scrolls and overlay appearances are diffed pre/post action. |
| **Reliability envelope — desktop** | `src/desktop-contract.ts`, `src/desktop-policy.ts` | Accessibility trees are depth/node/screenshot-byte capped and redacted; mutations require a fresh `stateId` from the most recent observation and are never blindly retried after dispatch. |
| **Output guarding** | `src/tool-output.ts` | Every tool result is truncated to a configurable character budget before it reaches the model, with head/tail preservation and a truncation marker. |

### Thin adapters (the seven tools)

Each public tool validates input, calls into the shared services above, and shapes the result for the model — `src/native-tools.ts` (`web_search`/`fetch`), `src/github.ts`, `src/reach-tools.ts` (`social`/`media`), `src/browser-tools.ts` + `src/agent-browser.ts` (`browser`), `src/desktop-tools.ts` (`desktop`). Adding a search provider or social platform is a fetch call plus a descriptor entry, not a new pipeline.

## What you get

| Tool | What it does |
|---|---|
| `web_search` | Search the web. Add `category: "research"` for academic sources (arXiv, PubMed, Crossref, Wikipedia, Hacker News). |
| `fetch` | Read any webpage as clean text, or do semantic retrieval — give it a query and it crawls pages, finds the most relevant passages, and returns ranked chunks. |
| `github` | Browse repos, read files, search code, discover trending projects. With an embedding sidecar, unlock `code_search` for AST-aware semantic code retrieval. |
| `social` | Read and search Twitter/X, Reddit, V2EX, XiaoHongShu, Facebook, Instagram. |
| `media` | YouTube and Bilibili search, metadata, subtitles. RSS/Atom feed reading. |
| `browser` | Headless browser automation via agent-browser — navigate, click, type, screenshot, snapshot with interactive refs, structured result categories, click verification, stale-ref detection, scroll no-op detection, overlay blocker detection. |
| `desktop` | Native desktop observation and interaction via Cua Driver (opt-in, disabled by default). |

## Quick start

Two ways to bring Pi-Atlas into `pi`:

### Install as a Pi package (recommended)

```bash
pi install git:github.com/rhinos0608/pi-extension-search-mcp
```

This clones the repo into `~/.pi/agent/git/` (or `.pi/git/` with `-l` for a project-local install), runs `npm install`, and registers the extension in settings for you. To try it for one session without installing anything: `pi -e git:github.com/rhinos0608/pi-extension-search-mcp`. See `pi`'s [package docs](https://github.com/earendil-works/pi) for update/remove commands.

### Clone and wire up manually

```bash
git clone https://github.com/rhinos0608/pi-extension-search-mcp.git Pi-Atlas
cd Pi-Atlas
npm install
```

Add it to `~/.pi/agent/settings.json` (or `.pi/settings.json` for a project-local extension):

```json
{
  "extensions": {
    "pi-atlas": "./src/index.ts"
  }
}
```

Or run it directly for a quick test:

```bash
pi -e ./src/index.ts
```

### About that `npm install`

Requires Node.js ≥ 24. `web_search`, `fetch`, `github`, `social`, and `media` have no native dependency — `npm install` (or `npm install --omit=optional`) is enough to use them. `browser` is the one tool backed by a native binary: `agent-browser` (~86 MB) is an **optional** npm dependency, so `npm install` downloads it by default, but nothing else in the package needs it. Skip it with:

```bash
npm install --omit=optional
```

Skipping it leaves the other six tools unaffected; `browser` calls fail with a clear `agent-browser executable not found` error until a binary is available — see [Browser automation](#browser-automation) to install it separately or point at an existing one.

`desktop` is separate again: it drives a native Cua Driver binary that was never an npm dependency at all, downloaded and put on `$PATH` by hand. It stays disabled (`PI_SEARCH_DESKTOP_AUTOMATION` unset) no matter how you installed Pi-Atlas — see [Desktop automation](#desktop-automation).

If the agent-browser download is slow or fails:
- Check network/proxy settings: `npm config get proxy`, `npm config get https-proxy`
- Verify internet connectivity to GitHub (where binaries are hosted)
- Use `npm install --verbose` to see download progress
- If stuck, try clearing npm cache: `npm cache clean --force && npm install`

That's it — web search works immediately via DuckDuckGo with zero configuration. If a file-backed `codex login` session is available, Pi-Atlas also detects it automatically and uses Codex results first.

## Configuration

Set variables in your shell profile (`.zshrc`, `.bashrc`) or a package-local `.env` file. Process environment wins over `.env`. See `.env.example` for every available variable.

### API keys

All optional. DuckDuckGo covers web search without any keys.

```bash
export GITHUB_TOKEN="ghp_..."           # GitHub API (private repos, higher rate limits)
export EXA_API_KEY="..."                # Exa semantic search
export BRAVE_API_KEY="..."              # Brave Search API
export TAVILY_API_KEY="..."             # Tavily AI-native search
export YOUTUBE_API_KEY="..."            # YouTube Data API
export REDDIT_CLIENT_ID="..."           # Reddit API
export REDDIT_CLIENT_SECRET="..."       # Reddit API
export REDDIT_USER_AGENT="pi-atlas/0.1"
export SEARXNG_BASE_URL="https://..."   # Self-hosted SearXNG
```

### Codex/ChatGPT search

Pi-Atlas automatically checks `CODEX_ACCESS_TOKEN`, then `${CODEX_HOME:-~/.codex}/auth.json` created by `codex login`. When credentials exist and no explicit backend override is set, Codex web search is primary: its ordered results appear first, then results from other configured providers are URL-normalized and deduplicated before filling remaining slots. Only search query is sent; conversation history and project files are not included.

```bash
export CODEX_ACCESS_TOKEN="..."       # Optional override
export CODEX_ACCOUNT_ID="..."         # Optional account routing
export CODEX_HOME="$HOME/.codex"       # Optional auth-file location
```

`PI_SEARCH_WEB_BACKENDS` is exact. If set, Codex runs only when `codex` appears in list.

> **Limited-support notice:** This integration uses undocumented, reverse-engineered ChatGPT/Codex search endpoint. It is best-effort, not official OpenAI integration, and may change, become unavailable, or be limited by account eligibility and usage limits. Usage may be governed by OpenAI/ChatGPT terms and policies. Confirm your intended use complies with those terms before enabling or relying on it.

### Backend selection

```bash
export PI_SEARCH_WEB_BACKENDS="codex,duckduckgo,brave"  # Exact provider set; codex remains primary when listed
export PI_SEARCH_BROWSER_BACKEND="cdp"                     # Deprecated: CDP fallback (no reliability checks)
export PI_SEARCH_BROWSER_ALLOW_SENSITIVE="1"              # Enable evaluate/set_cookies
export PI_SEARCH_DESKTOP_AUTOMATION="1"                   # Enable desktop tool
```

### Bootstrap control

```bash
export PI_SEARCH_BOOTSTRAP="off"         # Skip startup automation
export PI_SEARCH_AUTO_INSTALL="0"        # Skip startup installs
export PI_SEARCH_ALLOW_INSTALL="0"       # Disable all install execution
export PI_SEARCH_AUTO_COOKIES="off"      # Skip cookie import
export PI_SEARCH_BROWSER_AUTOMATION="0"  # Disable all browser features
```

### Output & state

```bash
export PI_SEARCH_MAX_TOOL_OUTPUT_CHARS="60000"   # Truncation limit
export PI_SEARCH_STATE_DIR="$HOME/.pi-atlas"     # State directory
export PI_SEARCH_COOKIE_BROWSER="chrome"         # chrome, brave, or edge
export PI_SEARCH_COOKIE_STALE_MS="43200000"      # Cookie re-import window (12h)
export BROWSER_CDP_ENDPOINT="http://127.0.0.1:9222"  # CDP fallback endpoint
```

## Embedding & semantic search

Pi-Atlas has two layers of semantic capability:

### 1. Built-in semantic retrieval (`fetch` with query)

When you call `fetch` with a `query` parameter, Pi-Atlas performs **hybrid search**:

1. **URL discovery** — queries configured search backends (Codex when detected, DuckDuckGo, Brave, Exa, Tavily, SearXNG, Ollama); Codex results lead, then remaining rankings are RRF-fused and URL-deduplicated
2. **Page fetching** — optionally uses Scrapling (Python stealth browser) for JS-rendered pages and anti-bot bypass, falls back to plain HTTP
3. **Chunking** — sentence-boundary-aware text splitting with overlap
4. **BM25 ranking** — Okapi BM25 lexical scoring (TF saturation, IDF weighting, length normalization)
5. **Embedding ranking** — vector similarity via embedding sidecar (if configured)
6. **RRF fusion** — merges BM25 and embedding rankings into final results

#### Site-wide crawling with `followLinks`

Set `followLinks: true` to crawl the entire site starting from `url`. The tool performs a bounded BFS across same-domain pages, extracts and indexes all content, then returns only the passages most relevant to your `query`.

```
fetch({ query: "pricing tiers", url: "https://example.com", followLinks: true })
```

- **`followLinks` requires both `url` and `query`** — site-wide crawls always use semantic packing; raw page dumps are not supported
- **Same-domain only** — external links are ignored; subdomains (`sub.example.com`) are excluded
- **`maxPages`** — controls total pages crawled (default 10, max 25)
- **`maxDepth`** — hardcoded at 3 levels deep, preventing runaway crawls
- **URL dedup** — fragments, tracking params, trailing slashes normalized before enqueue
- **Non-HTML content** — skipped automatically (PDFs, images, archives)
- **Graceful degradation** — link extraction uses Scrapling's CSS selector engine when available; falls back to regex-based extraction from raw HTML
- **Output** — limited to the most relevant `topK` chunks (default 8) via the same BM25+embedding RRF pipeline

Every layer degrades gracefully: no Python → plain HTTP fetch, no sidecar → BM25-only, no backends → DuckDuckGo fallback.

```
fetch({ query: "How does React concurrent rendering work?", searchQuery: "React 18 concurrent rendering" })
```

- `query` — what you want to find in the crawled pages
- `searchQuery` — what to search the web for (defaults to `query` if omitted)
- `topK` — how many chunks to return (default 8, max 20)
- `maxPages` — how many pages to crawl (default 10, max 25)

Without a `query`, `fetch` returns the full readable text of a URL (plain extraction, no semantic processing).

### 2. Embedding sidecar (semantic search + GitHub `code_search`)

Pi-Atlas can connect to an embedding service for **vector-based semantic search** in `fetch` and **AST-aware semantic code search** in GitHub `code_search`.

Configure the sidecar (works with any OpenAI-compatible embedding API — LM Studio, Ollama, OpenAI, etc.):

```bash
export EMBEDDING_SIDECAR_PROVIDER="openai"          # Provider identifier
export EMBEDDING_SIDECAR_BASE_URL="http://localhost:1234"  # Embedding service endpoint
export EMBEDDING_SIDECAR_API_TOKEN="sk-..."         # Auth token (optional for local services)
export EMBEDDING_SIDECAR_DIMENSIONS="768"            # Embedding vector dimensions
```

When `EMBEDDING_SIDECAR_BASE_URL` is set, `fetch` with query automatically uses BM25 + embedding RRF fusion for ranking. No Python process is spawned — it talks directly to your external embedding service.

#### Local Python sidecar (alternative)

If you don't have an external embedding service, Pi-Atlas can spawn a local Python sidecar:

```bash
pip install fastapi uvicorn sentence-transformers
export PI_SEARCH_EMBEDDING_ENABLED=1
export PI_SEARCH_EMBEDDING_MODEL=all-MiniLM-L6-v2  # 384 dims, 22MB
```

Pi-Atlas auto-spawns the sidecar on first use and manages its lifecycle.

#### Stealth browser mode (Scrapling)

If the Scrapling Python package is installed, Pi-Atlas uses it **automatically** for `fetch` — no configuration needed. It provides:

- JS-rendered page content (SPA, React, Angular sites)
- Cloudflare Turnstile/Interstitial auto-solve
- Anti-fingerprinting (canvas noise, WebRTC leak prevention, CDP detection bypass)
- Stealth browser via Patchright

```bash
pip install "scrapling[fetchers]"
scrapling install  # download browsers + system deps
```

Pi-Atlas auto-detects Scrapling on startup. If installed, `fetch` and `agentic_browse` use it automatically. If not installed, falls back to plain HTTP.

Optional proxy:
```bash
export PI_SEARCH_SCRAPLING_PROXY="http://user:pass@host:port"
```

### 3. GitHub `code_search`

```
github({ action: "code_search", repository: "owner/repo", query: "authentication middleware with JWT verification" })
```

The `profile` parameter lets you tune retrieval: `balanced`, `lexical-heavy`, `semantic-heavy`, `high-precision`, `fast`, `precision`, or `recall`.

Without the embedding sidecar, `code_search` falls back to lexical GitHub code search.

## CLI

The CLI is a thin JSON-in/JSON-out wrapper — useful for testing and scripting:

```bash
npm run cli -- status
npm run cli -- config
npm run cli -- call web_search '{"query":"pi agent extensions"}'
npm run cli -- call fetch '{"url":"https://example.com"}'
npm run cli -- call fetch '{"query":"error handling patterns","searchQuery":"Rust error handling best practices"}'
npm run cli -- call social '{"platform":"reddit","action":"subreddit","subreddit":"python","filter":"hot"}'
npm run cli -- call media '{"platform":"rss","url":"https://example.com/feed.xml"}'
npm run cli -- call reach_setup '{"action":"plan"}'
```

All CLI output is JSON: `{ "ok": true, "data": { "content": [...] } }`.

## Slash commands

User-facing setup and status commands (not LLM tools):

- `/reach-status [family]` — inspect channels and backends, e.g. `/reach-status social`
- `/reach-setup [action]` — `auto`, `status`, `plan`, `install_core`, `install_all`, `install_channels`, `import_cookies`, `login`

## Browser automation

`browser` tool provides headless browser control via **agent-browser** (core path) with reliability checks matching [pi-agent-browser-native](https://github.com/fitchmultz/pi-agent-browser-native). A legacy CDP fallback exists but is **deprecated** — use agent-browser.

### Installation

`agent-browser` is an **optional** npm dependency (`optionalDependencies` in `package.json`), not required by any other tool. By default `npm install` downloads the native binary (~86 MB) alongside everything else, so `browser` works immediately with no extra setup:

```bash
npm install
# agent-browser binary downloads automatically
```

If you installed with `npm install --omit=optional`, or the optional install failed for your platform, `browser` still registers as a tool but every call returns a clear `agent-browser executable not found` error. Fix it with any of:

```bash
npm install agent-browser         # install just the optional dependency
npm install -g agent-browser      # or use a system-wide install already on PATH
export BROWSER_EXECUTABLE_PATH="/path/to/agent-browser"  # or point at a specific binary
```

Resolution order: `BROWSER_EXECUTABLE_PATH` if set (exact path, no fallback) → otherwise `node_modules/.bin/agent-browser` → `node_modules/agent-browser/bin/agent-browser.js` → first `agent-browser` found on `PATH`.

### Capability matrix

#### Reliability checks (Phase 1–2, implemented)

| Check | What it does | Signal |
|-------|-------------|--------|
| **Structured result envelope** | Every result carries `resultCategory` (success/failure), `successCategory` (inspection/completed/artifact-saved), `failureCategory` (timeout/stale-ref/dispatch-unverified/overlay-blocked/etc), and `nextActions` with exact recovery steps | `details.resultCategory`, `details.failureCategory`, `details.nextActions` |
| **Click dispatch verification** | After clicks on `@eN` refs and `role=`/`xpath=` selectors, installs a capture-phase DOM event probe; fails the result if no click event reached the page | `details.dispatchUnverified: true` |
| **Stale ref detection** | Tracks per-session `@eN` ref snapshots; rejects mutations on stale refs before the CLI runs | `failureCategory: 'stale-ref'`, `nextActions: [snapshot refresh]` |
| **Scroll no-op detection** | Compares pre/post viewport position; flags when scroll had no effect | `details.scrolled: false`, `details.noop: true` |
| **Overlay blocker detection** | Counts `[role=dialog]`/`[aria-modal]` elements before/after clicks; flags when a modal appeared | `details.overlay: { appeared: true }` |
| **Session page state** | Per-session ref snapshot tracking, tab target tracking, invalidation on "No active page", stale update rejection via monotonic tokens | `details.refSnapshot`, `details.refSnapshotInvalidation` |

#### Snapshot & input modes (Phase 3–4, implemented)

| Feature | What it does |
|---------|-------------|
| **Interactive snapshot refs** | `snapshot` parses `@eN` refs from agent-browser output, records role/name/isContentEditable metadata per session |
| **Compact snapshot** | `compact: true` keeps high-value roles (button, link, textbox, checkbox, radio, combobox, select, menuitem, tab, switch), drops structural divs without names |
| **semanticAction** | Locator shorthands — `click`/`fill`/`check`/`select` with `role`/`text`/`label`/`placeholder`/`alt`/`title`/`testid` locators, compiled to agent-browser `find` commands |
| **job** | Constrained multi-step orchestration (max 20 steps: open/click/fill/type/select/wait/assert/snapshot/screenshot), sequential execution with reliability checks per step |
| **batch** | Raw multi-command stdin batching, per-step `batchSteps[]` result categories |

#### Actions

| Action | Parameters | What it does |
|--------|-----------|------|
| `status` | none | Check browser backend and session state |
| `tabs` | none | List open browser tabs |
| `navigate` | `url: string` | Navigate to a URL (public HTTP/HTTPS only) |
| `text` | none | Extract visible text from the current page |
| `html` | none | Get raw HTML of the current page |
| `screenshot` | none | Capture a PNG screenshot of the page |
| `snapshot` | `compact?: boolean` | Take interactive snapshot with `@eN` refs for click/fill |
| `click` | `selector: string` | Click an element — with dispatch verification on eligible selectors |
| `type` | `selector: string`, `text: string` | Type text into an input field, with stale-ref preflight |
| `fill` | `selector: string`, `text: string` | Fill a form field, with stale-ref preflight |
| `scroll` | `x?: number`, `y?: number` | Scroll by pixel offset, with no-op detection |
| `wait` | `selector?: string`, `waitMs?: number` | Wait for selector or milliseconds |
| `get_url` | none | Get current page URL |
| `get_title` | none | Get current page title |
| `close` | none | Close the current tab |
| `cookies` | `urls?: string[]` | Read cookie metadata (values never exposed) |
| `set_cookies` | `cookies: Array<...>` | Set cookies (requires `PI_SEARCH_BROWSER_ALLOW_SENSITIVE=1`) |
| `evaluate` | `expression: string` | Run JavaScript in page context (requires `PI_SEARCH_BROWSER_ALLOW_SENSITIVE=1`) |
| `semanticAction` | `{ verb, locator, query, value, ... }` | Click/fill/check/select with role/text/label locators |
| `job` | `{ steps: [...] }` | Multi-step orchestration with per-step reliability |
| `batch` | `commands: string[][]` | Raw multi-command batching (requires sensitive flag) |

### Examples

```bash
# Navigate and snapshot with interactive refs
browser({ action: "navigate", url: "https://example.com" })
browser({ action: "snapshot" })
# Returns @e1, @e2, @e3... refs for follow-up clicks
browser({ action: "click", selector: "@e2" })

# Semantic action — click by role/name
browser({ semanticAction: { verb: "click", locator: "role", query: "button", value: "Submit" } })

# Multi-step job with reliability
browser({ job: { steps: [
  { kind: "open", url: "https://example.com" },
  { kind: "fill", selector: "@e1", text: "hello" },
  { kind: "click", selector: "@e2" },
  { kind: "snapshot" }
] } })

# Extract text
browser({ action: "text" })

# Evaluate JavaScript
browser({ action: "evaluate", expression: "document.title" })
```

### Backend selection

agent-browser is the default and recommended backend. **CDP is deprecated** — it lacks reliability checks, snapshot refs, and session management. Only use it for legacy integrations that cannot install agent-browser.

```bash
# Deprecated — use agent-browser instead
export PI_SEARCH_BROWSER_BACKEND="cdp"
export BROWSER_CDP_ENDPOINT="http://127.0.0.1:9222"
```

### Security

- Agent-browser uses owned isolated sessions with strict public-domain navigation
- `evaluate`, `set_cookies`, and `batch` are disabled by default; enable with `PI_SEARCH_BROWSER_ALLOW_SENSITIVE=1`
- Cookies return metadata only (name, domain, path, expiry, flags) — values are never exposed
- Error messages sanitized: token/password/secret/authorization patterns stripped (≤2000 chars)
- Security enforcement is external through containerization and other extensions

## Desktop automation

`desktop` tool provides native desktop observation and interaction via [Cua Driver](https://github.com/trycua/cua).

### Installation

Cua Driver is optional and disabled by default. To enable:

1. Download [Cua Driver v0.7.1](https://github.com/trycua/cua/releases/tag/cua-driver-rs-v0.7.1) for your platform:
   - **macOS**: Download `cua-driver-aarch64-apple-darwin` (Apple Silicon) or `cua-driver-x86_64-apple-darwin` (Intel)
   - **Linux**: Download `cua-driver-x86_64-unknown-linux-gnu`
   - **Windows**: Download `cua-driver-x86_64-pc-windows-msvc.exe`

2. Make it executable and place it on your `$PATH` (typically `/usr/local/bin`):

```bash
chmod +x cua-driver
sudo mv cua-driver /usr/local/bin/
```

3. Grant permissions (one-time, OS-dependent):
   - **macOS**: First run prompts for Accessibility (System Settings > Security & Privacy)
   - **Linux**: May require `sudo` or xinput permissions
   - **Windows**: Run as Administrator the first time

4. Enable the tool:

```bash
export PI_SEARCH_DESKTOP_AUTOMATION="1"
```

Optionally configure the driver path:

```bash
export CUA_DRIVER_PATH="/usr/local/bin/cua-driver"
```

### Capabilities

`desktop` supports these actions:

| Action | Parameters | What it does |
|--------|-----------|------|
| `status` | none | Check Cua Driver health and permissions |
| `list_apps` | none | List running applications |
| `list_windows` | none | List open windows across all apps |
| `observe_window` | `pid: number`, `windowId: string`, `includeScreenshot?: boolean` | Get accessibility tree (AX) for a window; optionally screenshot |
| `click` | `pid: number`, `windowId: string`, `x: number`, `y: number`, `stateId: string` | Click at coordinates (requires fresh state ID) |
| `type_text` | `pid: number`, `windowId: string`, `text: string`, `stateId: string` | Type text (requires fresh state ID) |
| `press_key` | `pid: number`, `windowId: string`, `key: string`, `stateId: string` | Press a key (e.g., "Return", "Escape") |
| `scroll` | `pid: number`, `windowId: string`, `deltaX?: number`, `deltaY?: number`, `stateId: string` | Scroll by pixel delta (requires fresh state ID) |
| `wait` | `pid: number`, `windowId: string`, `predicate?: {text?, role?}`, `timeoutMs?: number` | Poll until text/role appears in AX tree (default 30s timeout) |

### Examples

```bash
# Check driver health
desktop({ action: "status" })

# List windows
desktop({ action: "list_windows" })

# Observe a window's accessibility tree
desktop({ action: "observe_window", pid: 1234, windowId: "main-window", includeScreenshot: false })

# Observe with screenshot
desktop({ action: "observe_window", pid: 1234, windowId: "main-window", includeScreenshot: true })

# Interact (requires stateId from observe_window response)
desktop({ action: "click", pid: 1234, windowId: "main-window", x: 100, y: 200, stateId: "state-123" })
desktop({ action: "type_text", pid: 1234, windowId: "main-window", text: "hello", stateId: "state-123" })

# Wait for text to appear
desktop({ action: "wait", pid: 1234, windowId: "main-window", predicate: { text: "Save" }, timeoutMs: 5000 })
```

### State IDs

Mutations (click, type, scroll) require a fresh `stateId` from the most recent `observe_window` call. After each mutation, you must call `observe_window` again to get a new state ID before the next mutation. This ensures:

- State consistency: AX tree matched to real state
- Atomicity: mutations are serialized and never retried after dispatch
- Isolation: transport loss yields `OUTCOME_UNKNOWN` (no blind retries)

### Screenshots

- Optional via `includeScreenshot: true` in `observe_window`
- Returns as inline base64 image content
- **Sensitive**: closes all apps before enabling; PII/credentials can leak
- Returns PNG with window content, resolution capped at 10 000×10 000 pixels (desktop screenshot via Cua Driver). Browser (`screen‑shot`) screenshots are capped at 8 000×8 000 pixels (configured in agent-browser adapter).

### Observations

- AX (Accessibility) tree is AX-only by default; includes element names, roles, values, but not visual pixel data
- Tree depth capped at 32 levels; node count capped at 1 000
- Redacts sensitive fields: passwords, tokens, secrets, paths
- Screenshot bytes capped at 10 MB (prevents large binaries)

### Permissions

Cua Driver requires OS-level permissions (never prompt — user must grant in System Settings):

- **macOS**: Accessibility (System Settings > Privacy & Security > Accessibility)
- **Linux**: X11 or Wayland permissions (varies by desktop)
- **Windows**: Administrator for some actions

Permissions are user-owned and persist across sessions. Session shutdown cannot revoke grants.

### Security & Privacy

- Disabled by default — set `PI_SEARCH_DESKTOP_AUTOMATION=1` to enable
- Observation is AX-only by default; screenshots require explicit opt-in
- Screenshots and AX trees can expose sensitive information — only use with trusted applications
- Mutations are serialized per window; transport loss is not retried
- Redaction is applied to output (passwords, tokens, paths removed before AI sees them)

## Package contract

```json
{
  "pi": {
    "extensions": ["./src/index.ts"]
  }
}
```
