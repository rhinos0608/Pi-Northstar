# Plan E — Hardened GitHub Acquisition

> **For agentic workers:** Implement task-by-task. Own only listed files. Depends on Plan B (ledger/retention/env) + Plan D transfer flag (Gate 1 seams); **not independent**. No commits.

**Goal:** Clone-first repo/tree path, REST-first blob/file, strict process and filesystem safety.

## Task E1: Clone backend
**Outcome:** `gh` then `git`, fixed argv, `shell:false`, Plan B `buildNativeChildEnvironment()` + ephemeral 0700 credential helper, disabled hooks/filters/LFS smudge/recursive submodules, random 0700 root, unconditional cleanup, `GITHUB_TOKEN`/`GH_TOKEN` with `contents:read` guidance, **no anonymous retry after auth failure**.

**Files:**
- Create: `src/github/github-clone.ts`
- Create: `test/github/github-clone.test.ts` (fake git binary fixture; hook/config/filter smuggling argv-tested; env sentinel leak test; cleanup on abort)

**Checks:**
- `node --import tsx --test test/github/github-clone.test.ts`

## Task E2: Clone policy
**Outcome:** Defaults operator-lower-only: 350MiB repo, 30s clone, 10k files scanned, 64MiB eligible text, 1MiB/file, 200 tree entries. Reject `.git`, special files, binaries (metadata only), symlink escape; ref ambiguity/traversal/encoding/option-shape rejection. `gh` absent → REST-only degrade with warning.

**Files:**
- Create: `src/github/github-clone-policy.ts`
- Create: `test/github/github-clone-policy.test.ts`

**Checks:**
- `node --import tsx --test test/github/github-clone-policy.test.ts`

## Task E3: Domain routing + redirect + pre-decode gates (correct ownership)
**Outcome:** Backend preference per action: repo/tree = clone-first → REST fallback; blob/file = REST-first. Authenticated API rejects redirects (in `github-domain.ts` `githubFetch` `:188-201` + `src/core/http.ts` redirect policy). Base64 blobs byte/binary-gated **before** decode (fix `decodeFilePayload` `:304-315`, which decodes then caps with no binary sniff).

**Files:**
- Modify: `src/github/github-domain.ts` (routing + redirect reject + pre-decode byte/binary gate; register clone backend in `GithubBackendPlan` seam)
- Modify: `src/core/http.ts` (redirect policy for authenticated GitHub API)
- Modify: `src/github/github-contract.ts`, `src/github/github-request-contract.ts` (validation/backends only — no fetch/decode logic here)
- Modify: `test/github/github-contract.test.ts`; create `test/github/github-redirect-gate.test.ts`, `test/github/github-blob-gate.test.ts`

**Checks:**
- `node --import tsx --test test/github/`

## Task E4: Truncation → reject (GitHub scope) + cross-plan gates
**Outcome:** `capped()` slicing (`github-domain.ts:82,312-314,523`) replaced with reject + UTF-8 byte accounting. Private-clone → cloud-transfer path asserts Plan D `transfer-policy.ts` flag. Aggregate 512MiB/fetch ledger (Plan B) enforced on clone acquisition.

**Files:**
- Modify: `src/github/github-domain.ts`
- Create: `test/github/github-cross-plan-gates.test.ts` (transfer flag asserted; ledger enforced)

**Checks:**
- `node --import tsx --test test/github/`
- Type: `npm run typecheck`; full `npm test` at gate.

## Negative security tests (this plan)
- Redirect/token leakage (token never in result/cursor/clone output); bombs; symlink escape/races; git process tree; cloud zero-call gates; cross-provider private leakage; upload cleanup; telemetry redaction.

## Known unknowns / defaults / pivots
- Ref resolution safety rules follow git-check-ref-format semantics; ambiguous refs reject. Pivot: platform ref edge cases → reject-first, escalate.
- Sanitized env + ephemeral credential helper pattern shared with Plan B `native-child-env.ts`; no token forwarding.
