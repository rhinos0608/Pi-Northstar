# ADR 0002: Use Cua Driver for desktop automation

## Status

Accepted — 2026-07-16

## Context

Pi-Northstar controls browser pages but has no native desktop automation. Desktop authority differs materially from browser authority: accessibility trees and screenshots expose workstation data; click/type/key actions can mutate arbitrary applications; macOS grants broad Accessibility and Screen Recording permissions to an application identity.

Cua Driver upstream reports native application inspection and background interaction across macOS, Windows, and Linux through MCP stdio, a daemon proxy, and one-shot CLI. Pi-Northstar support remains platform-specific and unverified until fixture E2E evidence exists. Upstream main and PyPI metadata currently identify `0.8.3`, while latest inspected GitHub release evidence identified prerelease `cua-driver-rs-v0.7.1`. Version `0.7.1` is approved as initial baseline; exact release artifact, checksum, signing, and runtime contract still require preflight evidence before authority-bearing execution.

Reference projects inform design:

- `injaneity/pi-computer-use`: Pi lifecycle hooks, immutable observation state IDs, progressive outline disclosure, resource-keyed scheduling, transactional verification, and image-result discipline.
- `openinterpreter/openinterpreter`: separate web and native computer-use backends, process/control-plane separation, bounded output, and disconnect cleanup.

## Decision

Add one vendor-neutral public Pi tool named `desktop`. Keep `browser` dedicated to web automation.

Use dedicated Cua Driver MCP stdio client. This is intentional exception to Pi-Northstar CLI-first preference because MCP preserves typed image content, connection-scoped state, and daemon-proxy behavior needed for macOS permission attribution.

Do not reuse `SearchMcpClient`; its environment and error model are inappropriate for workstation authority.

### Public contract

Closed actions:

- Observation: `status`, `list_apps`, `list_windows`, `observe_window`, `wait`.
- Confirmed interaction: `click`, `type_text`, `press_key`, `scroll`.

Public camelCase fields map privately to fixed upstream snake_case calls. Unknown fields, actions, tools, health-schema majors, and upstream additions fail closed.

Initial upstream allowlist:

- `health_report`
- `list_apps`
- `list_windows`
- `get_window_state` with screenshot disabled by default
- no upstream wait passthrough; public `wait` is bounded client-side polling of `get_window_state` against validated text/role predicate
- `click`, `type_text`, `press_key`, `scroll`

Explicitly deny kill/launch app, shell, browser JavaScript/page tools, config writes, recording/replay, install/update, agent cursor, foreground/bring-to-front, full-desktop capture, global/absolute coordinates, drag, hotkeys, double/right click, and set-value.

### Observation model

- Tool disabled by default through `PI_SEARCH_DESKTOP_AUTOMATION` opt-in, matching existing extension configuration prefix.
- Observation defaults to AX-only, known target window, `includeScreenshot: false`.
- Return immutable `stateId` bound to pid, window id, resource generation, and expiry.
- Mutations require fresh matching state/target. Stale or mismatched refs fail before driver call.
- Progressive disclosure caps AX depth, nodes, attributes, and text.
- Values marked by upstream as secure are removed; home/socket paths, stack traces, raw diagnostics, exact inherited secret values, and known secret patterns are redacted. AX trees can still expose PII, credentials, and application content because custom controls are not reliably classified. Users must close sensitive applications before enabling observation.
- Optional screenshot targets one known window and returns only Pi image content with media type, width, height, and byte length. Extension writes no screenshot files/logs and does not duplicate base64; Pi session persistence, compaction, export, or fork may retain inline image content.

### Interaction policy

Never retry mutation after dispatch. Transport loss after dispatch returns `OUTCOME_UNKNOWN`, stops workflow, and requires fresh observation before any later action. Fresh observation may reveal partial effects but cannot prove whether irreversible action occurred; Pi makes no automatic recovery or idempotency claim.

Security is enforced externally through containerization and other extensions; this extension applies policy classification and action allowlisting only.

### Client and lifecycle

