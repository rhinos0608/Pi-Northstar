import { delimiter, join } from 'node:path';

/**
 * Build a sanitised environment for Python child processes (scrapling bridge, sidecar).
 *
 * Only allowlisted vars pass through. Anything matching TOKEN/KEY/SECRET/COOKIE/PASSWORD
 * patterns is excluded. This prevents accidental leakage of API keys, cookies, and tokens
 * into subprocess environments.
 */
const PYTHON_CHILD_ALLOWLIST = new Set([
  'PATH', 'HOME', 'USERPROFILE', 'TMPDIR', 'TEMP', 'TMP', 'LANG', 'LC_ALL',
  'HTTP_PROXY', 'HTTPS_PROXY', 'http_proxy', 'https_proxy',
  'NO_PROXY', 'no_proxy',
  // Windows spawn essentials (benign, no secrets): cmd.exe resolution +
  // PATHEXT lookup for .cmd shims when PATH is shim-dir-only.
  'SystemRoot', 'windir', 'COMSPEC', 'PATHEXT',
  'PI_SEARCH_SCRAPLING_ENABLED', 'PI_SEARCH_SCRAPLING_PYTHON_PATH',
  'PI_SEARCH_SCRAPLING_FETCHER', 'PI_SEARCH_SCRAPLING_PROXY',
  'PI_SEARCH_SCRAPLING_TIMEOUT',
  // Embedding sidecar launch config read by sidecar/app.py argparse defaults
  // (PI_SEARCH_EMBEDDING_MODEL/PORT, SIDECAR_DEVICE). Explicit --model/--port/
  // --device argv wins; passthrough covers direct launches without options.
  'PI_SEARCH_EMBEDDING_MODEL', 'PI_SEARCH_EMBEDDING_PORT', 'SIDECAR_DEVICE',
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

export function buildPythonChildEnvironment(
  parentEnv: Record<string, string | undefined> = process.env,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const key of PYTHON_CHILD_ALLOWLIST) {
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
