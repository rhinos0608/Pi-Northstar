import type { ImageContent } from '@earendil-works/pi-ai';
import type { BackendCallResult } from '../backend.js';
import type { BrowserRequest, BatchCommand, SemanticActionRequest } from './browser-policy.js';
import { parseLoopbackDebugTarget } from './loopback-debug-policy.js';
import { enrichResult } from './browser-result.js';
import { type ViewportPosition, READ_VIEWPORT_EXPR, isScrollNoop } from './scroll-verification.js';
import { type OverlaySignature, OVERLAY_SIGNATURE_EXPR, detectOverlayAppearance } from './overlay-detection.js';
import { armClickProbe, isEligibleForVerification, readClickProbe, type EvalRunner } from './click-verification.js';
import { parseSnapshotRefs, extractSnapshotUrl, compactSnapshotRefs } from './snapshot-parser.js';
import { jobStepToBrowserRequest } from './browser-job.js';
import type { BatchStepResult, BrowserResult } from './browser-result.js';
import {
  validateBrowserRequest,
  validateNavigationUrl,
  validateSelector,
  validateText,
  validateExpression,
  validateCookiesArray,
  validateScrollCoord,
  validateWaitMs,
  MAX_SELECT_VALUES,
  dnsPreflight,
  freezeAllowedDomains,
  checkDomainAllowed,
  extractCookieMetadata,
  validateAllowedDomainsDns,
  isSensitiveAction,
  batchNavigationUrl,
} from './browser-policy.js';
import {
  runCommand,
  runBatchStdin,
  runScreenshot,
  closeSession,
  createRuntimeRoot,
  cleanupRuntimeRoot,
  generateNamespace,
  verifyVersion,
  resolveAgentBrowserExecutable,
  type AgentBrowserSession,
  type AgentBrowserProcessOptions,
  type AgentBrowserResult,
} from './agent-browser-process.js';
import { jsonTextResult, textResult } from '../core/tool-output.js';
import type { DnsLookup } from '../network-policy.js';
import { resolvePublicHostname } from '../network-policy.js';
import { SessionPageStateStore, StaleRefError, preflightRef } from './session-page-state.js';

function stripIpv6Brackets(hostname: string): string {
  return hostname.startsWith('[') && hostname.endsWith(']')
    ? hostname.slice(1, -1)
    : hostname;
}

/**
 * Guard predicate: batch command carrying a navigation target (open/navigate
 * URL arg, or `tab new <url>`). Uses the canonical batchNavigationUrl shape
 * so every navigation-carrying subcommand gets identical SSRF/loopback
 * preflight — raw command arrays cannot tunnel underneath the policy layer.
 * Commands reaching here already passed the SUPPORTED_BATCH_SUBCOMMANDS
 * allowlist + per-subcommand arity checks in validateBatchRequest
 * (pre-session, pre-spawn), so this only classifies navigation steps for
 * preflight — it never authorizes argv.
 */
function isBatchNavigationCommand(cmd: BatchCommand): boolean {
  return batchNavigationUrl(cmd) !== undefined;
}

/** Guard predicate: semantic request targets the nth locator (index rides positionally). */
function isNthSemanticLocator(sa: SemanticActionRequest): boolean {
  return sa.locator === 'nth';
}

/** Guard predicate: semantic fill carrying a value payload (must ride stdin, never argv). */
function hasSemanticFillValue(sa: SemanticActionRequest): boolean {
  return sa.verb === 'fill' && sa.value !== undefined;
}

/** Guard predicate: semantic click verb (needs dispatch verification). */
function isSemanticClickVerb(sa: SemanticActionRequest): boolean {
  return sa.verb === 'click';
}

/** Build the `find` argv for a semantic request. nth takes the index positionally. */
function buildSemanticFindArgs(sa: SemanticActionRequest): string[] {
  const args: string[] = isNthSemanticLocator(sa)
    ? ['find', 'nth', String(sa.index ?? 0), sa.query, sa.verb]
    : ['find', sa.locator, sa.query, sa.verb];
  if (sa.name) args.push('--name', sa.name);
  if (sa.exact) args.push('--exact');
  return args;
}

/** Shared sensitive-action gate: returns the policy-denial result, or undefined when allowed. */
function sensitiveGateResult(action: string, options: AgentBrowserProcessOptions): BackendCallResult | undefined {
  if (isSensitiveAction(action) && options.env?.PI_SEARCH_BROWSER_ALLOW_SENSITIVE !== '1') {
    return jsonTextResult({ error: `${action} disabled by policy. Set PI_SEARCH_BROWSER_ALLOW_SENSITIVE=1 to enable.` });
  }
  return undefined;
}

/** Scroll direction from a validated (x, y) offset pair. */
function scrollDirection(x: number, y: number): string {
  if (y > 0) return 'down';
  if (y < 0) return 'up';
  if (x > 0) return 'right';
  if (x < 0) return 'left';
  return 'down';
}

/** Snippet body as text: strings pass through, anything else JSON-encodes. */
function snippetTextFromData(data: unknown): string {
  return typeof data === 'string' ? data : JSON.stringify(data ?? '');
}

/** Cookie list from a `cookies get --json` payload (array or { cookies } envelope). */
function cookiesFromResultData(cookieData: { cookies?: unknown[] } | unknown): unknown[] {
  if (Array.isArray(cookieData)) return cookieData;
  if (cookieData && typeof cookieData === 'object') {
    const cookies = (cookieData as { cookies?: unknown }).cookies;
    if (Array.isArray(cookies)) return cookies;
  }
  return [];
}

/** Append per-cookie `--flag value` pairs for `cookies set`. */
function pushCookieFlagArgs(args: string[], c: Record<string, unknown>): void {
  if (typeof c.domain === 'string') args.push('--domain', c.domain);
  if (typeof c.path === 'string') args.push('--path', c.path);
  if (c.secure === true) args.push('--secure');
  if (c.httpOnly === true) args.push('--httpOnly');
  if (typeof c.sameSite === 'string') args.push('--sameSite', c.sameSite);
  if (typeof c.expires === 'number') args.push('--expires', String(c.expires));
}

/** Job step failure detail surfaced as the step error. */
function jobStepDetailError(stepResult: BrowserResult): string | undefined {
  return (stepResult as unknown as { details?: { error?: string } }).details?.error;
}

function extractError(result: BackendCallResult): string | undefined {
  const details = result.details as Record<string, unknown> | undefined;
  const error = details?.error;
  return typeof error === 'string' ? error : undefined;
}

