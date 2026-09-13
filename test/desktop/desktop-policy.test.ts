import assert from 'node:assert/strict';
import { test } from 'node:test';
import { assertAllowedAction, requiresConfirmation, isDeniedUpstreamTool, validatePolicy, DENIED_DESKTOP_ACTIONS } from '../../src/desktop/desktop-policy.js';

test('assertAllowedAction: allows known actions', () => {
  assertAllowedAction('status');
  assertAllowedAction('click');
  assertAllowedAction('observe_window');
});

test('assertAllowedAction: rejects unknown actions', () => {
  assert.throws(() => assertAllowedAction('shell'), /ACTION_DENIED/);
  assert.throws(() => assertAllowedAction('sudo'), /ACTION_DENIED/);
  assert.throws(() => assertAllowedAction('eval'), /ACTION_DENIED/);
});

test('requiresConfirmation: gates free-text injection (type_text/press_key)', () => {
  // Action-shape tiers: content tiers deliberately absent (text/key secret-handled).
  assert.equal(requiresConfirmation('click'), false);
  assert.equal(requiresConfirmation('scroll'), false);
  assert.equal(requiresConfirmation('type_text'), true);
  assert.equal(requiresConfirmation('press_key'), true);
  assert.equal(requiresConfirmation('status'), false);
  assert.equal(requiresConfirmation({ action: 'type_text' }), true);
  assert.equal(requiresConfirmation({ action: 'click' }), false);
});

test('requiresConfirmation: returns false for non-mutations', () => {
  assert.equal(requiresConfirmation('status'), false);
  assert.equal(requiresConfirmation('list_apps'), false);
  assert.equal(requiresConfirmation('list_windows'), false);
  assert.equal(requiresConfirmation('observe_window'), false);
  assert.equal(requiresConfirmation('wait'), false);
});

test('isDeniedUpstreamTool: denies tools in DENIED_DESKTOP_ACTIONS', () => {
  assert.equal(isDeniedUpstreamTool('shell'), true);
  assert.equal(isDeniedUpstreamTool('evaluate'), true);
  assert.equal(isDeniedUpstreamTool('launch_app'), true);
});

test('isDeniedUpstreamTool: allows all desktop actions', () => {
  const desktopActions = ['status','list_apps','list_windows','observe_window','wait','click','type_text','press_key','scroll'];
  for (const a of desktopActions) {
    assert.equal(isDeniedUpstreamTool(a), false);
  }
});

test('validatePolicy: happy path returns validated request', () => {
  const request = validatePolicy({ action: 'status' }, { PI_SEARCH_DESKTOP_AUTOMATION: '1' });
  assert.equal(request.action, 'status');
});

test('validatePolicy: rejects disabled desktop', () => {
  assert.throws(() => validatePolicy({ action: 'status' }, {}), /DESKTOP_DISABLED/);
});

test('validatePolicy: requires pid and windowId for observe_window', () => {
  assert.throws(
    () => validatePolicy({ action: 'observe_window' }, { PI_SEARCH_DESKTOP_AUTOMATION: '1' }),
    /pid and windowId required/,
  );
  assert.throws(
    () => validatePolicy({ action: 'observe_window', pid: 123 }, { PI_SEARCH_DESKTOP_AUTOMATION: '1' }),
    /pid and windowId required/,
  );
  assert.throws(
    () => validatePolicy({ action: 'observe_window', windowId: 'w1' }, { PI_SEARCH_DESKTOP_AUTOMATION: '1' }),
    /pid and windowId required/,
  );
  const req = validatePolicy({ action: 'observe_window', pid: 123, windowId: 'w1' }, { PI_SEARCH_DESKTOP_AUTOMATION: '1' });
  assert.equal(req.action, 'observe_window');
  assert.equal(req.pid, 123);
  assert.equal(req.windowId, 'w1');
});

test('validatePolicy: requires pid and windowId for wait', () => {
  assert.throws(
    () => validatePolicy({ action: 'wait' }, { PI_SEARCH_DESKTOP_AUTOMATION: '1' }),
    /pid and windowId required/,
  );
  const req = validatePolicy({ action: 'wait', pid: 123, windowId: 'w1' }, { PI_SEARCH_DESKTOP_AUTOMATION: '1' });
  assert.equal(req.action, 'wait');
});

test('validatePolicy: rejects includeScreenshot for non-observe_window', () => {
  assert.throws(
    () => validatePolicy({ action: 'status', includeScreenshot: true }, { PI_SEARCH_DESKTOP_AUTOMATION: '1' }),
    /includeScreenshot only valid for observe_window/,
  );
  assert.throws(
    () => validatePolicy({ action: 'click', includeScreenshot: true, stateId: 's1' }, { PI_SEARCH_DESKTOP_AUTOMATION: '1' }),
    /includeScreenshot only valid for observe_window/,
  );
  const req = validatePolicy(
    { action: 'observe_window', pid: 123, windowId: 'w1', includeScreenshot: true },
    { PI_SEARCH_DESKTOP_AUTOMATION: '1' },
  );
  assert.equal(req.action, 'observe_window');
  assert.equal(req.includeScreenshot, true);
});

