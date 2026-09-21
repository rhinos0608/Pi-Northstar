# Pi-Northstar

CLI-first research and code-context engine for Pi. 28 stateless commands
(`github`, `research`, `social`, `media`, `kg`, `graph`, `fetch`, `search`)
run without a daemon; a local Rust broker (`northstar-broker`) owns stateful
jobs (`broker serve`, `jobs status`). Native Pi tools default to zero and
require an explicit operator allowlist.

## Quickstart

Prereqs: Node >= 24 (`package.json:7-9`), Rust stable toolchain for broker.

```bash
npm install
npm run build
node --import tsx src/cli/cli.ts search "pi agent frameworks" --limit 5
```

More discovery: `node --import tsx src/cli/cli.ts --help` lists all 28
commands; `... <domain> --help` shows per-command flags, e.g.
`... search --help`, `... github --help`. Installed bins are `northstar` and
`pi-northstar` (`package.json:10-13`).

## Local broker run (stateful jobs)

Stateful CLI (`broker.serve`, `jobs.status`) is implemented but unregistered
pending Gate B Tier-2 proof — see `plan.md` Gate B status and
`docs/tier2-proof.md`. Local unsigned testing shape:

```bash
cargo build --release -p northstar-broker
northstar broker serve --project-id <id>
```

In another terminal:

```bash
northstar jobs status --project-id <id> --request-id <id>
```

Stop with Ctrl-C / SIGTERM. Usage strings above are verbatim from
`src/cli/cli.ts:161-162` top-level `--help`; per-subcommand `--help` for
`broker`/`jobs` currently errors (`internal_error`, TDZ bug) — see Unverified
note.

## Configuration

Copy `.env.example` to `.env` (repo root; process env wins). `.env.example`
documents every var; placeholders only, no secrets.

### Allowlisting tools (.env)

Native Pi tool exposure is default-deny, owned by `src/capabilities.ts:28`:

- Env var: `PI_SEARCH_NATIVE_TOOLS` (`PUBLIC_TOOL_ALLOWLIST_ENV_VAR`)
- Valid names (exact, from `PUBLIC_TOOL_NAMES`, `src/capabilities.ts:17`):
  `web_search`, `fetch`, `github`, `social`, `kg`, `graph`, `browser`,
  `desktop`, `agent_poll`
- Parsing (`parsePublicToolAllowlist`, `src/capabilities.ts:31-47`): comma-
  separated exact canonical names; unknown, legacy, internal, duplicate, or
  malformed entries reject at startup. `media` is internal acquisition, never
  a tenth tool.

Examples:

```bash
# default-deny (also what unset/blank means): zero native tools
PI_SEARCH_NATIVE_TOOLS=""
# search-only
PI_SEARCH_NATIVE_TOOLS="web_search"
# full local surface
PI_SEARCH_NATIVE_TOOLS="web_search,fetch,github,social,kg,graph,browser,desktop,agent_poll"
```

When unset or blank, zero native tools register and the backend stays inert —
CLI commands are unaffected (CLI availability never implies tool authority).

## Unsigned local testing

Public release is parked: no signed artifacts ship from this tree.
Installer docs (`docs/installer.md`) describe signed `.pkg`/`.msi`/systemd
flows that require privileged runners; Tier-2 proof (per-job isolation,
kill-to-zero, live socket denial, signature checks) is parked in
`docs/tier2-proof.md` and explicitly out of scope for unprivileged machines.

## Pointers

- Installer/service guide: `docs/installer.md`
- Authority boundary: `docs/adr/0010-gate-b-native-authority-boundary.md`
- Staged plan + Gate B status: `plan.md`
- Agent router skill: `SKILL.md`; per-domain contracts: `skills/*/SKILL.md`

## Unverified

- `northstar broker serve` runtime behavior beyond the usage string
  (detail `--help` errors; Tier-2 proof pending).
- Release-binary performance / install smoke (no signed artifacts built here).
