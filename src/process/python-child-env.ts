import { delimiter, join } from 'node:path';

/**
 * Sanitised environments for Python child processes.
 *
 * Only allowlisted vars pass through. Anything matching TOKEN/KEY/SECRET/COOKIE/PASSWORD
 * patterns is excluded. Proxy authority is split: the outbound scrapling
 * fetcher receives proxy config, the loopback embedding sidecar never does
 * (proxy URLs can embed credentials).
 */
const PYTHON_BASE_ALLOWLIST = new Set([
  'PATH', 'HOME', 'USERPROFILE', 'TMPDIR', 'TEMP', 'TMP', 'LANG', 'LC_ALL',
  'NO_PROXY', 'no_proxy',
  // Windows spawn essentials (benign, no secrets): cmd.exe resolution +
  // PATHEXT lookup for .cmd shims when PATH is shim-dir-only.
  'SystemRoot', 'windir', 'COMSPEC', 'PATHEXT',
  'PI_SEARCH_SCRAPLING_ENABLED', 'PI_SEARCH_SCRAPLING_PYTHON_PATH',
  'PI_SEARCH_SCRAPLING_FETCHER',
  'PI_SEARCH_SCRAPLING_TIMEOUT',
  // Embedding sidecar launch config read by sidecar/app.py argparse defaults
  // (PI_SEARCH_EMBEDDING_MODEL/PORT, SIDECAR_DEVICE). Explicit --model/--port/
  // --device argv wins; passthrough covers direct launches without options.
  'PI_SEARCH_EMBEDDING_MODEL', 'PI_SEARCH_EMBEDDING_PORT', 'SIDECAR_DEVICE',
]);

// Proxy authority is scrapling-only: proxy URLs can embed credentials and the
// loopback embedding sidecar never needs egress proxying.
const SCRAPLING_PROXY_ALLOWLIST = new Set([
  'HTTP_PROXY', 'HTTPS_PROXY', 'http_proxy', 'https_proxy',
  'PI_SEARCH_SCRAPLING_PROXY',
]);


export function appendUserToolBinsToPath(
  parentEnv: Record<string, string | undefined>,
): string | undefined {
  const rawPath = parentEnv.PATH ?? parentEnv.Path ?? parentEnv.path;
  if (typeof rawPath !== 'string' || rawPath.length === 0) return undefined;

  const current = rawPath.split(delimiter).filter((entry) => entry.length > 0);
  const home = parentEnv.HOME ?? parentEnv.USERPROFILE;
  const candidates = [
    parentEnv.UV_TOOL_BIN_DIR,
    parentEnv.XDG_BIN_HOME,
    home ? join(home, '.local', 'bin') : undefined,
  ];
  for (const candidate of candidates) {
    if (typeof candidate !== 'string' || candidate.length === 0 || current.includes(candidate)) continue;
    current.push(candidate);
  }
  return current.join(delimiter);
}

const BLOCKED_PATTERN = /^(?:.*(?:TOKEN|KEY|SECRET|COOKIE|PASSWORD|API_KEY|API_SECRET|AUTH|BEARER).*)$|^(?:npm_config_|NODE_OPTIONS$|NODE_PATH$|PYTHONPATH$|GIT_CONFIG_|SSL_CERT_|LD_PRELOAD$|DYLD_)/i;

/**
 * Build a sanitised environment for Python child processes.
 *
 * Only allowlisted vars pass through. Anything matching TOKEN/KEY/SECRET/COOKIE/PASSWORD
 * patterns is excluded. This prevents accidental leakage of API keys, cookies, and tokens
 * into subprocess environments.
 *
 * Proxy authority is split: proxy URLs can embed credentials, so only the
 * outbound scrapling fetcher receives them. The loopback embedding sidecar
 * gets base vars only (no HTTP(S)_PROXY, no PI_SEARCH_SCRAPLING_PROXY).
 */
function buildFromAllowlist(
  parentEnv: Record<string, string | undefined>,
  allowlist: ReadonlySet<string>,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const key of allowlist) {
    const val = parentEnv[key];
    if (typeof val === 'string' && !BLOCKED_PATTERN.test(key)) {
      out[key] = val;
    }
  }
  // Windows env keys are case-insensitive at the OS level but case-sensitive
  // in Node's env object (real key is `Path`, not `PATH`). Mirror it so .cmd
  // shims stay resolvable inside the sanitized child.
  if (out.PATH === undefined) {
    const alt = parentEnv.Path ?? parentEnv.path;
    if (typeof alt === 'string') out.PATH = alt;
  }
  const toolPath = appendUserToolBinsToPath(parentEnv);
  if (toolPath !== undefined) out.PATH = toolPath;
  return out;
}

/** Loopback embedding sidecar: base vars only, never proxy authority. */
export function buildEmbeddingChildEnvironment(
  parentEnv: Record<string, string | undefined> = process.env,
): Record<string, string> {
  return buildFromAllowlist(parentEnv, PYTHON_BASE_ALLOWLIST);
}

/** Outbound scrapling fetcher: base vars plus operator proxy config. */
export function buildScraplingChildEnvironment(
  parentEnv: Record<string, string | undefined> = process.env,
): Record<string, string> {
  return buildFromAllowlist(
    parentEnv,
    new Set([...PYTHON_BASE_ALLOWLIST, ...SCRAPLING_PROXY_ALLOWLIST]),
  );
}

/**
 * Back-compat alias for outbound-network Python children (scrapling, social
 * CLIs). Preserves proxy authority. New code should pick
 * buildEmbeddingChildEnvironment vs buildScraplingChildEnvironment explicitly.
 */
export function buildPythonChildEnvironment(
  parentEnv: Record<string, string | undefined> = process.env,
): Record<string, string> {
  return buildScraplingChildEnvironment(parentEnv);
}
