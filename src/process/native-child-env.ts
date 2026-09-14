/**
 * Sanitised environment for native (non-Python) child processes: git,
 * ffmpeg, and media CLIs. Dedicated seam so these children never reuse
 * the CLI bridge-token env.
 *
 * Minimal allowlist: OS spawn essentials + locale + temp dirs only. No
 * tokens, keys, or cookies; no proxy config (proxy URLs can embed
 * credentials); no interpreter, linker, git-config, or cert-dir overrides.
 *
 * Call-site requirement (documented, enforced by test): spawn with a fixed
 * argv array and `shell: false`. Never pass a shell string; never inherit
 * process.env.
 */
const NATIVE_CHILD_ALLOWLIST = new Set([
  'PATH', 'HOME', 'USERPROFILE', 'TMPDIR', 'TEMP', 'TMP', 'LANG', 'LC_ALL',
  // Windows spawn essentials (benign, no secrets).
  'SystemRoot', 'windir', 'COMSPEC', 'PATHEXT',
]);

const BLOCKED_PATTERN = /^(?:.*(?:TOKEN|KEY|SECRET|COOKIE|PASSWORD|API_KEY|API_SECRET|AUTH|BEARER).*)$|^(?:npm_config_|NODE_OPTIONS$|NODE_PATH$|PYTHONPATH$|GIT_CONFIG_|SSL_CERT_|LD_PRELOAD$|DYLD_)/i;

export function buildNativeChildEnvironment(
  parentEnv: Record<string, string | undefined> = process.env,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const key of NATIVE_CHILD_ALLOWLIST) {
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
  return out;
}
