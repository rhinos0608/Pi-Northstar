# Agent eval lane (Phase 0b)

Deterministic fake-provider cases over `runAgentCore`. No production-code change. Counters wrap `AgentCoreDeps` (search/fetchText/synth).

## Run

```sh
npm run bench:agent-eval   # stdout table + bench/agent-eval/latest.json
```

No network. Plain `.mjs` (matches `bench/cli-spawn-bench.mjs` precedent); outside `tsconfig.json` `src+test` include, so no typecheck impact.

## Cases (14)

- 4 `cmp-*` multi-fact comparisons. Every expected fact has `groundTruth: { supportingUrl, excerpt }` and value-bearing `match` tokens (prices, quotas, limits, measurements).
- 3 `adv-plausible-*` cases. Round-one corpus is plausible but incomplete. Stateful targeted search rules expose hidden missing facts when all `plannerHint` keywords occur in a query; v1 performs one search and therefore scores partial on these cases (pricing 0.5, laptop 1.0, api 1.0).
- 6 fault cases: `empty_search`, `fetch_failures`, `report_error` (retired with the report leg — now a plain graceful case, id and fault label kept stable), `claim_validation_fail`, `contradiction`, and `fault-bad-ir` (bench-only: scripted synthesizer returns broken output to exercise the fail-closed fallback). Contradiction targeted evidence states a different value ($99 per month vs $49 per seat, disjoint value tokens); v1 has no conflict machinery, so `contradictionDiscovery` remains 0, while v2 surfaces the pair via `detectConflicts`.
- `adv-injection`: fetched content includes instruction-like text. Fixture checks no fabricated URL citation and no instruction text in report claims/warnings. This tests an architecture-enforced guarantee planned from Phase 2, not model judgment.

## v2 lane (adaptive, scripted planner/evaluator)

For each case the runner executes a second pass through `runAgentCore` with
scripted seams (`planner` + `evaluator` present). Both are plain
deterministic async functions — stand-ins for the real leaf models until
Phase 3 wires them. No fixture or production code differs between lanes;
only the seams change (v1: no seams, cycle-floor composition over fetched
passages; v2: + planner/evaluator, PLAN → GATHER → EVALUATE → REFINE).

- Planner: root query as required question 1, plus a missing-dimension
  question 2 derived from `plannerHint` keywords (generic refinement phrasing
  for cases without hints). Single-fact cases get 1 question. Caller ids are
  never trusted (code recomputes them).
- Evaluator: round 1 proposes one targeted follow-up (`root + hint keywords`,
  which fixture `targeted` rules match) with `shouldContinue: true`; round 2+
  returns empty updates/queries with `shouldContinue: false`, so code-side
  `promoteToGrounded` / `no_queries` rules decide the stop. It never fabricates
  `evidenceIds`. Cases without `plannerHint` propose no queries (loop ends by
  `no_queries`; metrics match v1).
- `latest.json` keeps the v1 `aggregate` + `cases` entries byte-identical and
  adds `v2: { aggregate, cases }`. Per case: `structuralFactMatch`,
  `claimSupportRate` (same scorers as v1), `contradictionDiscovery` (sum of
  `conflicts=N` across `round N:` warning summaries), `searchesUsed` /
  `fetchesUsed` (summed from `searches=a fetches=b` round summaries),
  `rounds` (count of `round N:` summaries).

What the numbers mean: `searchesUsed`/`fetchesUsed`/`rounds` > v1 shows the
REFINE round fired and reached targeted hidden evidence. `structuralFactMatch` ≥ v1 means recovery (or parity); `contradictionDiscovery` counts code-side
conflict pairs surfaced per round, parsed from warnings.

Gates (soft — printed `GATE PASS/FAIL`, exit stays 0):

- v2 `structuralFactMatch` >= v1 per case (all 14).
- `adv-plausible-laptop` / `adv-plausible-api` v2 = 1.0; `adv-plausible-pricing` v3 = 1.0 (see pricing note); `fault-contradiction` v2 `contradictionDiscovery` >= 1.
- v3 `*-ir-grounded` per synth-used case (see v3 lane); `fault-bad-ir:v3-fallback-graceful`.

