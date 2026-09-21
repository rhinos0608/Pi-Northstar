# Pi-Northstar

**A local-first research and evidence engine for Pi, with a standalone CLI.**

Northstar puts web search and reading, GitHub, academic/public research, social and media reads, structured knowledge, browser automation, desktop control, and stateful jobs behind one set of contracts. Provider choice and credentials stay operator-owned. Model-facing Pi tools are opt-in and default to **zero**.

## Quick start

Requirements: Node.js 24+; Rust stable is only needed when building the native broker.

```bash
npm install
npm run build

# No API key required: DuckDuckGo is the zero-config web fallback.
npm run cli -- search "pi coding agent architecture" --limit 5

# The research registry is also usable without API keys.
npm run cli -- research search "retrieval augmented generation" --source openalex --limit 5

# Public GitHub reads work anonymously, with lower rate limits.
npm run cli -- github repo openai/openai-node
```

After package installation, the same surface is available as `northstar` (and `pi-northstar`). Run `northstar --help`, `northstar domains`, or `northstar capabilities` to discover the installed version instead of relying on copied command lists.

## System shape

```text
                     operator-owned config / credentials
                                   │
            ┌──────────────────────┴──────────────────────┐
            │                                             │
      northstar CLI                               Pi extension
  28 stateless commands                    up to 9 native tools
  + broker/jobs commands                  default: none exposed
            │                                             │
            └───────────────┬─────────────────────────────┘
                            ▼
                 canonical command/domain contracts
                            │
              ┌─────────────┴─────────────┐
              ▼                           ▼
      stateless provider paths      stateful local runtime
  web · GitHub · research ·       Rust broker · jobs ·
  social · media · KG/graph       state/authority checks
```

`media` and multimodal acquisition are intentionally not extra model-facing tools. Media is CLI/internal acquisition; vision lives behind explicit destination opt-ins. This keeps the model grammar small while the CLI can grow by nouns and verbs.

## CLI map

| Domain | Commands | Default auth shape |
| --- | --- | --- |
| `search` | web discovery | keyless baseline; optional keyed providers |
| `fetch` | URL read, sitemap, cached retrieval/verification | keyless native reader; optional external processors |
| `github` | repo, file, tree, search, trending, issues, pulls, releases, commits, workflows, runs | public reads keyless; token optional |
| `research` | search, paper, citations | all 12 sources usable anonymously; keys raise quotas |
| `social` | search, read | V2EX baseline is keyless; most other platforms use credentials or local login sessions |
| `media` | search, hot, details, transcript, feed | RSS keyless; YouTube is mixed; Bilibili uses local CLI/session backends |
| `kg` | search, enhance | Diffbot token required |
| `graph` | query, probe | Diffbot DQL token or operator SPARQL endpoint |
| `broker` / `jobs` | `serve`; `start`, `status`, `result`, `cancel` | broker authority is local; a job uses the credentials required by its exact `provider/model` |

The current CLI exposes **28 stateless command IDs** plus five local/development stateful IDs: `broker.serve`, `jobs.start`, `jobs.status`, `jobs.result`, and `jobs.cancel`. Domain syntax belongs in `skills/<domain>/SKILL.md` and the live `--help` output.

## Configuration model

Northstar loads configuration in a strict precedence order:

1. **Process environment**
2. **Environment file**: package-local `.env` by default, or `PI_SEARCH_ENV_PATH`
3. **Optional JSON mapping**: only when `SEARCH_MCP_CONFIG_PATH` is explicitly set

JSON config only maps known fields into canonical environment names. It is not an alternate policy language. `.env.example` is the primary operator-facing configuration catalogue.

Credentials and Pi tool exposure are separate controls. A configured provider does not automatically become a model tool, and enabling a Pi tool does not manufacture provider credentials.

```bash
# Default: no native Northstar tools are registered in Pi.
PI_SEARCH_NATIVE_TOOLS=""

# Small profile
PI_SEARCH_NATIVE_TOOLS="web_search,fetch,github"

# Maximum current profile
PI_SEARCH_NATIVE_TOOLS="web_search,fetch,github,social,kg,graph,browser,desktop,agent_poll"
```

