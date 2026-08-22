import { spawn } from 'node:child_process';
import { mkdir, rm, readFile, unlink, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { platform } from 'node:os';

// ── Types ──

export interface AgentBrowserProcessOptions {
  executablePath?: string;
  runtimeRoot?: string;
  namespace?: string;
  env?: Record<string, string | undefined>;
  signal?: AbortSignal;
  allowedDomains?: string[];
  loopbackProxyUrl?: string;
  loopbackProxyBypass?: string;
}

export interface AgentBrowserResult {
  success: boolean;
  data?: unknown;
  error?: string;
  type?: string;
  warning?: unknown;
}

export interface AgentBrowserSession {
  runtimeRoot: string;
  namespace: string;
}

// ── Constants ──

const RUNTIME_DIR_MODE = 0o700;

/** Environment variables allowed to pass through from parent (base set) */
const ALLOWED_PARENT_ENV_BASE = new Set([
  'PATH', 'HOME', 'USERPROFILE', 'TMPDIR', 'TEMP', 'TMP', 'LANG', 'LC_ALL',
]);

/** Display env vars — only passed on headed Linux setups */
const DISPLAY_ENV_KEYS = ['DISPLAY', 'WAYLAND_DISPLAY', 'XAUTHORITY', 'XDG_RUNTIME_DIR', 'DBUS_SESSION_BUS_ADDRESS'];

/** Explicitly excluded environment variable prefixes/keys */
const BLOCKED_KEYS = new Set([
  'AGENT_BROWSER_',
  'npm_config_',
  'NODE_OPTIONS',
  'NODE_PATH',
  'GIT_CONFIG_',
  'SSL_CERT_',
  'LD_PRELOAD',
  'DYLD_INSERT_LIBRARIES',
  'DYLD_LIBRARY_PATH',
  'PYTHONPATH',
]);

/** Default timeout for agent-browser commands */
const DEFAULT_CMD_TIMEOUT_MS = 60_000;
const SIGKILL_AFTER_MS = 5_000;
const MAX_STDOUT_BYTES = 5_000_000;  // 5MB per stream
const MAX_STDERR_BYTES = 1_000_000;  // 1MB stderr
const COMBINED_HARD_CAP = 5_500_000; // terminate child if combined exceeds

// ── Process runner ──

/**
 * Build a clean, frozen environment for the agent-browser child process.
 * Starts from zero, adds only allowlisted parent vars, then adapter-controlled vars.
 */
export function buildSandboxEnvironment(
  parentEnv: Record<string, string | undefined>,
  session: AgentBrowserSession,
  extraVars: Record<string, string> = {},
): Record<string, string> {
  const env: Record<string, string> = {};

  // Base allowlisted parent vars
  for (const key of ALLOWED_PARENT_ENV_BASE) {
    const val = parentEnv[key];
    if (typeof val === 'string') env[key] = val;
  }

  // Display vars only on headed Linux
  const isLinux = platform() === 'linux';
  const headed = parentEnv.AGENT_BROWSER_HEADED === '1' || parentEnv.AGENT_BROWSER_HEADED === 'true';
  if (isLinux && headed) {
    for (const key of DISPLAY_ENV_KEYS) {
      const val = parentEnv[key];
      if (typeof val === 'string') env[key] = val;
    }
  }

  // Block any leaked hostile variables
  for (const key of Object.keys(env)) {
    for (const blocked of BLOCKED_KEYS) {
      if (key.startsWith(blocked) || key === blocked) {
        delete env[key];
        break;
      }
    }
  }

  // Adapter-controlled variables
  env.AGENT_BROWSER_SESSION = session.namespace;
  env.AGENT_BROWSER_NAMESPACE = session.namespace;
  env.AGENT_BROWSER_CONFIG = join(session.runtimeRoot, 'config', 'config.json');
  env.AGENT_BROWSER_DEFAULT_TIMEOUT = String(DEFAULT_CMD_TIMEOUT_MS);
  env.AGENT_BROWSER_IDLE_TIMEOUT_MS = String(120_000);
  env.AGENT_BROWSER_CONTENT_BOUNDARIES = '1';

  // Extra vars (allowed domains, etc.)
  for (const [k, v] of Object.entries(extraVars)) {
    env[k] = v;
  }

  return env;
}

/**
 * Resolve the path to the agent-browser executable.
 */
function findOnPath(executable: string): string | undefined {
  const pathEnv = (process.env.PATH ?? '');
  const paths = pathEnv.split(':');
  for (const dir of paths) {
    const candidate = join(dir, executable);
    if (existsSync(candidate)) return candidate;
  }
  return undefined;
}

export async function resolveAgentBrowserExecutable(explicitPath?: string): Promise<string> {
  if (explicitPath) {
    if (!existsSync(explicitPath)) {
      throw new Error(`agent-browser executable not found at explicit path: ${explicitPath}`);
    }
    return explicitPath;
  }

  const localBin = join(process.cwd(), 'node_modules', '.bin', 'agent-browser');
  if (existsSync(localBin)) {
    try {
      await verifyVersion(localBin);
      return localBin;
    } catch {
      // version incompatible, continue resolution
    }
  }

  const pkgBin = join(process.cwd(), 'node_modules', 'agent-browser', 'bin', 'agent-browser.js');
  if (existsSync(pkgBin)) {
    try {
      await verifyVersion(pkgBin);
      return pkgBin;
    } catch {
      // version incompatible, continue resolution
    }
  }

  const pathBin = findOnPath('agent-browser');
  if (pathBin) {
    try {
      await verifyVersion(pathBin);
      return pathBin;
    } catch {
      // version incompatible, continue resolution
    }
  }

  throw new Error('agent-browser executable not found. Install agent-browser@0.32.0.');
}

/**
 * Verify agent-browser version without launching browser.
 */
const VERIFY_VERSION_TIMEOUT_MS = 10_000;

export async function verifyVersion(executablePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(executablePath, ['--version'], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '' },
    });
    let stdout = '';
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      try { child.kill('SIGKILL'); } catch { /* ignore */ }
      reject(new Error(`agent-browser --version timed out after ${VERIFY_VERSION_TIMEOUT_MS}ms`));
    }, VERIFY_VERSION_TIMEOUT_MS);
    child.stdout!.on('data', (chunk: Buffer) => { stdout += String(chunk); });
    child.on('error', (err: Error) => {
      clearTimeout(timer);
      if (!timedOut) reject(new Error(`Cannot execute agent-browser: ${err.message}`));
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (timedOut) return;
      if (code !== 0) reject(new Error(`agent-browser --version exited ${code}`));
      else {
        const version = stdout.trim();
        if (!/^agent-browser\s+0\.32\.0$/.test(version) && version !== '0.32.0') {
          reject(new Error(`agent-browser version mismatch: expected 0.32.0, got ${version || '<empty>'}`));
          return;
        }
        resolve(version);
      }
    });
  });
}

