import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  DESKTOP_ACTION_CONTRACT,
  validateDesktopRequest,
  type DesktopAction,
} from '../../src/desktop/desktop-contract.js';
import { validatePolicy } from '../../src/desktop/desktop-policy.js';
import { DesktopService } from '../../src/desktop/desktop-tools.js';

const ENV = { PI_SEARCH_DESKTOP_AUTOMATION: '1' };

class Fake {
  calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  async callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
    this.calls.push({ name, args });
    return { structuredContent: { ok: true } };
  }
  async close(): Promise<void> {}
}

test('action contract: canonical required/allowed fields per action', () => {
  const actions = Object.keys(DESKTOP_ACTION_CONTRACT).sort();
  assert.deepEqual(actions, [
    'click',
    'list_apps',
    'list_windows',
    'observe_window',
    'press_key',
    'scroll',
    'status',
    'type_text',
    'wait',
  ]);
  for (const action of ['status', 'list_apps', 'list_windows'] as const) {
    assert.deepEqual([...DESKTOP_ACTION_CONTRACT[action].required], []);
    assert.deepEqual([...DESKTOP_ACTION_CONTRACT[action].allowed], ['timeoutMs']);
  }
  assert.deepEqual([...DESKTOP_ACTION_CONTRACT.observe_window.required], ['pid', 'windowId']);
  assert.deepEqual([...DESKTOP_ACTION_CONTRACT.observe_window.allowed].sort(), [
    'includeScreenshot',
    'pid',
    'timeoutMs',
    'windowId',
  ]);
  assert.deepEqual([...DESKTOP_ACTION_CONTRACT.wait.required], ['pid', 'windowId']);
  assert.deepEqual([...DESKTOP_ACTION_CONTRACT.wait.allowed].sort(), [
    'pid',
    'predicate',
    'timeoutMs',
    'windowId',
  ]);
  const mutations: Record<DesktopAction, string[]> = {
    status: [],
    list_apps: [],
    list_windows: [],
    observe_window: [],
    wait: [],
    click: ['pid', 'stateId', 'timeoutMs', 'windowId', 'x', 'y'],
    type_text: ['pid', 'stateId', 'text', 'timeoutMs', 'windowId'],
    press_key: ['key', 'pid', 'stateId', 'timeoutMs', 'windowId'],
    scroll: ['deltaX', 'deltaY', 'pid', 'stateId', 'timeoutMs', 'windowId', 'x', 'y'],
  };
  for (const action of ['click', 'type_text', 'press_key', 'scroll'] as const) {
    assert.deepEqual([...DESKTOP_ACTION_CONTRACT[action].required].sort(), ['pid', 'stateId', 'windowId', ...(action === 'type_text' ? ['text'] : []), ...(action === 'press_key' ? ['key'] : [])].sort());
    assert.deepEqual([...DESKTOP_ACTION_CONTRACT[action].allowed].sort(), mutations[action].sort());
  }
});

test('action is required (no default)', () => {
  assert.throws(() => validateDesktopRequest({}), /action required/);
  assert.throws(() => validatePolicy({}, ENV), /action required/);
});

test('status/list actions accept only timeoutMs', () => {
  for (const action of ['status', 'list_apps', 'list_windows'] as const) {
    const req = validatePolicy({ action, timeoutMs: 100 }, ENV);
    assert.equal(req.action, action);
    for (const extra of [{ pid: 1 }, { windowId: 'w' }, { stateId: 's' }, { text: 'hi' }, { key: 'Enter' }, { x: 1 }, { predicate: { text: 't' } }, { includeScreenshot: true }]) {
      assert.throws(() => validatePolicy({ action, ...extra }, ENV), /INVALID_REQUEST/, `${action} ${JSON.stringify(extra)}`);
    }
  }
});

test('observe_window requires pid+windowId, allows includeScreenshot/timeoutMs only', () => {
  assert.throws(() => validatePolicy({ action: 'observe_window' }, ENV), /pid and windowId required/);
  const req = validatePolicy({ action: 'observe_window', pid: 1, windowId: 'w', includeScreenshot: true, timeoutMs: 500 }, ENV);
  assert.equal(req.pid, 1);
  for (const extra of [{ text: 'hi' }, { key: 'Enter' }, { x: 1 }, { predicate: { text: 't' } }, { stateId: 's' }]) {
    assert.throws(() => validatePolicy({ action: 'observe_window', pid: 1, windowId: 'w', ...extra }, ENV), /INVALID_REQUEST/, JSON.stringify(extra));
  }
});

