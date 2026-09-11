import type { ImageContent } from '@earendil-works/pi-ai';
import type { BackendCallResult } from './backend.js';
import type { BrowserRequest } from './browser-policy.js';
import { parseLoopbackDebugTarget } from './loopback-debug-policy.js';
import { enrichResult } from './browser-result.js';
import { type ViewportPosition, READ_VIEWPORT_EXPR, isScrollNoop } from './scroll-verification.js';
import { type OverlaySignature, OVERLAY_SIGNATURE_EXPR, detectOverlayAppearance } from './overlay-detection.js';
import { armClickProbe, isEligibleForVerification, readClickProbe, type EvalRunner } from './click-verification.js';
import { parseSnapshotRefs, extractSnapshotUrl, compactSnapshotRefs } from './snapshot-parser.js';
import { jobStepToBrowserRequest } from './browser-job.js';
import type { BatchStepResult } from './browser-result.js';
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
} from './agent-browser-process.js';
import { jsonTextResult, textResult } from './tool-output.js';
import { SessionPageStateStore, StaleRefError, preflightRef } from './session-page-state.js';

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

  constructor(options: AgentBrowserAdapterOptions = {}) {
    this.executablePath = options.executablePath;
    this.loopbackMode = options.loopbackMode;
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
    if (this._sessionStarted && this.session.namespace && this.session.runtimeRoot) {
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

  // ── Private dispatch ──

  private async dispatch(request: BrowserRequest, options: AgentBrowserProcessOptions): Promise<BackendCallResult> {
    switch (request.action) {
      case 'status':
        return this.status();
      case 'navigate':
        return this.handleNavigate(request, options);
      case 'evaluate':
        return this.handleEvaluate(request, options);
      case 'text':
        return this.handleText(request, options);
      case 'html':
        return this.handleHtml(request, options);
      case 'screenshot':
        return this.handleScreenshot(request, options);
      case 'click':
        return this.handleClick(request, options);
      case 'type':
        return this.handleType(request, options);
      case 'scroll':
        return this.handleScroll(request, options);
      case 'close':
        return this.handleClose();
      case 'tabs':
        return this.handleTabs(options);
      case 'cookies':
        return this.handleCookies(request, options);
      case 'set_cookies':
        return this.handleSetCookies(request, options);
      case 'snapshot':
        return this.handleSnapshot(request, options);
      case 'fill':
        return this.handleFill(request, options);
      case 'select':
        return this.handleSelect(request, options);
      case 'wait':
        return this.handleWait(request, options);
      case 'get_url':
        return this.handleGetUrl(options);
      case 'get_title':
        return this.handleGetTitle(options);
      case 'semanticAction':
        return this.handleSemanticAction(request, options);
      case 'job':
        return this.handleJob(request, options);
      case 'batch':
        return this.handleBatch(request, options);
      default:
        return jsonTextResult({ error: `Unsupported browser action: ${(request as { action: string }).action}` });
    }
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
   * preflight, first-hostname domain freeze, and containment check. Used by
   * single navigate and by batch/job navigation steps alike so raw command
   * arrays cannot tunnel underneath the policy layer. Throws on invalid
   * targets; returns { ok: false } only for domain-policy blocks.
   */
  private async preflightNavigationTarget(rawUrl: string, signal?: AbortSignal): Promise<{ ok: true; url: string } | { ok: false; error: string }> {
    const url = validateNavigationUrl(rawUrl);
    const hostname = new URL(url).hostname.toLowerCase();
    await dnsPreflight(hostname, signal);
    if (!this.domainsFrozen) {
      this.setAllowedDomains([hostname]);
      await validateAllowedDomainsDns(this.allowedDomains, signal);
    }
    if (this.allowedDomains.length > 0 && !checkDomainAllowed(hostname, this.allowedDomains)) {
      return {
        ok: false,
        error: `Navigation to ${hostname} blocked by domain policy. Allowed domains: ${this.allowedDomains.join(', ')}. Close the session and navigate fresh to a different hostname to continue.`,
      };
    }
    return { ok: true, url };
  }

  private async handleNavigate(request: BrowserRequest, options: AgentBrowserProcessOptions): Promise<BackendCallResult> {
    if (!request.url) {
      // Open without navigation (launch browser)
      await this.ensureSession(options);
      const merged = this.mergeOptions(options);
      const result = await runCommand(['open', 'about:blank'], merged);
      if (result.success) this.pageState.invalidate(this.session.namespace, 'navigation');
      return jsonTextResult(result.success ? { ok: true, message: 'Browser launched' } : { ok: false, error: sanitizeErrorMessage(result.error ?? 'Command failed') });
    }

    // ── Loopback adapter: narrow exception path ──
    if (this.loopbackMode) {
      const loopbackPolicy = parseLoopbackDebugTarget(request.url);
      if (!loopbackPolicy) {
        return jsonTextResult({ ok: false, error: sanitizeErrorMessage(`Loopback adapter rejected non-loopback URL: ${request.url}`) });
      }
      if (loopbackPolicy.origin !== this.loopbackMode.origin) {
        return jsonTextResult({ ok: false, error: sanitizeErrorMessage(`Different loopback origin rejected. Expected: ${this.loopbackMode.origin}, got: ${loopbackPolicy.origin}`) });
      }
      // Skip public hostname/DNS check — proxy enforces containment
      // Keep exact hostname in allowedDomains so vendor containment remains active.
      // This narrow loopback exception bypasses public domain validation only here.
      if (!this.domainsFrozen) {
        // Strip IPv6 brackets ([::1] → ::1) so mergeOptions forwards canonical value
        const hostname = loopbackPolicy.hostname.startsWith('[') && loopbackPolicy.hostname.endsWith(']')
          ? loopbackPolicy.hostname.slice(1, -1)
          : loopbackPolicy.hostname;
        this.allowedDomains = [hostname];
        this.domainsFrozen = true;
      }
      await this.ensureSession(options);
      const merged = this.mergeOptions(options);
      const result = await runCommand(['open', loopbackPolicy.navigationUrl], merged);
      if (result.success) this.pageState.invalidate(this.session.namespace, 'navigation');
      return jsonTextResult(result.success ? { ok: true, url: loopbackPolicy.navigationUrl } : { ok: false, error: sanitizeErrorMessage(result.error ?? 'Command failed') });
    }

    // ── Public adapter: SSRF defense-in-depth ──
    const preflight = await this.preflightNavigationTarget(request.url, options.signal);
    if (!preflight.ok) {
      return jsonTextResult({ ok: false, error: preflight.error });
    }
    const url = preflight.url;

    await this.ensureSession(options);
    const merged = this.mergeOptions(options);

    // Use 'open' command (not 'navigate')
    const result = await runCommand(['open', url], merged);
    if (result.success) this.pageState.invalidate(this.session.namespace, 'navigation');
    return jsonTextResult(result.success ? { ok: true, url } : { ok: false, error: sanitizeErrorMessage(result.error ?? 'Command failed') });
  }

  private async handleEvaluate(request: BrowserRequest, options: AgentBrowserProcessOptions): Promise<BackendCallResult> {
    if (isSensitiveAction('evaluate') && options.env?.PI_SEARCH_BROWSER_ALLOW_SENSITIVE !== '1') {
      return jsonTextResult({ error: 'evaluate disabled by policy. Set PI_SEARCH_BROWSER_ALLOW_SENSITIVE=1 to enable.' });
    }
    const expression = request.expression ? validateExpression(request.expression) : '';
    if (!expression) {
      return jsonTextResult({ error: 'expression is required' });
    }

    await this.ensureSession(options);
    const merged = this.mergeOptions(options);

    // Use stdin batch mode for sensitive payload — never argv
    const results = await runBatchStdin(
      [{ args: ['eval', expression], sensitive: true }],
      merged,
    );

    const result = results[0];
    if (!result?.success) {
      return jsonTextResult({ error: sanitizeErrorMessage(result?.error || 'Evaluation failed') });
    }

    return textResult(String(result.data ?? ''), { raw: result.data });
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

  private async handleClick(request: BrowserRequest, options: AgentBrowserProcessOptions): Promise<BackendCallResult> {
    const selector = request.selector ? validateSelector(request.selector) : '';
    if (!selector) {
      return jsonTextResult({ error: 'selector is required' });
    }

    try {
      preflightRef(this.pageState, this.session.namespace, selector);
    } catch (err) {
      if (err instanceof StaleRefError) {
        return jsonTextResult({ ok: false, error: err.message, staleRef: true });
      }
      throw err;
    }

    await this.ensureSession(options);
    const merged = this.mergeOptions(options);

    const eligible = isEligibleForVerification(selector);
    const before = eligible ? await this.readOverlaySignature(merged) : undefined;
    if (eligible) await armClickProbe(this.evalRunner(merged), selector);

    const result = await runCommand(['click', selector], merged);
    if (!result.success) {
      return jsonTextResult({ ok: false, error: sanitizeErrorMessage(result.error ?? 'Command failed') });
    }

    if (eligible) {
      const probe = await readClickProbe(this.evalRunner(merged));
      if (!probe.dispatched) {
        return jsonTextResult({ ok: false, error: `Click dispatch unverified: ${probe.reason}`, dispatchUnverified: true });
      }
    }

    if (before) {
      const after = await this.readOverlaySignature(merged);
      if (after && detectOverlayAppearance(before, after)) {
        this.pageState.invalidate(this.session.namespace, 'click');
        return jsonTextResult({ ok: true, selector, overlay: { appeared: true } });
      }
    }

    this.pageState.invalidate(this.session.namespace, 'click');
    return jsonTextResult({ ok: true, selector });
  }

  private async handleType(request: BrowserRequest, options: AgentBrowserProcessOptions): Promise<BackendCallResult> {
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

    await this.ensureSession(options);
    const merged = this.mergeOptions(options);

    // Use stdin batch for sensitive text payload — never argv
    const results = await runBatchStdin(
      [{ args: ['type', selector, text], sensitive: true }],
      merged,
    );
    const result = results[0];
    if (result?.success) this.pageState.invalidate(this.session.namespace, 'type');
    return jsonTextResult(result?.success ? { ok: true } : { ok: false, error: sanitizeErrorMessage(result?.error ?? 'Command failed') });
  }

  private async handleScroll(request: BrowserRequest, options: AgentBrowserProcessOptions): Promise<BackendCallResult> {
    const x = validateScrollCoord(request.x, 'x');
    const y = validateScrollCoord(request.y, 'y');
    await this.ensureSession(options);
    const merged = this.mergeOptions(options);
    const direction = y > 0 ? 'down' : y < 0 ? 'up' : x > 0 ? 'right' : x < 0 ? 'left' : 'down';
    const px = Math.abs(y || x);

    const before = await this.readViewport(merged);
    const result = await runCommand(['scroll', direction, String(px)], merged);
    if (!result.success) {
      return jsonTextResult({ ok: false, error: sanitizeErrorMessage(result.error ?? 'Command failed') });
    }
    const after = await this.readViewport(merged);
    const noop = before && after ? isScrollNoop(before, after) : false;
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
    const cookieData = result.data as { cookies?: unknown[] } | unknown;
    const cookies = Array.isArray(cookieData) ? cookieData : (cookieData && typeof cookieData === 'object' && Array.isArray((cookieData as { cookies?: unknown[] }).cookies) ? (cookieData as { cookies: unknown[] }).cookies : []);
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
      if (typeof c.domain === 'string') args.push('--domain', c.domain);
      if (typeof c.path === 'string') args.push('--path', c.path);
      if (c.secure === true) args.push('--secure');
      if (c.httpOnly === true) args.push('--httpOnly');
      if (typeof c.sameSite === 'string') args.push('--sameSite', c.sameSite);
      if (typeof c.expires === 'number') args.push('--expires', String(c.expires));
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
    if (refs.length > 0) {
      this.pageState.recordSnapshot(this.session.namespace, url, refs, token);
    }
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

    await this.ensureSession(options);
    const merged = this.mergeOptions(options);

    // Use stdin batch for sensitive text payload — never argv
    const results = await runBatchStdin(
      [{ args: ['fill', selector, text], sensitive: true }],
      merged,
    );
    const result = results[0];
    if (result?.success) this.pageState.invalidate(this.session.namespace, 'fill');
    return jsonTextResult(result?.success ? { ok: true } : { ok: false, error: sanitizeErrorMessage(result?.error ?? 'Command failed') });
  }

  private async handleSelect(request: BrowserRequest, options: AgentBrowserProcessOptions): Promise<BackendCallResult> {
    const selector = request.selector ? validateSelector(request.selector) : '';
    const rawValues = (request.values ?? []).filter((v): v is string => typeof v === 'string');
    if (!selector) return jsonTextResult({ error: 'selector is required' });
    if (rawValues.length === 0) return jsonTextResult({ error: 'values is required and must be a non-empty array' });
    if (rawValues.length > MAX_SELECT_VALUES) {
      return jsonTextResult({ error: `too many values (max ${MAX_SELECT_VALUES})` });
    }
    try {
      preflightRef(this.pageState, this.session.namespace, selector);
    } catch (err) {
      if (err instanceof StaleRefError) {
        return jsonTextResult({ ok: false, error: err.message, staleRef: true });
      }
      throw err;
    }
    // Option values ride the stdin batch as sensitive payloads, never argv.
    const values = rawValues.map((v) => validateText(v));
    await this.ensureSession(options);
    const merged = this.mergeOptions(options);
    const results = await runBatchStdin(
      [{ args: ['select', selector, ...values], sensitive: true }],
      merged,
    );
    const result = results[0];
    if (result?.success) this.pageState.invalidate(this.session.namespace, 'select');
    return jsonTextResult(result?.success ? { ok: true } : { ok: false, error: sanitizeErrorMessage(result?.error ?? 'Command failed') });
  }

  private async handleWait(request: BrowserRequest, options: AgentBrowserProcessOptions): Promise<BackendCallResult> {
    const ms = validateWaitMs(request.waitMs ?? 1000);
    await this.ensureSession(options);
    const merged = this.mergeOptions(options);

    // Text post-condition (job assert steps): selector-scoped substring match.
    // A page-wide `--text` wait would pass when the text appears anywhere else,
    // so wait for the element first, then check the element's own text.
    if (request.selector && request.text) {
      const selector = validateSelector(request.selector);
      const text = validateText(request.text);
      const scoped = await runCommand(['wait', selector], merged);
      if (!scoped.success) return jsonTextResult({ ok: false, error: sanitizeErrorMessage(scoped.error ?? 'Command failed') });
      const snippet = await runCommand(['get', 'text', selector], merged);
      if (!snippet.success) return jsonTextResult({ ok: false, error: sanitizeErrorMessage(snippet.error ?? 'Command failed') });
      const haystack = typeof snippet.data === 'string' ? snippet.data : JSON.stringify(snippet.data ?? '');
      return jsonTextResult(haystack.includes(text) ? { ok: true } : { ok: false, error: `text not found in element ${selector}` });
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

  private async handleSemanticAction(request: BrowserRequest, options: AgentBrowserProcessOptions): Promise<BackendCallResult> {
    const sa = request.semanticAction;
    if (!sa) return jsonTextResult({ error: 'semanticAction is required' });
    await this.ensureSession(options);
    const merged = this.mergeOptions(options);

    // nth takes the index positionally: find nth <index> <selector> <verb>.
    // Without it every nth(index) dispatched the same command.
    const args: string[] = sa.locator === 'nth'
      ? ['find', 'nth', String(sa.index ?? 0), sa.query, sa.verb]
      : ['find', sa.locator, sa.query, sa.verb];
    if (sa.name) args.push('--name', sa.name);
    if (sa.exact) args.push('--exact');

    // Value payloads (fill) go via stdin batch, never argv
    const hasValue = sa.verb === 'fill' && sa.value !== undefined;
    if (hasValue) {
      const results = await runBatchStdin(
        [{ args: [...args, sa.value!], sensitive: true }],
        merged,
      );
      const result = results[0];
      if (result?.success) this.pageState.invalidate(this.session.namespace, 'semantic');
      return jsonTextResult(result?.success
        ? { ok: true }
        : { ok: false, error: sanitizeErrorMessage(result?.error ?? 'Command failed') });
    }

    // Click verb gets dispatch verification
    if (sa.verb === 'click') {
      const eligible = true; // semantic locators are always role/text/label by construction
      if (eligible) await armClickProbe(this.evalRunner(merged), args.join(' '));
      const result = await runCommand(args, merged);
      if (!result.success) return jsonTextResult({ ok: false, error: sanitizeErrorMessage(result.error ?? 'Command failed') });
      if (eligible) {
        const probe = await readClickProbe(this.evalRunner(merged));
        if (!probe.dispatched) {
          return jsonTextResult({ ok: false, error: `Click dispatch unverified: ${probe.reason}`, dispatchUnverified: true });
        }
      }
      this.pageState.invalidate(this.session.namespace, 'semantic');
      return jsonTextResult({ ok: true });
    }

    const result = await runCommand(args, merged);
    if (result.success) this.pageState.invalidate(this.session.namespace, 'semantic');
    return jsonTextResult(result.success ? { ok: true } : { ok: false, error: sanitizeErrorMessage(result.error ?? 'Command failed') });
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

      steps.push({
        index,
        action: stepRequest.action,
        resultCategory: stepResult.resultCategory ?? 'failure',
        ...(stepResult.successCategory ? { successCategory: stepResult.successCategory } : {}),
        ...(stepResult.failureCategory ? { failureCategory: stepResult.failureCategory } : {}),
        ...((stepResult as unknown as { details?: { error?: string } }).details?.error
          ? { error: (stepResult as unknown as { details: { error?: string } }).details.error }
          : {}),
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

  private async handleBatch(request: BrowserRequest, options: AgentBrowserProcessOptions): Promise<BackendCallResult> {
    if (isSensitiveAction('batch') && options.env?.PI_SEARCH_BROWSER_ALLOW_SENSITIVE !== '1') {
      return jsonTextResult({ error: 'batch disabled by policy. Set PI_SEARCH_BROWSER_ALLOW_SENSITIVE=1 to enable.' });
    }
    const batch = request.batch;
    if (!batch) return jsonTextResult({ error: 'batch is required' });

    // Navigation-capable batch commands pass through the exact same trust
    // boundary as single navigate: no raw tunnel underneath the policy layer.
    // Loopback stays rejected outright (validateNoLoopbackInBatch); public
    // targets get static validation + DNS preflight + domain freeze here, so
    // the first batch navigation freezes containment for the rest of the batch.
    // In loopback sessions any batch navigation is rejected: public preflight
    // would overwrite the pinned loopback domain with an attacker-influenced
    // host. Use a single navigate action for loopback targets instead.
    for (let i = 0; i < batch.commands.length; i++) {
      const cmd = batch.commands[i]!;
      const action = cmd.args[0]?.toLowerCase();
      if ((action === 'open' || action === 'navigate') && typeof cmd.args[1] === 'string') {
        if (this.loopbackMode) {
          return jsonTextResult({ error: `command ${i}: navigation commands are not allowed in batch for loopback sessions. Use a single navigate action instead.` });
        }
        try {
          const preflight = await this.preflightNavigationTarget(cmd.args[1], options.signal);
          if (!preflight.ok) return jsonTextResult({ error: `command ${i}: ${preflight.error}` });
        } catch (error) {
          return jsonTextResult({ error: `command ${i}: ${error instanceof Error ? error.message : String(error)}` });
        }
      }
    }

    await this.ensureSession(options);
    const merged = this.mergeOptions(options);

    const results = await runBatchStdin(
      batch.commands.map(c => ({ args: c.args, sensitive: c.sensitive ?? true })),
      merged,
    );

    const steps: BatchStepResult[] = results.map((r, index) => ({
      index,
      action: batch.commands[index]?.args[0] ?? 'unknown',
      resultCategory: r.success ? 'success' : 'failure',
      ...(!r.success ? { error: sanitizeErrorMessage(r.error ?? 'Command failed') } : {}),
    }));

    if (results.some(r => r.success)) this.pageState.invalidate(this.session.namespace, 'batch');
    const result = jsonTextResult({ steps }) as BackendCallResult;
    (result as { batchSteps?: BatchStepResult[] }).batchSteps = steps;
    return result;
  }
}