- Fixed `cua-driver mcp` invocation; no shell or dynamic tool registration. MCP `listTools` is used only to verify required exact-version tools exist; it never expands Pi allowlist.
- Start only on enabled desktop call, not extension startup.
- One transport/session per Pi session; close on `session_shutdown`.
- Resource-keyed serialization prevents concurrent input against same window.
- Exact base environment allowlist: `PATH`, `HOME`, `USERPROFILE`, `TMPDIR`, `TEMP`, `TMP`, `LANG`, `LC_ALL`. Linux may additionally receive `DISPLAY`, `WAYLAND_DISPLAY`, `XAUTHORITY`, `XDG_RUNTIME_DIR`, and `DBUS_SESSION_BUS_ADDRESS`. Adapter-generated telemetry/update-disable variables are added only after exact-version verification.
- Exclude API keys, tokens, cookies, browser/search variables, proxies, `npm_config_*`, `NODE_OPTIONS`, `NODE_PATH`, `PYTHONPATH`, `GIT_CONFIG_*`, `SSL_CERT_*`, `LD_PRELOAD`, and `DYLD_*`.
- Bounded sanitized stderr ring buffer.
- Abort-aware calls. Read-only pre-dispatch health may reconnect; mutations never reconnect-and-replay.
- Action timeouts: status/list/AX 15s, screenshot 30s, mutation 10s, wait <=30s, absolute ceiling 60s.

### Install, version, and platform policy

No runtime download, remote install script, daemon/autostart management, update, chmod, or permission prompt.

User manually installs official signed driver/app. Release owner must select one exact version after verifying:

- release URL and SHA-256 asset checksum;
- `cua-driver --version`;
- MCP initialize, tool list, and health schema;
- macOS bundle identity/signing/notarization where applicable;
- telemetry/update-check disablement;
- harmless fixture E2E.

Version `0.7.1` is approved as baseline, but live support remains **unverified** until artifact/runtime gate passes. Tasks after version preflight must stop if gate fails. Report separately what Pi-Northstar tested versus what upstream reports. `status` uses driver's permission-health tool rather than reading OS permission databases directly, reports Accessibility/Screen Recording state, and session shutdown warns when desktop was used that OS grants may remain; Pi cannot revoke them.

## Alternatives considered

1. **One-shot `cua-driver call`** — rejected for primary path because it loses typed images and connection state; acceptable only for diagnostics.
2. **Dynamic MCP tool passthrough** — rejected because upstream additions would silently gain workstation authority.
3. **Depend on `pi-computer-use`** — rejected. Useful design reference, but bundled helpers, postinstall, separate browser stack, and broad tool surface conflict with bounded Cua integration.
4. **Bundle or auto-install driver** — rejected due supply-chain, signing, TCC, and platform risk.
5. **Instructions only** — rejected because Pi-Northstar needs typed, testable policy and lifecycle boundaries.

## Consequences

Positive:

- Native app testing without conflating browser and desktop contracts.
- Window-targeted background accessibility path.
- Static Pi policy remains authority over broad upstream capabilities.

Negative:

- Cua Driver and macOS TCC grant powerful workstation access beyond Pi session lifetime.
- AX trees/screenshots can expose sensitive data.
- Generic clicks and typing cannot prove business intent.
- Upstream prerelease protocol and platform behavior can drift.
- Pi serialization cannot prevent other local Cua clients from contending.

## Rollback

Set `PI_SEARCH_DESKTOP_AUTOMATION=0`, close MCP transport, and remove tool registration in follow-up release. Extension-owned observation state is memory-only and cleared; extension writes no screenshot files, while Pi session storage may retain returned inline images. Rollback does not alter user-installed driver, daemon configuration, or OS permissions; docs must explain manual permission revocation.

## Verification

- Fake MCP initialize/list/call/image/malformed/stderr/timeout/abort/crash/schema-drift server.
- Static allowlist and action validation tests.
- Secret-environment canaries and exact-value redaction tests.
- Immutable state freshness, target matching, queue serialization, and shutdown tests.
- Confirmation/no-UI/cancel tests proving zero driver calls.
- Image-only result and secure-field redaction tests.
- Focused desktop/browser regression tests, then `npm test`, `npm run typecheck`, `npm audit --audit-level=high`, `npm pack --dry-run`, and `git diff --check`.
- Manual signed-driver fixture E2E only after approval. Unavailable platform/live checks remain unverified.

## Approval checklist

- [x] Public name `desktop` and dedicated MCP exception approved 2026-07-16.
- [x] Cua Driver `0.7.1` baseline approved 2026-07-16; exact artifact verification remains required before live execution.
- [x] Disabled-by-default, AX-only observation baseline approved 2026-07-16.
- [x] Target-window screenshot opt-in and extension no-persistence policy approved 2026-07-16.
- [x] Per-call UI confirmation removed 2026-07-16; security handled externally.
- [x] Explicit denied-action list approved 2026-07-16.
- [x] Manual signed install and permission-revocation ownership approved 2026-07-16.
- [ ] Telemetry/update controls require runtime verification against `0.7.1` before live execution.
- [x] Initial verified-platform labeling and workstation/TCC residual risk approved 2026-07-16.

Implementation plan: [`../plans/2026-07-16-cua-desktop-integration.md`](../plans/2026-07-16-cua-desktop-integration.md)
