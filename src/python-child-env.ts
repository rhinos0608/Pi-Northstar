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
  'PI_SEARCH_SCRAPLING_ENABLED', 'PI_SEARCH_SCRAPLING_PYTHON_PATH',
  'PI_SEARCH_SCRAPLING_FETCHER', 'PI_SEARCH_SCRAPLING_PROXY',
  'PI_SEARCH_SCRAPLING_TIMEOUT',
]);

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
  return out;
}