test('validatePolicy: requires stateId for mutations', () => {
  assert.throws(
    () => validatePolicy({ action: 'click' }, { PI_SEARCH_DESKTOP_AUTOMATION: '1' }),
    /mutation requires stateId/,
  );
  assert.throws(
    () => validatePolicy({ action: 'type_text' }, { PI_SEARCH_DESKTOP_AUTOMATION: '1' }),
    /mutation requires stateId/,
  );
  assert.throws(
    () => validatePolicy({ action: 'press_key' }, { PI_SEARCH_DESKTOP_AUTOMATION: '1' }),
    /mutation requires stateId/,
  );
  assert.throws(
    () => validatePolicy({ action: 'scroll' }, { PI_SEARCH_DESKTOP_AUTOMATION: '1' }),
    /mutation requires stateId/,
  );
  const req = validatePolicy({ action: 'click', stateId: 's1' }, { PI_SEARCH_DESKTOP_AUTOMATION: '1' });
  assert.equal(req.action, 'click');
  assert.equal(req.stateId, 's1');
});

test('validatePolicy: non-mutations do not require stateId', () => {
  assert.doesNotThrow(() => validatePolicy({ action: 'status' }, { PI_SEARCH_DESKTOP_AUTOMATION: '1' }));
  assert.doesNotThrow(() => validatePolicy({ action: 'list_apps' }, { PI_SEARCH_DESKTOP_AUTOMATION: '1' }));
  assert.doesNotThrow(() => validatePolicy({ action: 'list_windows' }, { PI_SEARCH_DESKTOP_AUTOMATION: '1' }));
});

test('DENIED_DESKTOP_ACTIONS: contains upstream-only tools', () => {
  assert.ok(DENIED_DESKTOP_ACTIONS.includes('launch_app'));
  assert.ok(DENIED_DESKTOP_ACTIONS.includes('evaluate'));
  assert.ok(DENIED_DESKTOP_ACTIONS.includes('shell'));
  assert.ok(!(DENIED_DESKTOP_ACTIONS as readonly string[]).includes('click'));
  assert.ok(!(DENIED_DESKTOP_ACTIONS as readonly string[]).includes('status'));
});

test('requiresConfirmation: tiers across all actions', () => {
  const gated = ['type_text','press_key'] as const;
  const ungated = ['status','list_apps','list_windows','observe_window','wait','click','scroll'] as const;
  for (const a of gated) assert.equal(requiresConfirmation(a), true, a);
  for (const a of ungated) assert.equal(requiresConfirmation(a), false, a);
});
test('validatePolicy: gated actions defer human confirmation to service', () => {
  const env = { PI_SEARCH_DESKTOP_AUTOMATION: '1' };
  const typeText = validatePolicy({ action: 'type_text', stateId: 's1', text: 'hi' }, env);
  assert.equal(typeText.action, 'type_text');
  const pressKey = validatePolicy({ action: 'press_key', stateId: 's1', key: 'Enter' }, env);
  assert.equal(pressKey.action, 'press_key');
  assert.throws(() => validatePolicy({ action: 'type_text', stateId: 's1', text: 'hi', confirmed: true }, env), /unknown field confirmed/);
  // Ungated mutations unaffected.
  const click = validatePolicy({ action: 'click', stateId: 's1' }, env);
  assert.equal(click.action, 'click');
});
test('validatePolicy: rejects oversized ids, predicate text, and out-of-range coords', () => {
  const env = { PI_SEARCH_DESKTOP_AUTOMATION: '1' };
  assert.throws(() => validatePolicy({ action: 'list_windows', windowId: 'w'.repeat(201) }, env), /INVALID_REQUEST/);
  assert.throws(() => validatePolicy({ action: 'wait', pid: 1, windowId: 'w', predicate: { text: 't'.repeat(201) } }, env), /INVALID_REQUEST/);
  assert.throws(() => validatePolicy({ action: 'wait', pid: 1, windowId: 'w', predicate: { role: 'r'.repeat(201) } }, env), /INVALID_REQUEST/);
  assert.throws(() => validatePolicy({ action: 'click', pid: 1, windowId: 'w', stateId: 's', x: 100001 }, env), /INVALID_REQUEST/);
  assert.throws(() => validatePolicy({ action: 'scroll', pid: 1, windowId: 'w', stateId: 's', deltaY: -100001 }, env), /INVALID_REQUEST/);
});
test('validatePolicy: defense-in-depth DENIED_DESKTOP_ACTIONS check exists', () => {
  // Assert that validatePolicy would catch a hypothetically allowed-but-denied action
  // Can't test directly since no overlap exists today — structural assertion only
  const allowedActions = ['status','list_apps','list_windows','observe_window','wait','click','type_text','press_key','scroll'];
  const deniedActions = [...DENIED_DESKTOP_ACTIONS];
  const overlap = allowedActions.filter(a => (deniedActions as string[]).includes(a));
  assert.equal(overlap.length, 0, 'no overlap — DENIED check is future-proofing only');
});