`PI_SEARCH_NATIVE_TOOLS` accepts exact canonical names only. Unknown, duplicate, legacy, internal, or malformed entries fail at startup. CLI commands remain available independently.

Provider selection is also operator-owned. The model does not receive provider flags or credentials. With `PI_SEARCH_WEB_BACKENDS` unset, Northstar selects the first three configured providers in this preference order:

`tavily → exa → brave → diffbot → firecrawl → jina → searxng → ollama-search → duckduckgo`

`duckduckgo` is always configured. `codex` is explicit-only. Extended providers such as Parallel, TinyFish, Querit, Valyu, Bocha, Xcrawl, xAI, Mistral, Bright Data, SerpApi, and Serper are also explicit-list only.

## What works without a key?

| Surface | Keyless behavior | What credentials or setup add |
| --- | --- | --- |
| Web search | DuckDuckGo works with no configuration | Tavily, Exa, Brave, Diffbot, Firecrawl, Jina and other vendor backends; SearXNG/Ollama can use operator endpoints |
| Web fetch | native page reader; local PDF text; direct-image metadata; media/RSS specialization; Scrapling when locally installed | optional image/video vision through a configured OpenAI-compatible or Gemini route; Firecrawl/Jina external processing when explicitly enabled |
| Research | Semantic Scholar, OpenAlex, PubMed, Stack Overflow, DataCite, ROR, GDELT, Wikipedia, Wikidata, arXiv, Crossref, Hacker News | optional source keys raise quotas |
| GitHub | public REST reads | `GITHUB_TOKEN` / `GH_TOKEN` for private content and better limits |
| RSS / Atom | full feed reads | none |
| V2EX | legacy public reads | `V2EX_PAT` unlocks API 2.0-only reads such as notifications |
| YouTube | limited details via oEmbed; degraded transcript path via watch page/timedtext | `YOUTUBE_API_KEY` for official search/hot/details; explicit cookie import can help consent-gated transcripts |
| SPARQL graph | no API key is required, but an operator `GRAPH_SPARQL_ENDPOINT` is required | optional `GRAPH_SPARQL_TOKEN` bearer auth |
| Browser | isolated local browser path when its dependency is available | user-Chrome companion requires pairing plus explicit `/chrome authorize` |
| Desktop | no API key | `PI_SEARCH_DESKTOP_AUTOMATION=1` plus the installed Cua Driver |
| Vision | a loopback OpenAI-compatible endpoint can be keyless; vision features still require their exact fetch opt-in | cloud OpenAI-compatible/Gemini routes require explicit destination config and credentials/project auth |

### Keyed or login-backed surfaces

- **KG / Diffbot DQL:** `DIFFBOT_TOKEN`.
- **Vendor search:** each selected vendor uses its documented key; Bright Data requires both key and SERP zone.
- **Reddit:** OAuth credentials or a supported local session backend.
- **Twitter/X, Facebook, Instagram, XiaoHongShu, LinkedIn, Bilibili:** local CLI/OpenCLI/browser-session authentication as supported by that adapter.
- **Codex search:** `codex login` auth is auto-detected, or use `CODEX_ACCESS_TOKEN`; this backend is explicit-only and unofficial/best-effort.

## Search, fetch, and privacy

Plain web search fuses fulfilled provider rankings deterministically with reciprocal rank fusion. Provider failures remain observable; an all-provider failure is not rewritten as "zero results." Search results can yield a local `responseId`, which `fetch` can use for no-network slicing, text lookup, and claim checks.

External page processors are not silent fallbacks. Firecrawl/Jina fetch processing requires `PI_SEARCH_EXTERNAL_FETCH=1` plus an explicit ordered `PI_SEARCH_FETCH_BACKENDS` list. Authenticated fetch profiles use a narrower path: HTTPS, configured hosts only, same-origin redirects, and no external rendering.

Some optional routes send content to third parties:

