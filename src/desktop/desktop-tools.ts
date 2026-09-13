import { CuaClient } from './cua-client.js';
import { ObservationStore, isMutation, resourceKey, timeoutFor, fingerprintData, OBSERVATION_TTL_MS, COORDINATE_MUTATION_FRESHNESS_MS, type DesktopRequest, type DesktopResult, MAX_AX_DEPTH, MAX_AX_NODES, MAX_SCREENSHOT_BYTES, MAX_DIMENSION } from './desktop-contract.js';
import { guardText } from '../core/tool-output.js';
import { validatePolicy, requiresConfirmation } from './desktop-policy.js';

const MAP: Record<string, string> = { status: 'health_report', list_apps: 'list_apps', list_windows: 'list_windows', observe_window: 'get_window_state', click: 'click', type_text: 'type_text', press_key: 'press_key', scroll: 'scroll' };

// Confirmation tiers: type_text/press_key (free-text injection) require
// explicit human confirmation through DesktopService's injected callback;
// scroll/click stay ungated. Operators are additionally warned via the
// desktop promptGuidelines (AX trees may expose PII/credentials).
export function sanitizeDesktopErrorMessage(message: string): string {
  return message
    .replace(/Proxy-Authorization\s*[:=]\s*[^,\s}"']+/gi, 'Proxy-Authorization: ***')
    .replace(/Authorization\s*[:=]\s*(?:Bearer|Basic|token)?\s*\S+/gi, 'Authorization: ***')
    .replace(/\/\/[^\/\s]*:[^\/\s]*@/g, '//***:***@')
    .replace(/\/\/[^\/\s]*@/g, '//***@')
    .replace(/(["']?(?:cookie|value|token|password|secret|api_?key)["']?)\s*[:=]\s*["']?[^,\s}"']+["']?/gi, '$1=***')
    .replace(/Bearer\s+\S+/gi, 'Bearer ***')
    .replace(/Cookie\s*[:=]\s*[^,\s}"']+/gi, 'Cookie: ***')
    .replace(/Set-Cookie\s*[:=]\s*[^,\s}"']+/gi, 'Set-Cookie: ***')
    .slice(0, 2000);
}
/** Await human confirmation, honoring caller abort while the TUI dialog
 *  is pending. Listener removed once confirmation settles. Rejects with the
 *  signal reason on abort; a missing callback fails closed (false). */
function confirmWithSignal(
  confirmation: ((request: DesktopRequest) => Promise<boolean>) | undefined,
  request: DesktopRequest,
  signal?: AbortSignal,
): Promise<boolean> {
  if (confirmation === undefined) return Promise.resolve(false);
  if (signal === undefined) return confirmation(request);
  if (signal.aborted) return Promise.reject(signal.reason ?? new Error('confirmation aborted'));
  return new Promise<boolean>((resolve, reject) => {
    const onAbort = (): void => reject(signal.reason ?? new Error('confirmation aborted'));
    signal.addEventListener('abort', onAbort, { once: true });
    confirmation(request).then(
      (approved) => {
        signal.removeEventListener('abort', onAbort);
        resolve(approved);
      },
      (error) => {
        signal.removeEventListener('abort', onAbort);
        reject(error);
      },
    );
  });
}
function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(signal.reason ?? new Error('wait aborted'));
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => { signal?.removeEventListener('abort', onAbort); resolve(); }, ms);
    const onAbort = () => { clearTimeout(timer); reject(signal?.reason ?? new Error('wait aborted')); };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}
export class DesktopService {
  readonly observations = new ObservationStore(); private used = false;
  constructor(private readonly client: CuaClient = new CuaClient(), private readonly env: Record<string, string | undefined> = process.env, private readonly confirm?: (request: DesktopRequest) => Promise<boolean>) {}
  async execute(raw: Record<string, unknown>, signal?: AbortSignal, confirm?: (request: DesktopRequest) => Promise<boolean>): Promise<DesktopResult & { content?: unknown[] }> {
    const request = validatePolicy(raw, this.env);
    const confirmation = confirm ?? this.confirm;
    if (requiresConfirmation(request) && !(await confirmWithSignal(confirmation, request, signal))) throw new Error('CONFIRMATION_REQUIRED: type_text/press_key require explicit human confirmation in TUI');
    this.used = true;
    const pid = request.pid ?? 0; const windowId = request.windowId ?? '';
    if (isMutation(request.action)) { if (!request.pid || !request.windowId || !request.stateId) throw new Error('STALE_OBSERVATION: mutation requires target and state'); const coordinate = request.x !== undefined || request.y !== undefined || request.deltaX !== undefined || request.deltaY !== undefined; const stored = this.observations.get(request.stateId!, request.pid, request.windowId, coordinate ? COORDINATE_MUTATION_FRESHNESS_MS : OBSERVATION_TTL_MS); await this.assertWindowFresh(request.pid, request.windowId, stored.fingerprint, stored.stateId, signal); }
    if (request.action === 'wait') return this.wait(request, signal);
    let result: unknown; try { result = await this.client.callTool(MAP[request.action]!, this.args(request), { ...(signal ? { signal } : {}), timeout: timeoutFor(request.action, request.timeoutMs), ...(pid && windowId ? { resource: resourceKey(pid, windowId) } : {}), mutation: isMutation(request.action) }); } catch (error) { throw error instanceof Error ? new Error(sanitizeDesktopErrorMessage(error.message)) : error; }
    const includeImage = request.action === 'observe_window' && request.includeScreenshot === true;
    // Keep image bytes only in MCP/Pi content; never in normalized data/details.
    const normalized = boundAggregate(normalize(result, false));
    const details = boundAggregate(normalize(result, false));
    if (request.action === 'observe_window') { const state = this.observations.issue(request.pid!, request.windowId!, normalized); return { action: request.action, stateId: state.stateId, data: normalized, content: contentFor(result, includeImage), details }; }
    return { action: request.action, data: normalized, content: contentFor(result, false), details };
  }
  async close(): Promise<void> { this.observations.clear(); await this.client.close(); }
  wasUsed(): boolean { return this.used; }
  private async assertWindowFresh(pid: number, windowId: string, fingerprint: string, stateId: string, signal?: AbortSignal): Promise<void> {
    let current: unknown;
    try { current = await this.client.callTool('get_window_state', { pid, window_id: windowId }, { ...(signal ? { signal } : {}), timeout: 5000, resource: resourceKey(pid, windowId) }); }
    catch (error) { this.observations.remove(stateId); throw new Error(`STALE_OBSERVATION: pre-mutation re-observe failed for ${pid}:${windowId}, re-observe before retry`); }
    const fresh = fingerprintData(boundAggregate(normalize(current, false)));
    if (fresh !== fingerprint) { this.observations.remove(stateId); throw new Error('STALE_OBSERVATION: window changed since observation, re-observe before retry'); }
  }
  private args(r: DesktopRequest): Record<string, unknown> { const out: Record<string, unknown> = {}; if (r.pid !== undefined) out.pid = r.pid; if (r.windowId !== undefined) out.window_id = r.windowId; if (r.text !== undefined) out.text = r.text; if (r.key !== undefined) out.key = r.key; if (r.x !== undefined) out.x = r.x; if (r.y !== undefined) out.y = r.y; if (r.deltaX !== undefined) out.delta_x = r.deltaX; if (r.deltaY !== undefined) out.delta_y = r.deltaY; if (r.includeScreenshot === true) out.include_screenshot = true; return out; }
  private async wait(r: DesktopRequest, signal?: AbortSignal): Promise<DesktopResult> { const until = Date.now() + timeoutFor('wait', r.timeoutMs); while (Date.now() < until) { let value: unknown; try { value = await this.client.callTool('get_window_state', this.args(r), { ...(signal ? { signal } : {}), timeout: 15000 }); } catch (error) { throw error instanceof Error ? new Error(sanitizeDesktopErrorMessage(error.message)) : error; } const safe = boundAggregate(normalize(value, false)); const text = JSON.stringify(safe); if ((!r.predicate?.text || text.includes(r.predicate.text)) && (!r.predicate?.role || text.includes(r.predicate.role))) return { action: 'wait', data: safe }; await abortableSleep(100, signal); } throw new Error('wait timed out'); }
}

function normalize(value: unknown, _includeImage = false): unknown {
  const walk = (v: unknown, depth = 0, secureSibling = false): unknown => {
    if (depth > MAX_AX_DEPTH) return '[depth capped]';
    if (Array.isArray(v)) return v.slice(0, MAX_AX_NODES).map(x => walk(x, depth + 1, secureSibling));
    if (v && typeof v === 'object') {
      const entries = Object.entries(v as Record<string, unknown>);
      const secureMarker = entries.some(([k, x]) => /^(?:is_secure|secure|sensitive|password|secret|token|key)$/i.test(k) && (x === true || /^(?:password|secret|token|key)$/i.test(k)));
      const out: Record<string, unknown> = {};
      for (const [k, x] of entries) {
        if (/^(?:is_secure|secure|sensitive|password|secret|token|key)$/i.test(k)) continue;
        // Never carry image/base64 bytes into normalized model-visible data.
        if (/^(?:data|base64)$/i.test(k)) continue;
        out[k] = secureMarker || secureSibling ? '[redacted]' : walk(x, depth + 1, false);
      }
      return out;
    }
    if (secureSibling) return '[redacted]';
    if (typeof v === 'string') {
      if (/(?:Bearer\s+\S+|-----BEGIN|\/Users\/|\/home\/|[A-Z_]*(?:TOKEN|SECRET|PASSWORD|API_KEY)[=:])/i.test(v)) return '[redacted]';
      if (/\bat\s+[^\n]+:\d+:\d+/i.test(v)) return '[stack redacted]';
      if (v.length > 10000) return guardText(v);
    }
    return v;
  };
  return walk(value);
}

const MAX_AGGREGATE_CHARS = 120_000;

function boundAggregate(value: unknown): unknown {
  let serialized: string;
  try { serialized = JSON.stringify(value) ?? String(value); } catch { return '[aggregate guard: unserializable]'; }
  if (serialized.length > MAX_AGGREGATE_CHARS) return guardText(serialized);
  return value;
}

function contentFor(value: unknown, includeImage: boolean): unknown[] {
  if (!includeImage) return [{ type: 'text', text: guardText(JSON.stringify(normalize(value, false))) }];
  const root = value && typeof value === 'object' ? value as Record<string, unknown> : {};
  const blocks = Array.isArray(root.content) ? root.content : [];
  const image = blocks.find((block): block is Record<string, unknown> => {
    return !!block && typeof block === 'object' && (block as Record<string, unknown>).type === 'image' && typeof (block as Record<string, unknown>).data === 'string';
  });
  if (!image) return [{ type: 'text', text: guardText(JSON.stringify(normalize(value, false))) }];
  const data = image.data as string;
  const bytes = Math.floor(data.length * 3 / 4);
  const width = typeof image.width === 'number' ? image.width : 0;
  const height = typeof image.height === 'number' ? image.height : 0;
  if (bytes > MAX_SCREENSHOT_BYTES || width > MAX_DIMENSION || height > MAX_DIMENSION) throw new Error('Screenshot exceeds safety limits');
  return [{ type: 'image', mediaType: typeof image.mimeType === 'string' ? image.mimeType : (typeof image.mediaType === 'string' ? image.mediaType : 'image/png'), data, width, height, byteLength: bytes }];
}
