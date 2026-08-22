# ADR 0001: Use agent-browser for web automation

## Status

Accepted — 2026-07-16

**Superseded sections noted inline below.** The prior removal of application URL/DNS
controls is superseded by [ADR 0003](0003-restore-application-ssrf-guards.md).
Scope A restores defense-in-depth blocking for user-controlled public fetch/browser URLs;
configured local services remain operator-owned, and container egress remains the outer boundary.
This does not claim complete SSRF containment.

## Context

Pi-Northstar exposes one public `browser` tool through `src/index.ts`. `src/browser-tools.ts` maps 13 actions to custom CDP primitives in `src/cdp.ts`. That same CDP module also implements loopback cookie import and headed provider login. Browser automation and authentication setup therefore share code but have different security and lifecycle requirements.

`agent-browser@0.32.0` is available from npm, licensed Apache-2.0, and requires Node.js 24 or newer. Its package postinstall downloads a platform-specific native binary. It provides session-isolated browser automation, accessibility snapshots and refs, structured JSON output, action policies, domain controls, and daemon lifecycle management.

Research references:

- `vercel-labs/agent-browser` package metadata, CLI source, JSON output, session, and security controls.
- `openinterpreter/openinterpreter`, which delegates web computer use to agent-browser rather than maintaining another browser driver.
- Existing Pi-Northstar browser, setup, cookie, output-guard, and contract tests.

## Decision

Replace public custom-CDP browser automation with a Pi-owned, typed adapter around exact-pinned `agent-browser@0.32.0`.

Preserve public tool name `browser`, existing input names, and existing actions:

`status`, `tabs`, `navigate`, `evaluate`, `text`, `html`, `screenshot`, `click`, `type`, `scroll`, `close`, `cookies`, `set_cookies`.

Add only bounded high-value actions needed for agent-browser's ref workflow after contract review:

`snapshot`, `fill`, `wait`, `get_url`, `get_title`.

Do not expose raw agent-browser CLI arguments, MCP tools, plugins, providers, dashboard, chat, profiles, restore/state, extensions, raw Chrome args, install, upgrade, or arbitrary upstream actions.

### Adapter boundary

- Fixed command builders; `shell: false`; sensitive payloads use stdin rather than argv.
- Exact executable/version verification.
- Random owned session and runtime root per Pi session; fixed private directory layout inside that root. `session_shutdown` closes it.
- `status` performs executable/version/config checks without starting daemon or browser.
- Dedicated private config, socket, temp, and screenshot directories. POSIX directory mode `0700`; sensitive file mode `0600`.
- Exact base environment allowlist: `PATH`, `HOME`, `USERPROFILE`, `TMPDIR`, `TEMP`, `TMP`, `LANG`, `LC_ALL`. Headed Linux setup may additionally receive `DISPLAY`, `WAYLAND_DISPLAY`, `XAUTHORITY`, `XDG_RUNTIME_DIR`, and `DBUS_SESSION_BUS_ADDRESS`. Adapter-generated `AGENT_BROWSER_SESSION`, `AGENT_BROWSER_NAMESPACE`, `AGENT_BROWSER_CONFIG`, `AGENT_BROWSER_DEFAULT_TIMEOUT`, `AGENT_BROWSER_IDLE_TIMEOUT_MS`, `AGENT_BROWSER_MAX_OUTPUT`, and `AGENT_BROWSER_CONTENT_BOUNDARIES` are allowed. All inherited `AGENT_BROWSER_*`, proxy, `npm_config_*`, `NODE_OPTIONS`, `NODE_PATH`, `GIT_CONFIG_*`, `SSL_CERT_*`, loader/preload, search credential, token, cookie, and API-key variables are discarded before adapter values are added.
- Incremental stdout/stderr byte caps; parse only `{ success: boolean, data?: unknown, error?: string, type?: string, warning?: unknown }`; safe normalized errors, timeout/abort handling, TERM-to-KILL escalation, owned-child reaping, and bounded owned-session cleanup.
- Screenshot data returns as Pi image content with metadata limited to media type, width, height, and byte length. Never duplicate base64 in text, details, or extension logs/files. Pi session persistence, compaction, export, or fork may retain inline image content under Pi's lifecycle.

### Navigation and sessions

`navigate` continues accepting public HTTP(S) URLs only. Does not reject
localhost, private/reserved IP ranges, or metadata endpoints — those checks
were intentionally removed (commits a0fad0e, 04f373d).

~~Add optional `allowedDomains: string[]`. Default is exact navigation
hostname. Each entry must be a normalized public hostname or `*.` subdomain
pattern whose current DNS answers are public. Allowed-domain set is fixed at
owned-session launch; sorted set hashes into session key. Non-allowlisted
navigation, redirects, subresources, WebSocket/EventSource, sendBeacon,
workers, and WebRTC fail closed through agent-browser containment. Caller
must explicitly add required CDN/IdP domains; blocked-domain errors are
actionable and never auto-widen policy.~~

**SUPERSEDED by ADR 0003:** Domain allowlisting is enforced for public browser sessions.
Loopback access is a narrow exception only in the browser-tools-created adapter backed by
LoopbackProxy.

