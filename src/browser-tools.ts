import type { BackendCallResult } from './backend.js'
import {
  isBrowserAutomationDisabled,
  openCdpSession,
  cdpListTargets,
  cdpNavigate,
  cdpEvaluate,
  cdpGetText,
  cdpGetHtml,
  cdpScreenshot,
  cdpClick,
  cdpType,
  cdpScroll,
  cdpCloseTarget,
  cdpGetCookiesRaw,
  cdpSetCookies,
} from './cdp.js'

import { textResult as guardedTextResult } from './tool-output.js'
import { AgentBrowserAdapter } from './agent-browser.js'
import { resolveAgentBrowserExecutable } from './agent-browser-process.js'
import { extractCookieMetadata, isSensitiveAction, validateLegacyLoopbackEndpoint } from './browser-policy.js'
import { parseLoopbackDebugTarget, type LoopbackDebugPolicy } from './loopback-debug-policy.js'
import { LoopbackProxy } from './loopback-proxy.js'

export type BrowserAction = 'status' | 'tabs' | 'navigate' | 'evaluate' | 'text' | 'html' | 'screenshot' | 'click' | 'type' | 'scroll' | 'close' | 'cookies' | 'set_cookies'

// ── Backend selection ──

export type BrowserBackend = 'agent-browser' | 'cdp'

export function resolveBrowserBackend(env?: Record<string, string | undefined>): BrowserBackend {
  const raw = env?.PI_SEARCH_BROWSER_BACKEND?.trim().toLowerCase()
  if (raw === 'cdp') return 'cdp'
  return 'agent-browser'
}

// ── Persistent adapter ──

let _adapter: AgentBrowserAdapter | null = null
let _adapterInit: Promise<AgentBrowserAdapter> | null = null
let _loopbackPolicy: LoopbackDebugPolicy | null = null
let _loopbackProxy: LoopbackProxy | null = null

// Guards fresh loopback entry to prevent concurrent transitions
let _transitionBusy = false

async function getAdapter(env?: Record<string, string | undefined>): Promise<AgentBrowserAdapter> {
  if (_loopbackPolicy) {
    // Loopback mode active — never create a normal adapter that could overwrite the confined one
    if (_adapter) return _adapter
    throw new Error('Loopback mode active but no adapter available. Wait for loopback transition to complete.')
  }
  if (_adapter) return _adapter
  if (_adapterInit) return _adapterInit
  _adapterInit = (async () => {
    const executablePath = await resolveAgentBrowserExecutable(env?.BROWSER_EXECUTABLE_PATH)
    _adapter = new AgentBrowserAdapter({ env, executablePath })
    _adapterInit = null
    return _adapter
  })()
  return _adapterInit
}

async function disposeCurrentAdapter(): Promise<void> {
  if (_adapter) {
    const a = _adapter
    _adapter = null
    _adapterInit = null
    _loopbackPolicy = null
    await a.close()
  }
  if (_loopbackProxy) {
    const p = _loopbackProxy
    _loopbackProxy = null
    await p.close()
  }
}

export async function closeBrowserSession(): Promise<void> {
  await disposeCurrentAdapter()
}

// ── CDP endpoint ──

function getCdpEndpoint(args: Record<string, unknown>, env: Record<string, string | undefined>): string | undefined {
  const endpoint = (typeof args.endpoint === 'string' && args.endpoint.trim())
    ? args.endpoint.trim()
    : (env.BROWSER_CDP_ENDPOINT?.trim())
  return endpoint || undefined
}

// ── Main entry point ──

export async function browser(
  args: Record<string, unknown>,
  options: { signal?: AbortSignal; env?: Record<string, string | undefined> } = {},
): Promise<BackendCallResult> {
  const env = options.env ?? process.env

  if (isBrowserAutomationDisabled(env)) {
    return textResult({ ok: false, message: 'Browser automation disabled by PI_SEARCH_BROWSER_AUTOMATION. Set it to 1 or unset to enable.' })
  }

  const backend = resolveBrowserBackend(env)

  if (backend === 'cdp') {
    return legacyCdpBrowser(args, options)
  }

  return agentBrowserRoute(args, options)
}