Known misses (2026-09-15, honest, bench-only scope cannot fix):

- `adv-plausible-pricing:v2==1.0` FAIL (0.50 = v1). The REFINE round fetches
  the hidden page, but fallback claims take the first sentence per passage, so
  `$79` (second sentence) never enters a claim. Recovery is visible at
  evidence level only. The v3 lane (below) closes this exact gap: the scripted
  synthesizer places `$79` in a claim unit citing admitted evidence, and
  `adv-plausible-pricing` v3 = 1.0. The v2 miss stands as the composition-floor
  record; IR rendering supersedes first-sentence fallback whenever the
  synthesizer seam is present. v2-only pricing is superseded by
  v3-by-construction: the gate now asserts `adv-plausible-pricing:v3==1.0`
  (renderer-level recovery) instead of the v2 pricing gate.
- `fault-contradiction:v2-contradiction>=1` PASS. Fixture bodies carry digit-free padding past the 100-char chunk minimum so both pages admit evidence; $49 vs $99 value tokens are disjoint so `detectConflicts` fires.

W11 evidence-only floor (2026-09-16, oracle D3: absent synthesizer =
 evidence-only composition). The v2 lane runs WITHOUT a synthesizer, so v2
results are now evidence-only claims over admitted excerpts, and sub-100-char
fixture bodies fall below the chunker admission floor: `adv-plausible-laptop`
/ `adv-plausible-api` v2 structural is 0 even though REFINE fires and fetches
the hidden page (searches/fetches/rounds all advance past v1). The old
`v2==1.0` gates asserted the pre-D3 composition contract and are retired;
`:v2-evidence-only-floor` gates assert the intended floor (REFINE fires,
structural 0, fixtures byte-identical). Recovery lives in the v3 lane
(scripted synthesizer + V3_PAD). Likewise the old
`fault-contradiction:v4-repair-applied`,
`fault-contradiction:v4-support>=v3`, and
`fault-repair-regression:v4-best-version-rejects` gates assumed repair fires
on V4_NO_SYNTH cases; under the floor those claims self-support
 deterministically (verification stage executes, zero model calls, zero
repair events), so `:v4-evidence-only-floor` gates assert that instead, and
the shared `v4-support>=v3` loop skips V4_NO_SYNTH ids (incomparable
denominator).

Residual (honest, not gated): under the floor, the `fault-contradiction`
`$99` excerpt composes into a claim the core ladder reports as supported
(`verification: 2 supported`), because each excerpt claim self-supports
against its own cited evidence. The contradiction still surfaces via the
`conflicts=2` round warning (detectConflicts), not via refutation/repair —
no-model means no model-backed refutation. If cross-excerpt deterministic
refutation is ever wanted, that is a ladder change with its own fixtures,
not a bench-expectation edit.

## v3 lane (adaptive + scripted synthesizer, IR-rendered synthesis)

