# Northstar capability-exposure matrix (Phase 6 groundwork, audit only)

Status: audit only. Counts refreshed against current source and test evidence.
Baseline: plan.md Phase 6 classes: CLI+skill / explicit native-tool-only / dual / workflow-only / internal-only / intentionally-removed.
Rule used: trace registered route before claiming. "Registered" = `pi.registerTool` call in `src/index.ts` / `src/github/github.ts` gated by `PI_SEARCH_NATIVE_TOOLS` allowlist (`src/capabilities.ts`). "CLI" = `northstar <domain> ...` grammar in `src/cli/cli.ts`. "Skill" = entry in `src/skills/skill-registry.ts` + `skills/` file. "Legacy dispatch" = reachable ONLY via `callNativeTool` direct branch (`src/native-tools.ts`), `callReachTool` (`src/reach-tools.ts`), or raw `northstar call` / private worker (`src/cli/cli.ts:43-46`, `src/cli/worker.ts:12`) with no registry/CLI/skill coverage.

## Matrix

| Capability | Registered native tool? | CLI? | Skill? | Class | Route (actual code) | Migration gap? |
|---|---|---|---|---|---|---|
| `search.web` (`web_search` plain single/batch) | yes — `src/index.ts:395` `pi.registerTool({name:'web_search'...})`, allowlist-gated (`:334`) | yes — `northstar search QUERY` (`src/cli/cli.ts` → `executeSearchWeb`) | yes — `DOMAIN_SKILLS` + `skills/search/SKILL.md` | dual | registry `search.web` → handler (`src/commands/search-web-handler.ts`); CLI + native share handler | no — migrated seam (Phase 4 parity accepted) |
| `fetch.read` (`fetch` 5-branch union) | yes — `src/index.ts:412` `pi.registerTool({name:'fetch'...})` | yes — `northstar fetch URL` (`src/cli/cli.ts` → `executeFetchRead`) | yes — `DOMAIN_SKILLS` + `skills/fetch/SKILL.md` | dual | registry `fetch.read` → handler (`src/commands/fetch-read-handler.ts`); CLI + native share handler | no — migrated seam (Phase 4 parity accepted) |
| `github.file` | yes — `src/github/github.ts:106` `pi.registerTool({name:'github'...})`, routed via `commandHandler('github.file')` for file/repo/tree/trending/search/search_repos (`src/native-tools.ts:80-83`) | yes — `northstar github file` (`src/cli/cli.ts:158-212` → `executeGithubFile`) | yes — `DOMAIN_SKILLS` + `skills/github/SKILL.md` | dual | registry `src/commands/command-registry.ts:14-21` → handler → same contract/domain; CLI + Pi adapter share handler | no — migrated seam (Phase 1 slice) |
| `github.repo` | yes (same `github` tool, command-routed) | yes — `northstar github repo` | yes | dual | `commandHandler('github.repo')` / `executeGithubRepo` | no |
| `github.tree` | yes (command-routed) | yes — `northstar github tree` | yes | dual | `commandHandler('github.tree')` / `executeGithubTree` | no |
| `github.trending` | yes (command-routed) | yes — `northstar github trending` | yes | dual | `commandHandler('github.trending')` / `executeGithubTrending` | no |
| `github.search` (code) | yes (command-routed) | yes — `northstar github search` | yes | dual | `commandHandler('github.search')` / `executeGithubSearch` | no |
| `github.search_repos` | yes (command-routed) | yes — `northstar github search-repos` | yes | dual | `commandHandler('github.search_repos')` / `executeGithubSearchRepos` | no |
| `github.issues` | yes (same `github` tool, command-routed) | yes — `northstar github issues` | yes | dual | `commandHandler('github.issues')` / `executeGithubIssues` | no |
| `github.pulls` | yes (command-routed) | yes — `northstar github pulls` | yes | dual | `commandHandler('github.pulls')` / `executeGithubPulls` | no |
| `github.releases` | yes (command-routed) | yes — `northstar github releases` | yes | dual | `commandHandler('github.releases')` / `executeGithubReleases` | no |
| `github.commits` | yes (command-routed) | yes — `northstar github commits` | yes | dual | `commandHandler('github.commits')` / `executeGithubCommits` | no |
| `github.workflows` | yes (command-routed) | yes — `northstar github workflows` | yes | dual | `commandHandler('github.workflows')` / `executeGithubWorkflows` | no |
| `github.runs` | yes (command-routed) | yes — `northstar github runs` | yes | dual | `commandHandler('github.runs')` / `executeGithubRuns` | no |
| `social.search` | yes — same `social` tool, routed via `commandHandler('social.search')` | yes — `northstar social search` | yes — `skills/social/SKILL.md` | dual | registry → handler → same contract/domain | no — migrated seam |
| `social.read` (all ten canonical reads) | yes — same `social` tool, routed via `commandHandler('social.read')` | yes — `northstar social read` | yes — `skills/social/SKILL.md` | dual | registry → handler → same contract/domain | no — migrated seam |
| `media.search` | no public tool (internal/CLI acquisition) | yes — `northstar media search` | yes — `skills/media/SKILL.md` | CLI+skill | registry → handler → same media contract/domain | no — migrated seam |
| `media.hot` | no public tool (internal/CLI acquisition) | yes — `northstar media hot` | yes — `skills/media/SKILL.md` | CLI+skill | registry → handler → same media contract/domain | no — migrated seam |
| `media.details` | no public tool (internal/CLI acquisition) | yes — `northstar media details` | yes — `skills/media/SKILL.md` | CLI+skill | registry → handler → same contract/media path | no — migrated seam |
| `media.transcript` | no public tool (internal/CLI acquisition) | yes — `northstar media transcript` | yes — `skills/media/SKILL.md` | CLI+skill | registry → handler → same contract/media path | no — migrated seam |
| `media.feed` | no public tool (internal/CLI acquisition) | yes — `northstar media feed` | yes — `skills/media/SKILL.md` | CLI+skill | registry → handler → same contract/media path | no — migrated seam |
| `research.search` (12 sources) | no standalone public tool by design | yes — `northstar research search` | yes — `skills/research/SKILL.md` | CLI+skill | registry → handler → pinned source adapters; native/agent calls route same handler | no — migrated seam |
| `research.paper` | no standalone public tool by design | yes — `northstar research paper` | yes — `skills/research/SKILL.md` | CLI+skill | registry → handler → pinned source adapters; native calls route same handler | no — migrated seam |
| `research.citations` | no standalone public tool by design | yes — `northstar research citations` | yes — `skills/research/SKILL.md` | CLI+skill | registry → handler → pinned source adapters; native calls route same handler | no — migrated seam |
| `kg.search` | yes — `kg` tool | yes — `northstar kg search` | yes — `skills/kg/SKILL.md` | dual | registry → shared KG execution seam; native and CLI share fanout/spend/assembly | no — migrated seam |
| `kg.enhance` | yes — `kg` tool | yes — `northstar kg enhance` | yes — `skills/kg/SKILL.md` | dual | registry → shared KG execution seam; native and CLI share fanout/spend/assembly | no — migrated seam |
| `graph.query` | yes — conditional `graph` tool | yes — `northstar graph query` | yes — `skills/graph/SKILL.md` | dual | registry → handler → `callGraphTool`; native query uses handler | no — migrated seam |
| `graph.probe` | yes — conditional `graph` tool | yes — `northstar graph probe` | yes — `skills/graph/SKILL.md` | dual | registry → handler → `callGraphTool`; native probe uses handler | no — migrated seam |
| `broker.serve` | no (operator infrastructure, never a model tool) | yes — explicit foreground local/development command | no | CLI local-dev infrastructure | `brokerServeCommand` → `startBrokerHost` → Rust broker + same-user local runtime executor; never auto-started by ordinary job commands | production signing/isolation gate remains open |
| `jobs.start` | no | yes — local/development | no | CLI local-dev | `jobsStartCommand` → existing `BrokerClient` → runtime `start`; durable receipt is written before dispatch and bound to returned runtime job ID after verified ack | production isolation gate remains open |
| `jobs.status` | no | yes — local/development | no | CLI local-dev | `jobsStatusCommand` → durable receipt query → runtime `status`; preserves `outcome_unknown` and stale/not-found distinctions | production isolation gate remains open |
| `jobs.result` | no | yes — local/development | no | CLI local-dev | `jobsResultCommand` → receipt-owned runtime `result` | production isolation gate remains open |
| `jobs.cancel` | no | yes — local/development | no | CLI local-dev | `jobsCancelCommand` → receipt-owned `cancelAndSettle`; broker denies unowned run IDs and forwards the runtime reply without inventing settlement labels | production isolation gate remains open |
| `tcb.manifest` | no (driver gate infrastructure) | no (CLI enrollment script `scripts/enroll-artifacts.mjs`) | no | internal-only | `verifyDriverArtifact` in `src/desktop/driver-manifest.ts` (Slice 10/12, Gate B Tier-1 complete, verify-if-enrolled) | no — security gate infrastructure |