// ── Agent-browser route ──

async function agentBrowserRoute(
  args: Record<string, unknown>,
  options: { signal?: AbortSignal; env?: Record<string, string | undefined> },
): Promise<BackendCallResult> {
  const env = options.env ?? process.env
  const action = typeof args.action === 'string' ? args.action : ''
  const url = typeof args.url === 'string' ? args.url.trim() : ''

  // Reject credentialed URLs — prevents bypass of loopback detection
  if (url.includes('@')) {
    return textResult({
      error: 'URLs with credentials (user:pass@host) are not allowed. Remove userinfo from the URL.',
      failureCategory: 'domain-blocked',
    })
  }

  // Detect loopback navigate: parse target, start proxy if needed
  if (action === 'navigate' && url) {
    const policy = parseLoopbackDebugTarget(url)
    if (policy) {
      // Loopback navigate requested
      if (_loopbackPolicy && _adapter) {
        // Already in loopback mode — check same origin
        if (_loopbackPolicy.origin !== policy.origin) {
          return textResult({
            error: `Different loopback origin rejected. Close confined session before navigating elsewhere. Current: ${_loopbackPolicy.origin}, requested: ${policy.origin}`,
            failureCategory: 'domain-blocked',
          })
        }
        // Same origin — reuse adapter, navigate
        return _adapter.execute(args, { env, ...(options.signal ? { signal: options.signal } : {}) })
      }

      // Fresh loopback entry: guarded via boolean flag to prevent concurrent transitions
      if (_transitionBusy) {
        return textResult({ error: 'Loopback transition already in progress', failureCategory: 'domain-blocked' })
      }
      _transitionBusy = true;
      try {
        await disposeCurrentAdapter()
        const proxy = new LoopbackProxy(policy)
        let proxyUrl: string;
        try {
          proxyUrl = await proxy.start()
        } catch (err) {
          await proxy.close();
          return textResult({ ok: false, error: `Failed to start loopback proxy: ${err instanceof Error ? err.message : String(err)}`, failureCategory: 'domain-blocked' });
        }
        _loopbackProxy = proxy
        _loopbackPolicy = policy

        try {
          const executablePath = await resolveAgentBrowserExecutable(env?.BROWSER_EXECUTABLE_PATH)
          const freshAdapter = new AgentBrowserAdapter({
            env,
            executablePath,
            loopbackMode: {
              proxyUrl,
              origin: policy.origin,
            },
          })
          _adapter = freshAdapter

          // Execute navigate (adapter will send open + navigate via confined process)
          return freshAdapter.execute(args, { env, ...(options.signal ? { signal: options.signal } : {}) })
        } catch (err) {
          // Cleanup: proxy started but adapter/execute failed
          _loopbackProxy = null;
          _loopbackPolicy = null;
          await proxy.close();
          return textResult({ ok: false, error: `Loopback adapter failed: ${err instanceof Error ? err.message : String(err)}`, failureCategory: 'domain-blocked' });
        }
      } finally {
        _transitionBusy = false;
      }
    }
  }

  // Close action: clean up loopback state + adapter
  if (action === 'close') {
    await disposeCurrentAdapter()
    return textResult('Browser session closed')
  }

  // Non-navigate action: if in loopback mode, validate the adapter is loopback
  if (_loopbackPolicy && _adapter) {
    // Loopback mode active — all actions go through the confined adapter
    return _adapter.execute(args, { env, ...(options.signal ? { signal: options.signal } : {}) })
  }

  const adapter = await getAdapter(env)
  return adapter.execute(args, { env, ...(options.signal ? { signal: options.signal } : {}) })
}

// ── Legacy CDP route (rollback path) ──