function sanitizeErrorMessage(message: string): string {
  return message
    .replace(/Proxy-Authorization\s*[:=]\s*[^,\s}"']+/gi, 'Proxy-Authorization: ***')
    .replace(/Authorization\s*[:=]\s*(?:Bearer|Basic|token)?\s*\S+/gi, 'Authorization: ***')
    .replace(/\/\/[^\/\s]*:[^\/\s]*@/g, '//***:***@')
    .replace(/\/\/[^\/\s]*@/g, '//***@')
    .replace(/(["']?(?:cookie|value|token|password|secret)["']?)\s*[:=]\s*["']?[^,\s}"']+["']?/gi, '$1=***')
    .replace(/Bearer\s+\S+/gi, 'Bearer ***')
    .replace(/Cookie\s*[:=]\s*[^,\s}"']+/gi, 'Cookie: ***')
    .replace(/Set-Cookie\s*[:=]\s*[^,\s}"']+/gi, 'Set-Cookie: ***')
    .slice(0, 2000);
}

// ── Types ──

export interface AgentBrowserAdapterOptions {
  executablePath?: string;
  runtimeRoot?: string;
  env?: Record<string, string | undefined> | undefined;
  signal?: AbortSignal;
  /** DNS stub seam: hermetic tests resolve without external network. Production omits it (system DNS). */
  dnsLookup?: DnsLookup | undefined;
  loopbackMode?: {
    proxyUrl: string;
    proxyBypass?: string;
    origin: string;
  };
}

export interface AgentBrowserStatus {
  version: string;
  executable: string;
  backend: 'agent-browser';
}

// ── Screenshot limits ──

export const SCREENSHOT_MAX_BYTES = 10_000_000;
export const SCREENSHOT_MAX_DIMENSION = 8_000;

// ── Adapter ──

export class AgentBrowserAdapter {
  private session: AgentBrowserSession;
  private executablePath: string | undefined;
  private versionVerified = false;
  private allowedDomains: string[] = [];
  private domainsFrozen = false;
  private _closed = false;
  private _sessionStarted = false;
  private readonly pageState = new SessionPageStateStore();
  /** Immutable loopback mode, if active. */
  readonly loopbackMode?: AgentBrowserAdapterOptions['loopbackMode'];
  private readonly dnsLookup?: DnsLookup | undefined;

  constructor(options: AgentBrowserAdapterOptions = {}) {
    this.executablePath = options.executablePath;
    this.loopbackMode = options.loopbackMode;
    this.dnsLookup = options.dnsLookup;
    this.session = {
      runtimeRoot: options.runtimeRoot ?? '',
      namespace: '',
    };
  }

  private async resolveExecutable(options?: AgentBrowserProcessOptions): Promise<string> {
    const candidate = options?.executablePath ?? this.executablePath;
    if (candidate) {
      // Operator-configured paths are trusted locations, not trusted versions:
      // drift between the pinned CLI surface and the binary breaks argv contracts.
      if (!this.versionVerified || this.executablePath !== candidate) {
        await verifyVersion(candidate);
        this.executablePath = candidate;
        this.versionVerified = true;
      }
      return this.executablePath;
    }
    this.executablePath = await resolveAgentBrowserExecutable();
    this.versionVerified = true;
    return this.executablePath;
  }

  get closed(): boolean {
    return this._closed;
  }

  get sessionInfo(): AgentBrowserSession {
    return this.session;
  }

  /**
   * Internal-only file attachment seam for code-owned browser workflows.
   * This is deliberately NOT a BrowserAction and is therefore unreachable
   * from the model-facing browser tool schema. Both selector and local path
   * ride the stdin batch transport rather than child argv.
   */
  async uploadFileForInternalUse(
    selector: string,
    filePath: string,
    options: AgentBrowserProcessOptions = {},
  ): Promise<BackendCallResult> {
    if (options.env?.PI_SEARCH_BROWSER_ALLOW_SENSITIVE !== '1') {
      return jsonTextResult({
        error: 'internal file upload disabled by policy',
      });
    }
    const validatedSelector = validateSelector(selector);
    if (!validatedSelector) return jsonTextResult({ error: 'selector is required' });
    if (typeof filePath !== 'string' || filePath.trim() === '' || filePath.includes('\0')) {
      return jsonTextResult({ error: 'file path is invalid' });
    }
    await this.ensureSession(options);
    const merged = this.mergeOptions(options);
    const results = await runBatchStdin(
      [{
        args: ['upload', validatedSelector, filePath],
        sensitive: true,
      }],
      merged,
    );
    const result = results[0];
    if (result?.success) this.pageState.invalidate(this.session.namespace, 'upload');
    return jsonTextResult(
      result?.success
        ? { ok: true }
        : { ok: false, error: sanitizeErrorMessage(result?.error ?? 'File upload failed') },
    );
  }

  /**
   * Perform a status check - verify executable and version without launching browser.
   */
  async status(): Promise<AgentBrowserStatus & BackendCallResult> {
    const exe = await this.resolveExecutable();
    const version = await verifyVersion(exe);
    return {
      version,
      executable: exe,
      backend: 'agent-browser',
      content: [{ type: 'text', text: `agent-browser ${version} ready` }],
      details: { version, executable: this.executablePath, backend: 'agent-browser' },
    };
  }

  /**
   * Execute a browser action. Validation errors return as results, never throws.
   */
  async execute(rawArgs: Record<string, unknown>, options: AgentBrowserProcessOptions = {}): Promise<BackendCallResult> {
    if (this._closed) {
      const result: BackendCallResult = { content: [{ type: 'text', text: 'Session closed' }], details: { error: 'Session closed' } };
      const action = typeof rawArgs.action === 'string' ? (rawArgs.action as BrowserRequest['action']) : 'status';
      return enrichResult(result, { action, errorMessage: 'Session closed' });
    }

    let request: BrowserRequest;
    try {
      request = validateBrowserRequest(rawArgs);
    } catch (error) {
      const rawMessage = error instanceof Error ? error.message : String(error);
      const message = sanitizeErrorMessage(rawMessage);
      const result: BackendCallResult = { content: [{ type: 'text', text: message }], details: { error: message } };
      const action = typeof rawArgs.action === 'string' ? (rawArgs.action as BrowserRequest['action']) : 'status';
      return enrichResult(result, { action, errorMessage: message });
    }

    try {
      const raw = await this.dispatch(request, options);
      const errorMessage = extractError(raw);
      return errorMessage !== undefined
        ? enrichResult(raw, { action: request.action, errorMessage })
        : enrichResult(raw, { action: request.action });
    } catch (error) {
      const rawMessage = error instanceof Error ? error.message : String(error);
      const message = sanitizeErrorMessage(rawMessage);
      const result: BackendCallResult = { content: [{ type: 'text', text: message }], details: { error: message } };
      return enrichResult(result, { action: request.action, errorMessage: message });
    }
  }

  /**
   * Close the session - shutdown daemon and cleanup runtime root.
   */
  async close(): Promise<void> {
    if (this._closed) return;
    this._closed = true;
    if (this.hasActiveSession()) {
      await closeSession(this.session, { executablePath: this.executablePath ?? '' });
    }
    if (this.session.runtimeRoot) {
      await cleanupRuntimeRoot(this.session.runtimeRoot);
    }
  }

  /**
   * Set allowed domains. Can only be set once before any navigation.
   */
  setAllowedDomains(domains: string[]): void {
    if (this.domainsFrozen) {
      throw new Error('Allowed domains already frozen for this session');
    }
    this.allowedDomains = freezeAllowedDomains(domains);
    this.domainsFrozen = true;
  }

  /** Guard predicate: live session with namespace + runtime root (close guard). */
  private hasActiveSession(): boolean {
    return this._sessionStarted && !!this.session.namespace && !!this.session.runtimeRoot;
  }

  /** Guard predicate: first navigation while domains unfrozen (freeze-staging check). */
  private isStagingFirstNavigation(staged?: string[]): boolean {
    return !this.domainsFrozen && (!staged || staged.length === 0);
  }

  // ── Private dispatch ──

  private async dispatch(request: BrowserRequest, options: AgentBrowserProcessOptions): Promise<BackendCallResult> {
    const handler = this.lookupActionHandler(request.action);
    if (!handler) {
      return jsonTextResult({ error: `Unsupported browser action: ${(request as { action: string }).action}` });
    }
    return handler(request, options);
  }

  private lookupActionHandler(
    action: BrowserRequest['action'],
  ): ((request: BrowserRequest, options: AgentBrowserProcessOptions) => Promise<BackendCallResult>) | undefined {
    const handlers: Record<
      BrowserRequest['action'],
      (request: BrowserRequest, options: AgentBrowserProcessOptions) => Promise<BackendCallResult>
    > = {
      status: () => this.status(),
      close: () => this.handleClose(),
      navigate: (req, options) => this.handleNavigate(req, options),
      evaluate: (req, options) => this.handleEvaluate(req, options),
      text: (req, options) => this.handleText(req, options),
      html: (req, options) => this.handleHtml(req, options),
      click: (req, options) => this.handleClick(req, options),
      type: (req, options) => this.handleType(req, options),
      scroll: (req, options) => this.handleScroll(req, options),
      tabs: (_req, options) => this.handleTabs(options),
      cookies: (req, options) => this.handleCookies(req, options),
      set_cookies: (req, options) => this.handleSetCookies(req, options),
      screenshot: (req, options) => this.handleScreenshot(req, options),
      snapshot: (req, options) => this.handleSnapshot(req, options),
      fill: (req, options) => this.handleFill(req, options),
      select: (req, options) => this.handleSelect(req, options),
      wait: (req, options) => this.handleWait(req, options),
      get_url: (_req, options) => this.handleGetUrl(options),
      get_title: (_req, options) => this.handleGetTitle(options),
      semanticAction: (req, options) => this.handleSemanticAction(req, options),
      job: (req, options) => this.handleJob(req, options),
      batch: (req, options) => this.handleBatch(req, options),
    };
    return handlers[action];
  }

  private async ensureSession(options: AgentBrowserProcessOptions): Promise<void> {
    await this.resolveExecutable(options);
    if (!this.session.runtimeRoot) {
      const root = options.runtimeRoot ?? await createRuntimeRoot();
      this.session = {
        runtimeRoot: root,
        namespace: generateNamespace(),
      };
    }
    if (!this.session.namespace) {
      this.session.namespace = generateNamespace();
    }
    this._sessionStarted = true;
  }

  private evalRunner(merged: AgentBrowserProcessOptions): EvalRunner {
    return async (expression: string) => {
      const results = await runBatchStdin([{ args: ['eval', expression], sensitive: true }], merged);
      const result = results[0];
      if (!result) return { success: false, error: 'No eval result' };
      if (!result.success) return { success: false, error: result.error ?? 'Evaluation failed' };
      return { success: true, data: result.data };
    };
  }

  private mergeOptions(options: AgentBrowserProcessOptions): AgentBrowserProcessOptions {
    const exePath = this.executablePath ?? options.executablePath ?? '';
    const merged: AgentBrowserProcessOptions = {
      ...options,
      executablePath: exePath,
    };
    if (this.session.runtimeRoot) merged.runtimeRoot = this.session.runtimeRoot;
    if (this.session.namespace) merged.namespace = this.session.namespace;
    if (this.allowedDomains.length > 0) merged.allowedDomains = this.allowedDomains;
    // Pass loopback confinement env to every command when active
    if (this.loopbackMode) {
      merged.loopbackProxyUrl = this.loopbackMode.proxyUrl;
      if (this.loopbackMode.proxyBypass) {
        merged.loopbackProxyBypass = this.loopbackMode.proxyBypass;
      }
    }
    return merged;
  }

  // ── Action handlers ──

  /**
   * Shared public-navigation trust boundary: static URL validation, DNS
   * preflight, first-hostname staging, and containment check. Used by
   * single navigate and by batch/job navigation steps alike so raw command
   * arrays cannot tunnel underneath the policy layer. Throws on invalid
   * targets; returns { ok: false } only for domain-policy blocks.
   *
   * Stage-then-commit: when the session is not yet frozen, the first
   * hostname is validated (freeze-shape + DNS) and returned as
   * pendingHostname WITHOUT freezing. The caller commits the freeze only
   * after the navigation command succeeds, so a failed open leaves
   * domainsFrozen=false and allowedDomains unchanged. Pass `staged` when
   * preflighting several commands up front (batch) so later commands are
   * checked against the staged first hostname.
   */
  private async preflightNavigationTarget(rawUrl: string, signal?: AbortSignal, staged?: string[]): Promise<{ ok: true; url: string; pendingHostname?: string } | { ok: false; error: string }> {
    const url = validateNavigationUrl(rawUrl);
    const hostname = new URL(url).hostname.toLowerCase();
    await dnsPreflight(hostname, signal, this.dnsLookup);
    const effective = this.domainsFrozen ? this.allowedDomains : (staged ?? this.allowedDomains);
    if (this.isStagingFirstNavigation(staged)) {
      const candidate = freezeAllowedDomains([hostname]);
      await validateAllowedDomainsDns(candidate, signal, this.dnsLookup);
      return { ok: true, url, pendingHostname: candidate[0]! };
    }
    if (effective.length > 0 && !checkDomainAllowed(hostname, effective)) {
      const allowed = this.domainsFrozen ? this.allowedDomains : effective;
      return {
        ok: false,
        error: `Navigation to ${hostname} blocked by domain policy. Allowed domains: ${allowed.join(', ')}. Close the session and navigate fresh to a different hostname to continue.`,
      };
    }
    return { ok: true, url };
  }

  /** Commit a staged first-navigation hostname. No-op once frozen. */
  private commitNavigationFreeze(hostname: string): void {
    if (!this.domainsFrozen) {
      this.setAllowedDomains([hostname]);
    }
  }

  private async handleNavigate(request: BrowserRequest, options: AgentBrowserProcessOptions): Promise<BackendCallResult> {
    if (!request.url) return this.openBlank(options);
    if (this.loopbackMode) return this.navigateLoopbackTarget(request.url, options);
    return this.navigatePublicTarget(request.url, options);
  }

  private async openBlank(options: AgentBrowserProcessOptions): Promise<BackendCallResult> {
    // Open without navigation (launch browser)
    await this.ensureSession(options);
    const merged = this.mergeOptions(options);
    const result = await runCommand(['open', 'about:blank'], merged);
    if (result.success) this.pageState.invalidate(this.session.namespace, 'navigation');
    return jsonTextResult(result.success ? { ok: true, message: 'Browser launched' } : { ok: false, error: sanitizeErrorMessage(result.error ?? 'Command failed') });
  }

  private async navigateLoopbackTarget(url: string, options: AgentBrowserProcessOptions): Promise<BackendCallResult> {
    // ── Loopback adapter: narrow exception path ──
    const loopbackMode = this.loopbackMode;
    if (!loopbackMode) throw new Error('navigateLoopbackTarget requires loopback mode');
    const loopbackPolicy = parseLoopbackDebugTarget(url);
    if (!loopbackPolicy) {
      return jsonTextResult({ ok: false, error: 'Loopback adapter rejected non-loopback URL' });
    }
    if (loopbackPolicy.origin !== loopbackMode.origin) {
      return jsonTextResult({ ok: false, error: sanitizeErrorMessage(`Different loopback origin rejected. Expected: ${loopbackMode.origin}, got: ${loopbackPolicy.origin}`) });
    }
    // Skip public hostname/DNS check — proxy enforces containment
    // Keep exact hostname in allowedDomains so vendor containment remains active.
    // This narrow loopback exception bypasses public domain validation only here.
    // Strip IPv6 brackets ([::1] → ::1) so mergeOptions forwards canonical value
    const pendingLoopbackHost = stripIpv6Brackets(loopbackPolicy.hostname);
    await this.ensureSession(options);
    const merged = this.mergeOptions(options);
    const result = await runCommand(['open', loopbackPolicy.navigationUrl], merged);
    if (result.success) {
      if (!this.domainsFrozen) {
        this.allowedDomains = [pendingLoopbackHost];
        this.domainsFrozen = true;
      }
      this.pageState.invalidate(this.session.namespace, 'navigation');
    }
    return jsonTextResult(result.success ? { ok: true, url: loopbackPolicy.navigationUrl } : { ok: false, error: sanitizeErrorMessage(result.error ?? 'Command failed') });
  }

  private async navigatePublicTarget(url: string, options: AgentBrowserProcessOptions): Promise<BackendCallResult> {
    // ── Public adapter: strongly filtered, DNS-rebinding TOCTOU remains in user-Chrome path ──
    const preflight = await this.preflightNavigationTarget(url, options.signal);
    if (!preflight.ok) {
      return jsonTextResult({ ok: false, error: preflight.error });
    }
    const finalUrl = preflight.url;

    await this.ensureSession(options);
    const merged = this.mergeOptions(options);

    // Use 'open' command (not 'navigate')
    const result = await runCommand(['open', finalUrl], merged);
    if (result.success) {
      if (preflight.pendingHostname) this.commitNavigationFreeze(preflight.pendingHostname);
      this.pageState.invalidate(this.session.namespace, 'navigation');
      const hostname = new URL(finalUrl).hostname.toLowerCase();
      const suspect = await this.rebindingSuspectError(hostname, options.signal);
      if (suspect) {
        this.pageState.invalidate(this.session.namespace, 'dns-rebinding-suspect');
        try { await this.close(); } catch { /* best-effort session teardown */ }
        return jsonTextResult({ ok: false, error: suspect });
      }
    }
    return jsonTextResult(result.success ? { ok: true, url: finalUrl } : { ok: false, error: sanitizeErrorMessage(result.error ?? 'Command failed') });
  }

  /**
   * Best-effort post-navigation DNS re-resolution check (DNS-rebinding suspect detector).
   * Re-resolves the navigated hostname after a successful open; if it now
   * resolves private/reserved, the preflight address likely differs from the
   * address Chromium connected to (DNS rebinding / Chromium DNS TOCTOU).
   * Returns the degradation error string on suspect (caller invalidates state /
   * aborts), undefined otherwise. Does NOT claim containment. DNS lookup
   * failure keeps success (no proof either way).
   */
  private async rebindingSuspectError(hostname: string, signal?: AbortSignal): Promise<string | undefined> {
    try {
      await resolvePublicHostname(hostname, signal, this.dnsLookup);
      return undefined;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!/private\/reserved address/.test(message)) return undefined;
      return `DNS rebinding suspected: ${hostname} now resolves private; session invalidated (strongly filtered, DNS-rebinding TOCTOU remains in user-Chrome path)`;
    }
  }

  private async runEvaluateBatch(
    merged: AgentBrowserProcessOptions,
    expression: string,
  ): Promise<AgentBrowserResult | undefined> {
    // Use stdin batch mode for sensitive payload — never argv
    const results = await runBatchStdin(
      [{ args: ['eval', expression], sensitive: true }],
      merged,
    );
    return results[0];
  }

  private formatEvaluateResult(result: AgentBrowserResult | undefined): BackendCallResult {
    if (!result?.success) {
      return jsonTextResult({ error: sanitizeErrorMessage(result?.error || 'Evaluation failed') });
    }
    return textResult(String(result.data ?? ''), { raw: result.data });
  }

  private async handleEvaluate(request: BrowserRequest, options: AgentBrowserProcessOptions): Promise<BackendCallResult> {
    const gate = sensitiveGateResult('evaluate', options);
    if (gate) return gate;
    const expression = request.expression ? validateExpression(request.expression) : '';
    if (!expression) {
      return jsonTextResult({ error: 'expression is required' });
    }

    await this.ensureSession(options);
    const merged = this.mergeOptions(options);
    const result = await this.runEvaluateBatch(merged, expression);
    return this.formatEvaluateResult(result);
  }

  private async handleText(_request: BrowserRequest, options: AgentBrowserProcessOptions): Promise<BackendCallResult> {
    await this.ensureSession(options);
    const merged = this.mergeOptions(options);
    const result = await runCommand(['read', '--json'], merged);
    if (!result.success) {
      const fallback = await runCommand(['eval', 'document.body.innerText'], merged);
      return textResult(String(fallback.data ?? ''), { raw: fallback.data });
    }
    const data = result.data as { text?: string } | undefined;
    return textResult(data?.text ?? String(result.data ?? ''), { raw: result.data });
  }

  private async handleHtml(_request: BrowserRequest, options: AgentBrowserProcessOptions): Promise<BackendCallResult> {
    await this.ensureSession(options);
    const merged = this.mergeOptions(options);
    const result = await runCommand(['eval', 'document.documentElement.outerHTML'], merged);
    return textResult(String(result.data ?? ''), { raw: result.data });
  }

  private async handleScreenshot(_request: BrowserRequest, options: AgentBrowserProcessOptions): Promise<BackendCallResult> {
    await this.ensureSession(options);
    const merged = this.mergeOptions(options);

    const shotResult = await runScreenshot(merged);
    if ('error' in shotResult) {
      return jsonTextResult({ error: sanitizeErrorMessage(shotResult.error) });
    }

    const image: ImageContent = {
      type: 'image',
      mimeType: shotResult.mediaType,
      data: shotResult.data,
    };

    return {
      content: [image],
      details: {
        mediaType: shotResult.mediaType,
        width: shotResult.width,
        height: shotResult.height,
        byteLength: shotResult.byteLength,
      },
    };
  }

  private validatedSelector(request: BrowserRequest): string {
    return request.selector ? validateSelector(request.selector) : '';
  }

  /** Run the snapshot-ref preflight; returns the stale-ref error result, or undefined when fresh. When expectedToken is passed, resolution is gated on the snapshot token so a ref resolved before navigation/invalidation cannot dispatch after it. */
  private preflightSelectorRef(selector: string, expectedToken?: number): BackendCallResult | undefined {
    try {
      preflightRef(this.pageState, this.session.namespace, selector, expectedToken);
    } catch (err) {
      if (err instanceof StaleRefError) {
        return jsonTextResult({ ok: false, error: err.message, staleRef: true });
      }
      throw err;
    }
    return undefined;
  }

  private async setupClickVerification(
    merged: AgentBrowserProcessOptions,
    selector: string,
  ): Promise<{ eligible: boolean; before: OverlaySignature | undefined }> {
    const eligible = isEligibleForVerification(selector);
    const before = eligible ? await this.readOverlaySignature(merged) : undefined;
    if (eligible) await armClickProbe(this.evalRunner(merged), selector);
    return { eligible, before };
  }

  /** Returns the dispatch-unverified error result, or undefined when the click dispatched. */
  private async verifyClickDispatch(merged: AgentBrowserProcessOptions): Promise<BackendCallResult | undefined> {
    const probe = await readClickProbe(this.evalRunner(merged));
    if (!probe.dispatched) {
      return jsonTextResult({ ok: false, error: `Click dispatch unverified: ${probe.reason}`, dispatchUnverified: true });
    }
    return undefined;
  }

  /** Returns the overlay-appeared result, or undefined when no overlay appeared. */
  private async finalizeClickOverlay(
    merged: AgentBrowserProcessOptions,
    selector: string,
    before: OverlaySignature | undefined,
  ): Promise<BackendCallResult | undefined> {
    if (!before) return undefined;
    const after = await this.readOverlaySignature(merged);
    if (after && detectOverlayAppearance(before, after)) {
      this.pageState.invalidate(this.session.namespace, 'click');
      return jsonTextResult({ ok: true, selector, overlay: { appeared: true } });
    }
    return undefined;
  }

  private async handleClick(request: BrowserRequest, options: AgentBrowserProcessOptions): Promise<BackendCallResult> {
    const selector = this.validatedSelector(request);
    if (!selector) {
      return jsonTextResult({ error: 'selector is required' });
    }

    const stale = this.preflightSelectorRef(selector);
    if (stale) return stale;
    const refToken = this.pageState.snapshot(this.session.namespace)?.token;

    await this.ensureSession(options);
    const merged = this.mergeOptions(options);

    const { eligible, before } = await this.setupClickVerification(merged, selector);

    // Invalidate-then-resolve ordering: re-resolve after the awaits above so a
    // navigation/invalidation that landed mid-flight blocks the dispatch.
    const rechecked = this.preflightSelectorRef(selector, refToken);
    if (rechecked) return rechecked;

    const result = await runCommand(['click', selector], merged);
    if (!result.success) {
      return jsonTextResult({ ok: false, error: sanitizeErrorMessage(result.error ?? 'Command failed') });
    }

    if (eligible) {
      const unverified = await this.verifyClickDispatch(merged);
      if (unverified) return unverified;
    }

    const overlaid = await this.finalizeClickOverlay(merged, selector, before);
    if (overlaid) return overlaid;

    this.pageState.invalidate(this.session.namespace, 'click');
    return jsonTextResult({ ok: true, selector });
  }

  private validatedText(request: BrowserRequest): string {
    return request.text ? validateText(request.text) : '';
  }

  private async runTextInputCommand(
    merged: AgentBrowserProcessOptions,
    command: 'type' | 'fill',
    selector: string,
    text: string,
  ): Promise<BackendCallResult> {
    // Use stdin batch for sensitive text payload — never argv
    const results = await runBatchStdin(
      [{ args: [command, selector, text], sensitive: true }],
      merged,
    );
    const result = results[0];
    if (result?.success) this.pageState.invalidate(this.session.namespace, command);
    return jsonTextResult(result?.success ? { ok: true } : { ok: false, error: sanitizeErrorMessage(result?.error ?? 'Command failed') });
  }

  private async handleType(request: BrowserRequest, options: AgentBrowserProcessOptions): Promise<BackendCallResult> {
    const selector = this.validatedSelector(request);
    const text = this.validatedText(request);
    if (!selector) return jsonTextResult({ error: 'selector is required' });
    if (!text) return jsonTextResult({ error: 'text is required' });

    const stale = this.preflightSelectorRef(selector);
    if (stale) return stale;
    const refToken = this.pageState.snapshot(this.session.namespace)?.token;

    await this.ensureSession(options);
    const merged = this.mergeOptions(options);
    const rechecked = this.preflightSelectorRef(selector, refToken);
    if (rechecked) return rechecked;
    return this.runTextInputCommand(merged, 'type', selector, text);
  }

  private detectScrollNoop(
    before: ViewportPosition | undefined,
    after: ViewportPosition | undefined,
  ): boolean {
    if (!before || !after) return false;
    return isScrollNoop(before, after);
  }

  private async handleScroll(request: BrowserRequest, options: AgentBrowserProcessOptions): Promise<BackendCallResult> {
    const x = validateScrollCoord(request.x, 'x');
    const y = validateScrollCoord(request.y, 'y');
    await this.ensureSession(options);
    const merged = this.mergeOptions(options);
    const direction = scrollDirection(x, y);
    const px = Math.abs(y || x);

    const before = await this.readViewport(merged);
    const result = await runCommand(['scroll', direction, String(px)], merged);
    if (!result.success) {
      return jsonTextResult({ ok: false, error: sanitizeErrorMessage(result.error ?? 'Command failed') });
    }
    const after = await this.readViewport(merged);
    const noop = this.detectScrollNoop(before, after);
    return jsonTextResult({ ok: true, scrolled: !noop });
  }

  private async readViewport(merged: AgentBrowserProcessOptions): Promise<ViewportPosition | undefined> {
    const result = await runCommand(['eval', READ_VIEWPORT_EXPR], merged);
    if (!result.success) return undefined;
    try {
      return JSON.parse(String(result.data)) as ViewportPosition;
    } catch {
      return undefined;
    }
  }

  private async readOverlaySignature(merged: AgentBrowserProcessOptions): Promise<OverlaySignature | undefined> {
    const result = await runCommand(['eval', OVERLAY_SIGNATURE_EXPR], merged);
    if (!result.success) return undefined;
    try {
      return JSON.parse(String(result.data)) as OverlaySignature;
    } catch {
      return undefined;
    }
  }

  private async handleClose(): Promise<BackendCallResult> {
    await this.ensureSession({});
    const result = await runCommand(['close'], this.mergeOptions({}));
    if (result.success) this.pageState.clear(this.session.namespace);
    return jsonTextResult(result.success ? { ok: true, message: 'Browser closed' } : { error: sanitizeErrorMessage(result.error ?? 'Close failed') });
  }

  private async handleTabs(options: AgentBrowserProcessOptions): Promise<BackendCallResult> {
    await this.ensureSession(options);
    const merged = this.mergeOptions(options);
    const result = await runCommand(['tab', 'list', '--json'], merged);
    if (!result.success) {
      return jsonTextResult({ error: sanitizeErrorMessage(result.error || 'Failed to get tabs') });
    }
    const data = result.data as { tabs?: unknown[] } | undefined;
    const tabs = Array.isArray(data?.tabs) ? data.tabs : (Array.isArray(result.data) ? result.data : []);
    return jsonTextResult(tabs);
  }

  private async handleCookies(request: BrowserRequest, options: AgentBrowserProcessOptions): Promise<BackendCallResult> {
    await this.ensureSession(options);
    const merged = this.mergeOptions(options);
    const args = ['cookies', 'get', '--json'];

    if (request.urls && request.urls.length > 0) {
      args.push('--url', request.urls[0]!);
    }

    const result = await runCommand(args, merged);
    if (!result.success) {
      return jsonTextResult({ error: sanitizeErrorMessage(result.error || 'Failed to get cookies') });
    }

    // Return metadata only (no values)
    const cookies = cookiesFromResultData(result.data as { cookies?: unknown[] } | unknown);
    const metadata = extractCookieMetadata(cookies as Array<{ name: string; value: string; domain: string; path: string; expires: number | undefined; httpOnly: boolean; secure: boolean; sameSite?: string }>);
    return jsonTextResult(metadata);
  }

  private async handleSetCookies(request: BrowserRequest, options: AgentBrowserProcessOptions): Promise<BackendCallResult> {
    if (isSensitiveAction('set_cookies') && options.env?.PI_SEARCH_BROWSER_ALLOW_SENSITIVE !== '1') {
      return jsonTextResult({ error: 'set_cookies disabled by policy. Set PI_SEARCH_BROWSER_ALLOW_SENSITIVE=1 to enable.' });
    }
    if (!Array.isArray(request.cookies)) {
      return jsonTextResult({ error: 'cookies is required and must be an array' });
    }
    validateCookiesArray(request.cookies);

    await this.ensureSession(options);
    const merged = this.mergeOptions(options);

    // Use stdin batch to pass cookie values securely
    const commands = request.cookies.map((cookie) => {
      const c = cookie as Record<string, unknown>;
      const args = ['cookies', 'set', String(c.name), String(c.value ?? '')];
      pushCookieFlagArgs(args, c);
      return { args, sensitive: true };
    });
    const results = await runBatchStdin(commands, merged);
    const failed = results.find(result => !result.success);
    if (failed) return jsonTextResult({ error: sanitizeErrorMessage(failed.error ?? 'Failed to set cookies') });
    return jsonTextResult({ ok: true, count: request.cookies.length });
  }

  private async handleSnapshot(request: BrowserRequest, options: AgentBrowserProcessOptions): Promise<BackendCallResult> {
    await this.ensureSession(options);
    const merged = this.mergeOptions(options);
    const token = this.pageState.currentToken(this.session.namespace);
    const result = await runCommand(['snapshot', '-i', '--json'], merged);
    if (!result.success) {
      return jsonTextResult({ error: sanitizeErrorMessage(result.error || 'Snapshot failed') });
    }
    const refs = parseSnapshotRefs(result.data);
    const url = extractSnapshotUrl(result.data);
    // Record every successful snapshot, including refs=[]. An empty page must
    // supersede the prior record; skipping it leaves stale @eN resolvable.
    this.pageState.recordSnapshot(this.session.namespace, url, refs, token);
    if (request.compact) {
      const compacted = compactSnapshotRefs(refs);
      return jsonTextResult({ url, refs: compacted.refs, omittedCount: compacted.omittedCount, truncated: compacted.truncated });
    }
    return jsonTextResult(result.data);
  }

  private async handleFill(request: BrowserRequest, options: AgentBrowserProcessOptions): Promise<BackendCallResult> {
    const selector = request.selector ? validateSelector(request.selector) : '';
    const text = request.text ? validateText(request.text) : '';
    if (!selector) return jsonTextResult({ error: 'selector is required' });
    if (!text) return jsonTextResult({ error: 'text is required' });

    try {
      preflightRef(this.pageState, this.session.namespace, selector);
    } catch (err) {
      if (err instanceof StaleRefError) {
        return jsonTextResult({ ok: false, error: err.message, staleRef: true });
      }
      throw err;
    }
    const refToken = this.pageState.snapshot(this.session.namespace)?.token;

    await this.ensureSession(options);
    const merged = this.mergeOptions(options);
    const rechecked = this.preflightSelectorRef(selector, refToken);
    if (rechecked) return rechecked;
    return this.runFillCommand(merged, selector, text);
  }

  private async runFillCommand(
    merged: AgentBrowserProcessOptions,
    selector: string,
    text: string,
  ): Promise<BackendCallResult> {
    // Sensitive text payload rides the stdin batch — never argv.
    const results = await runBatchStdin(
      [{ args: ['fill', selector, text], sensitive: true }],
      merged,
    );
    const result = results[0];
    if (result?.success) this.pageState.invalidate(this.session.namespace, 'fill');
    return jsonTextResult(result?.success ? { ok: true } : { ok: false, error: sanitizeErrorMessage(result?.error ?? 'Command failed') });
  }

  private async waitForScopedElementText(
    merged: AgentBrowserProcessOptions,
    selectorRaw: string,
    textRaw: string,
  ): Promise<BackendCallResult> {
    const selector = validateSelector(selectorRaw);
    const text = validateText(textRaw);
    const scoped = await runCommand(['wait', selector], merged);
    if (!scoped.success) return jsonTextResult({ ok: false, error: sanitizeErrorMessage(scoped.error ?? 'Command failed') });
    const snippet = await runCommand(['get', 'text', selector], merged);
    if (!snippet.success) return jsonTextResult({ ok: false, error: sanitizeErrorMessage(snippet.error ?? 'Command failed') });
    const haystack = snippetTextFromData(snippet.data);
    return jsonTextResult(haystack.includes(text) ? { ok: true } : { ok: false, error: `text not found in element ${selector}` });
  }

  private validatedSelectRawValues(request: BrowserRequest): string[] {
    return (request.values ?? []).filter((v): v is string => typeof v === 'string');
  }

  private async runSelectCommand(
    merged: AgentBrowserProcessOptions,
    selector: string,
    rawValues: string[],
  ): Promise<BackendCallResult> {
    // Option values ride the stdin batch as sensitive payloads, never argv.
    const values = rawValues.map((v) => validateText(v));
    const results = await runBatchStdin(
      [{ args: ['select', selector, ...values], sensitive: true }],
      merged,
    );
    const result = results[0];
    if (result?.success) this.pageState.invalidate(this.session.namespace, 'select');
    return jsonTextResult(result?.success ? { ok: true } : { ok: false, error: sanitizeErrorMessage(result?.error ?? 'Command failed') });
  }

  private async handleSelect(request: BrowserRequest, options: AgentBrowserProcessOptions): Promise<BackendCallResult> {
    const selector = this.validatedSelector(request);
    const rawValues = this.validatedSelectRawValues(request);
    if (!selector) return jsonTextResult({ error: 'selector is required' });
    if (rawValues.length === 0) return jsonTextResult({ error: 'values is required and must be a non-empty array' });
    if (rawValues.length > MAX_SELECT_VALUES) {
      return jsonTextResult({ error: `too many values (max ${MAX_SELECT_VALUES})` });
    }
    const stale = this.preflightSelectorRef(selector);
    if (stale) return stale;
    const refToken = this.pageState.snapshot(this.session.namespace)?.token;
    await this.ensureSession(options);
    const merged = this.mergeOptions(options);
    const rechecked = this.preflightSelectorRef(selector, refToken);
    if (rechecked) return rechecked;
    return this.runSelectCommand(merged, selector, rawValues);
  }

  private async handleWait(request: BrowserRequest, options: AgentBrowserProcessOptions): Promise<BackendCallResult> {
    const ms = validateWaitMs(request.waitMs ?? 1000);
    await this.ensureSession(options);
    const merged = this.mergeOptions(options);

    // Text post-condition (job assert steps): selector-scoped substring match.
    // A page-wide `--text` wait would pass when the text appears anywhere else,
    // so wait for the element first, then check the element's own text.
    if (request.selector && request.text) {
      return this.waitForScopedElementText(merged, request.selector, request.text);
    }
    if (request.text) {
      const text = validateText(request.text);
      const result = await runCommand(['wait', '--text', text], merged);
      return jsonTextResult(result.success ? { ok: true } : { ok: false, error: sanitizeErrorMessage(result.error ?? 'Command failed') });
    }

    if (request.selector) {
      const selector = validateSelector(request.selector);
      // agent-browser wait takes <sel|ms> as positional arg
      const result = await runCommand(['wait', selector], merged);
      return jsonTextResult(result.success ? { ok: true } : { ok: false, error: sanitizeErrorMessage(result.error ?? 'Command failed') });
    }

    // Wait for time
    const result = await runCommand(['wait', String(ms)], merged);
    return jsonTextResult(result.success ? { ok: true } : { ok: false, error: sanitizeErrorMessage(result.error ?? 'Command failed') });
  }

  private async handleGetUrl(options: AgentBrowserProcessOptions): Promise<BackendCallResult> {
    await this.ensureSession(options);
    const merged = this.mergeOptions(options);
    const result = await runCommand(['get', 'url'], merged);
    if (!result.success) {
      return jsonTextResult({ ok: false, error: sanitizeErrorMessage(result.error ?? 'Command failed') });
    }
    return textResult(String(result.data ?? ''), { raw: result.data });
  }

  private async handleGetTitle(options: AgentBrowserProcessOptions): Promise<BackendCallResult> {
    await this.ensureSession(options);
    const merged = this.mergeOptions(options);
    const result = await runCommand(['get', 'title'], merged);
    if (!result.success) {
      return jsonTextResult({ ok: false, error: sanitizeErrorMessage(result.error ?? 'Command failed') });
    }
    return textResult(String(result.data ?? ''), { raw: result.data });
  }

  // ── Component 9: semanticAction ──

  private async runSemanticFill(
    merged: AgentBrowserProcessOptions,
    args: string[],
    value: string,
  ): Promise<BackendCallResult> {
    // Value payloads (fill) go via stdin batch, never argv
    const results = await runBatchStdin(
      [{ args: [...args, value], sensitive: true }],
      merged,
    );
    const result = results[0];
    if (result?.success) this.pageState.invalidate(this.session.namespace, 'semantic');
    return jsonTextResult(result?.success
      ? { ok: true }
      : { ok: false, error: sanitizeErrorMessage(result?.error ?? 'Command failed') });
  }

  private async runSemanticClick(merged: AgentBrowserProcessOptions, args: string[]): Promise<BackendCallResult> {
    // Click verb gets dispatch verification; semantic locators are always role/text/label by construction
    await armClickProbe(this.evalRunner(merged), args.join(' '));
    const result = await runCommand(args, merged);
    if (!result.success) return jsonTextResult({ ok: false, error: sanitizeErrorMessage(result.error ?? 'Command failed') });
    const unverified = await this.verifyClickDispatch(merged);
    if (unverified) return unverified;
    this.pageState.invalidate(this.session.namespace, 'semantic');
    return jsonTextResult({ ok: true });
  }

  private async runSemanticDefault(merged: AgentBrowserProcessOptions, args: string[]): Promise<BackendCallResult> {
    const result = await runCommand(args, merged);
    if (result.success) this.pageState.invalidate(this.session.namespace, 'semantic');
    return jsonTextResult(result.success ? { ok: true } : { ok: false, error: sanitizeErrorMessage(result.error ?? 'Command failed') });
  }

  private async handleSemanticAction(request: BrowserRequest, options: AgentBrowserProcessOptions): Promise<BackendCallResult> {
    const sa = request.semanticAction;
    if (!sa) return jsonTextResult({ error: 'semanticAction is required' });
    await this.ensureSession(options);
    const merged = this.mergeOptions(options);

    // nth takes the index positionally: find nth <index> <selector> <verb>.
    // Without it every nth(index) dispatched the same command.
    const args = buildSemanticFindArgs(sa);

    if (hasSemanticFillValue(sa)) {
      return this.runSemanticFill(merged, args, sa.value!);
    }
    if (isSemanticClickVerb(sa)) {
      return this.runSemanticClick(merged, args);
    }
    return this.runSemanticDefault(merged, args);
  }

  // ── Component 10: job ──

  private async handleJob(request: BrowserRequest, options: AgentBrowserProcessOptions): Promise<BackendCallResult> {
    const job = request.job;
    if (!job) return jsonTextResult({ error: 'job is required' });

    const steps: BatchStepResult[] = [];
    let overallFailed = false;

    for (let index = 0; index < job.steps.length; index++) {
      const step = job.steps[index]!;
      const stepRequest = jobStepToBrowserRequest(step);
      const rawResult = await this.execute(stepRequest as unknown as Record<string, unknown>, options);
      const stepResult = rawResult as import('./browser-result.js').BrowserResult;

      const stepError = jobStepDetailError(stepResult);
      steps.push({
        index,
        action: stepRequest.action,
        resultCategory: stepResult.resultCategory ?? 'failure',
        ...(stepResult.successCategory ? { successCategory: stepResult.successCategory } : {}),
        ...(stepResult.failureCategory ? { failureCategory: stepResult.failureCategory } : {}),
        ...(stepError ? { error: stepError } : {}),
      });

      if ((stepResult.resultCategory ?? 'failure') === 'failure') {
        overallFailed = true;
        if (!step.continueOnFailure) break;
      }
    }

    const result = jsonTextResult({ steps }) as BackendCallResult;
    (result as { batchSteps?: BatchStepResult[] }).batchSteps = steps;
    (result as { resultCategory?: string }).resultCategory = overallFailed ? 'failure' : 'success';
    return result;
  }

  // ── Component 11: batch ──

  private async preflightBatchNavigations(
    batch: NonNullable<BrowserRequest['batch']>,
    signal: AgentBrowserProcessOptions['signal'],
  ): Promise<{ stagedHost: string | undefined; navIndices: number[]; normalizedUrls: Map<number, string> } | { errorResult: BackendCallResult }> {
    // Navigation-capable batch commands pass through the exact same trust
    // boundary as single navigate: no raw tunnel underneath the policy layer.
    // Loopback stays rejected outright; public targets get static validation +
    // DNS preflight here with the first batch navigation staged so it bounds
    // containment for the rest of the batch. The staged freeze commits only
    // after a batch navigation succeeds, so a failed batch leaves
    // domainsFrozen=false and allowedDomains unchanged.
    // In loopback sessions any batch navigation is rejected: public preflight
    // would overwrite the pinned loopback domain with an attacker-influenced
    // host. Use a single navigate action for loopback targets instead.
    let stagedHost: string | undefined;
    const navIndices: number[] = [];
    const normalizedUrls = new Map<number, string>();
    for (let i = 0; i < batch.commands.length; i++) {
      const cmd = batch.commands[i]!;
      if (!isBatchNavigationCommand(cmd)) continue;
      if (this.loopbackMode) {
        return { errorResult: jsonTextResult({ error: `command ${i}: navigation commands are not allowed in batch for loopback sessions. Use a single navigate action instead.` }) };
      }
      try {
        const staged = stagedHost ? [stagedHost] : undefined;
        const preflight = await this.preflightNavigationTarget(batchNavigationUrl(cmd)!, signal, staged);
        if (!preflight.ok) return { errorResult: jsonTextResult({ error: `command ${i}: ${preflight.error}` }) };
        if (preflight.pendingHostname && !stagedHost) stagedHost = preflight.pendingHostname;
        navIndices.push(i);
        normalizedUrls.set(i, preflight.url);
      } catch (error) {
        return { errorResult: jsonTextResult({ error: `command ${i}: ${error instanceof Error ? error.message : String(error)}` }) };
      }
    }
    return { stagedHost, navIndices, normalizedUrls };
  }

  private buildBatchSteps(
    batch: NonNullable<BrowserRequest['batch']>,
    results: Awaited<ReturnType<typeof runBatchStdin>>,
  ): BatchStepResult[] {
    return results.map((r, index) => ({
      index,
      action: batch.commands[index]?.args[0] ?? 'unknown',
      resultCategory: r.success ? 'success' : 'failure',
      ...(!r.success ? { error: sanitizeErrorMessage(r.error ?? 'Command failed') } : {}),
    }));
  }

  private batchStdinCommands(
    batch: NonNullable<BrowserRequest['batch']>,
    normalizedUrls?: Map<number, string>,
  ): Array<{ args: string[]; sensitive?: boolean }> {
    return batch.commands.map((c, index) => {
      const args = [...c.args];
      const normalized = normalizedUrls?.get(index);
      if (normalized !== undefined) {
        const action = args[0]?.toLowerCase();
        if ((action === 'open' || action === 'navigate') && args.length > 1) {
          args[1] = normalized;
        } else if (action === 'tab' && args[1]?.toLowerCase() === 'new' && args.length > 2) {
          args[2] = normalized;
        }
      }
      return { args, sensitive: c.sensitive ?? true };
    });
  }

  private commitStagedFreezeIfNavigated(
    stagedHost: string | undefined,
    navIndices: number[],
    results: AgentBrowserResult[],
  ): void {
    if (stagedHost && navIndices.some((i) => results[i]?.success)) {
      this.commitNavigationFreeze(stagedHost);
    }
  }

  private async handleBatch(request: BrowserRequest, options: AgentBrowserProcessOptions): Promise<BackendCallResult> {
    // Order: allowlist/arity validation already ran in execute() (pre-session, pre-spawn) →
    // sensitive gate → navigation preflight + freeze → session → stdin dispatch.
    const gate = sensitiveGateResult('batch', options);
    if (gate) return gate;
    const batch = request.batch;
    if (!batch) return jsonTextResult({ error: 'batch is required' });

    const preflighted = await this.preflightBatchNavigations(batch, options.signal);
    if ('errorResult' in preflighted) return preflighted.errorResult;
    const { stagedHost, navIndices, normalizedUrls } = preflighted;

    await this.ensureSession(options);
    const merged = this.mergeOptions(options);

    const stdinCmds = this.batchStdinCommands(batch, normalizedUrls);
    // Dispatch incrementally, split at navigation boundaries: a successful
    // navigation is re-resolved BEFORE later commands dispatch, so eval/click/
    // type cannot run against a rebound host. Unexecuted commands on suspect
    // synthesize aborted failures to preserve step alignment.
    const orderedNavs = [...navIndices].sort((a, b) => a - b);
    const navSet = new Set(orderedNavs);
    const segmentEnds: number[] = [...orderedNavs.map((i) => i + 1), stdinCmds.length];
    const results: AgentBrowserResult[] = new Array(stdinCmds.length);
    let cursor = 0;
    let suspectError: string | undefined;
    for (const end of segmentEnds) {
      if (suspectError) break;
      if (end <= cursor) continue;
      const expected = end - cursor;
      const segmentResults = await runBatchStdin(stdinCmds.slice(cursor, end), merged);
      if (segmentResults.length < expected) {
        // Fail closed on incomplete results: execution state is unknown (a
        // navigation may have run unconfirmed), so later segments must not
        // dispatch. Falls into the abort path below.
        for (let k = 0; k < segmentResults.length && cursor + k < stdinCmds.length; k++) {
          results[cursor + k] = segmentResults[k]!;
        }
        cursor = end;
        suspectError =
          `batch aborted: incomplete results for dispatched commands (expected ${expected}, got ${segmentResults.length})`;
        break;
      }
      for (let k = 0; k < segmentResults.length && cursor + k < stdinCmds.length; k++) {
        results[cursor + k] = segmentResults[k]!;
      }
      cursor = end;
      const navIdx = end - 1;
      if (navIdx >= 0 && navSet.has(navIdx) && results[navIdx]?.success) {
        if (stagedHost) this.commitStagedFreezeIfNavigated(stagedHost, navIndices, results);
        const navUrl = normalizedUrls.get(navIdx);
        if (navUrl) {
          suspectError = await this.rebindingSuspectError(
            new URL(navUrl).hostname.toLowerCase(),
            options.signal,
          );
        }
      }
    }
    // Fail closed on short CLI returns: every command gets an explicit result so
    // step alignment holds and an unconfirmed navigation never skips re-check.
    for (let i = 0; i < results.length; i++) {
      results[i] ??= { success: false, error: 'missing batch result' };
    }
    if (suspectError) {
      for (let i = cursor; i < stdinCmds.length; i++) {
        results[i] = { success: false, error: `aborted: ${suspectError}` };
      }      const abortedSteps = this.buildBatchSteps(batch, results);
      this.pageState.invalidate(this.session.namespace, 'dns-rebinding-suspect');
      try { await this.close(); } catch { /* best-effort session teardown */ }
      return jsonTextResult({ steps: abortedSteps, ok: false, error: suspectError });
    }

    this.commitStagedFreezeIfNavigated(stagedHost, navIndices, results);

    const steps = this.buildBatchSteps(batch, results);

    if (results.some(r => r.success)) this.pageState.invalidate(this.session.namespace, 'batch');
    const result = jsonTextResult({ steps }) as BackendCallResult;
    (result as { batchSteps?: BatchStepResult[] }).batchSteps = steps;
    return result;
  }
}