test('wait requires pid+windowId, allows predicate/timeoutMs only', () => {
  assert.throws(() => validatePolicy({ action: 'wait' }, ENV), /pid and windowId required/);
  const req = validatePolicy({ action: 'wait', pid: 1, windowId: 'w', predicate: { text: 'ok' }, timeoutMs: 500 }, ENV);
  assert.equal(req.action, 'wait');
  for (const extra of [{ text: 'hi' }, { key: 'Enter' }, { x: 1 }, { includeScreenshot: true }, { stateId: 's' }]) {
    assert.throws(() => validatePolicy({ action: 'wait', pid: 1, windowId: 'w', ...extra }, ENV), /INVALID_REQUEST/, JSON.stringify(extra));
  }
});

test('mutations: policy keeps target check deferred, requires payload, rejects irrelevant fields', () => {
  // Policy still passes without pid/windowId (service enforces post-confirmation).
  const click = validatePolicy({ action: 'click', stateId: 's1' }, ENV);
  assert.equal(click.stateId, 's1');
  assert.throws(() => validatePolicy({ action: 'click', pid: 1, windowId: 'w', stateId: 's', text: 'hi' }, ENV), /INVALID_REQUEST/);
  assert.throws(() => validatePolicy({ action: 'click', pid: 1, windowId: 'w', stateId: 's', key: 'Enter' }, ENV), /INVALID_REQUEST/);
  assert.throws(() => validatePolicy({ action: 'click', pid: 1, windowId: 'w', stateId: 's', predicate: { text: 't' } }, ENV), /INVALID_REQUEST/);
  assert.throws(() => validatePolicy({ action: 'click', pid: 1, windowId: 'w', stateId: 's', includeScreenshot: true }, ENV), /INVALID_REQUEST/);
  const scrolled = validatePolicy({ action: 'scroll', stateId: 's', deltaY: 10 }, ENV);
  assert.equal(scrolled.deltaY, 10);
  assert.throws(() => validatePolicy({ action: 'scroll', pid: 1, windowId: 'w', stateId: 's', text: 'hi' }, ENV), /INVALID_REQUEST/);
  // type_text/press_key require nonempty bounded payload.
  assert.throws(() => validatePolicy({ action: 'type_text', pid: 1, windowId: 'w', stateId: 's' }, ENV), /text required/);
  assert.throws(() => validatePolicy({ action: 'type_text', pid: 1, windowId: 'w', stateId: 's', text: '' }, ENV), /text required/);
  assert.throws(() => validatePolicy({ action: 'press_key', pid: 1, windowId: 'w', stateId: 's' }, ENV), /key required/);
  assert.throws(() => validatePolicy({ action: 'press_key', pid: 1, windowId: 'w', stateId: 's', key: '' }, ENV), /key required/);
  assert.throws(() => validatePolicy({ action: 'type_text', pid: 1, windowId: 'w', stateId: 's', text: 'hi', key: 'Enter' }, ENV), /INVALID_REQUEST/);
  assert.throws(() => validatePolicy({ action: 'press_key', pid: 1, windowId: 'w', stateId: 's', key: 'Enter', text: 'hi' }, ENV), /INVALID_REQUEST/);
  const typed = validatePolicy({ action: 'type_text', pid: 1, windowId: 'w', stateId: 's', text: 'hi', timeoutMs: 500 }, ENV);
  assert.equal(typed.text, 'hi');
});

test('confirmation still precedes target checks', async () => {
  // Gated action without targets passes policy; service fails on confirmation first.
  const req = validatePolicy({ action: 'type_text', stateId: 's1', text: 'secret' }, ENV);
  assert.equal(req.action, 'type_text');
  const service = new DesktopService(new Fake() as never, ENV);
  await assert.rejects(service.execute({ action: 'type_text', stateId: 's1', text: 'secret' }), /CONFIRMATION_REQUIRED/);
  // Ungated mutation without targets passes policy; service enforces target+state.
  await assert.rejects(service.execute({ action: 'click', stateId: 's1' }), /mutation requires target and state/);
  await service.close();
});
