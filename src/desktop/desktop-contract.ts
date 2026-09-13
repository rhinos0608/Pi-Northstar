export const DESKTOP_ACTIONS = ['status','list_apps','list_windows','observe_window','wait','click','type_text','press_key','scroll'] as const;
export type DesktopAction = typeof DESKTOP_ACTIONS[number];
export type MutationAction = 'click'|'type_text'|'press_key'|'scroll';
export const UPSTREAM_TOOLS = ['health_report','list_apps','list_windows','get_window_state','click','type_text','press_key','scroll'] as const;
export type UpstreamTool = typeof UPSTREAM_TOOLS[number];
export type DesktopErrorCode = 'DESKTOP_DISABLED'|'ACTION_DENIED'|'CONFIRMATION_REQUIRED'|'STALE_OBSERVATION'|'TARGET_MISMATCH'|'OUTCOME_UNKNOWN'|'INVALID_REQUEST'|'DRIVER_UNAVAILABLE';
export interface DesktopRequest { action: DesktopAction; pid?: number; windowId?: string; stateId?: string; includeScreenshot?: boolean; predicate?: { text?: string; role?: string }; text?: string; key?: string; x?: number; y?: number; deltaX?: number; deltaY?: number; timeoutMs?: number; }
export type DesktopField = 'pid'|'windowId'|'stateId'|'includeScreenshot'|'predicate'|'text'|'key'|'x'|'y'|'deltaX'|'deltaY'|'timeoutMs';
export interface DesktopActionSpec { required: readonly DesktopField[]; allowed: readonly DesktopField[]; }
/** Canonical action-to-fields contract. Policy enforces field parity from
 *  `allowed`; `required` documents full runtime needs (mutation pid/windowId
 *  stay enforced post-confirmation in DesktopService). Later schema builders
 *  should generate strict per-action schemas from this table. */