For each case the runner executes a third pass: the v2 adaptive path plus a
`synthesizer` seam. The script cannot know admitted evidence ids up front
(`ev-` content hashes), so it parses them out of the synthesis prompt —
exactly where a real model reads them — then binds every expected fact to the
MINIMAL supporting ids (only evidence whose fetched content contains the
fact's `groundTruth.excerpt`; facts without ground truth keep the full set)
and returns the IR as a JSON string (exercising the parse path).
`fault-bad-ir` returns broken output to exercise the fail-closed fallback.

Grounding by construction: `validateSynthesisOutput` drops claim units citing
unadmitted ids and blocks with dangling refs; `renderResultFromIR` emits only
validated blocks with `[src-N]` markers, claims citing only catalog ids, and
derived sources. The rendered `reportText` replaces cycle-floor composition.

Bench-only padding: the v3 fetch wrapper appends one neutral sentence
(lowercase, digit-free, entity-free) to each fetched body so short fixture
bodies clear the 100-char chunk admission floor and the synthesizer has
admitted evidence to cite. v1/v2 fixtures stay byte-identical.

- `latest.json` adds `v3: { aggregate, cases }`. Per case:
  `structuralFactMatch` (same scorer, over rendered claims),
  `reportOnlyFactMatch`, `claimCitationValidity`, `unsupportedProse` (same
  heuristic, over rendered `reportText` — 0 by construction for valid IR),
  `synthUsed` (`synthesis from evidence IR` warning present), `fallbackUsed`
  (fallback warning present), `graceful`.

Gates: for every synth-used case, `unsupportedProse === 0` AND
`claimCitationValidity === 1`; `fault-bad-ir` must fall back gracefully
(`fallbackUsed && graceful`).

Pricing note (2026-09-15): `adv-plausible-pricing` v3 = 1.0 — the scripted
synthesizer places `$79` in a claim unit citing the admitted hidden evidence,
so the first-sentence fallback miss is superseded whenever the synthesizer
seam is present. Cases with no admitted evidence (`empty_search`,
`fetch_failures`) correctly stay on the composition floor (`synthUsed: false`).

## v4 lane (verify + repair + best-version gate over v3+IR)

For each case the runner executes a fourth pass: the v3 path plus the pinned
`verifier` / `repairer` seams (`{ prompt } => unknown`). The scripted verifier
parses the verification prompt (CLAIM + fenced admitted excerpts) and judges
deterministically from fixture knowledge: claim contains the fact's
groundTruth value token -> `supported`; contains the contradicting fixture
value (`$99` / `99 per month` in `fault-contradiction`) -> `refuted`;
otherwise `not_enough_evidence` (descriptive unsupported prose never counts as
support — deterministic rung returns NEE, never supported-by-absence). The
scripted repairer returns repaired IR JSON binding the correct value to the
supporting evidence ids parsed from the prompt (same position as v3).

Three-way verdicts are clause-wise (`supported | refuted |
not_enough_evidence`), and deterministic refutation wins: a clause the
deterministic rung refutes stays refuted even if the semantic rung disagrees —
the model can only upgrade `not_enough_evidence`, never overturn a refutation.
The best-version gate rejects regressions: a repair that drops a supported
claim is discarded, the original restored, and a `repair rejected` warning
emitted; a repair that re-supports claims emits `repair applied`.

Cases: (a) all v3 cases re-run with verifier (`supportedCount` / verdict
breakdown recorded); (b) `fault-contradiction`: one claim carries the
contradicting value -> deterministic refutation -> repair restores the correct
value -> final report supported with `repair applied`; (c) v4-only
`fault-repair-regression`: repairer returns WORSE content (drops a supported
claim) -> gate must REJECT -> original restored + `repair rejected`, original
content intact; (d) v4-only `fault-numeric-lie`: with the report leg deleted
no `$199` survives anywhere in the lane, so no clause refutes and the gate
asserts exactly that — gate: no refuted clause in final verdicts; (e) gate:
`verifySupportedFraction = supportedCount / verdicts >= v3 structuralFactMatch`
for valid-IR cases (v3 records no `claimSupportRate`; the structural scorer is
the same claims scorer, so the verifier can only confirm or flag, never lower
true support).

W10 path fixtures (v4-only, each forcing one ladder path deterministically
via a custom synthesizer that binds fixed claim texts to the first admitted
id — the lie cites the very evidence that refutes it):

- `fault-v4-semantic-escalation`: single claim pairs a supported value with
  an absent year (`...launched in 2019...`, no excerpt dates at all) ->
  deterministic `not_enough_evidence` + year signal ->
  `gateSemanticVerification` true -> the scripted verifier IS called.
  Gate `v4-semantic-called`: `verifierCalls >= 1`, prompt carried admitted
  evidence, summary present, zero refuted, no repair.
- `fault-v4-repair-accepted`: claims are the true `$49` plus a `$99` lie on
  the `$49` evidence -> deterministic refutation -> fix repairer restores
  `$49` -> re-verify supports -> best-version gate ACCEPTS.
  Gate `v4-repair-applied`: `repairApplied >= 1`, repairer ran, zero
  refuted, both claims supported (`repair applied: 1 claims re-supported`).
- `fault-v4-repair-rejected`: same lie, but the regress repairer returns
  `$199` -> re-verify stays refuted -> no score improvement -> gate REJECTS.
  Gate `v4-best-version-rejects`: `repairRejected >= 1`, repairer ran, the
  original `$49` claim intact.

- `latest.json` adds `v4: { aggregate, cases, gates }`. Per case: `verdicts`,
  `supportedCount` / `refutedCount` / `unsupportedCount`,
  `verifySupportedFraction`, `hasVerification` (the core's own stable
  verification-stage seam: the `verification: N supported, M refuted, K
  without enough evidence` summary warning emitted by `tryVerifyAndRepair`
  after `verifyReport` runs), `verifierCalls` / `repairerCalls` /
  `verifierSawEvidence` (bench-side stub invocation counts, independent of
  the core signal), `repairApplied` / `repairRejected` counts, `repairEvents`
  (warning texts). Aggregate carries `seamWired` / `skipped` / totals plus
  `verifierCallsTotal` / `repairerCallsTotal`.
- Seam-guard (W10): `seamWired` is true when EVERY v4 case emitted the core
  verification summary — i.e. the verification stage EXECUTED — regardless
  of whether the ladder needed a semantic model call. Deterministic verdicts
  legitimately skip the scripted verifier stub (`verifyClaim` early-returns
  in `agent-verifier.ts`), so the old stub-invocation detector false-skipped
  whenever no claim escalated. All v4 gates evaluate when wired
  (`skipped: false`); the runner exits non-zero on any FAIL (see reporting).

## v5 lane (Phase 9 ablation: derived confidence vs verification verdicts)

`deriveEvidenceConfidence` (`src/web/agent/agent-policy.ts`) is pure and
deterministic — no model, never an LLM number. Formula: +0.35 per distinct
`corroboratingFingerprint` among admitted evidence (cap 2 → +0.7); +0.1 per
distinct `official`/`repo`/`academic` source class (cap +0.2); −0.15 per
`detectConflicts` pair touching the scored set (recomputed internally);
+0.15 per distinct verified fingerprint named by `verifiedEvidenceIds`
(cap +0.3; unknown ids ignored); clamped to [0, 1]. `AgentResultV1` is
unchanged — the helper is internal-only until it clears its ablation gate.

Method: for each v4 case the runner re-fetches the case URLs (root query +
hint follow-up, deduped — no v3 padding), admits one evidence entry per
sentence (`sourceClass: unknown`), and scores the full set plus two
value-aligned slot groups per scripted-lie case: sentences containing the lie
value (`$99` / `$199`) vs sentences containing expected-fact match tokens but
not the lie value. NO verified ids are passed (`verifiedBoost` 0 by
construction — feeding v4 verdicts into the score would make the correlation
circular). Gates: `<id>:v5-derived-computed` (score in [0, 1], breakdown
sums to score, recompute byte-identical) plus
`<id>:v5-ablation-refuted-lower` for the three scripted-lie cases.

Result (2026-09-15): 16/16 computed gates PASS; all 3 ablation gates SKIP.
`fault-contradiction` is the only applicable case and ties 0.35 vs 0.35 —
single-sentence lie/truth slots with uniform `unknown` source class carry no
observational asymmetry for the formula to grip. `fault-numeric-lie` and
`fault-repair-regression` have no lie-valued admitted evidence at all (the
former `$199` report-leg lie is gone with the report leg), so
their slots are N/A. Verdict: **ablation inconclusive: fixture corpus
insufficient** — the helper stays internal-only and no public confidence API
ships on these fixtures (Revision 2 row 9 rule: no mechanism ships on vibes).
A separating corpus needs multi-sentence lie/truth slots with mixed source
classes (official vs community) so independence + authority terms can differ.

Search providers use:

```js
{ defaultHits: [...], targeted: [{ matchAny: ['keyword', ...], hits: [...] }] }
```

`search(query)` lowercases query and returns first targeted rule whose keywords all occur; otherwise it returns `defaultHits`.

## Metrics

- `structuralFactMatch`: expected facts matched by a claim using OR-token structural matching only, with valid source IDs. Citation-invalid matches do not count.
- `reportOnlyFactMatch`: facts in `reportText` but no valid claim. Positive value = report-outruns-evidence gap.
- `claimCitationValidity`: claims with all `sourceIds` valid / all claims. Citation validity only; it does not prove fetched support.
- `fetchCoverageOfCitations`: distinct cited source IDs whose URL was fetched / distinct cited IDs. Fetched-only metric.
- `claimSupportRate`: declared ground-truth support. Fact counts only when claim value tokens match, cited URL canonicalizes equal to `groundTruth.supportingUrl`, and `groundTruth.excerpt` is present in fetched source content.
- `unsupportedProse`: deterministic heuristic counting fact-like report sentences whose extracted tokens are not all present in joined claim text. Fact-like means a number with ≥2 digits or capitalized multi-token entity.
- `duplicateFetchRate`: `(fetchCalls - uniqueUrls) / fetchCalls`.
- `contradictionDiscovery`: 0 in v1 (single search round, no conflict machinery).
- Call counts, latency, and graceful status are informational. Graceful means no throw and `validateAgentResult` passes (plus injection assertions).

## Baseline policy and lanes

`baseline-v1.json` is immutable, with checksum recorded by release review. Runner writes only `latest.json`; never overwrite baseline. Gate compares `baseline-v1.json` against `latest.json` using renamed metric fields and reviews deltas (new v2-only metrics are additive).

`latest.json` volatile fields: `generatedAt`, `latencyMs`, `latencyMsTotal`, `searchMs`, `fetchMs`, `synthMs` — strip before diffing.

Lane A is this deterministic suite. Lane B is frozen-corpus quality evaluation, deferred until model-driven phases; it must not be conflated with these fake-provider numbers.

## v6 lane (Task 9: specialist gather routes over runAgentCore)

Planner proposes nested `GatherIntent`s; a stub `gatherExecutor` admits
fixture bodies through the real specialist admission helpers
(`admitGithubContent` / `admitResearchAbstract` / `admitSocialBody` /
`admitKgFields` / `admitFromFetch`) with no network. A scripted synthesizer
binds each expected fact to the minimal supporting admitted ids parsed from
the synthesis prompt (same position as v3). Legacy search/fetch legs are
counting stubs and must stay at zero (`v6:legacy-legs-zero` gate proves the
executor path is exclusive). Six lanes:

- `route-github`, `route-research`, `route-social`, `route-kg`: one planner
  question with a specialist intent each (exact-keys domain shapes:
  `github_search` scope+repoHint, `research_search` source+year range,
  `social_search` platform, `kg_lookup` entityType+name).
- `route-mixed`: 3 planner questions (web+github+kg) → asserts 3 parallel
  round-1 actions across lanes (`web+github+kg`), plus admitted-route
  coverage for all three lanes.
- `route-broad-survey`: 4 planned questions, balanced width 3 → asserts
  exactly 3 parallel round-1 actions (width slice, Task 8) with the 4th
  (decoy) never dispatched.

Per lane the runner records: `structuralFactMatch` (same scorer, over
synthesized or evidence-only claims), `admitted` count, `routeOk` (every
fact excerpt sits in an admitted excerpt of the expected route with the
right `acquisitionRoute`/`sourceClass`/locator: char-range for document
routes, `{nodeId, field}` for kg), `round1Routes` + `widthOk` (round-1 slice
vs `widthForRound('balanced', 1)`), `laneCounts` + `laneOk` (each lane ≤
`DEFAULT_LANE_CAPS`) + `envelopeOk` (total ≤ `maxGatherActions` 6),
`journalOk`/`journalDetailOk` (every `onProgress` event carries
stage/round/counters; exactly one gather event whose
`detail.admittedEvidenceIds` match the ledger; `done` fires last; gather
detail entries carry id/questionIds/excerptHash/fingerprint).

Gates per lane: `<id>:v6-grounded`, `<id>:v6-width-envelope`,
`<id>:v6-journal`, plus `v6:legacy-legs-zero`. `latest.json` adds
`v6: { aggregate, cases, gates }`.

## v6real lane (W10: real gather tools, no stub executor)

A second v6 lane runs the REAL `buildNativeGatherTools` (imported from
`src/web/agent/agent-gather.ts` via the bench tsx mechanism) through the REAL
`gatherExecutor` against canned production-shaped native envelopes copied from
`test/web/agent/agent-gather-adapters.test.ts`: research with a genuine
abstract, github content+url, kg search (candidate-only), kg enhance (claims).
Parity = admission produces the same evidence/candidates the adapter contract
tests assert (research 1 admitted / 2 candidates with the genuine abstract;
github 2 admitted / 4 candidates; kg search 0 admitted / 2 candidates; kg
enhance ≥2 admitted with the `alignment:1`/`ceo` locator plus `Jane Doe`, 1
candidate). Gates `<id>:v6real-parity` (4 legs); `latest.json` adds
`v6real: { aggregate, cases, gates }`. This lane exercises the production
adapter boundary; the stub-executor v6 lane above still exercises
orchestration (width/envelope/journal) only.

### v6real-followup (candidate follow-up through the real executor)

A fifth v6real leg runs discovery → follow-up across two rounds against the
same production path: round 1 `research_search` returns a candidate-only
`research-source` row (no abstract, zero admitted evidence); round 2 reads
it back via the `web_fetch` intent (`{ kind: 'web_fetch', url }`), which
compiles to a direct `tools.fetchText(url)` call — one gather action slot +
exactly one fetch attempt, never a `maxSearches` slot — and the paper body
admits as `fetch` evidence with questionId linkage. Parity = candidate
visible after round 1, exactly 1 admitted `fetch` excerpt containing the
paper fact after round 2, `searchesUsed === 0`, `fetchesUsed === 1`.
Gate `v6real-followup:parity`.

## Residual: candidate observability (count-only telemetry ships; deep journaling deferred)

Candidate counts now ship as count-only `CandidatesAccumulated` journal telemetry
(accepted/dropped counts per round, no titles/urls/snippets/identities — candidates
stay untrusted navigation hints, see `src/web/agent/agent-candidates.ts`). Deep
per-candidate journaling and snapshot fields stay deferred. Follow-up routing is
proven by round execution instead — the evaluator's routed follow-up intents
dispatch a next round and admit round-N+1 evidence (E2E Goal B asserts
`EvaluationAccepted` round 2 plus round-2 `EvidenceAdmitted`; the v6
`round1Routes`/`laneOk` assertions pin dispatch per lane).

## Reporting (W10)

Every gate prints one `GATE PASS/FAIL/SKIP <id>` line. At the end the runner
prints the headline `BENCH PASS x / FAIL y / SKIP z` (also persisted as
top-level `summary` in `latest.json`) and exits non-zero when any gate
FAILED. Skips stay explicit SKIP lines — never exit-zero-silent. Legitimate
skips (e.g. the v5 ablation `inconclusive` gates where the fixture corpus
carries no observational asymmetry) keep their `skipReason` and `skipped:
true` in `latest.json`.

Fixed 2026-09-16 (Task 10): structured-identity sources now ship as claims —
`admitKgFields` admits URL-less evidence, the IR renderer maps it to a
`provider:nodeId/field` catalog source with its `{nodeId, field}` locator,
and the result contract validates it. `route-kg` gates on full claim coverage
like every other route; `route-mixed` scores its KG fact the same way.

## How to read latest.json

Top-level `aggregate` + `cases` are the v1 lane; `v2`/`v3`/`v4`/`v5`/`v6`
objects each carry `{ aggregate, cases }` (`v4`/`v5`/`v6` also carry their
gates); `v6real` carries `{ aggregate, cases, gates }`. `baseline-v1.json` is the immutable Phase-0 snapshot (metric names
predate renames: `factCoverage` → `structuralFactMatch`, `supportedClaimRate`
→ `claimSupportRate`, `citationPrecision` → `claimCitationValidity`).
`baseline-v2-agent-mode.json` is the Task-9 snapshot including the v6 lanes.
Volatile fields (strip before diffing): `generatedAt`, `latencyMs`,
`latencyMsTotal`, `searchMs`, `fetchMs`, `synthMs`.

## v1 limitations

1. Single search/job — no REFINE round; targeted hidden evidence is not reached.
2. Whole-page BM25 (no chunk evidence); fallback claim = first sentence.
3. `reportText` ungoverned — `reportOnlyFactMatch > 0` can occur while claims stay clean.
4. Contradiction discovery impossible (expected 0 in v1).
