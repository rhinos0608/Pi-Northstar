import type { BackendCallResult } from './backend.js'
import { isBrowserAutomationDisabled } from './cdp.js'

import { textResult as guardedTextResult } from './tool-output.js'
import { AgentBrowserAdapter } from './agent-browser.js'
import { agentBrowserExecutableConfigured, resolveAgentBrowserExecutable } from './agent-browser-process.js'
import { parseLoopbackDebugTarget, type LoopbackDebugPolicy } from './loopback-debug-policy.js'
import { LoopbackProxy } from './loopback-proxy.js'

export type BrowserAction = 'status' | 'tabs' | 'navigate' | 'evaluate' | 'text' | 'html' | 'screenshot' | 'click' | 'type' | 'scroll' | 'close' | 'cookies' | 'set_cookies'

export function browserToolConfigured(env: Record<string, string | undefined> = process.env): boolean {
  if (isBrowserAutomationDisabled(env)) return false
  return agentBrowserExecutableConfigured(env.BROWSER_EXECUTABLE_PATH, env)
}

// ── Persistent adapter ──

let _adapter: AgentBrowserAdapter | null = null
let _adapterInit: Promise<AgentBrowserAdapter> | null = null
let _loopbackPolicy: LoopbackDebugPolicy | null = null
let _loopbackProxy: LoopbackProxy | null = null

// Guards fresh loopback entry to prevent concurrent transitions
let _transitionBusy = false

async function getAdapter(env?: Record<string, string | undefined>): Promise<AgentBrowserAdapter | BackendCallResult> {
  if (_loopbackPolicy) {
    // Loopback mode active — never create a normal adapter that could overwrite the confined one
    if (_adapter) return _adapter
    return textResult({ error: 'Loopback mode active but no adapter available. Wait for loopback transition to complete.', failureCategory: 'domain-blocked' })
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
  _loopbackPolicy = null
  if (_adapter) {
    const a = _adapter
    _adapter = null
    _adapterInit = null
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

// ── Main entry point ──

export async function browser(
  args: Record<string, unknown>,
  options: { signal?: AbortSignal; env?: Record<string, string | undefined> } = {},
): Promise<BackendCallResult> {
  const env = options.env ?? process.env

  if (isBrowserAutomationDisabled(env)) {
    return textResult({ ok: false, message: 'Browser automation disabled by PI_SEARCH_BROWSER_AUTOMATION. Set it to 1 or unset to enable.' })
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

  // Reject credentialed URLs — prevents bypass of loopback detection.
  // Parse the URL so '@' in the path/query does not false-positive.
  if (url) {
    let hasCredentials = false
    try {
      const parsedUrl = new URL(url)
      hasCredentials = parsedUrl.username !== '' || parsedUrl.password !== ''
    } catch { /* invalid URL handled downstream */ }
    if (hasCredentials) {
      return textResult({
        error: 'URLs with credentials (user:pass@host) are not allowed. Remove userinfo from the URL.',
        failureCategory: 'domain-blocked',
      })
    }
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

  const adapterOrResult = await getAdapter(env)
  if (isAgentBrowserAdapter(adapterOrResult)) {
    return adapterOrResult.execute(args, { env, ...(options.signal ? { signal: options.signal } : {}) })
  }
  return adapterOrResult
}

/** Narrowing guard for the adapter/result union returned by getAdapter. */
function isAgentBrowserAdapter(value: AgentBrowserAdapter | BackendCallResult): value is AgentBrowserAdapter {
  return typeof (value as AgentBrowserAdapter).execute === 'function'
}

// ── Helpers ──

function textResult(data: unknown): BackendCallResult {
  const text = typeof data === 'string' ? data : JSON.stringify(data, null, 2) ?? String(data)
  const result = guardedTextResult(text, data)
  if (typeof data === 'object' && data !== null && 'failureCategory' in data) {
    return { ...result, failureCategory: (data as Record<string, unknown>).failureCategory }
  }
  return result
}