export const DESKTOP_ACTION_CONTRACT: Record<DesktopAction, DesktopActionSpec> = {
  status: { required: [], allowed: ['timeoutMs'] },
  list_apps: { required: [], allowed: ['timeoutMs'] },
  list_windows: { required: [], allowed: ['timeoutMs'] },
  observe_window: { required: ['pid','windowId'], allowed: ['pid','windowId','includeScreenshot','timeoutMs'] },
  wait: { required: ['pid','windowId'], allowed: ['pid','windowId','predicate','timeoutMs'] },
  click: { required: ['pid','windowId','stateId'], allowed: ['pid','windowId','stateId','x','y','timeoutMs'] },
  type_text: { required: ['pid','windowId','stateId','text'], allowed: ['pid','windowId','stateId','text','timeoutMs'] },
  press_key: { required: ['pid','windowId','stateId','key'], allowed: ['pid','windowId','stateId','key','timeoutMs'] },
  scroll: { required: ['pid','windowId','stateId'], allowed: ['pid','windowId','stateId','x','y','deltaX','deltaY','timeoutMs'] },
};
export interface Observation { stateId:string; pid:number; windowId:string; generation:number; issuedAt:number; expiresAt:number; fingerprint:string; data: unknown; }
export const OBSERVATION_TTL_MS = 30_000;
export const COORDINATE_MUTATION_FRESHNESS_MS = 15_000;
export function fingerprintData(data: unknown): string {
  const text = (() => { try { return JSON.stringify(data) ?? String(data); } catch { return String(data); } })();
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) { hash ^= text.charCodeAt(i); hash = Math.imul(hash, 0x01000193); }
  return (hash >>> 0).toString(16).padStart(8, '0') + ':' + text.length.toString(16);
}
export interface DesktopResult { action: DesktopAction; stateId?: string; data?: unknown; details?: unknown; capability?: Capability; }
export interface Capability { status: 'tested'|'upstream_reported'|'degraded'|'unsupported'|'unverified'; version?: string; platform?: string; }
export const MAX_TEXT_LENGTH=10000; export const MAX_AX_NODES=1000; export const MAX_AX_DEPTH=32; export const MAX_SCREENSHOT_BYTES=10_000_000; export const MAX_DIMENSION=10_000;
export const MAX_SELECTOR_TEXT_LENGTH=200; export const MAX_ID_LENGTH=200; export const MAX_COORD_ABS=100000; const ECHO_LIMIT=32;
// text/key carry user-typed secrets: reject without value echo. All other fields echo a capped slice.
function invalidParam(key: string, value: unknown, secret: boolean): Error { if (secret || typeof value !== 'string') return new Error(`INVALID_REQUEST: invalid ${key}`); return new Error(`INVALID_REQUEST: invalid ${key} ${JSON.stringify(value.slice(0, ECHO_LIMIT))}`); }
export function isMutation(action: DesktopAction): action is MutationAction { return action==='click'||action==='type_text'||action==='press_key'||action==='scroll'; }
export function validateDesktopRequest(raw: Record<string, unknown>): DesktopRequest {
  const allowed = new Set(['action','pid','windowId','stateId','includeScreenshot','predicate','text','key','x','y','deltaX','deltaY','timeoutMs']);
  for (const key of Object.keys(raw)) if (!allowed.has(key)) throw new Error(`INVALID_REQUEST: unknown field ${key}`);
  if (raw.action === undefined) throw new Error('INVALID_REQUEST: action required');
  const action = raw.action;
  if (typeof action !== 'string' || !(DESKTOP_ACTIONS as readonly string[]).includes(action)) throw new Error(`INVALID_REQUEST: unsupported action ${String(action)}`);
  const req: DesktopRequest = { action: action as DesktopAction };
  if (raw.pid !== undefined && (!Number.isInteger(raw.pid)||Number(raw.pid)<=0)) throw new Error('INVALID_REQUEST: pid must be positive integer');
  if (typeof raw.pid==='number') req.pid=raw.pid;
  for (const key of ['windowId','stateId','text','key'] as const) if (raw[key]!==undefined) { const secret = key==='text'||key==='key'; const limit = key==='text' ? MAX_TEXT_LENGTH : MAX_ID_LENGTH; if(typeof raw[key]!=='string'||(raw[key] as string).length>limit) throw invalidParam(key, raw[key], secret); req[key]=raw[key] as never; }
  if (raw.includeScreenshot!==undefined) { if(typeof raw.includeScreenshot!=='boolean') throw new Error('INVALID_REQUEST: includeScreenshot must be boolean'); req.includeScreenshot=raw.includeScreenshot; }
  if (raw.predicate!==undefined) { if(typeof raw.predicate!=='object'||raw.predicate===null) throw new Error('INVALID_REQUEST: predicate must be object'); const p=raw.predicate as Record<string,unknown>; for (const key of ['text','role'] as const) if (p[key]!==undefined && (typeof p[key]!=='string'||(p[key] as string).length>MAX_SELECTOR_TEXT_LENGTH)) throw invalidParam(`predicate.${key}`, p[key], false); req.predicate={...(typeof p.text==='string'?{text:p.text}:{}),...(typeof p.role==='string'?{role:p.role}:{})}; }
  for (const key of ['x','y','deltaX','deltaY','timeoutMs'] as const) if(raw[key]!==undefined) { if(typeof raw[key]!=='number'||!Number.isFinite(raw[key])) throw new Error(`INVALID_REQUEST: invalid ${key}`); if(key!=='timeoutMs'&&Math.abs(raw[key] as number)>MAX_COORD_ABS) throw new Error(`INVALID_REQUEST: invalid ${key} out of range`); req[key]=raw[key] as never; }
  if (req.timeoutMs!==undefined && (req.timeoutMs<0||req.timeoutMs>60000)) throw new Error('INVALID_REQUEST: timeout exceeds 60000ms');
  return req;
}
export function resourceKey(pid:number, windowId:string):string { return `desktop:${pid}:${windowId}`; }
export function timeoutFor(action:DesktopAction, requested?:number):number { const max=action==='observe_window'||action==='status'||action==='list_apps'||action==='list_windows'?15000:action==='wait'?30000:10000; return Math.min(max, Math.max(1, requested??max)); }
export class ObservationStore {
 private readonly entries=new Map<string,Observation>(); private readonly latest=new Map<string,number>(); private generation=0;
 issue(pid:number,windowId:string,data:unknown,ttlMs=OBSERVATION_TTL_MS):Observation { const now=Date.now(); const resource=resourceKey(pid,windowId); const observation=Object.freeze({stateId:crypto.randomUUID(),pid,windowId,generation:++this.generation,issuedAt:now,expiresAt:now+ttlMs,fingerprint:fingerprintData(data),data:Object.freeze(data)}); this.latest.set(resource,observation.generation); this.entries.set(observation.stateId,observation); while(this.entries.size>128) this.entries.delete(this.entries.keys().next().value!); return observation; }
 get(stateId:string,pid:number,windowId:string,maxAgeMs?:number):Observation { const value=this.entries.get(stateId); const now=Date.now(); if(!value||value.expiresAt<=now) throw new Error('STALE_OBSERVATION: observation expired or missing'); if(value.pid!==pid||value.windowId!==windowId) throw new Error('TARGET_MISMATCH: observation target differs'); if(this.latest.get(resourceKey(pid,windowId))!==value.generation) throw new Error('STALE_OBSERVATION: newer observation exists'); if(maxAgeMs!==undefined&&now-value.issuedAt>maxAgeMs) throw new Error('STALE_OBSERVATION: observation too old for coordinate mutation, re-observe'); return value; }
 remove(stateId:string):void { this.entries.delete(stateId); }
 clear():void { this.entries.clear(); }
}
