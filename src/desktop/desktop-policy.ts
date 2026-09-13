import { DESKTOP_ACTIONS, type DesktopAction, isMutation, validateDesktopRequest, type DesktopRequest } from './desktop-contract.js';

/** Free-text injection actions gated behind explicit human confirmation.
 *  scroll/click stay ungated; content-based tiers are deliberately absent:
 *  text/key are secret-handled (never echoed/inspected), so sensitivity
 *  cannot be judged from the request. Gate is the action shape, not content. */
export const CONFIRMATION_GATED_ACTIONS: readonly DesktopAction[] = ['type_text', 'press_key'] as const;
export const DENIED_DESKTOP_ACTIONS = ['launch_app','kill_app','shell','evaluate','page_javascript','config_write','record','replay','full_desktop_screenshot','foreground','drag','hotkey','double_click','right_click','set_value'] as const;
export function desktopEnabled(env:Record<string,string|undefined>=process.env):boolean { const value=env.PI_SEARCH_DESKTOP_AUTOMATION?.trim().toLowerCase(); return value==='1'||value==='true'||value==='yes'||value==='on'; }
export function assertAllowedAction(action:string): asserts action is DesktopAction { if (!(DESKTOP_ACTIONS as readonly string[]).includes(action)) throw new Error(`ACTION_DENIED: ${action}`); }
export function validatePolicy(raw:Record<string,unknown>, env:Record<string,string|undefined>=process.env):DesktopRequest { if(!desktopEnabled(env)) throw new Error('DESKTOP_DISABLED: set PI_SEARCH_DESKTOP_AUTOMATION=1 to enable'); const request=validateDesktopRequest(raw); assertAllowedAction(request.action); if(isDeniedUpstreamTool(request.action)) throw new Error(`ACTION_DENIED: ${request.action} is denied`); if((request.action==='observe_window'||request.action==='wait')&&(!request.pid||!request.windowId)) throw new Error('INVALID_REQUEST: pid and windowId required'); if(request.includeScreenshot!==undefined&&request.action!=='observe_window') throw new Error('INVALID_REQUEST: includeScreenshot only valid for observe_window'); if(isMutation(request.action)&&request.stateId===undefined) throw new Error('STALE_OBSERVATION: mutation requires stateId'); return request; }
export function requiresConfirmation(request: DesktopRequest): boolean;
export function requiresConfirmation(action: DesktopAction): boolean;
export function requiresConfirmation(target: DesktopRequest | DesktopAction): boolean {
  const action = typeof target === 'string' ? target : target.action;
  return (CONFIRMATION_GATED_ACTIONS as readonly string[]).includes(action);
}
export function isDeniedUpstreamTool(name:string):boolean { return (DENIED_DESKTOP_ACTIONS as readonly string[]).includes(name); }
