import { spawn, type ChildProcess } from 'node:child_process';
import { writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { validatePublicHttpUrl, fetchText as realFetchText } from './http.js';
import { buildPythonChildEnvironment } from './python-child-env.js';
import { resolvePublicHostname, type DnsLookup } from './network-policy.js';

// ── Constants ──

const DEFAULT_PYTHON_PATH = 'python3';
const DEFAULT_FETCH_TIMEOUT_MS = 30_000;
const SIGKILL_AFTER_MS = 5_000;

// ── Embedded Python script ──
// Reads JSON commands from stdin, writes JSON responses to stdout.
// Commands: {"action":"fetch|health|close",...}
// Responses: {"ok":true|false,...}

const PYTHON_SCRIPT = `import sys, json

def _write(data):
    sys.stdout.write(json.dumps(data) + "\\n")
    sys.stdout.flush()

def main():
    while True:
        line = sys.stdin.readline()
        if not line:
            break
        line = line.strip()
        if not line:
            continue
        try:
            cmd = json.loads(line)
        except Exception as e:
            _write({"ok": False, "error": "Invalid JSON: " + str(e)})
            continue

        action = cmd.get("action", "")

        if action == "fetch":
            try:
                from scrapling.fetchers import Fetcher, DynamicFetcher, StealthyFetcher
                url = cmd["url"]
                fetcher_name = cmd.get("fetcher", "stealthy")
                timeout = cmd.get("timeout", 30000)
                proxy = cmd.get("proxy")

                fetcher_kwargs = {}
                if proxy:
                    fetcher_kwargs["proxy"] = proxy
                if cmd.get("solve_cloudflare"):
                    fetcher_kwargs["cloudflare_solver"] = True
                # Explicit safe redirect policy: the static Fetcher rejects
                # hops to internal/private IPs (SSRF protection); the cap
                # bounds redirect chains. Browser-engine fetchers ignore
                # unknown kwargs, so this stays on the verified static path —
                # the Node boundary still validates the final URL for all paths.
                safe_redirect_kwargs = {"follow_redirects": "safe", "max_redirects": 10}

                # Browser-engine route interception (enforced by Scrapling via
                # Playwright request abortion, suffix-matched on domain names).
                # Mirrors the Node BLOCKED_HOSTNAMES plus the highest-risk IP
                # literals (loopback, link-local, cloud metadata, common gateway
                # addresses). CIDR ranges cannot be expressed here - only the
                # static Fetcher safe-redirect mode and the Node final-URL check
                # cover those. Packets to a redirect target can already have left
                # the host before Node revalidates: container egress stays the
                # authoritative boundary for browser-engine fetchers.
                browser_blocked = {
                    "localhost", "metadata", "metadata.google.internal",
                    "metadata.azure.com", "instance-data",
                    "instance-data.compute.internal",
                    "host.docker.internal", "gateway.docker.internal",
                    "127.0.0.1", "::1", "0.0.0.0",
                    "169.254.169.254", "100.100.100.200",
                    "10.0.0.1", "10.0.2.2",
                    "192.168.0.1", "192.168.1.1",
                    "172.16.0.1", "172.17.0.1",
                }

                if fetcher_name == "dynamic":
                    fetcher = DynamicFetcher(**fetcher_kwargs)
                elif fetcher_name == "fetcher":
                    fetcher = Fetcher(**{**fetcher_kwargs, **safe_redirect_kwargs})
                else:
                    fetcher = StealthyFetcher(**fetcher_kwargs)
                # Older Scrapling releases predate blocked_domains: retry
                # without it rather than failing into a silent downgrade loop.
                # (Static Fetcher stays on safe-redirect kwargs only.)
                if fetcher_name in ("dynamic", "stealthy"):
                    try:
                        fetcher = (DynamicFetcher if fetcher_name == "dynamic" else StealthyFetcher)(
                            **{**fetcher_kwargs, "blocked_domains": browser_blocked})
                    except TypeError:
                        pass

                # Fetcher.get timeout is in seconds
                timeout_sec = timeout / 1000 if timeout > 1000 else timeout
                if fetcher_name == "fetcher":
                    result = fetcher.get(url, timeout=timeout_sec, **safe_redirect_kwargs)
                else:
                    result = fetcher.get(url, timeout=timeout_sec)
                # Extract same-page links if requested
                links = []
                if cmd.get("extract_links"):
                    try:
                        from urllib.parse import urljoin, urlparse
                        raw_links = result.css('a::attr(href)').getall() if hasattr(result, 'css') else []
                        page_url = getattr(result, 'url', url)
                        for href in raw_links:
                            if not href or href.startswith('#') or href.startswith('javascript:'):
                                continue
                            try:
                                abs_url = urljoin(page_url, href)
                                parsed = urlparse(abs_url)
                                if parsed.scheme in ('http', 'https'):
                                    # Strip fragment to match extractLinksFromHtml normalization
                                    clean_url = parsed._replace(fragment='').geturl()
                                    # Exclude binary/file extensions matching BINARY_EXTENSIONS
                                    path_lower = parsed.path.lower()
                                    dot_idx = path_lower.rfind('.')
                                    if dot_idx != -1:
                                        ext = path_lower[dot_idx:]
                                        if ext in ('.pdf','.zip','.gz','.tar','.rar','.7z','.exe','.dmg','.pkg','.deb','.rpm','.png','.jpg','.jpeg','.gif','.webp','.svg','.ico','.bmp','.tiff','.mp3','.mp4','.avi','.mov','.wmv','.flv','.webm','.ogg','.wav','.woff','.woff2','.ttf','.otf','.eot','.doc','.docx','.xls','.xlsx','.ppt','.pptx','.csv','.json','.xml','.yaml','.yml','.bin','.dat','.so','.dll','.dylib'):
                                            continue
                                    links.append(clean_url)
                            except Exception:
                                pass
                    except Exception:
                        pass
                _write({
                    "ok": True,
                    "url": getattr(result, 'url', url),
                    "title": getattr(result, 'title', ''),
                    "content": getattr(result, 'text', getattr(result, 'content', '')),
                    "status_code": getattr(result, 'status', 200),
                    "content_type": str(getattr(result, 'headers', {}).get('content-type', '')),
                    "links": links,
                    "content_length": len(getattr(result, 'text', getattr(result, 'content', ''))),
                })
            except Exception as e:
                _write({"ok": False, "error": f"{type(e).__name__}: {e}"})

        elif action == "health":
            try:
                import scrapling
                _write({
                    "ok": True,
                    "scrapling_version": getattr(scrapling, '__version__', 'unknown'),
                    "python_version": sys.version.split()[0],
                })
            except ImportError:
                _write({"ok": False, "error": "scrapling not installed"})
            except Exception as e:
                _write({"ok": False, "error": f"{type(e).__name__}: {e}"})

        elif action == "close":
            break

    sys.exit(0)

if __name__ == "__main__":
    main()
`;

// ── Public Interfaces (spec) ──

export interface ScraplingBridgeOptions {
  pythonPath?: string;
  fetcher?: 'fetcher' | 'dynamic' | 'stealthy';
  solveCloudflare?: boolean;
  proxy?: string;
  fetchTimeout?: number;
  signal?: AbortSignal;
  extractLinks?: boolean;
  lookup?: DnsLookup;
}

export interface ScraplingFetchResult {
  url: string;
  title: string;
  content: string;
  statusCode?: number;
  contentType?: string;
  links?: string[];
  contentLength?: number;
}

export interface ScraplingHealthStatus {
  available: boolean;
  pythonVersion?: string;
  scraplingVersion?: string;
  error?: string;
}

// ── ScraplingBridge ──

export class ScraplingBridge {
  private static _scriptDir: string | undefined;
  private static _scriptPath: string | undefined;

  private readonly options: {
    pythonPath: string;
    fetcher: 'fetcher' | 'dynamic' | 'stealthy';
    solveCloudflare: boolean;
    proxy: string | undefined;
    fetchTimeout: number;
    extractLinks: boolean;
  };
  private readonly _enabled: boolean;
  private readonly _signal: AbortSignal | undefined;
  private readonly _lookup: DnsLookup | undefined;
  private readonly _spawn: typeof spawn;
  private readonly _fetchTextFallback: typeof realFetchText;

  private _child: ChildProcess | undefined;
  private _buffer = '';
  private _fetching: Promise<unknown> | null = null;
  private _pendingResolve: ((value: Record<string, unknown>) => void) | null = null;
  private _pendingReject: ((reason: unknown) => void) | null = null;
  private _closed = false;
  private _commandMutex: Promise<void> = Promise.resolve();
  private _healthCache: ScraplingHealthStatus | undefined;

  // Track registered listeners for cleanup on restart
  private _onChildData: ((chunk: Buffer) => void) | undefined;
  private _onChildExit: ((code: number | null, signal: string | null) => void) | undefined;
  private _onChildError: ((err: Error) => void) | undefined;

  constructor(options?: ScraplingBridgeOptions) {
    const env = process.env;
    // Auto-detect: always enabled unless explicitly disabled
    const envEnabled = env.PI_SEARCH_SCRAPLING_ENABLED;
    this._enabled = envEnabled === undefined || (envEnabled !== '0' && envEnabled !== 'false' && envEnabled !== '');

    const envFetcher = env.PI_SEARCH_SCRAPLING_FETCHER;
    const validFetcher = envFetcher === 'fetcher' || envFetcher === 'dynamic' || envFetcher === 'stealthy'
      ? envFetcher
      : undefined;
    const envSolve = env.PI_SEARCH_SCRAPLING_SOLVE_CLOUDFLARE;
    this.options = {
      pythonPath: options?.pythonPath ?? env.PI_SEARCH_SCRAPLING_PYTHON_PATH ?? DEFAULT_PYTHON_PATH,
      fetcher: options?.fetcher ?? validFetcher ?? 'stealthy',
      solveCloudflare: options?.solveCloudflare ?? !(envSolve === '0' || envSolve === 'false'),
      proxy: options?.proxy ?? env.PI_SEARCH_SCRAPLING_PROXY ?? undefined,
      fetchTimeout: options?.fetchTimeout ?? DEFAULT_FETCH_TIMEOUT_MS,
      extractLinks: options?.extractLinks ?? false,
    };

    this._signal = options?.signal;
    this._lookup = options?.lookup;
    this._spawn = (options as Record<string, unknown>)?._spawn as typeof spawn | undefined ?? spawn;
    this._fetchTextFallback = (options as Record<string, unknown>)?._fetchText as typeof realFetchText | undefined ?? realFetchText;

    if (this._signal) {
      if (this._signal.aborted) {
        this._closed = true;
      } else {
        this._signal.addEventListener('abort', () => {
          if (this._pendingReject) {
            const reject = this._pendingReject;
            this._pendingResolve = null;
            this._pendingReject = null;
            reject(new DOMException('Aborted', 'AbortError'));
          }
          this.close().catch(() => { /* swallow */ });
        }, { once: true });
      }
    }
  }

  // ── Public API ──

  async fetch(url: string): Promise<ScraplingFetchResult> {
    if (this._closed) throw new Error('ScraplingBridge is closed');

    const validatedUrl = validatePublicHttpUrl(url);
    // SSRF dispatch gating (mirrors http.ts ordering): static validation
    // above, DNS preflight here — before any subprocess spawns. Network
    // enforcement semantics live in network-policy; this only wires it in.
    // A pre-aborted signal dispatches nothing, so skip straight through and
    // let the closed/abort path surface as before.
    if (!this._signal?.aborted) {
      await resolvePublicHostname(new URL(validatedUrl).hostname, this._signal, this._lookup);
    }

    if (!this._enabled) {
      return this.fallbackFetch(validatedUrl);
    }

    // App-layer SSRF note: static + DNS preflight above run before any
    // subprocess spawns, and the final-URL check below fails closed without
    // fallback. Neither can guarantee no packet reaches an internal address:
    // the Python engine follows redirects / resolves DNS on its own. The
    // static 'fetcher' path additionally gets safe-redirect kwargs; the
    // browser-engine paths (dynamic/stealthy) get only suffix-matched
    // blocked_domains. Container egress is the authoritative boundary.
    // Proxy passthrough is operator-owned: a proxy can relay anywhere, so a
    // configured proxy must itself be trusted. Fail closed on malformed proxy.
    let proxy: string | null = this.options.proxy ?? null;
    if (proxy !== null) {
      let scheme = '';
      try {
        scheme = new URL(proxy).protocol;
      } catch {
        throw new Error('Invalid Scrapling proxy URL');
      }
      if (scheme !== 'http:' && scheme !== 'https:') {
        throw new Error('Invalid Scrapling proxy URL');
      }
    }

    const scriptPath = ScraplingBridge.ensureScript();

    // Serialize fetch calls so queued operations cannot start while a prior
    // command is retrying or restartProcess is still running.
    const prev = this._fetching ?? Promise.resolve();
    const current = (async () => {
      await prev;
      await this.ensureProcess(scriptPath);

      // Try with one restart
      for (let attempt = 1; attempt <= 2; attempt++) {
        try {
          const response = await this.sendCommand({
            action: 'fetch',
            url: validatedUrl,
            fetcher: this.options.fetcher,
            solve_cloudflare: this.options.solveCloudflare,
            proxy,
            timeout: this.options.fetchTimeout,
            extract_links: this.options.extractLinks ?? false,
          });

          if (response.ok === true) {
            // Final-URL revalidation: the Python engine may already have
            // followed redirects before Node sees the result. Fail closed
            // with a fixed boundary message (never serve blocked content
            // via return or fallback).
            // Validate a normalized copy; return the engine URL verbatim
            // to preserve the prior return shape (no normalization change).
            const finalUrl = String(response.url ?? validatedUrl);
            try {
              const checked = validatePublicHttpUrl(finalUrl);
              if (!this._signal?.aborted) {
                await resolvePublicHostname(new URL(checked).hostname, this._signal, this._lookup);
              }
            } catch {
              throw new Error('Scrapling bridge returned blocked URL');
            }
            return {
              url: finalUrl,
              title: String(response.title ?? ''),
              content: String(response.content ?? ''),
              ...(response.status_code !== undefined && response.status_code !== null
                ? { statusCode: Number(response.status_code) }
                : {}),
              ...(response.content_type ? { contentType: String(response.content_type) } : {}),
              ...(Array.isArray(response.links) ? { links: response.links as string[] } : {}),
              ...(typeof response.content_length === 'number' ? { contentLength: response.content_length as number } : {}),
            };
          }

          // Error response from Python — restart and retry
          if (attempt === 2) break;
          await this.restartProcess(scriptPath);
        } catch (err) {
          // Boundary violations fail closed: never restart into or fall
          // back onto blocked content.
          if (err instanceof Error && err.message === 'Scrapling bridge returned blocked URL') throw err;
          // If bridge was closed or aborted, don't restart
          if (this._closed || this._signal?.aborted) throw new Error('ScraplingBridge is closed');
          // Process error / crash — restart and retry
          if (attempt === 2) break;
          await this.restartProcess(scriptPath);
        }
      }
      // All retry attempts exhausted — fall back to plain HTTP
      return this.fallbackFetch(validatedUrl);
    })();
    this._fetching = current.then(
      () => { if (this._fetching === current) this._fetching = null; },
      () => { if (this._fetching === current) this._fetching = null; },
    );
    return current;
  }

  async health(): Promise<ScraplingHealthStatus> {
    if (this._healthCache) return this._healthCache;

    if (!this._enabled) {
      this._healthCache = { available: false };
      return this._healthCache;
    }

    const scriptPath = ScraplingBridge.ensureScript();
    let result: ScraplingHealthStatus;

    try {
      const parsed = await this.oneShotCommand(scriptPath, { action: 'health' });
      if (parsed.ok === true) {
        result = {
          available: true,
          ...(parsed.python_version ? { pythonVersion: String(parsed.python_version) } : {}),
          ...(parsed.scrapling_version ? { scraplingVersion: String(parsed.scrapling_version) } : {}),
        };
      } else {
        result = {
          available: false,
          error: parsed.error ? String(parsed.error) : 'Health check returned error',
        };
      }
    } catch (err) {
      result = {
        available: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }

    this._healthCache = result;
    return result;
  }

  async close(): Promise<void> {
    if (this._closed) return;
    this._closed = true;

    const child = this._child;
    if (!child) return;

    this._child = undefined;
    this.clearPending('Bridge closed');

    // Send close command if stdin is writable
    try {
      if (child.stdin && !child.stdin.destroyed && child.stdin.writable) {
        child.stdin.write(JSON.stringify({ action: 'close' }) + '\n');
      }
    } catch { /* swallow */ }

    // SIGTERM, then SIGKILL after timeout
    try {
      child.kill('SIGTERM');
    } catch { /* swallow */ }

    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        try { child.kill('SIGKILL'); } catch { /* swallow */ }
        resolve();
      }, SIGKILL_AFTER_MS);

      child.once('exit', () => {
        clearTimeout(timer);
        resolve();
      });

      // Also resolve if already exited
      if (child.exitCode !== null || child.signalCode !== null) {
        clearTimeout(timer);
        resolve();
      }
    });
  }

  // ── Private helpers ──

  private async ensureProcess(scriptPath: string): Promise<void> {
    if (this._child && !this._child.killed) return;
    this.spawnProcess(scriptPath);
  }

  private spawnProcess(scriptPath: string): void {
    // Clear stale stdout fragment before new child — prevents old partial line joining new JSON
    this._buffer = '';
    // Detach old listeners if any
    this.detachChildListeners();

    const child = this._spawn(this.options.pythonPath, [scriptPath], {
      stdio: ['pipe', 'pipe', 'inherit'],
      env: buildPythonChildEnvironment(),
    });
    this._child = child;

    // Buffer stdout and resolve pending command responses
    const onData = (chunk: Buffer) => {
      this._buffer += chunk.toString();
      const lines = this._buffer.split('\n');
      this._buffer = lines.pop() ?? '';

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          const parsed = JSON.parse(trimmed) as Record<string, unknown>;
          const resolve = this._pendingResolve;
          if (resolve) {
            this._pendingResolve = null;
            this._pendingReject = null;
            resolve(parsed);
          }
        } catch {
          // Invalid JSON line — ignore
        }
      }
    };

    // Process exit before response received
    const onExit = () => {
      this._child = undefined;
      if (this._pendingReject) {
        const reject = this._pendingReject;
        this._pendingResolve = null;
        this._pendingReject = null;
        reject(new Error('Subprocess exited unexpectedly'));
      }
    };

    // Spawn error (ENOENT, etc.)
    const onError = (err: Error) => {
      this._child = undefined;
      if (this._pendingReject) {
        const reject = this._pendingReject;
        this._pendingResolve = null;
        this._pendingReject = null;
        reject(err);
      }
    };

    this._onChildData = onData;
    this._onChildExit = onExit;
    this._onChildError = onError;

    if (child.stdout) child.stdout.on('data', onData);
    child.on('exit', onExit);
    child.once('error', onError);
  }

  private detachChildListeners(): void {
    const child = this._child;
    if (!child) return;
    if (child.stdout && this._onChildData) child.stdout.removeListener('data', this._onChildData);
    if (this._onChildExit) child.removeListener('exit', this._onChildExit);
    if (this._onChildError) child.removeListener('error', this._onChildError);
    this._onChildData = undefined;
    this._onChildExit = undefined;
    this._onChildError = undefined;
  }

  private killChild(): void {
    const child = this._child;
    if (!child) return;
    this.detachChildListeners();
    this._child = undefined;
    try { child.kill('SIGKILL'); } catch { /* swallow */ }
  }

  private async restartProcess(scriptPath: string): Promise<void> {
    if (this._closed || this._signal?.aborted) return;
    this._buffer = '';
    this.killChild();
    // Brief yield to let OS release resources
    await new Promise((r) => setImmediate(r));
    if (this._closed || this._signal?.aborted) return;
    this.spawnProcess(scriptPath);
  }

  private sendCommand(data: Record<string, unknown>): Promise<Record<string, unknown>> {
    const result = this._commandMutex.then(() => this._doSendCommand(data));
    this._commandMutex = result.then(() => {}, () => {});
    return result;
  }

  private _doSendCommand(data: Record<string, unknown>): Promise<Record<string, unknown>> {
    return new Promise<Record<string, unknown>>((resolve, reject) => {
      const child = this._child;
      if (!child || !child.stdin || child.stdin.destroyed || !child.stdin.writable) {
        reject(new Error('Subprocess not available'));
        return;
      }

      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        this._pendingResolve = null;
        const rejectFn = this._pendingReject;
        this._pendingReject = null;
        if (rejectFn) {
          rejectFn(new Error('Command timed out'));
        }
        if (child && !child.killed) {
          try { child.kill('SIGKILL'); } catch { /* ignore */ }
        }
      }, this.options.fetchTimeout);

      this._pendingResolve = (value) => {
        if (timedOut) return;
        clearTimeout(timer);
        this._pendingResolve = null;
        this._pendingReject = null;
        resolve(value);
      };
      this._pendingReject = (reason) => {
        if (timedOut) return;
        clearTimeout(timer);
        this._pendingResolve = null;
        this._pendingReject = null;
        reject(reason);
      };

      try {
        child.stdin.write(JSON.stringify(data) + '\n');
      } catch (err) {
        clearTimeout(timer);
        this._pendingResolve = null;
        this._pendingReject = null;
        reject(err);
      }
    });
  }

  private oneShotCommand(scriptPath: string, data: Record<string, unknown>): Promise<Record<string, unknown>> {
    return new Promise<Record<string, unknown>>((resolve, reject) => {
      const child = this._spawn(this.options.pythonPath, [scriptPath], {
        stdio: ['pipe', 'pipe', 'inherit'],
        env: buildPythonChildEnvironment(),
      });

      let buffer = '';
      let responded = false;
      const timer = setTimeout(() => {
        if (!responded) {
          responded = true;
          try { child.kill('SIGKILL'); } catch { /* swallow */ }
          reject(new Error('One-shot command timed out'));
        }
      }, this.options.fetchTimeout);

      const onData = (chunk: Buffer) => {
        buffer += chunk.toString();
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed) continue;
          try {
            const parsed = JSON.parse(trimmed) as Record<string, unknown>;
            if (!responded) {
              responded = true;
              clearTimeout(timer);
              resolve(parsed);
            }
          } catch { /* ignore */ }
        }
      };

      const onExit = () => {
        if (!responded) {
          responded = true;
          clearTimeout(timer);
          reject(new Error('One-shot subprocess exited without response'));
        }
      };

      child.stdout?.on('data', onData);
      child.once('exit', onExit);
      child.once('error', (err) => {
        if (!responded) {
          responded = true;
          clearTimeout(timer);
          reject(err);
        }
      });

      try {
        child.stdin?.write(JSON.stringify(data) + '\n');
        child.stdin?.end();
      } catch (err) {
        if (!responded) {
          responded = true;
          clearTimeout(timer);
          reject(err);
        }
      }
    });
  }

  private async fallbackFetch(url: string): Promise<ScraplingFetchResult> {
    const content = await this._fetchTextFallback(url);
    return { url, title: '', content };
  }

  private clearPending(reason: string): void {
    if (this._pendingReject) {
      const reject = this._pendingReject;
      this._pendingResolve = null;
      this._pendingReject = null;
      reject(new Error(reason));
    }
    this._pendingResolve = null;
    this._pendingReject = null;
  }

  // ── Static script management ──

  private static ensureScript(): string {
    if (!ScraplingBridge._scriptPath) {
      const dir = mkdtempSync(join(tmpdir(), 'scrapling-bridge-'));
      const filePath = join(dir, '_bridge.py');
      writeFileSync(filePath, PYTHON_SCRIPT, 'utf-8');
      ScraplingBridge._scriptDir = dir;
      ScraplingBridge._scriptPath = filePath;

      // Cleanup on process exit
      process.once('exit', () => {
        ScraplingBridge.cleanupScript();
      });
    }
    return ScraplingBridge._scriptPath;
  }

  private static cleanupScript(): void {
    if (ScraplingBridge._scriptDir) {
      try { rmSync(ScraplingBridge._scriptDir, { recursive: true, force: true }); } catch { /* swallow */ }
      ScraplingBridge._scriptDir = undefined;
      ScraplingBridge._scriptPath = undefined;
    }
  }
}
