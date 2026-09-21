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
| `broker` / `jobs` | `serve`, `status` | local stateful authority; no cloud API key |

The current CLI exposes **28 stateless command IDs** plus `broker.serve` and `jobs.status`. Domain syntax belongs in `skills/<domain>/SKILL.md` and the live `--help` output.

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
| Web fetch | native page reader, PDF/media/RSS specialization; Scrapling when locally installed | Firecrawl/Jina external processing when explicitly enabled |
| Research | Semantic Scholar, OpenAlex, PubMed, Stack Overflow, DataCite, ROR, GDELT, Wikipedia, Wikidata, arXiv, Crossref, Hacker News | optional source keys raise quotas |
| GitHub | public REST reads | `GITHUB_TOKEN` / `GH_TOKEN` for private content and better limits |
| RSS / Atom | full feed reads | none |
| V2EX | legacy public reads | `V2EX_PAT` unlocks API 2.0-only reads such as notifications |
| YouTube | limited details via oEmbed; degraded transcript path via watch page/timedtext | `YOUTUBE_API_KEY` for official search/hot/details; explicit cookie import can help consent-gated transcripts |
| SPARQL graph | no API key is required, but an operator `GRAPH_SPARQL_ENDPOINT` is required | optional `GRAPH_SPARQL_TOKEN` bearer auth |
| Browser | isolated local browser path when its dependency is available | user-Chrome companion requires pairing plus explicit `/chrome authorize` |
| Desktop | no API key | `PI_SEARCH_DESKTOP_AUTOMATION=1` plus the installed Cua Driver |
| Vision | a local OpenAI-compatible endpoint may be keyless | cloud OpenAI-compatible/Gemini routes require explicit destination config and credentials/project auth |

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
- Cloud vision sends admitted image/PDF/video bytes and derived text to the configured destination.
- Private/authenticated GitHub material cannot reach cloud vision unless `PI_VISION_PRIVATE_GITHUB_TRANSFER=1` is also set.

See `.env.example` before enabling those routes.

## Browser, desktop, and setup authority

`/reach-status`, `/reach-setup`, and `/chrome` are **user slash commands**, not model tools. Cookie import and login never happen at startup or because an environment variable happens to exist. They require explicit operator actions such as `/reach-setup import_cookies ...`, `/reach-setup login ...`, or `/chrome authorize`.

Browser navigation enforces URL/origin policy and treats remote content as untrusted evidence. Desktop mutation requires fresh observed state; sensitive keyboard input requires human confirmation. Social write capability is deny-by-default and no provider is currently allowlisted for writes.

## Stateful broker

The working tree currently exposes:

```bash
northstar broker serve --project-id <id> [--root-dir <dir>]
northstar jobs status --project-id <id> --request-id <id> [--root-dir <dir>]
```

These commands make the local broker grammar testable, but **public release readiness is still gated**. Gate B Tier-1 is implemented; privileged Tier-2 proof and signed installer/service validation remain open in `docs/tier2-proof.md`. Treat broker commands as local/development surface until those release gates are closed and the plan is reconciled with the executable tree.

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
- `architecture.md`: target architecture and authority model.
- `plan.md`: staged redesign/release plan. Treat it as planning state, not stronger truth than reachable code.
- `docs/adr/`: focused architecture/security decisions.
- `docs/tier2-proof.md`: privileged broker/release proof plan.