- `DIFFBOT_TOKEN` enables paid Diffbot endpoints.
- Firecrawl and Jina process requested page content on their services.
- Cloud OpenAI-compatible or Gemini vision can receive admitted image/video bytes and derived text only through explicitly enabled vision paths.
- Normal PDF fetch stays local today. Sparse/scanned pages are detected and warned; the reserved PDF cloud-render flag remains fail-closed until a page renderer exists.
- Private/authenticated GitHub material cannot reach cloud vision unless `PI_VISION_PRIVATE_GITHUB_TRANSFER=1` is also set.

See `.env.example` before enabling those routes.

## Multimodal fetch

Multimodal work stays behind `fetch` and internal acquisition rather than growing the public Pi tool vocabulary.

| Asset | Default path | Optional vision path |
| --- | --- | --- |
| PDF | `.pdf` URLs and `application/pdf` responses are extracted locally with `unpdf`; normal fetch is bounded to 10 MiB, 50 pages, and 50,000 characters with page citations and sparse-page warnings | none on the normal fetch path today; `PI_VISION_PDF_CLOUD_RENDER=1` is reserved but fails closed until a page-image renderer exists |
| Image | PNG/JPEG/GIF/WebP bytes are magic-sniffed and returned as bounded metadata | exact `PI_VISION_FETCH_DESCRIBE=1` plus OpenAI-compatible or Gemini produces a separate description in result details |
| YouTube | metadata/transcript evidence uses the media path; the transcript has its separate unofficial keyless adapter | exact `PI_VISION_FETCH_VIDEO_FRAMES=1` plus OpenAI-compatible or Gemini can add anonymous keyframe evidence; configured vision can also synthesize admitted evidence |

### Vision destinations

**OpenAI-compatible** vision accepts an operator-selected HTTP(S) base URL plus exact model IDs. Loopback servers such as Ollama, LM Studio, or vLLM can run keyless with `PI_VISION_OPENAI_COMPAT_BASE_URL` + `PI_VISION_OPENAI_COMPAT_MODEL`; `PI_VISION_OPENAI_COMPAT_API_KEY` is optional for endpoints that need it. A loopback endpoint keeps the vision call local; a remote base URL sends the admitted asset to that operator-selected service.

**Gemini** requires exact `PI_VISION_GEMINI_ENABLED=1`. Developer API mode uses `GEMINI_API_KEY` or `GOOGLE_GENAI_API_KEY`. Vertex mode additionally uses `GOOGLE_GENAI_USE_VERTEXAI=1`, a project (`GOOGLE_VERTEX_PROJECT` or `GOOGLE_CLOUD_PROJECT`), `GOOGLE_CLOUD_LOCATION`, and ADC. `PI_VISION_GEMINI_MODEL` selects the exact model; otherwise the current transport default is `gemini-2.0-flash`.

`PI_VISION_GEMINI_WEB_ENABLED=1` enables a separate last-resort Gemini Web transport seam, but the current fetch image and video analyzers do not select it. One configured destination never authorizes another.

Fetch-time YouTube frames are the narrow exception to the normal media rule around `yt-dlp`: with the exact frames opt-in, Northstar may use `yt-dlp` + `ffmpeg` internally for anonymous frame extraction. That child path strips cookies, account credentials, proxy configuration, and user config. YouTube search/hot/details/transcript do not use `yt-dlp`.

## Browser, desktop, and setup authority

`/reach-status`, `/reach-setup`, and `/chrome` are **user slash commands**, not model tools. Cookie import and login never happen at startup or because an environment variable happens to exist. They require explicit operator actions such as `/reach-setup import_cookies ...`, `/reach-setup login ...`, or `/chrome authorize`.

Browser navigation enforces URL/origin policy and treats remote content as untrusted evidence. Desktop mutation requires fresh observed state; sensitive keyboard input requires human confirmation. Social write capability is deny-by-default and no provider is currently allowlisted for writes.

## Leaf runtime integration

Northstar has two leaf-execution paths with different jobs and authority boundaries:

| Path | Runtime | Configuration | Structured output |
| --- | --- | --- | --- |
| adaptive agent steering | co-installed `pi-subagents` over `subagents:runtime:v1` | exact `PI_NORTHSTAR_LEAF_MODEL=provider/model` | negotiated; current producer advertises `structured-v1` |
| local broker jobs | `src/runtime/local-leaf-runtime.ts` over the Pi AI model registry | `northstar jobs start --model provider/model` | text-only in the current same-user development runtime |