## Phase 4 exit-gate audit (checked)

Evidence anchors: registry and all 28 handler registrations are `src/commands/command-registry.ts:36-65`; exposure/CLI grammar/help/optional Pi metadata are `src/skills/skill-registry.ts:12-328`; caller-neutral contract is `src/commands/command-context.ts:4-19`; result mapping/validation is implemented by each listed `src/commands/*-handler.ts` and validated through `command-result.ts`; native routing guard is `src/native-tools.ts:90-125` (registry-first, terminal on handler failure). Pi GitHub routing is also explicit at `src/github/github.ts:117-120`. `test/architecture-gate.test.ts` verifies dependency direction; `test/native-tools-routing-regression.test.ts` verifies bypass closure.

| Command id | (a) registry/exposure/handler/outcome/CLI+help/Pi parity/bypass | (b) native-tools/Pi-schema dependence | Result |
|---|---|---|---|
| `github.file`, `github.repo`, `github.tree`, `github.trending` | yes; handler + CLI/skill metadata; Pi and native registry route | registry-first shell; adapter schemas only | PASS |
| `github.search`, `github.search_repos`, `github.issues`, `github.pulls` | yes; same evidence | registry-first shell; adapter schemas only | PASS |
| `github.releases`, `github.commits`, `github.workflows`, `github.runs` | yes; same evidence | registry-first shell; adapter schemas only | PASS |
| `research.search`, `research.paper`, `research.citations` | yes; CLI+skill by design, native/agent adapter route same handlers; no standalone public tool | registry-first shell; no handler Pi-schema import | PASS |
| `social.search`, `social.read` | yes; all canonical read actions validated and native-routed | registry-first shell; no semantic fork | PASS |
| `media.search`, `media.hot`, `media.details`, `media.transcript`, `media.feed` | yes; CLI+skill handlers, internal acquisition only (no public native tool); shared handler path | registry-first shell; no semantic fork | PASS |
| `graph.query`, `graph.probe` | yes; CLI+skill and native query/probe share handlers | registry-first shell; graph schema legacy is outside migrated query/probe handler | PASS |
| `kg.search`, `kg.enhance` | registry/CLI/skill/native share provider plan and result assembly; cursor contract remains explicit rejection in CLI path and native fanout contract | shared `src/knowledge/knowledge-execution.ts` seam | **PASS** |