~~DNS preflight is defense in depth, not complete DNS-rebinding containment:
agent-browser/Chromium resolves independently after validation. High-assurance
deployments require OS/container egress policy denying private/reserved
networks. ADR approval accepts this residual risk; tests must include DNS-change
simulation where controllable and label live rebinding checks unverified when
not enforceable.~~

**SUPERSEDED by ADR 0003:** DNS preflight resolves through system DNS and rejects any
private/reserved answer. DNS rebinding and Chromium DNS TOCTOU remain residual risks.

When `endpoint` is present, call routes only to legacy loopback CDP during rollback release; it never configures agent-browser. Remote or LAN CDP stays forbidden. External CDP attach lacks owned-session subresource containment. `endpoint` and legacy backend are removed no earlier than release `0.2.0`, after one full release burn-in; project maintainer owns removal.

### Sensitive actions

- `evaluate` and `set_cookies` are disabled unless explicit policy enables them. Security is enforced externally through containerization and other extensions; this extension applies policy classification only.
- Enabled `evaluate` grants full JavaScript authority in current page context, including DOM, cookies available to JavaScript, web storage, clipboard APIs allowed by browser, and network requests allowed by browser policy.
- `cookies` returns metadata only: name, domain, path, expiry, and security flags. Cookie values never enter model-visible text/details/errors/logs.
- Expressions, typed values, and cookie values use agent-browser batch JSON over stdin and must not appear in argv or diagnostics.

These controls intentionally tighten observable legacy behavior and require explicit approval before implementation.

### Authentication setup

Retain existing default-browser cookie import, provider-domain filtering, Playwright-shaped storage state, and private Pi state writer.

Keep setup authentication separate from public browser sessions:

- Loopback endpoint import remains during migration.
- Headed login uses isolated setup session and manual credential/MFA entry.
- Extract only registered provider domains and required session-cookie predicates.
- Deprecate optional login port explicitly; do not silently ignore it.
- Do not reuse profiles or agent-browser auth vault.

Delete custom high-level public CDP primitives only after rollout proof. Retain cookie setup/import code until separate migration proves equivalent filtering, secrecy, and rollback.

## Alternatives considered

1. **Expose raw agent-browser CLI or MCP** — rejected. Surface expands whenever upstream changes and bypasses Pi validation, output, and environment controls.
2. **Keep custom CDP indefinitely** — rejected. Duplicates mature browser lifecycle, accessibility, interaction, and diagnostics behavior.
3. **Immediate CDP deletion** — rejected. Removes rollback and risks cookie/login regressions.
4. **Use profiles/restore/auth vault** — rejected initially. Mixes public browsing with bearer session state and weakens domain/session isolation.

## Consequences

Positive:

- Smaller first-party browser stack.
- Accessibility refs, better interactions, standardized sessions, and upstream diagnostics.
- Closed Pi contract remains stable despite upstream growth.

Negative:

- Node.js 24 floor, npm unpacked size 85,658,821 bytes (44 files as measured 2026-07-16), postinstall native download, daemon lifecycle, and new supply-chain review.
- Strict domain containment can require explicit CDN and identity-provider domains.
- Secure cookie/eval semantics differ from legacy behavior.
- agent-browser 0.x contract requires exact pin and adapter tests.

## Rollout and rollback

1. Characterize current behavior before route switch.
2. Add adapter behind `PI_SEARCH_BROWSER_BACKEND`, accepting `agent-browser` or `cdp`.
3. Run compatibility/security review and gated live E2E.
4. Target release defaults unset flag to `agent-browser`; `cdp` remains explicit rollback value for one full release.
5. Isolate backends with separate runtime roots/namespaces; legacy CDP uses configured loopback endpoint and neither backend shares browser state or ports.
6. Roll back through backend flag; close owned sessions; preserve cookie state.
7. Project maintainer removes high-level CDP automation no earlier than `0.2.0` in separately reviewed change after burn-in.

## Verification

- Fixed argv, stdin, environment, config, session, and output contract tests with injected fake executable.
- URL/DNS/private-address negative tests.
- Secret canaries absent from text, details, errors, logs, argv, and screenshots metadata.
- Timeout, abort, daemon cleanup, session isolation, and opt-out tests.
- Focused browser/setup/contract tests, then `npm test`, `npm run typecheck`, `npm audit --audit-level=high`, `npm pack --dry-run`, and `git diff --check`.
- Gated live navigate/snapshot/click/fill/wait/screenshot/close and rollback checks. Unavailable live checks must be reported as unverified.

## Approval checklist

- [x] Exact `agent-browser@0.32.0`, Node.js >=24, native postinstall, and package-size impact approved 2026-07-16.
- [x] Default-disabled `evaluate`/`set_cookies` plus metadata-only `cookies` approved 2026-07-16.
- [x] Strict owned-session domain containment and documented CDN/IdP additions approved 2026-07-16.
- [x] One-release dual-backend rollback window and removal owner/date approved 2026-07-16.
- [x] Login-port deprecation and initial OAuth/session-cookie domain scope approved 2026-07-16.

Implementation plan: [`../plans/2026-07-16-agent-browser-migration.md`](../plans/2026-07-16-agent-browser-migration.md)