/**
 * Create a random, isolated runtime root for an agent-browser session.
 */
export async function createRuntimeRoot(baseDir?: string): Promise<string> {
  const rootBase = baseDir ?? join(tmpdir(), 'pi-agent-browser');
  await mkdir(rootBase, { recursive: true, mode: RUNTIME_DIR_MODE });

  const runtimeRoot = join(rootBase, `session-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`);
  await mkdir(runtimeRoot, { recursive: true, mode: RUNTIME_DIR_MODE });

  for (const sub of ['config', 'socket', 'temp', 'screenshots']) {
    const dir = join(runtimeRoot, sub);
    await mkdir(dir, { recursive: true, mode: RUNTIME_DIR_MODE });
  }
  await writeFile(join(runtimeRoot, 'config', 'config.json'), '{}\n', { mode: 0o600 });

  return runtimeRoot;
}

/**
 * Clean up a runtime root directory.
 */
export async function cleanupRuntimeRoot(runtimeRoot: string): Promise<void> {
  try {
    await rm(runtimeRoot, { recursive: true, force: true, maxRetries: 3 });
  } catch {
    // Best effort
  }
}

/**
 * Generate a unique session namespace.
 */
export function generateNamespace(): string {
  return `pi-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * Parse agent-browser JSON output. Only accepts valid success/error envelopes.
 */
export function parseAgentBrowserOutput(stdout: string): AgentBrowserResult[] {
  const results: AgentBrowserResult[] = [];
  const trimmedOutput = stdout.trim();
  if (trimmedOutput.startsWith('[')) {
    try {
      const parsed = JSON.parse(trimmedOutput);
      if (Array.isArray(parsed)) {
        return parsed.filter((entry): entry is AgentBrowserResult =>
          typeof entry === 'object' && entry !== null && typeof (entry as Record<string, unknown>).success === 'boolean')
          .map((entry) => {
            const record = entry as AgentBrowserResult & { result?: unknown };
            if (record.data === undefined && 'result' in record) {
              const { result, ...rest } = record;
              const data = result && typeof result === 'object' && 'result' in result
                ? (result as { result: unknown }).result
                : result;
              return { ...rest, data } as AgentBrowserResult;
            }
            return entry;
          });
      }
    } catch { /* fall through to line parser */ }
  }
  const lines = trimmedOutput.split('\n');

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed = JSON.parse(trimmed);
      if (typeof parsed === 'object' && parsed !== null && 'success' in parsed) {
        const record = parsed as AgentBrowserResult & { result?: unknown };
        if (record.data === undefined && 'result' in record) {
          const { result, ...rest } = record;
          const data = result && typeof result === 'object' && 'result' in result
            ? (result as { result: unknown }).result
            : result;
          results.push({ ...rest, data } as AgentBrowserResult);
        } else {
          results.push(record);
        }
      }
      // Non-envelope JSON is ignored
    } catch {
      continue;
    }
  }

  return results;
}

// ── Output tracking ──

interface OutputTracker {
  stdoutBytes: number;
  stderrBytes: number;
  stdout: string;
  stderr: string;
  capped: boolean;
}

function createOutputTracker(): OutputTracker {
  return { stdoutBytes: 0, stderrBytes: 0, stdout: '', stderr: '', capped: false };
}

function trackOutput(tracker: OutputTracker, child: ReturnType<typeof spawn>): void {
  let killTimer: ReturnType<typeof setTimeout> | undefined;
  const terminate = () => {
    if (tracker.capped) return;
    tracker.capped = true;
    try { child.kill('SIGTERM'); } catch { /* ignore */ }
    killTimer = setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* ignore */ } }, SIGKILL_AFTER_MS);
  };
  const append = (stream: 'stdout' | 'stderr', chunk: Buffer, cap: number) => {
    const bytes = Buffer.byteLength(chunk);
    const current = stream === 'stdout' ? tracker.stdoutBytes : tracker.stderrBytes;
    if (current + bytes > cap || tracker.stdoutBytes + tracker.stderrBytes + bytes > COMBINED_HARD_CAP) {
      terminate();
    }
    const allowed = Math.max(0, Math.min(bytes, cap - current, COMBINED_HARD_CAP - tracker.stdoutBytes - tracker.stderrBytes));
    const text = chunk.subarray(0, allowed).toString('utf8');
    if (stream === 'stdout') { tracker.stdout += text; tracker.stdoutBytes += Buffer.byteLength(text); }
    else { tracker.stderr += text; tracker.stderrBytes += Buffer.byteLength(text); }
  };
  child.stdout!.on('data', (chunk: Buffer) => append('stdout', chunk, MAX_STDOUT_BYTES));
  child.stderr!.on('data', (chunk: Buffer) => append('stderr', chunk, MAX_STDERR_BYTES));
  child.once('close', () => { if (killTimer) clearTimeout(killTimer); });
}

// ── Command execution ──

/**
 * Run a single agent-browser command. Uses the provided session (does not create new one).
 */
export async function runCommand(
  args: string[],
  options: AgentBrowserProcessOptions = {},
): Promise<AgentBrowserResult> {
  const executablePath = await resolveAgentBrowserExecutable(options.executablePath);
  if (!options.runtimeRoot || !options.namespace) {
    throw new Error('Session required: provide runtimeRoot and namespace in options');
  }
  const session: AgentBrowserSession = { runtimeRoot: options.runtimeRoot, namespace: options.namespace };
  const extraVars: Record<string, string> = {};
  if (options.allowedDomains && options.allowedDomains.length > 0) {
    extraVars.AGENT_BROWSER_ALLOWED_DOMAINS = options.allowedDomains.join(',');
  }
  if (options.loopbackProxyUrl) {
    extraVars.AGENT_BROWSER_PROXY = options.loopbackProxyUrl;
    // `<-loopback>` ensures no real hostname matches, routing all traffic
    // (including localhost) through the enforcing proxy.
    extraVars.AGENT_BROWSER_PROXY_BYPASS = options.loopbackProxyBypass ?? '<-loopback>';
  }
  const sandboxEnv = buildSandboxEnvironment(options.env ?? process.env, session, extraVars);

  return new Promise((resolve) => {
    const tracker = createOutputTracker();
    let settled = false;
    let killTimer: ReturnType<typeof setTimeout> | undefined;

    const settle = (result: AgentBrowserResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(cmdTimer);
      if (killTimer) clearTimeout(killTimer);
      if (options.signal) {
        try { options.signal.removeEventListener('abort', abortHandler); } catch { /* ignore */ }
      }
      resolve(result);
    };

    const abortHandler = () => {
      if (settled) return;
      child.kill('SIGTERM');
      killTimer = setTimeout(() => {
        try { child.kill('SIGKILL'); } catch { /* ignore */ }
      }, SIGKILL_AFTER_MS);
    };

    if (options.signal) {
      options.signal.addEventListener('abort', abortHandler, { once: true });
    }

    const child = spawn(executablePath, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: sandboxEnv,
      shell: false,
    });

    trackOutput(tracker, child);

    const cmdTimer = setTimeout(() => {
      abortHandler();
      if (!settled) {
        settle({ success: false, error: 'Command timed out' });
      }
    }, DEFAULT_CMD_TIMEOUT_MS);

    child.on('error', (err: Error) => {
      settle({ success: false, error: `Process error: ${err.message}` });
    });

    child.on('close', (code) => {
      if (settled) return;

      if (tracker.capped) {
        settle({ success: false, error: 'Output limit exceeded' });
        return;
      }

      if (tracker.stdout.trim()) {
        const results = parseAgentBrowserOutput(tracker.stdout);
        if (results.length === 1) {
          settle(results[0]!);
          return;
        }
        if (results.length > 1) {
          const errorResult = results.find(r => !r.success);
          settle(errorResult ?? results[results.length - 1]!);
          return;
        }
      }

      if (code === 0) {
        settle({ success: true, data: tracker.stdout.trim() || undefined });
      } else {
        const errorMsg = tracker.stderr.trim() || tracker.stdout.trim() || `Exited with code ${code}`;
        settle({ success: false, error: sanitizeErrorMessage(errorMsg) });
      }
    });
  });
}

/**
 * Execute batch commands via agent-browser batch --json with stdin.
 * Secure path for sensitive payloads (evaluate, type, fill, set_cookies).
 */
export async function runBatchStdin(
  commands: Array<{ args: string[]; sensitive?: boolean }>,
  options: AgentBrowserProcessOptions = {},
): Promise<AgentBrowserResult[]> {
  const executablePath = await resolveAgentBrowserExecutable(options.executablePath);
  if (!options.runtimeRoot || !options.namespace) {
    throw new Error('Session required: provide runtimeRoot and namespace in options');
  }
  const session: AgentBrowserSession = { runtimeRoot: options.runtimeRoot, namespace: options.namespace };
  const extraVars: Record<string, string> = {};
  if (options.allowedDomains && options.allowedDomains.length > 0) {
    extraVars.AGENT_BROWSER_ALLOWED_DOMAINS = options.allowedDomains.join(',');
  }
  if (options.loopbackProxyUrl) {
    extraVars.AGENT_BROWSER_PROXY = options.loopbackProxyUrl;
    extraVars.AGENT_BROWSER_PROXY_BYPASS = options.loopbackProxyBypass ?? '<-loopback>';
  }
  const sandboxEnv = buildSandboxEnvironment(options.env ?? process.env, session, extraVars);

  const batchCommands = commands.map(cmd => cmd.args);
  const batchJson = JSON.stringify(batchCommands);

  return new Promise((resolve) => {
    const tracker = createOutputTracker();
    let settled = false;
    let killTimer: ReturnType<typeof setTimeout> | undefined;

    const settle = (results: AgentBrowserResult[]) => {
      if (settled) return;
      settled = true;
      clearTimeout(cmdTimer);
      if (killTimer) clearTimeout(killTimer);
      if (options.signal) {
        try { options.signal.removeEventListener('abort', abortHandler); } catch { /* ignore */ }
      }
      resolve(results);
    };

    const abortHandler = () => {
      if (settled) return;
      child.kill('SIGTERM');
      killTimer = setTimeout(() => {
        try { child.kill('SIGKILL'); } catch { /* ignore */ }
      }, SIGKILL_AFTER_MS);
    };

    if (options.signal) {
      options.signal.addEventListener('abort', abortHandler, { once: true });
    }

    const child = spawn(executablePath, ['batch', '--json', '--bail'], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: sandboxEnv,
      shell: false,
    });

    trackOutput(tracker, child);

    const cmdTimer = setTimeout(() => {
      abortHandler();
      if (!settled) {
        settle([{ success: false, error: 'Batch command timed out' }]);
      }
    }, DEFAULT_CMD_TIMEOUT_MS * 2);

    child.on('error', (err: Error) => {
      settle([{ success: false, error: `Process error: ${err.message}` }]);
    });

    child.on('close', (code) => {
      if (settled) return;

      if (tracker.capped) {
        settle([{ success: false, error: 'Output limit exceeded' }]);
        return;
      }

      const results = parseAgentBrowserOutput(tracker.stdout);
      if (results.length > 0) {
        settle(results);
      } else if (code === 0) {
        settle([{ success: true, data: tracker.stdout.trim() || undefined }]);
      } else {
        settle([{ success: false, error: sanitizeErrorMessage(tracker.stderr.trim() || tracker.stdout.trim() || `Exited with code ${code}`) }]);
      }
    });

    child.stdin.write(batchJson);
    child.stdin.end();
  });
}

/**
 * Take a screenshot via agent-browser, writing to a temp file and reading it back.
 */
export async function runScreenshot(
  options: AgentBrowserProcessOptions = {},
): Promise<{ data: string; mediaType: string; width: number; height: number; byteLength: number } | { error: string }> {
  const executablePath = await resolveAgentBrowserExecutable(options.executablePath);
  if (!options.runtimeRoot || !options.namespace) {
    return { error: 'Session required for screenshot' };
  }
  const session: AgentBrowserSession = { runtimeRoot: options.runtimeRoot, namespace: options.namespace };
  const extraVars: Record<string, string> = {};
  if (options.allowedDomains && options.allowedDomains.length > 0) {
    extraVars.AGENT_BROWSER_ALLOWED_DOMAINS = options.allowedDomains.join(',');
  }
  if (options.loopbackProxyUrl) {
    extraVars.AGENT_BROWSER_PROXY = options.loopbackProxyUrl;
    extraVars.AGENT_BROWSER_PROXY_BYPASS = options.loopbackProxyBypass ?? '<-loopback>';
  }
  const sandboxEnv = buildSandboxEnvironment(options.env ?? process.env, session, extraVars);

  const screenshotDir = join(options.runtimeRoot, 'screenshots');
  const screenshotPath = join(screenshotDir, `shot-${Date.now()}.png`);

  return new Promise((resolve) => {
    let settled = false;
    let killTimer: ReturnType<typeof setTimeout> | undefined;

    let cleaned = false;
    const cleanupScreenshot = async (): Promise<void> => {
      if (cleaned) return;
      cleaned = true;
      await unlink(screenshotPath).catch(() => {});
    };
    const settle = (result: { data: string; mediaType: string; width: number; height: number; byteLength: number } | { error: string }) => {
      if (settled) return;
      settled = true;
      clearTimeout(cmdTimer);
      if (killTimer) clearTimeout(killTimer);
      if (options.signal) {
        try { options.signal.removeEventListener('abort', abortHandler); } catch { /* ignore */ }
      }
      void cleanupScreenshot().finally(() => resolve(result));
    };

    const abortHandler = () => {
      if (settled) return;
      child.kill('SIGTERM');
      killTimer = setTimeout(() => {
        try { child.kill('SIGKILL'); } catch { /* ignore */ }
      }, SIGKILL_AFTER_MS);
    };

    if (options.signal) {
      options.signal.addEventListener('abort', abortHandler, { once: true });
    }

    const child = spawn(executablePath, ['screenshot', screenshotPath], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: sandboxEnv,
      shell: false,
    });

    const tracker = createOutputTracker();
    trackOutput(tracker, child);

    const cmdTimer = setTimeout(() => {
      abortHandler();
      if (!settled) settle({ error: 'Screenshot timed out' });
    }, DEFAULT_CMD_TIMEOUT_MS);

    child.on('error', (err: Error) => {
      settle({ error: `Screenshot process error: ${err.message}` });
    });

    child.on('close', async (code) => {
      if (settled) {
        await cleanupScreenshot();
        return;
      }
      try {
        if (code !== 0) {
          settle({ error: sanitizeErrorMessage(tracker.stderr.trim() || `Screenshot exited ${code}`) });
          return;
        }
        const buf = await readFile(screenshotPath);
        if (buf.byteLength > 10_000_000) {
          settle({ error: `Screenshot too large: ${buf.byteLength} bytes (max 10MB)` });
          return;
        }
        // Read dimensions from PNG header
        let width = 0;
        let height = 0;
        if (buf.length > 24 && buf[0] === 0x89 && buf[1] === 0x50) {
          width = buf.readUInt32BE(16);
          height = buf.readUInt32BE(20);
        }
        if (width > 8000 || height > 8000) {
          settle({ error: `Screenshot dimensions too large: ${width}x${height} (max 8000x8000)` });
          return;
        }
        const data = buf.toString('base64');
        settle({ data, mediaType: 'image/png', width, height, byteLength: buf.byteLength });
      } catch (err) {
        settle({ error: `Screenshot read error: ${err instanceof Error ? err.message : String(err)}` });
      } finally {
        await cleanupScreenshot();
      }
    });
  });
}

/**
 * Close an agent-browser session.
 */
export async function closeSession(session: AgentBrowserSession, options: AgentBrowserProcessOptions = {}): Promise<void> {
  try {
    const executablePath = await resolveAgentBrowserExecutable(options.executablePath);
    const env = buildSandboxEnvironment(options.env ?? process.env, session);

    await new Promise<void>((resolveSettle) => {
      const child = spawn(executablePath, ['session', 'shutdown', '--force'], {
        stdio: ['ignore', 'pipe', 'pipe'],
        env,
        shell: false,
      });

      const timer = setTimeout(() => {
        try { child.kill('SIGKILL'); } catch { /* ignore */ }
        resolveSettle();
      }, 10_000);

      child.on('close', () => {
        clearTimeout(timer);
        resolveSettle();
      });

      child.on('error', () => {
        clearTimeout(timer);
        resolveSettle();
      });
    });
  } catch {
    // Best effort cleanup
  } finally {
    await cleanupRuntimeRoot(session.runtimeRoot);
  }
}

// ── Helpers ──

function sanitizeErrorMessage(msg: string): string {
  return msg
    .replace(/Authorization:\s*(Bearer|token|Basic)\s+\S+/gi, 'Authorization: ***')
    .replace(/Set-Cookie:\s*\S+/gi, 'Set-Cookie: ***')
    .replace(/Cookie:\s*\S+/gi, 'Cookie: ***')
    .replace(/([A-Z_]+_TOKEN|GH_TOKEN|API_KEY)[=:]\s*\S+/gi, '$1=***')
    .slice(0, 2000);
}