Audit total: 28 PASS, 0 FAIL across all 28 migrated command IDs (20 dual + 8 CLI+skill).
Focused fetch/route acceptance suite (`test/web/web-fetch-route-contract.test.ts`, `test/web/web-search-route-contract.test.ts`, `test/web/web-fetch-pi-parity.test.ts`, `test/web/web-search-pi-parity.test.ts`, `test/commands/fetch-read-handler.test.ts`, `test/commands/search-web-handler.test.ts`, `test/cli/fetch-search-cli.test.ts`, `test/web/access/web-access-contract.test.ts`): 65 pass, 0 fail.
Full test suite: 3,959 pass, 0 fail, 11 skipped. Build, typecheck, and git diff --check pass.
Isolated npm pack and clean install smoke (binaries, --help, --version, domains command, and published files manifest) pass.

## Gap list (migration gaps = reachable ONLY through legacy dispatch, ordered by Phase 4 priority)

Phase 4 order per plan: remaining GitHub → research-source → graph/KG → social → media → direct fetch/search.

1. GitHub remaining verbs (0): all 12 GitHub verbs migrated to dual handler/CLI/skill. Count: 0.
2. Research standalone verbs (0): search, paper, citations migrated to CLI+skill handlers. Count: 0.
3. Graph + KG reads (0): graph query/probe and KG search/enhance share migrated seams. Count: 0.
4. Social remaining actions (0): all ten canonical read actions route through `social.read`; search routes through `social.search`. Count: 0.
5. Media remaining actions (0): search, hot, details, transcript, feed all classified CLI+skill and share handlers; no public native tool. Count: 0.
6. Direct fetch/search verbs (0): search.web and fetch.read migrated to dual handlers; Phase 4 parity accepted. Count: 0.
7. Residual seams (browse and native-tools/cli-backend cache): internal-only legacy branches — explicit Phase 7 cleanup, not live registered forks. Count: 1.

Gap count: 0 capability rows with Phase 4 legacy semantic fork. Residual cleanup items (browse and unmigrated dispatch paths in `src/native-tools.ts` / `src/cli/cli-backend.ts`) are scheduled for Phase 7 authority deletion.

Migrated command breakdown: 28 command IDs total (20 dual + 8 CLI+skill). Workflow-only rows (by design, not gaps): 1 (agent orchestration; agent_poll poller is explicit native-tool-only support for it).

## Notes / uncertainty flags

- `browser`/`desktop`/`agent_poll` remain Phase 5 or workflow surfaces, not migrated Phase 4 command ids. Broker/jobs local-development grammar is reachable and tested, while production stateful release claims remain gated on the privileged installer/isolation/Tier-2 proof. No broker/job command becomes a model tool by being CLI-reachable.
- Social per-platform auth tiers are registry/provider concerns and were not changed by this audit.
- `browse` and residual branches in `src/native-tools.ts` remain internal cleanup targets for Phase 7 after zero-import proof.