async function legacyCdpBrowser(
  args: Record<string, unknown>,
  options: { signal?: AbortSignal; env?: Record<string, string | undefined> },
): Promise<BackendCallResult> {
  const env = options.env ?? process.env
  const endpoint = getCdpEndpoint(args, env)

  if (!endpoint) {
    throw new Error('CDP endpoint is required. Set BROWSER_CDP_ENDPOINT env or pass endpoint param.')
  }

  validateLegacyLoopbackEndpoint(endpoint)
  const action = typeof args.action === 'string' ? args.action : 'status'

  if (isSensitiveAction(action) && env.PI_SEARCH_BROWSER_ALLOW_SENSITIVE !== '1') {
    return textResult({ error: `${action} disabled by policy. Set PI_SEARCH_BROWSER_ALLOW_SENSITIVE=1 to enable.` })
  }

  if (action === 'status') {
    return textResult({
      endpoint,
      browserAutomationEnabled: true,
      backend: 'cdp',
      websocketAvailable: typeof globalThis.WebSocket === 'function',
    })
  }

  // CDP loopback fail-closed: loopback navigate under CDP backend is unsupported
  const cdpUrl = typeof args.url === 'string' ? args.url.trim() : ''
  if (action === 'navigate' && cdpUrl) {
    const policy = parseLoopbackDebugTarget(cdpUrl)
    if (policy) {
      return textResult({
        error: `Loopback navigate under CDP backend is unsupported. Use the default agent-browser backend for loopback confinement.`,
        failureCategory: 'domain-blocked',
      })
    }
  }



  const signal = options.signal
  const session = await openCdpSession(endpoint, signal)
  try {
    switch (action) {
      case 'tabs':
        return textResult(await cdpListTargets(session))
      case 'navigate': {
        const url = requireString(args.url, 'url')
        return textResult(await cdpNavigate(session, url))
      }
      case 'evaluate': {
        const expression = requireString(args.expression, 'expression')
        return textResult(await cdpEvaluate(session, expression))
      }
      case 'text':
        return textResult(await cdpGetText(session))
      case 'html':
        return textResult(await cdpGetHtml(session))
      case 'screenshot':
        return textResult(await cdpScreenshot(session))
      case 'click': {
        const selector = requireString(args.selector, 'selector')
        return textResult(await cdpClick(session, selector))
      }
      case 'type': {
        const selector = requireString(args.selector, 'selector')
        const text = requireString(args.text, 'text')
        return textResult(await cdpType(session, selector, text))
      }
      case 'scroll': {
        const x = typeof args.x === 'number' ? args.x : 0
        const y = typeof args.y === 'number' ? args.y : 0
        return textResult(await cdpScroll(session, x, y))
      }
      case 'close':
        return textResult(await cdpCloseTarget(session))
      case 'cookies': {
        const urls = Array.isArray(args.urls) ? args.urls.filter((u): u is string => typeof u === 'string') : undefined
        const rawCookies = await cdpGetCookiesRaw(session, urls)
        // Return metadata only (no values) — consistent with agent-browser path
        const metadata = extractCookieMetadata(rawCookies as Array<{ name: string; value: string; domain: string; path: string; expires: number | undefined; httpOnly: boolean; secure: boolean; sameSite?: string }>)
        return textResult(metadata)
      }
      case 'set_cookies': {
        const cookies = args.cookies
        if (!Array.isArray(cookies)) throw new Error('cookies is required and must be an array')
        for (const c of cookies) {
          if (typeof c !== 'object' || c === null || typeof (c as Record<string, unknown>).name !== 'string' || !(c as Record<string, unknown>).name) {
            throw new Error('each cookie must be an object with a non-empty string name')
          }
        }
        return textResult(await cdpSetCookies(session, cookies))
      }
      default:
        throw new Error(`Unsupported browser action: ${action}`)
    }
  } finally {
    session.close()
  }
}

// ── Helpers ──

function requireString(value: unknown, name: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${name} is required`)
  return value.trim()
}

function textResult(data: unknown): BackendCallResult {
  const text = typeof data === 'string' ? data : JSON.stringify(data, null, 2) ?? String(data)
  const result = guardedTextResult(text, data)
  if (typeof data === 'object' && data !== null && 'failureCategory' in data) {
    return { ...result, failureCategory: (data as Record<string, unknown>).failureCategory }
  }
  return result
}