For the co-installed path, the producer contract in `../pi-subagents/src/api/runtime-rpc.ts` is ground truth; `src/runtime/runtime-rpc-protocol.ts` is Northstar's self-contained consumer mirror. The event protocol exposes `negotiate`, `start`, `status`, `result`, and `cancelAndSettle`. Model IDs are exact `provider/model` strings and thinking suffixes are rejected.

A fresh negotiation is capability discovery, not authorization. The current `pi-subagents` bridge advertises text + JSON output, `structured-v1` schema support, and correlation v2 after a successful exact-model negotiation. Northstar attaches an `outputSchema` only when `structured-v1` was negotiated; otherwise it asks for text JSON and parses/validates locally. Domain validators remain authoritative in both cases. The event bus is trusted co-installed extension plumbing, and correlation metadata is never authentication.

If `PI_NORTHSTAR_LEAF_MODEL` is unset, negotiation fails, the sibling bridge is disabled/unavailable, or a staged leaf call fails, adaptive research degrades to the deterministic/evidence-only path instead of inventing model output. Exact `PI_NORTHSTAR_AGENT_STEERING=0` disables staged model steering even when a leaf runtime is available.

## Stateful broker

A source checkout can run the complete same-user development path without the signed installer or privileged worker service:

```bash
npm run build:local

# Terminal 1: explicit foreground authority. Ordinary jobs commands never auto-start it.
npm run cli -- broker serve --project-id local-demo

# Terminal 2: exact provider/model, using that provider's normal operator-owned credentials.
npm run cli -- jobs start --project-id local-demo --request-id demo-1 \
  --model openai/gpt-4o-mini --prompt "Return the word ready" --max-output-tokens 32
npm run cli -- jobs status --project-id local-demo --request-id demo-1
npm run cli -- jobs result --project-id local-demo --request-id demo-1
npm run cli -- jobs cancel --project-id local-demo --request-id demo-1
```

In this local mode the TypeScript host provides a same-user, text-only leaf runtime backed by the existing Pi AI provider stack. The Rust broker still owns public IPC admission, sequence/replay checks, durable submission receipts, and cancellation ownership. Successful starts are journaled with the runtime-issued job ID; definitive failed starts remain settled internal mutations but do not fabricate a job receipt; interrupted dispatches become `outcome_unknown` and are never automatically replayed.

Pi can own the same local broker lifecycle when `PI_NORTHSTAR_BROKER_PROJECT_ID` is set to an exact project ID. On `session_start`, Pi starts the broker only when no healthy owner already exists; on `session_shutdown`, it aborts the broker and local runtime. This opt-in is independent of `PI_NORTHSTAR_LEAF_MODEL`, which remains the separate staged-agent steering configuration. Ordinary CLI/model-triggered job paths never auto-start broker authority.

**Production release readiness is still gated.** The local executor is not the privileged per-job isolation service. Signed installers, root/SYSTEM worker-service validation, per-job identity isolation, kill-to-zero proof, and the remaining Tier-2 checks stay open in `docs/tier2-proof.md`. Published/production stateful claims must not treat the unsigned source-checkout path as that proof.

## Development

```bash
npm run typecheck
npm test
npm run build
git diff --check

# Broker changes
cargo test --manifest-path rust/Cargo.toml --workspace
```

For changes to contracts, credentials, provider routing, browser/desktop mutation, or the broker, read `AGENTS.md` before editing.

## Documentation map

- `AGENTS.md`: repository-wide engineering and security contract.
- `SKILL.md`: compact agent router for choosing the right Northstar surface.
- `skills/*/SKILL.md`: per-domain CLI contracts and syntax.
- `.env.example`: primary configuration catalogue and privacy-sensitive opt-ins.
- `docs/architecture.md`: target architecture and authority model.
- `docs/roadmap-ledger.md` and `docs/plans/`: staged redesign/release state. Treat planning prose as weaker truth than reachable code.
- `docs/adr/`: focused architecture/security decisions.
- `docs/tier2-proof.md`: privileged broker/release proof plan.