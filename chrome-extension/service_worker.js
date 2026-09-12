/* Pi-Northstar user-Chrome companion service worker.
 *
 * Owned inactive-tab automation only. Enforces companion-side grant/lease,
 * tab-scoped deny-by-default DNR around navigation, and cleanup that never
 * touches user tabs/windows or the Chrome process.
 *
 * Hard prohibitions (also enforced Pi-side):
 * - No cookies/storage/history/identity APIs, no raw HTML, no Runtime.evaluate,
 *   no captureVisibleTab fallback, no windows.remove, no active-tab fallback,
 *   no existing-tab adoption, no loopback/private navigation handling here
 *   (rejected pre-dispatch by Pi policy).
 *
 * Exposed for tests: globalThis.__atlasCompanion (pure helpers + dispatch
 * with injectable chrome/fetch/now). All chrome access happens inside
 * functions; top-level only defines state and registers listeners when the
 * chrome API exists.
 */
(function () {
  'use strict';

  var PROTOCOL = 1;
  var BRIDGE_URL = 'http://127.0.0.1:17319';
  var LEASE_MAX_MS = 60_000;
  var POLL_MS = 25_000;
  var INSTANCE_KEY = 'atlasInstance';
  var OWNED_KEY = 'atlasOwnedTab';
  var COMMAND_TIMEOUT_MS = 25_000;
  // Shared effective maximum for waitMs (mirrors CHROME_PROFILE_WAIT_MAX_MS
  // in src/chrome-profile-contract.ts). Keep in sync; a wait must fit inside
  // COMMAND_TIMEOUT_MS so the Pi-side clamp and this clamp never diverge.
  var WAIT_MAX_MS = 15_000;
  var REDACTED = '[redacted]';

  // Closed operation union mirror. Anything else fails closed.
  var OPERATION_KINDS = [
    'navigate', 'snapshot', 'text', 'screenshot', 'click', 'type', 'fill',
    'select', 'scroll', 'wait', 'get_url', 'get_title', 'semantic_action',
    'tabs', 'close',
  ];

  var state = {
    grant: null, // { sessionKey, grantId, leaseExpiresAt }
    bridgeToken: null, // session token paired via origin-pinned POST /register
    lastRegisterAttempt: 0, // epoch ms of last POST /register attempt
    owned: null, // { tabId, frozenHostname, sessionKey, grantId }
    polling: false,
  };
  // Re-pair interval when unpaired or the token goes stale (bridge restart
  // rotates the session token; a token-mismatch route rejection clears the
  // token so the next loop iteration re-registers promptly).
  var REGISTER_RETRY_MS = 60_000;
  /** Throw when the operation was cancelled (timeout) or the grant is gone.
   *  Checked before every browser mutation so nothing mutates after timeout
   *  or revocation. */
  function throwIfCancelled(signal) {
    if (signal && signal.aborted === true) throw new Error('chrome_timeout: operation cancelled');
    if (state.grant === null) throw new Error('chrome_revoked: grant revoked during operation');
  }

  function now() {
    return Date.now();
  }

  function randomInstanceId() {
    try {
      if (globalThis.crypto && typeof globalThis.crypto.randomUUID === 'function') {
        return globalThis.crypto.randomUUID();
      }
    } catch (e) {}
    return 'i-' + Math.floor(Math.random() * 0xffffffff).toString(16) + '-' + now().toString(36);
  }

  /**
   * Chromium-family evidence only. Returns { family, version, evidence }.
   * Never claims Firefox/Safari support: non-Chromium UAs yield family 'unknown'.
   */
  function detectFamily(userAgentData) {
    var brands = userAgentData && userAgentData.brands;
    if (Array.isArray(brands)) {
      var hasChromium = false;
      var chromiumVersion = '';
      var named = '';
      var namedVersion = '';
      for (var i = 0; i < brands.length; i++) {
        var b = brands[i] || {};
        if (b.brand === 'Chromium') {
          hasChromium = true;
          chromiumVersion = String(b.version || '');
        } else if (b.brand === 'Google Chrome' || b.brand === 'Microsoft Edge' || b.brand === 'Brave' || b.brand === 'Opera' || b.brand === 'Vivaldi' || b.brand === 'Arc') {
          named = String(b.brand);
          namedVersion = String(b.version || '');
        }
      }
      if (hasChromium) {
        return {
          family: named ? named.toLowerCase().replace(/[^a-z]+/g, '-') : 'chromium',
          version: namedVersion || chromiumVersion,
          evidence: 'ua-brands:' + brands.map(function (x) { return String((x && x.brand) || '?'); }).join('+').slice(0, 120),
        };
      }
    }
    return { family: 'unknown', version: '', evidence: 'no-chromium-brand' };
  }

  /** Normalize UA brand versions to strict semver the bridge accepts (major[.minor[.patch]]). */
  function normalizeVersion(raw) {
    var s = String(raw || '').trim();
    var m = /^(\d+)(?:\.(\d+))?(?:\.(\d+))?/.exec(s);
    if (!m) return '0.0.0';
    return m[1] + '.' + (m[2] === undefined ? '0' : m[2]) + '.' + (m[3] === undefined ? '0' : m[3]);
  }

  /** Stable identity strategy: no hardcoded chrome-extension:// id here.
   * The install carries its id (unpacked path, Web Store key, or enterprise
   * policy); Pi pins that id operator-side (bridge extensionId -> Origin).
   * runtime.id is read for diagnostics only, never sent with grant secrets. */
  function ownExtensionId(chrome) {
    try {
      var id = chrome && chrome.runtime && chrome.runtime.id;
      if (typeof id === 'string' && id.length > 0) return id;
    } catch (e) {}
    return '';
  }

  /** Collision-free DNR base per owned tab (two consecutive ids: deny+allow).
   * Distinct tabs map to distinct bases; same tab reuses its base so reinstall
   * overwrites instead of leaking. Stays inside the dynamic-rule id range. */
  function ruleBaseForTab(tabId) {
    var n = typeof tabId === 'number' && Number.isFinite(tabId) ? Math.abs(Math.trunc(tabId)) : 0;
    return 1000 + ((n % 2000) * 2);
  }

  function navData() {
    try {
      var n = globalThis.navigator;
      if (n && n.userAgentData) return n.userAgentData;
    } catch (e) {}
    return null;
  }

  /** Ephemeral instance registration in chrome.storage.session (clears on restart). */
  async function ensureInstance(chrome, at) {
    var fam = detectFamily(navData());
    var record = null;
    try {
      var got = await chrome.storage.session.get(INSTANCE_KEY);
      var cur = got && got[INSTANCE_KEY];
      if (cur && isNonEmptyString(cur.instanceId) && typeof cur.lastSeen === 'number') record = cur;
    } catch (e) {
      record = null;
    }
    if (record === null) {
      record = {
        instanceId: randomInstanceId(),
        family: fam.family,
        version: normalizeVersion(fam.version),
        evidence: fam.evidence,
        lastSeen: at === undefined ? now() : at,
      };
    } else {
      record.family = fam.family;
      record.version = normalizeVersion(fam.version);
      record.evidence = fam.evidence;
      record.lastSeen = at === undefined ? now() : at;
    }
    try {
      var put = {};
      put[INSTANCE_KEY] = record;
      await chrome.storage.session.set(put);
    } catch (e) {
      // storage best-effort; caller still gets the record.
    }
    return record;
  }

  /** Heartbeat: refresh lastSeen, preserve ephemeral instanceId. */
  async function heartbeatInstance(chrome, at) {
    return ensureInstance(chrome, at);
  }

  /** Pair the bridge session token via origin-pinned POST /register.
   *  Best-effort: pollLoop retries while unpaired; commands fail closed
   *  against a foreign token once paired. Never logged. */
  async function registerCompanion(fetchImpl, chrome, inst) {
    state.lastRegisterAttempt = now();
    var record = inst || null;
    try {
      if (record === null && chrome && chrome.storage && chrome.storage.session) {
        record = await ensureInstance(chrome);
      }
    } catch (e) {
      record = null;
    }
    if (record === null) return null;
    try {
      var res = await fetchImpl(registerUrl(), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          instanceId: record.instanceId,
          family: record.family,
          version: record.version,
          caps: record.evidence || '',
        }),
      });
      if (!res.ok) return null;
      var body = await res.json();
      if (body && isNonEmptyString(body.bridgeToken)) {
        state.bridgeToken = body.bridgeToken;
        return body.bridgeToken;
      }
      return null;
    } catch (e) {
      return null;
    }
  }

  function err(code, message, retryable) {
    return { code: code, message: String(message).slice(0, 500), retryable: retryable === true };
  }

  function isNonEmptyString(v) {
    return typeof v === 'string' && v.length > 0;
  }

  /** Fail-closed command parse: unknown protocol/kind rejected. */
  function parseCommand(value) {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      throw new Error('chrome_invalid_request: command must be an object');
    }
    if (value.protocol !== PROTOCOL) {
      throw new Error('chrome_version_mismatch: unsupported protocol ' + String(value.protocol).slice(0, 32));
    }
    if (!isNonEmptyString(value.id) || !isNonEmptyString(value.sessionKey) || !isNonEmptyString(value.grantId)) {
      throw new Error('chrome_invalid_request: id/sessionKey/grantId required');
    }
    // Per-instance targeting + session token ride every command; missing
    // either fails closed so a grant can never land in the wrong browser.
    if (!isNonEmptyString(value.targetInstanceId) || !isNonEmptyString(value.bridgeToken)) {
      throw new Error('chrome_invalid_request: targetInstanceId/bridgeToken required');
    }
    var kind = value.kind;
    if (kind === 'authorize' || kind === 'renew') {
      if (typeof value.leaseExpiresAt !== 'number' || !Number.isFinite(value.leaseExpiresAt)) {
        throw new Error('chrome_invalid_request: leaseExpiresAt must be a finite number');
      }
      return value;
    }
    if (kind === 'execute') {
      if (typeof value.operation !== 'object' || value.operation === null) {
        throw new Error('chrome_invalid_request: operation must be an object');
      }
      if (OPERATION_KINDS.indexOf(value.operation.kind) === -1) {
        throw new Error('chrome_invalid_request: unknown operation kind ' + String(value.operation.kind).slice(0, 64));
      }
      return value;
    }
    if (kind === 'revoke') return value;
    throw new Error('chrome_invalid_request: unknown command kind ' + String(kind).slice(0, 32));
  }

  function grantMatches(cmd) {
    return (
      state.grant !== null &&
      cmd.sessionKey === state.grant.sessionKey &&
      cmd.grantId === state.grant.grantId
    );
  }

  function isLeaseLive(at) {
    return state.grant !== null && (at === undefined ? now() : at) < state.grant.leaseExpiresAt;
  }

  /** Companion-side auth gate: every execute requires live matching grant. */
  function checkExecute(cmd, at, inst) {
    if (state.grant === null) return err('chrome_locked', 'user-chrome control locked', false);
    if (!grantMatches(cmd)) return err('chrome_revoked', 'grant mismatch or revoked', false);
    // Paired-token + target binding: enforced once paired via /register.
    if (isNonEmptyString(state.bridgeToken) && cmd.bridgeToken !== state.bridgeToken) {
      return err('chrome_revoked', 'bridge token mismatch', false);
    }
    if (inst && isNonEmptyString(inst.instanceId) && cmd.targetInstanceId !== inst.instanceId) {
      return err('chrome_revoked', 'command targeted at another companion', false);
    }
    if (!isLeaseLive(at)) return err('chrome_revoked', 'grant lease expired', true);
    return null;
  }

  function onAuthorize(cmd, inst) {
    // Never accept a grant that is not addressed to this instance or stamped
    // with the paired session token: any local process can reach loopback.
    if (isNonEmptyString(state.bridgeToken) && cmd.bridgeToken !== state.bridgeToken) {
      throw new Error('chrome_revoked: bridge token mismatch');
    }
    if (inst && isNonEmptyString(inst.instanceId) && cmd.targetInstanceId !== inst.instanceId) {
      throw new Error('chrome_revoked: authorize targeted at another companion');
    }
    var leaseExpiresAt = Math.min(cmd.leaseExpiresAt, now() + LEASE_MAX_MS);
    state.grant = { sessionKey: cmd.sessionKey, grantId: cmd.grantId, leaseExpiresAt: leaseExpiresAt };
    return { ok: true };
  }

  function onRenew(cmd) {
    if (!grantMatches(cmd)) return { ok: false, error: err('chrome_revoked', 'grant mismatch or revoked', false) };
    if (isNonEmptyString(state.bridgeToken) && cmd.bridgeToken !== state.bridgeToken) {
      return { ok: false, error: err('chrome_revoked', 'bridge token mismatch', false) };
    }
    state.grant.leaseExpiresAt = Math.min(cmd.leaseExpiresAt, now() + LEASE_MAX_MS);
    return { ok: true };
  }

  function ownedMatches(tabId) {
    return state.owned !== null && state.owned.tabId === tabId;
  }

  /**
   * Tab-scoped DNR rules: deny-all default (priority 1) + exact-host allow
   * for http/https over the frozen hostname (priority 2). Applied to the
   * owned tab only, before navigation; DNR failure aborts navigation.
   */
  function buildDnrRules(frozenHostname, tabId, ruleBase) {
    var base = typeof ruleBase === 'number' ? ruleBase : ruleBaseForTab(tabId);
    var host = String(frozenHostname).toLowerCase();
    var escaped = host.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return [
      {
        id: base,
        priority: 1,
        action: { type: 'block' },
        condition: { urlFilter: '*', tabIds: [tabId], resourceTypes: ['main_frame', 'sub_frame', 'xmlhttprequest', 'websocket', 'script', 'image', 'stylesheet', 'media', 'font', 'other'] },
      },
      {
        id: base + 1,
        priority: 2,
        action: { type: 'allow' },
        condition: { regexFilter: '^https?://' + escaped + '(:[0-9]+)?([/?#]|$)', tabIds: [tabId] },
      },
    ];
  }

  function redactSecrets(text, secrets) {
    var out = String(text);
    var list = [];
    if (secrets) {
      if (isNonEmptyString(secrets.sessionKey)) list.push(secrets.sessionKey);
      if (isNonEmptyString(secrets.grantId)) list.push(secrets.grantId);
      if (isNonEmptyString(secrets.nonce)) list.push(secrets.nonce);
      if (Array.isArray(secrets.typedValues)) {
        for (var i = 0; i < secrets.typedValues.length; i++) {
          if (typeof secrets.typedValues[i] === 'string' && secrets.typedValues[i].length >= 3) list.push(secrets.typedValues[i]);
        }
      }
    }
    for (var j = 0; j < list.length; j++) {
      out = out.split(list[j]).join(REDACTED);
    }
    return out
      .replace(/(cookie|set-cookie)(\s*[:=]\s*)([^\s;,\n]+)/gi, '$1$2' + REDACTED)
      .replace(/(authorization)(\s*[:=]\s*)([^\n]+)/gi, '$1$2' + REDACTED)
      .replace(/\b(bearer)\s+([A-Za-z0-9\-.~_+/=]+)/gi, '$1 ' + REDACTED)
      .replace(/[A-Za-z0-9+/]{200,}={0,2}/g, REDACTED);
  }

  function chromeApi() {
    var c = globalThis.chrome;
    if (!c) throw new Error('chrome_extension_unavailable: chrome API unavailable');
    return c;
  }

  /** Create the Atlas-owned inactive tab; new unfocused window only if none. */
  async function ensureOwnedTab(chrome, frozenHostname, sessionKey, grantId) {
    if (state.owned !== null && state.owned.sessionKey === sessionKey && state.owned.grantId === grantId) {
      try {
        var existing = await chrome.tabs.get(state.owned.tabId);
        if (existing && existing.id === state.owned.tabId) return state.owned;
      } catch (e) {
        state.owned = null;
      }
    }
    // Never adopt: only Atlas-created tabs are tracked; existing tabs unadoptable.
    var tab;
    try {
      tab = await chrome.tabs.create({ active: false, url: 'about:blank' });
    } catch (e) {
      var win = await chrome.windows.create({ focused: false, url: 'about:blank' });
      var tabs = win && win.tabs ? win.tabs : [];
      tab = tabs[0];
      if (!tab || typeof tab.id !== 'number') throw new Error('chrome_no_owned_tab: could not create owned tab');
      // Close any extra tabs the window creation implies? No: never close unknown tabs.
    }
    state.owned = { tabId: tab.id, frozenHostname: frozenHostname, sessionKey: sessionKey, grantId: grantId };
    try {
      await chrome.storage.session.set({ atlasOwnedTab: state.owned });
    } catch (e) {
      // storage best-effort; ownership lives in memory regardless.
    }
    return state.owned;
  }

  async function applyDnr(chrome, rules) {
    try {
      await chrome.declarativeNetRequest.updateDynamicRules({
        removeRuleIds: rules.map(function (r) { return r.id; }),
        addRules: rules,
      });
    } catch (e) {
      throw new Error('chrome_policy_failure: DNR install failed, navigation aborted');
    }
  }

  async function removeDnrRules(chrome, ruleIds) {
    try {
      await chrome.declarativeNetRequest.updateDynamicRules({ removeRuleIds: ruleIds, addRules: [] });
    } catch (e) {
      // best-effort
    }
  }

  async function removeAllowRules(chrome, ruleBase, tabId) {
    var base = typeof ruleBase === 'number' ? ruleBase : ruleBaseForTab(tabId);
    try {
      // Retain deny-all for orphans; remove only the allow rule.
      await chrome.declarativeNetRequest.updateDynamicRules({ removeRuleIds: [base + 1], addRules: [] });
    } catch (e) {
      // best-effort
    }
  }

  function cdpSend(chrome, tabId, method, params, timeoutMs) {
    return new Promise(function (resolve, reject) {
      var done = false;
      var timer = setTimeout(function () {
        if (!done) {
          done = true;
          reject(new Error('chrome_timeout: CDP ' + method + ' timed out'));
        }
      }, timeoutMs || 5000);
      chrome.debugger.sendCommand({ tabId: tabId }, method, params || {}, function (result) {
        if (done) return;
        done = true;
        clearTimeout(timer);
        var lastError = chrome.runtime && chrome.runtime.lastError;
        if (lastError) {
          reject(new Error('chrome_invalid_result: CDP ' + method + ' failed: ' + lastError.message));
          return;
        }
        resolve(result);
      });
    });
  }

  function debuggerAttach(chrome, tabId) {
    return new Promise(function (resolve, reject) {
      chrome.debugger.attach({ tabId: tabId }, '1.3', function () {
        var lastError = chrome.runtime && chrome.runtime.lastError;
        if (lastError) {
          reject(new Error('chrome_debugger_conflict: debugger attach failed: ' + lastError.message));
          return;
        }
        resolve();
      });
    });
  }

  function debuggerDetachBestEffort(chrome, tabId) {
    return new Promise(function (resolve) {
      try {
        chrome.debugger.detach({ tabId: tabId }, function () { resolve(); });
      } catch (e) {
        resolve();
      }
    });
  }

  async function queryNode(chrome, tabId, selector) {
    var doc = await cdpSend(chrome, tabId, 'DOM.getDocument', { depth: 1 });
    var root = doc && doc.root && doc.root.nodeId;
    if (typeof root !== 'number') throw new Error('chrome_invalid_result: no DOM root');
    var found = await cdpSend(chrome, tabId, 'DOM.querySelector', { nodeId: root, selector: selector });
    if (!found || typeof found.nodeId !== 'number' || found.nodeId === 0) {
      throw new Error('chrome_invalid_result: selector not found: ' + String(selector).slice(0, 120));
    }
    return found.nodeId;
  }

  async function clickNode(chrome, tabId, nodeId) {
    var box = await cdpSend(chrome, tabId, 'DOM.getBoxModel', { nodeId: nodeId });
    var quad = box && box.model && (box.model.content || box.model.border);
    if (!Array.isArray(quad) || quad.length < 2) throw new Error('chrome_invalid_result: element has no geometry');
    var x = Math.round((quad[0] + quad[2]) / 2);
    var y = Math.round((quad[1] + quad[5]) / 2);
    await cdpSend(chrome, tabId, 'Input.dispatchMouseEvent', { type: 'mousePressed', x: x, y: y, button: 'left', clickCount: 1 });
    await cdpSend(chrome, tabId, 'Input.dispatchMouseEvent', { type: 'mouseReleased', x: x, y: y, button: 'left', clickCount: 1 });
  }

  async function focusNode(chrome, tabId, nodeId) {
    await cdpSend(chrome, tabId, 'DOM.focus', { nodeId: nodeId });
  }

  /** Execute one closed-union operation against the owned tab only. */
  async function dispatchOperation(chrome, cmd, fetchImpl, inst, signal) {
    var op = cmd.operation;
    // Direct-dispatch gate mirrors the pollLoop pre-check (tests call here directly).
    var direct = checkExecute(cmd, undefined, inst);
    if (direct !== null) throw new Error(direct.code + ': ' + direct.message);
    throwIfCancelled(signal);
    var tabId;
    if (op.kind === 'tabs') {
      if (state.owned === null) return { tabs: [] };
      try {
        var t = await chrome.tabs.get(state.owned.tabId);
        return { tabs: [{ id: t.id, url: t.url, title: t.title }] };
      } catch (e) {
        return { tabs: [] };
      }
    }
    if (op.kind === 'close') {
      if (state.owned === null) throw new Error('chrome_no_owned_tab: no Atlas-owned tab');
      var ownedId = state.owned.tabId;
      var ruleBase = ruleBaseForTab(ownedId);
      await debuggerDetachBestEffort(chrome, ownedId);
      await chrome.tabs.remove(ownedId);
      await removeDnrRules(chrome, [ruleBase, ruleBase + 1]);
      state.owned = null;
      try {
        await chrome.storage.session.remove('atlasOwnedTab');
      } catch (e) {}
      return { closed: true };
    }
    if (op.kind === 'navigate') {
      if (!isNonEmptyString(op.url) || !isNonEmptyString(op.frozenHostname)) {
        throw new Error('chrome_invalid_request: navigate needs url + frozenHostname');
      }
      throwIfCancelled(signal);
      var owned = await ensureOwnedTab(chrome, op.frozenHostname.toLowerCase(), cmd.sessionKey, cmd.grantId);
      tabId = owned.tabId;
      var rules = buildDnrRules(op.frozenHostname.toLowerCase(), tabId, ruleBaseForTab(tabId));
      throwIfCancelled(signal);
      await applyDnr(chrome, rules);
      throwIfCancelled(signal);
      try {
        await chrome.tabs.update(tabId, { url: op.url });
      } catch (e) {
        throw new Error('chrome_domain_blocked: navigation rejected: ' + String((e && e.message) || e).slice(0, 200));
      }
      return { navigated: true };
    }
    // All remaining ops require an existing owned tab; never fall back to active tab.
    if (state.owned === null) throw new Error('chrome_no_owned_tab: no Atlas-owned tab');
    throwIfCancelled(signal);
    tabId = state.owned.tabId;
    switch (op.kind) {
      case 'snapshot': {
        var injected = await chrome.scripting.executeScript({
          target: { tabId: tabId },
          world: 'ISOLATED',
          files: ['snapshot_injected.js'],
        }).catch(function () { return null; });
        void injected;
        var results = await chrome.scripting.executeScript({
          target: { tabId: tabId },
          world: 'ISOLATED',
          func: function (compact) { return globalThis.__atlasSnapshot(compact); },
          args: [op.compact === true],
        });
        var first = results && results[0] && results[0].result;
        if (typeof first !== 'string') throw new Error('chrome_invalid_result: snapshot returned no text');
        return { snapshot: redactSecrets(first, { sessionKey: cmd.sessionKey, grantId: cmd.grantId }) };
      }
      case 'text': {
        var textResults = await chrome.scripting.executeScript({
          target: { tabId: tabId },
          world: 'ISOLATED',
          func: function () {
            try {
              return (globalThis.document && globalThis.document.body && globalThis.document.body.innerText) || '';
            } catch (e) {
              return '';
            }
          },
          args: [],
        });
        var text = textResults && textResults[0] && textResults[0].result;
        if (typeof text !== 'string') throw new Error('chrome_invalid_result: text returned no text');
        return { text: redactSecrets(text, { sessionKey: cmd.sessionKey, grantId: cmd.grantId }) };
      }
      case 'screenshot': {
        // CDP capture only; no captureVisibleTab fallback (would capture active tab).
        await debuggerAttach(chrome, tabId);
        try {
          var shot = await cdpSend(chrome, tabId, 'Page.captureScreenshot', { format: 'png', fromSurface: true });
          if (!shot || typeof shot.data !== 'string' || shot.data.length === 0) {
            throw new Error('chrome_invalid_result: screenshot returned no data');
          }
          return { screenshotBase64: shot.data };
        } finally {
          await debuggerDetachBestEffort(chrome, tabId);
        }
      }
      case 'click':
      case 'type':
      case 'fill':
      case 'select':
      case 'scroll': {
        throwIfCancelled(signal);
        await debuggerAttach(chrome, tabId);
        try {
          if (op.kind === 'scroll') {
            if (typeof op.x !== 'number' || typeof op.y !== 'number') {
              throw new Error('chrome_invalid_request: scroll needs numeric x/y');
            }
            await cdpSend(chrome, tabId, 'Input.dispatchMouseEvent', { type: 'mouseWheel', x: 100, y: 100, deltaX: op.x, deltaY: op.y });
            return { scrolled: true };
          }
          if (!isNonEmptyString(op.selector)) throw new Error('chrome_invalid_request: selector required');
          throwIfCancelled(signal);
          var nodeId = await queryNode(chrome, tabId, op.selector);
          throwIfCancelled(signal);
          if (op.kind === 'click') {
            await clickNode(chrome, tabId, nodeId);
            return { clicked: true };
          }
          if (op.kind === 'type' || op.kind === 'fill') {
            if (typeof op.text !== 'string' || op.text.length === 0) {
              throw new Error('chrome_invalid_request: text required');
            }
            throwIfCancelled(signal);
            await focusNode(chrome, tabId, nodeId);
            throwIfCancelled(signal);
            if (op.kind === 'fill') {
              await cdpSend(chrome, tabId, 'Input.dispatchKeyEvent', { type: 'keyDown', modifiers: 2, key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65 });
              await cdpSend(chrome, tabId, 'Input.dispatchKeyEvent', { type: 'keyUp', modifiers: 2, key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65 });
            }
            await cdpSend(chrome, tabId, 'Input.insertText', { text: op.text });
            // Typed values reach the page payload but are never echoed back.
            return { typed: true };
          }
          // select
          if (!Array.isArray(op.values) || op.values.length === 0) {
            throw new Error('chrome_invalid_request: select needs non-empty values');
          }
          await cdpSend(chrome, tabId, 'DOM.setAttributeValue', { nodeId: nodeId, name: 'data-atlas-selected', value: op.values.join(',') });
          await focusNode(chrome, tabId, nodeId);
          for (var si = 0; si < op.values.length; si++) {
            await cdpSend(chrome, tabId, 'Input.insertText', { text: String(op.values[si]) });
          }
          return { selected: true };
        } finally {
          await debuggerDetachBestEffort(chrome, tabId);
        }
      }
      case 'wait': {
        var waitMs = typeof op.waitMs === 'number' && Number.isFinite(op.waitMs) ? Math.min(Math.max(op.waitMs, 0), WAIT_MAX_MS) : 0;
        var deadline = Date.now() + waitMs;
        if (isNonEmptyString(op.selector)) {
          await debuggerAttach(chrome, tabId);
          try {
            for (;;) {
              throwIfCancelled(signal);
              try {
                await queryNode(chrome, tabId, op.selector);
                break;
              } catch (e) {
                if (Date.now() >= deadline) throw new Error('chrome_timeout: wait selector not found');
                await new Promise(function (r) { setTimeout(r, 100); });
              }
            }
          } finally {
            await debuggerDetachBestEffort(chrome, tabId);
          }
          return { waited: true };
        }
        throwIfCancelled(signal);
        if (waitMs > 0) await new Promise(function (r) { setTimeout(r, waitMs); });
        throwIfCancelled(signal);
        void deadline;
        return { waited: true };
      }
      case 'get_url': {
        var tab = await chrome.tabs.get(tabId);
        return { url: tab.url || '' };
      }
      case 'get_title': {
        var tab2 = await chrome.tabs.get(tabId);
        return { title: tab2.title || '' };
      }
      case 'semantic_action': {
        var req = op.request || {};
        if (!isNonEmptyString(req.locator) || !isNonEmptyString(req.query) || !isNonEmptyString(req.verb)) {
          throw new Error('chrome_invalid_request: semantic_action needs locator/query/verb');
        }
        await debuggerAttach(chrome, tabId);
        try {
          var semNode = await queryNode(chrome, tabId, req.locator);
          var verb = String(req.verb).toLowerCase();
          if (verb === 'click' || verb === 'press') {
            await clickNode(chrome, tabId, semNode);
            return { semantic: 'clicked' };
          }
          if (verb === 'type' || verb === 'fill' || verb === 'input') {
            if (typeof req.value !== 'string' || req.value.length === 0) {
              throw new Error('chrome_invalid_request: semantic type needs value');
            }
            await focusNode(chrome, tabId, semNode);
            await cdpSend(chrome, tabId, 'Input.insertText', { text: req.value });
            return { semantic: 'typed' };
          }
          if (verb === 'scroll') {
            await cdpSend(chrome, tabId, 'Input.dispatchMouseEvent', { type: 'mouseWheel', x: 100, y: 100, deltaX: 0, deltaY: 300 });
            return { semantic: 'scrolled' };
          }
          throw new Error('chrome_invalid_request: unsupported semantic verb ' + String(req.verb).slice(0, 32));
        } finally {
          await debuggerDetachBestEffort(chrome, tabId);
        }
      }
      default:
        throw new Error('chrome_invalid_request: unsupported operation ' + String(op.kind).slice(0, 64));
    }
    void fetchImpl;
  }

  /** Revoke: sync local invalidate, purge ownership + typed buffers, detach, close owned tab only.
   * Typed values are never retained: operation payloads live only on the
   * in-flight command object and are unreachable after dispatch/revoke. */
  async function revokeLocal(chrome, ruleBase) {
    state.grant = null;
    var owned = state.owned;
    state.owned = null;
    if (!chrome) return;
    if (owned !== null) {
      var base = typeof ruleBase === 'number' ? ruleBase : ruleBaseForTab(owned.tabId);
      await debuggerDetachBestEffort(chrome, owned.tabId);
      try {
        // Only Atlas-created tabs are closable; never windows.remove.
        await chrome.tabs.remove(owned.tabId);
        await removeDnrRules(chrome, [base, base + 1]);
      } catch (e) {
        // Orphan: keep deny-all, drop allow rule so it cannot reach new hosts.
        await removeAllowRules(chrome, base);
      }
      try {
        await chrome.storage.session.remove('atlasOwnedTab');
      } catch (e) {}
    }
  }

  function resultEnvelope(cmd, data) {
    return { protocol: PROTOCOL, id: cmd.id, ok: true, data: data };
  }

  function errorEnvelope(cmdOrId, e) {
    var id = typeof cmdOrId === 'string' ? cmdOrId : cmdOrId.id;
    var message = String((e && e.message) || e || 'failed');
    var code = 'chrome_invalid_result';
    var m = /^([a-z_]+):/.exec(message);
    if (m && OPERATION_KINDS.indexOf(m[1]) === -1) {
      // error-code prefix passthrough for known codes
      var known = ['chrome_locked', 'chrome_revoked', 'chrome_extension_unavailable', 'chrome_version_mismatch', 'chrome_domain_blocked', 'chrome_no_owned_tab', 'chrome_timeout', 'chrome_invalid_request', 'chrome_invalid_result', 'chrome_debugger_conflict', 'chrome_policy_failure'];
      if (known.indexOf(m[1]) !== -1) code = m[1];
    }
    var clean = message.replace(/^[a-z_]+:\s*/, '').slice(0, 500);
    var retryable = code === 'chrome_timeout' || code === 'chrome_extension_unavailable';
    return { protocol: PROTOCOL, id: id, ok: false, error: { code: code, message: clean, retryable: retryable } };
  }

  function sleep(ms, signal) {
    return new Promise(function (resolve, reject) {
      if (signal && signal.aborted) {
        reject(new Error('aborted'));
        return;
      }
      var t = setTimeout(function () { cleanup(); resolve(); }, ms);
      function onAbort() { clearTimeout(t); cleanup(); reject(new Error('aborted')); }
      function cleanup() { if (signal && signal.removeEventListener) signal.removeEventListener('abort', onAbort); }
      if (signal && signal.addEventListener) signal.addEventListener('abort', onAbort);
    });
  }

  /** Canonical poll URL: GET /next with anonymous instance claims in query.
   * Never carries sessionKey/grantId (dual grant travels in commands only). */
  function buildNextUrl(timeoutMs, inst) {
    var q = 'timeoutMs=' + encodeURIComponent(String(timeoutMs));
    q += '&protocol=' + encodeURIComponent(String(PROTOCOL));
    if (inst && inst.instanceId) {
      q += '&instanceId=' + encodeURIComponent(String(inst.instanceId));
      q += '&family=' + encodeURIComponent(String(inst.family || ''));
      q += '&version=' + encodeURIComponent(String(inst.version || ''));
      q += '&caps=' + encodeURIComponent('closed-union-v1');
    }
    return BRIDGE_URL + '/next?' + q;
  }

  function resultUrl(inst) {
    // Full anonymous claim so the bridge heartbeat path registers on POST /result
    // too (bridge ignores malformed claims here, never blocks delivery).
    if (inst && inst.instanceId) {
      var q = 'instanceId=' + encodeURIComponent(String(inst.instanceId));
      q += '&protocol=' + encodeURIComponent(String(PROTOCOL));
      q += '&family=' + encodeURIComponent(String(inst.family || ''));
      q += '&version=' + encodeURIComponent(String(inst.version || ''));
      q += '&caps=' + encodeURIComponent('closed-union-v1');
      return BRIDGE_URL + '/result?' + q;
    }
    return BRIDGE_URL + '/result';
  }

  function registerUrl() {
    return BRIDGE_URL + '/register';
  }

  /** Long-poll loop against the Pi-side bridge (Worker 2 owns the server). */
  async function pollLoop(deps) {
    deps = deps || {};
    var fetchImpl = deps.fetchImpl || globalThis.fetch;
    var chrome = deps.chrome || globalThis.chrome;
    if (!fetchImpl) throw new Error('chrome_extension_unavailable: fetch unavailable');
    if (state.polling) return;
    state.polling = true;
    if (chrome && chrome.storage && chrome.storage.session) {
      try { await heartbeatInstance(chrome); } catch (e) {}
    }
    try {
      for (;;) {
        var next;
        var inst = null;
        if (chrome && chrome.storage && chrome.storage.session) {
          try { inst = await ensureInstance(chrome); } catch (e) { inst = null; }
        }
        // Pair the session token before polling so routed commands verify.
        // Re-pair when unpaired or the last attempt is stale: a bridge restart
        // rotates the session token and orphans a token-paired companion.
        if ((state.bridgeToken === null || now() - state.lastRegisterAttempt > REGISTER_RETRY_MS) && typeof fetch === 'function') {
          try { await registerCompanion(fetchImpl, chrome, inst); } catch (e) {}
        }
        try {
          var res = await fetchImpl(buildNextUrl(COMMAND_TIMEOUT_MS, inst), {
            method: 'GET',
            signal: deps.signal,
          });
          if (res.status === 204) {
            next = null;
          } else if (!res.ok) {
            await new Promise(function (r) { setTimeout(r, 2000); });
            continue;
          } else {
            next = await res.json();
          }
        } catch (e) {
          if (deps.signal && deps.signal.aborted) return;
          await new Promise(function (r) { setTimeout(r, 2000); });
          continue;
        }
        if (!next || next.none === true || next === null) {
          if (chrome && chrome.storage && chrome.storage.session) {
            try { await heartbeatInstance(chrome); } catch (e) {}
          }
          await sleep(deps.idleMs === undefined ? POLL_MS : deps.idleMs, deps.signal);
          continue;
        }
        var cmd;
        try {
          cmd = parseCommand(next);
        } catch (e) {
          continue;
        }
        var out;
        try {
          // Routing pre-check: never execute a command addressed to another
          // companion or stamped with a foreign session token. Fail closed
          // with an error result so the Pi waiter rejects instead of hanging.
          var routeError = null;
          if (inst && isNonEmptyString(inst.instanceId) && cmd.targetInstanceId !== inst.instanceId) {
            routeError = err('chrome_revoked', 'command targeted at another companion', false);
          } else if (isNonEmptyString(state.bridgeToken) && cmd.bridgeToken !== state.bridgeToken) {
            // Stale token (bridge restarted): drop it so the next loop
            // iteration re-registers instead of failing closed forever.
            state.bridgeToken = null;
            routeError = err('chrome_revoked', 'bridge token mismatch', false);
          }
          if (routeError !== null) {
            out = { protocol: PROTOCOL, id: cmd.id, ok: false, error: routeError };
          } else if (cmd.kind === 'authorize') out = resultEnvelope(cmd, onAuthorize(cmd, inst));
          else if (cmd.kind === 'renew') {
            var r = onRenew(cmd);
            out = r.ok ? resultEnvelope(cmd, {}) : { protocol: PROTOCOL, id: cmd.id, ok: false, error: r.error };
          } else if (cmd.kind === 'revoke') {
            await revokeLocal(chrome);
            out = resultEnvelope(cmd, { revoked: true });
          } else {
            var gate = checkExecute(cmd, now(), inst);
            if (gate) {
              out = { protocol: PROTOCOL, id: cmd.id, ok: false, error: gate };
            } else {
              // Cooperative cancellation: the timeout only rejects the race,
              // so mark the signal and let dispatchOperation refuse further
              // browser mutations once the deadline passes.
              var opSignal = { aborted: false };
              var opTimer = null;
              var opPromise = dispatchOperation(chrome, cmd, fetchImpl, inst, opSignal);
              var timeoutPromise = new Promise(function (_, reject) {
                opTimer = setTimeout(function () { opSignal.aborted = true; reject(new Error('chrome_timeout: operation timed out')); }, COMMAND_TIMEOUT_MS);
              });
              try {
                var data = await Promise.race([opPromise, timeoutPromise]);
                out = resultEnvelope(cmd, data);
              } finally {
                if (opTimer !== null) clearTimeout(opTimer);
                opSignal.aborted = true;
              }
            }
          }
        } catch (e) {
          out = errorEnvelope(cmd, e);
        }
        try {
          await fetchImpl(resultUrl(inst), {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(out),
          });
        } catch (e) {
          // best-effort result delivery
        }
      }

    } finally {
      state.polling = false;
    }
  }

  /** Start the grant long-poll loop (idempotent; second call returns immediately). */
  function startPolling(chrome, fetchImpl) {
    pollLoop({ chrome: chrome, fetchImpl: fetchImpl }).catch(function () {});
  }

  var companion = {
    PROTOCOL: PROTOCOL,
    BRIDGE_URL: BRIDGE_URL,
    LEASE_MAX_MS: LEASE_MAX_MS,
    OPERATION_KINDS: OPERATION_KINDS,
    _state: state,
    parseCommand: parseCommand,
    checkExecute: checkExecute,
    isLeaseLive: isLeaseLive,
    onAuthorize: onAuthorize,
    onRenew: onRenew,
    buildDnrRules: buildDnrRules,
    redactSecrets: redactSecrets,
    ensureOwnedTab: ensureOwnedTab,
    applyDnr: applyDnr,
    removeAllowRules: removeAllowRules,
    dispatchOperation: dispatchOperation,
    revokeLocal: revokeLocal,
    removeDnrRules: removeDnrRules,
    ruleBaseForTab: ruleBaseForTab,
    normalizeVersion: normalizeVersion,
    ownExtensionId: ownExtensionId,
    INSTANCE_KEY: INSTANCE_KEY,
    POLL_MS: POLL_MS,
    COMMAND_TIMEOUT_MS: COMMAND_TIMEOUT_MS,
    WAIT_MAX_MS: WAIT_MAX_MS,
    REGISTER_RETRY_MS: REGISTER_RETRY_MS,
    throwIfCancelled: throwIfCancelled,
    detectFamily: detectFamily,
    ensureInstance: ensureInstance,
    heartbeatInstance: heartbeatInstance,
    registerCompanion: registerCompanion,
    buildNextUrl: buildNextUrl,
    resultUrl: resultUrl,
    startPolling: startPolling,
    resultEnvelope: resultEnvelope,
    errorEnvelope: errorEnvelope,
    pollLoop: pollLoop,
    _reset: function () {
      state.grant = null;
      state.owned = null;
      state.polling = false;
      state.bridgeToken = null;
      state.lastRegisterAttempt = 0;
    },
  };

  globalThis.__atlasCompanion = companion;

  // Start the poll loop immediately in a real extension worker (service workers
  // suspend; listeners alone would leave the loop dead after a restart). Only
  // when chrome.runtime.id exists so unit tests loading this file stay inert.
  function autostartIfExtensionWorker() {
    try {
      var c = globalThis.chrome;
      if (c && c.runtime && typeof c.runtime.id === 'string' && c.runtime.id.length > 0) {
        try { startPolling(c); } catch (e) {}
      }
    } catch (e) {}
  }
  autostartIfExtensionWorker();

  // Register worker listeners only where the chrome API exists.
  try {
    var c = globalThis.chrome;
    if (c && c.runtime && typeof c.runtime.onInstalled === 'object') {
      c.runtime.onInstalled.addListener(function () {
        // Ephemeral session state only (cleared on browser/extension restart).
        try {
          if (c.storage && c.storage.session && typeof c.storage.session.get === 'function') {
            c.storage.session.get('atlasOwnedTab').then(function (v) {
              if (v && v.atlasOwnedTab && typeof v.atlasOwnedTab.tabId === 'number') {
                state.owned = v.atlasOwnedTab;
              }
            }).catch(function () {});
          }
        } catch (e) {}
        try { startPolling(c); } catch (e) {}
      });
    }
    if (c && c.runtime && c.runtime.onStartup && typeof c.runtime.onStartup.addListener === 'function') {
      c.runtime.onStartup.addListener(function () {
        // storage.session is empty after restart: poll loop registers a fresh ephemeral instance.
        try { startPolling(c); } catch (e) {}
      });
    }
    if (c && c.alarms && typeof c.alarms.create === 'function') {
      try {
        c.alarms.create('atlas-lease', { periodInMinutes: 0.5 });
        c.alarms.onAlarm.addListener(function (alarm) {
          if (!alarm || alarm.name !== 'atlas-lease') return;
          try {
            if (c.storage && c.storage.session) heartbeatInstance(c).catch(function () {});
          } catch (e) {}
          if (state.grant !== null && !isLeaseLive(now())) {
            revokeLocal(c).catch(function () {});
          }
        });
      } catch (e) {}
    }
  } catch (e) {
    // Non-Chrome runtimes (tests) skip listener registration.
  }
})();
