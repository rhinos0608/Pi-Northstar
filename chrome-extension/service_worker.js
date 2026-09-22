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
  var RULEBASE_KEY = 'atlasRuleBase';
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
    pairingSecret: null, // pre-seeded or bridge-minted pairing secret; sent on every steady-state bridge request
    bridgeToken: null, // session token paired via POST /register (pinned origin + pairing secret)
    lastRegisterAttempt: 0, // epoch ms of last POST /register attempt
    owned: null, // { tabId, frozenHostname, sessionKey, grantId }
    polling: false,
  };
  // Re-pair interval when unpaired or the token goes stale. The disconnected
  // poll path already retries loopback every ~2s, so matching that cadence
  // avoids a 60s first-use stall without introducing a new polling rhythm.
  var REGISTER_RETRY_MS = 2_000;
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
   * Monotonic counter with a tabId map: distinct tabs get distinct bases
   * (modulo hashing collides, e.g. tab 11 vs 2011); same tab reuses its
   * base so reinstall overwrites instead of leaking. */
  var ruleBaseNext = 1000;
  var ruleBaseByTab = {};
  /** Best-effort persist of DNR base allocation so a restart reuses bases
   * instead of colliding with live dynamic rules. */
  function persistRuleBase(chrome) {
    try {
      if (chrome && chrome.storage && chrome.storage.session && typeof chrome.storage.session.set === 'function') {
        var put = {};
        put[RULEBASE_KEY] = { next: ruleBaseNext, byTab: ruleBaseByTab };
        var p = chrome.storage.session.set(put);
        if (p && typeof p.catch === 'function') p.catch(function () {});
      }
    } catch (e) {}
  }
  /** Restore DNR base allocation on startup; malformed entries fail closed
   * to the compiled default. */
  async function restoreRuleBase(chrome) {
    try {
      if (!chrome || !chrome.storage || !chrome.storage.session || typeof chrome.storage.session.get !== 'function') return;
      var got = await chrome.storage.session.get(RULEBASE_KEY);
      var cur = got && got[RULEBASE_KEY];
      if (!cur || typeof cur.next !== 'number' || !Number.isFinite(cur.next)) return;
      if (!cur.byTab || typeof cur.byTab !== 'object' || Array.isArray(cur.byTab)) return;
      var next = Math.trunc(cur.next);
      if (next < 1000) return;
      var map = {};
      for (var k in cur.byTab) {
        if (!Object.prototype.hasOwnProperty.call(cur.byTab, k)) continue;
        var v = cur.byTab[k];
        if (typeof v === 'number' && Number.isFinite(v)) map[k] = Math.trunc(v);
      }
      ruleBaseNext = next;
      ruleBaseByTab = map;
    } catch (e) {}
  }
  function ruleBaseForTab(tabId) {
    var key = typeof tabId === 'number' && Number.isFinite(tabId) ? String(Math.trunc(tabId)) : '0';
    if (Object.prototype.hasOwnProperty.call(ruleBaseByTab, key)) return ruleBaseByTab[key];
    var base = ruleBaseNext;
    ruleBaseNext += 2;
    ruleBaseByTab[key] = base;
    persistRuleBase(globalThis.chrome);
    return base;
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

  /** Operator provisioning for the out-of-band pairing secret. Persisted
   *  best-effort in session storage so a worker restart stays paired. */
  var PAIRING_KEY = 'atlasPairingSecret';
  function setPairingSecret(secret) {
    state.pairingSecret = isNonEmptyString(secret) ? secret : null;
    try {
      var c = globalThis.chrome;
      if (c && c.storage && c.storage.session && typeof c.storage.session.set === 'function') {
        var put = {};
        put[PAIRING_KEY] = state.pairingSecret;
        var p = c.storage.session.set(put);
        if (p && typeof p.catch === 'function') p.catch(function () {});
      }
    } catch (e) {}
    return state.pairingSecret;
  }
  async function restorePairingSecret(chrome) {
    if (isNonEmptyString(state.pairingSecret)) return state.pairingSecret;
    try {
      if (!chrome || !chrome.storage || !chrome.storage.session || typeof chrome.storage.session.get !== 'function') return null;
      var got = await chrome.storage.session.get(PAIRING_KEY);
      var cur = got && got[PAIRING_KEY];
      if (isNonEmptyString(cur)) state.pairingSecret = cur;
    } catch (e) {}
    return state.pairingSecret;
  }
  /** Pair the bridge session token via POST /register. Steady-state requires
   *  pinned origin + pairing secret; the explicit /chrome-authorize window may
   *  mint the first secret. Best-effort: pollLoop retries while unpaired;
   *  commands fail closed against a foreign token once paired. Never logged. */
  async function registerCompanion(fetchImpl, chrome, inst, opts) {
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
    var timeoutMs = opts && typeof opts.timeoutMs === 'number' && Number.isFinite(opts.timeoutMs) ? opts.timeoutMs : 10_000;
    var outerSignal = opts && opts.signal ? opts.signal : null;
    var ctrl = null;
    var timer = null;
    var onOuterAbort = null;
    try {
      if (typeof AbortController !== 'undefined') {
        ctrl = new AbortController();
        if (outerSignal) {
          if (outerSignal.aborted === true) ctrl.abort();
          else if (typeof outerSignal.addEventListener === 'function') {
            onOuterAbort = function () { try { ctrl.abort(); } catch (e) {} };
            outerSignal.addEventListener('abort', onOuterAbort, { once: true });
          }
        }
        timer = setTimeout(function () { try { ctrl.abort(); } catch (e) {} }, timeoutMs);
      }
    } catch (e) {
      ctrl = null;
    }
    try {
      var res = await fetchImpl(registerUrl(), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        signal: ctrl ? ctrl.signal : (outerSignal || undefined),
        body: JSON.stringify({
          instanceId: record.instanceId,
          family: record.family,
          version: record.version,
          caps: record.evidence || '',
          pairingSecret: state.pairingSecret,
        }),
      });
      if (!res.ok) return null;
      var body = await res.json();
      // Zero-config TOFU bootstrap: the user-armed bridge may mint the pairing
      // secret on the first successful register. Persist it in session storage
      // before polling so every steady-state request is secret-gated.
      if (body && isNonEmptyString(body.pairingSecret)) {
        // A newly started zero-config bridge mints a new secret. Replace any
        // stale session-storage secret returned from the previous Pi bridge so
        // the next /next and /result requests authenticate to this owner.
        setPairingSecret(body.pairingSecret);
      }
      if (body && isNonEmptyString(body.bridgeToken)) {
        state.bridgeToken = body.bridgeToken;
        return body.bridgeToken;
      }
      return null;
    } catch (e) {
      return null;
    } finally {
      if (timer !== null) clearTimeout(timer);
      try {
        if (outerSignal && onOuterAbort && typeof outerSignal.removeEventListener === 'function') {
          outerSignal.removeEventListener('abort', onOuterAbort);
        }
      } catch (e) {}
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
    if (state.grant === null || !cmd) return false;
    if (!isNonEmptyString(cmd.sessionKey) || !isNonEmptyString(cmd.grantId)) return false;
    return (
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
    // A renewal may extend a live lease, but must never resurrect an expired one.
    if (!isLeaseLive(now())) {
      return { ok: false, error: err('chrome_revoked', 'grant lease expired', true) };
    }
    state.grant.leaseExpiresAt = Math.min(cmd.leaseExpiresAt, now() + LEASE_MAX_MS);
    return { ok: true };
  }

  function ownedMatches(tabId) {
    return state.owned !== null && state.owned.tabId === tabId;
  }

  function navigationMatchesFrozenHost(rawUrl, frozenHostname) {
    if (!isNonEmptyString(rawUrl) || !isNonEmptyString(frozenHostname)) return false;
    try {
      var parsed = new URL(rawUrl);
      var protocol = String(parsed.protocol || '').toLowerCase();
      if (protocol !== 'http:' && protocol !== 'https:') return false;
      var actual = String(parsed.hostname || '').toLowerCase().replace(/\.$/, '');
      var frozen = String(frozenHostname).trim().toLowerCase().replace(/\.$/, '');
      return actual.length > 0 && actual === frozen;
    } catch (e) {
      return false;
    }
  }

  // Keep this list in sync with Chrome's declarativeNetRequest.ResourceType
  // enum. Explicitly include main_frame because omitting resourceTypes excludes
  // top-level navigation from a rule's match set.
  var DNR_RESOURCE_TYPES = ['main_frame', 'sub_frame', 'stylesheet', 'script', 'image', 'font', 'object', 'xmlhttprequest', 'ping', 'csp_report', 'media', 'websocket', 'webtransport', 'webbundle', 'other'];

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
        condition: { urlFilter: '*', tabIds: [tabId], resourceTypes: DNR_RESOURCE_TYPES.slice() },
      },
      {
        id: base + 1,
        priority: 2,
        action: { type: 'allow' },
        condition: { regexFilter: '^https?://' + escaped + '(:[0-9]+)?([/?#]|$)', tabIds: [tabId], resourceTypes: DNR_RESOURCE_TYPES.slice() },
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

  async function forgetOwnedTab(chrome, owned, closeTab) {
    if (!owned || typeof owned.tabId !== 'number') return;
    var base = ruleBaseForTab(owned.tabId);
    if (state.owned !== null && state.owned.tabId === owned.tabId) state.owned = null;
    await debuggerDetachBestEffort(chrome, owned.tabId);
    if (closeTab === true) {
      try { await chrome.tabs.remove(owned.tabId); } catch (e) {}
    }
    await removeDnrRules(chrome, [base, base + 1]);
    try { await chrome.storage.session.remove(OWNED_KEY); } catch (e) {}
  }

  /** Create the Atlas-owned inactive tab; new unfocused window only if none. */
  async function ensureOwnedTab(chrome, frozenHostname, sessionKey, grantId) {
    if (state.owned !== null) {
      var sameGrant = state.owned.sessionKey === sessionKey && state.owned.grantId === grantId;
      if (sameGrant && state.owned.frozenHostname !== frozenHostname) {
        throw new Error('chrome_domain_blocked: frozen hostname cannot change within a grant');
      }
      if (!sameGrant) {
        // A new grant must not orphan authority from the prior grant.
        await forgetOwnedTab(chrome, state.owned, true);
      } else {
        try {
          var existing = await chrome.tabs.get(state.owned.tabId);
          if (existing && existing.id === state.owned.tabId) return state.owned;
        } catch (e) {}
        await forgetOwnedTab(chrome, state.owned, false);
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
      var ownedPut = {};
      ownedPut[OWNED_KEY] = state.owned;
      await chrome.storage.session.set(ownedPut);
    } catch (e) {
      // storage best-effort; ownership lives in memory regardless.
    }
    return state.owned;
  }

  async function discardStoredOwnedTab(chrome, owned) {
    // Verification failure means we cannot safely claim ownership. Retain the
    // deny rule but remove the allow rule so a stale/reused tab cannot keep
    // network authority under an unverifiable record.
    if (owned && typeof owned.tabId === 'number' && Number.isFinite(owned.tabId)) {
      var base = ruleBaseForTab(owned.tabId);
      await removeAllowRules(chrome, base, owned.tabId);
    }
    try {
      if (chrome.storage && chrome.storage.session) await chrome.storage.session.remove(OWNED_KEY);
    } catch (e) {}
  }

  async function restoreOwnedTab(chrome) {
    if (state.owned !== null) return state.owned;
    if (!chrome || !chrome.storage || !chrome.storage.session || typeof chrome.storage.session.get !== 'function') return null;
    var got;
    try {
      got = await chrome.storage.session.get(OWNED_KEY);
    } catch (e) {
      return null;
    }
    var owned = got && got[OWNED_KEY];
    if (!owned || typeof owned !== 'object' || Array.isArray(owned)) return null;
    if (
      typeof owned.tabId !== 'number' || !Number.isFinite(owned.tabId) ||
      !isNonEmptyString(owned.frozenHostname) ||
      !isNonEmptyString(owned.sessionKey) ||
      !isNonEmptyString(owned.grantId)
    ) {
      await discardStoredOwnedTab(chrome, owned);
      return null;
    }

    var tab;
    try {
      tab = await chrome.tabs.get(owned.tabId);
    } catch (e) {
      await discardStoredOwnedTab(chrome, owned);
      return null;
    }
    if (!tab || tab.id !== owned.tabId) {
      await discardStoredOwnedTab(chrome, owned);
      return null;
    }

    var currentUrl = isNonEmptyString(tab.pendingUrl) ? tab.pendingUrl : (isNonEmptyString(tab.url) ? tab.url : '');
    if (currentUrl !== 'about:blank' && !navigationMatchesFrozenHost(currentUrl, owned.frozenHostname)) {
      await discardStoredOwnedTab(chrome, owned);
      return null;
    }

    // tabIds are legal only in session-scoped DNR rules. Require both of our
    // tab-scoped rules before trusting persisted ownership after a worker wake.
    if (!chrome.declarativeNetRequest || typeof chrome.declarativeNetRequest.getSessionRules !== 'function') {
      await discardStoredOwnedTab(chrome, owned);
      return null;
    }
    var rules;
    try {
      rules = await chrome.declarativeNetRequest.getSessionRules();
    } catch (e) {
      await discardStoredOwnedTab(chrome, owned);
      return null;
    }
    var base = ruleBaseForTab(owned.tabId);
    var denySeen = false;
    var allowSeen = false;
    for (var i = 0; i < rules.length; i++) {
      var rule = rules[i];
      var ids = rule && rule.condition && rule.condition.tabIds;
      if (!Array.isArray(ids) || ids.indexOf(owned.tabId) === -1) continue;
      if (rule.id === base) denySeen = true;
      if (rule.id === base + 1) allowSeen = true;
    }
    if (!denySeen || !allowSeen) {
      await discardStoredOwnedTab(chrome, owned);
      return null;
    }

    state.owned = {
      tabId: owned.tabId,
      frozenHostname: String(owned.frozenHostname).toLowerCase(),
      sessionKey: owned.sessionKey,
      grantId: owned.grantId,
    };
    return state.owned;
  }

  async function applyDnr(chrome, rules) {
    try {
      await chrome.declarativeNetRequest.updateSessionRules({
        removeRuleIds: rules.map(function (r) { return r.id; }),
        addRules: rules,
      });
    } catch (e) {
      throw new Error('chrome_policy_failure: DNR install failed, navigation aborted');
    }
  }

  async function removeDnrRules(chrome, ruleIds) {
    try {
      await chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: ruleIds, addRules: [] });
    } catch (e) {
      // best-effort
    }
  }

  async function removeAllowRules(chrome, ruleBase, tabId) {
    var base = typeof ruleBase === 'number' ? ruleBase : ruleBaseForTab(tabId);
    try {
      // Retain deny-all for orphans; remove only the allow rule.
      await chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: [base + 1], addRules: [] });
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

  async function markSemanticTarget(chrome, tabId, req, marker) {
    var results = await chrome.scripting.executeScript({
      target: { tabId: tabId },
      world: 'ISOLATED',
      func: function (locator, query, name, index, exact, markerValue) {
        var attr = 'data-pi-atlas-semantic-target';
        var all = Array.from((globalThis.document && globalThis.document.querySelectorAll('*')) || []);
        for (var ci = 0; ci < all.length; ci++) {
          try { all[ci].removeAttribute(attr); } catch (e) {}
        }
        function norm(v) { return String(v == null ? '' : v).replace(/\s+/g, ' ').trim(); }
        function matches(value, expected) {
          var left = norm(value).toLowerCase();
          var right = norm(expected).toLowerCase();
          return exact === true ? left === right : left.indexOf(right) !== -1;
        }
        function roleOf(el) {
          var explicit = el.getAttribute && el.getAttribute('role');
          if (explicit) return norm(explicit).toLowerCase();
          var tag = String(el.tagName || '').toLowerCase();
          var type = norm(el.getAttribute && el.getAttribute('type')).toLowerCase();
          if (tag === 'textarea' || (tag === 'input' && ['text', 'search', 'email', 'url', 'tel', 'password', ''].indexOf(type) !== -1)) return 'textbox';
          if (el.getAttribute && el.getAttribute('contenteditable') === 'true') return 'textbox';
          if (tag === 'button' || (tag === 'input' && ['button', 'submit', 'reset'].indexOf(type) !== -1)) return 'button';
          if (tag === 'a' && el.getAttribute && el.getAttribute('href')) return 'link';
          if (tag === 'input' && type === 'checkbox') return 'checkbox';
          if (tag === 'input' && type === 'radio') return 'radio';
          if (tag === 'select') return 'combobox';
          return '';
        }
        function accessibleName(el) {
          var aria = el.getAttribute && el.getAttribute('aria-label');
          if (aria) return aria;
          var labelledBy = el.getAttribute && el.getAttribute('aria-labelledby');
          if (labelledBy && globalThis.document) {
            var parts = labelledBy.split(/\s+/).map(function (id) {
              var n = globalThis.document.getElementById(id);
              return n ? norm(n.textContent || '') : '';
            }).filter(Boolean);
            if (parts.length) return parts.join(' ');
          }
          try {
            if (el.labels && el.labels.length) {
              return Array.from(el.labels).map(function (label) { return norm(label.textContent || ''); }).filter(Boolean).join(' ');
            }
          } catch (e) {}
          return (el.getAttribute && (el.getAttribute('alt') || el.getAttribute('title') || el.getAttribute('placeholder'))) || norm(el.innerText || el.textContent || '');
        }
        var candidates = [];
        try {
          if (locator === 'role') {
            candidates = all.filter(function (el) {
              return roleOf(el) === norm(query).toLowerCase() && (!name || matches(accessibleName(el), name));
            });
          } else if (locator === 'text') {
            candidates = all.filter(function (el) { return matches(el.innerText || el.textContent || '', query); });
          } else if (locator === 'label') {
            candidates = all.filter(function (el) {
              try {
                return el.labels && Array.from(el.labels).some(function (label) { return matches(label.textContent || '', query); });
              } catch (e) { return false; }
            });
          } else if (locator === 'placeholder') {
            candidates = all.filter(function (el) { return matches(el.getAttribute && el.getAttribute('placeholder'), query); });
          } else if (locator === 'alt') {
            candidates = all.filter(function (el) { return matches(el.getAttribute && el.getAttribute('alt'), query); });
          } else if (locator === 'title') {
            candidates = all.filter(function (el) { return matches(el.getAttribute && el.getAttribute('title'), query); });
          } else if (locator === 'testid') {
            candidates = all.filter(function (el) {
              return matches(el.getAttribute && (el.getAttribute('data-testid') || el.getAttribute('data-test-id')), query);
            });
          } else if (locator === 'first' || locator === 'last' || locator === 'nth') {
            var selected = Array.from(globalThis.document.querySelectorAll(query));
            if (locator === 'first') candidates = selected.slice(0, 1);
            else if (locator === 'last') candidates = selected.slice(-1);
            else candidates = typeof index === 'number' && index >= 0 && index < selected.length ? [selected[index]] : [];
          }
        } catch (e) {
          candidates = [];
        }
        var target = candidates[0];
        if (!target) return false;
        try {
          target.setAttribute(attr, markerValue);
          return true;
        } catch (e) {
          return false;
        }
      },
      args: [req.locator, req.query, req.name || '', typeof req.index === 'number' ? req.index : null, req.exact === true, marker],
    });
    return Boolean(results && results[0] && results[0].result === true);
  }

  async function inspectSemanticTarget(chrome, tabId, marker) {
    var results = await chrome.scripting.executeScript({
      target: { tabId: tabId },
      world: 'ISOLATED',
      func: function (markerValue) {
        var attr = 'data-pi-atlas-semantic-target';
        var nodes = Array.from((globalThis.document && globalThis.document.querySelectorAll('[' + attr + ']')) || []);
        var target = nodes.find(function (node) { return node.getAttribute(attr) === markerValue; });
        if (!target) return { found: false, checked: false, text: '' };
        var ariaChecked = target.getAttribute && target.getAttribute('aria-checked');
        var checked = target.checked === true || ariaChecked === 'true';
        var value = typeof target.value === 'string' ? target.value : '';
        var text = String(target.innerText || target.textContent || value || '').replace(/\s+/g, ' ').trim();
        return { found: true, checked: checked, text: text };
      },
      args: [marker],
    });
    var state = results && results[0] && results[0].result;
    if (!state || state.found !== true) throw new Error('chrome_invalid_result: semantic target disappeared');
    return state;
  }

  async function clearSemanticTarget(chrome, tabId, marker) {
    try {
      await chrome.scripting.executeScript({
        target: { tabId: tabId },
        world: 'ISOLATED',
        func: function (markerValue) {
          var attr = 'data-pi-atlas-semantic-target';
          var nodes = Array.from((globalThis.document && globalThis.document.querySelectorAll('[' + attr + ']')) || []);
          for (var i = 0; i < nodes.length; i++) {
            if (nodes[i].getAttribute(attr) === markerValue) nodes[i].removeAttribute(attr);
          }
        },
        args: [marker],
      });
    } catch (e) {}
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

  async function hoverNode(chrome, tabId, nodeId) {
    var box = await cdpSend(chrome, tabId, 'DOM.getBoxModel', { nodeId: nodeId });
    var quad = box && box.model && (box.model.content || box.model.border);
    if (!Array.isArray(quad) || quad.length < 2) throw new Error('chrome_invalid_result: element has no geometry');
    var x = Math.round((quad[0] + quad[2]) / 2);
    var y = Math.round((quad[1] + quad[5]) / 2);
    await cdpSend(chrome, tabId, 'Input.dispatchMouseEvent', { type: 'mouseMoved', x: x, y: y, button: 'none' });
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
      var closing = state.owned;
      await forgetOwnedTab(chrome, closing, true);
      return { closed: true };
    }
    if (op.kind === 'navigate') {
      if (!isNonEmptyString(op.url) || !isNonEmptyString(op.frozenHostname)) {
        throw new Error('chrome_invalid_request: navigate needs url + frozenHostname');
      }
      if (!navigationMatchesFrozenHost(op.url, op.frozenHostname)) {
        throw new Error('chrome_domain_blocked: navigation url must be http(s) on frozenHostname');
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
        try {
          await chrome.scripting.executeScript({
            target: { tabId: tabId },
            world: 'ISOLATED',
            files: ['snapshot_injected.js'],
          });
        } catch (e) {
          throw new Error('chrome_invalid_result: snapshot injector failed: ' + String((e && e.message) || e).slice(0, 200));
        }
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
        var marker = 'atlas-' + String(cmd.id).replace(/[^A-Za-z0-9_-]/g, '').slice(0, 80) + '-' + String(Date.now());
        var marked = false;
        var attached = false;
        try {
          throwIfCancelled(signal);
          marked = await markSemanticTarget(chrome, tabId, req, marker);
          if (!marked) throw new Error('chrome_invalid_result: semantic target not found');
          throwIfCancelled(signal);
          var targetState = await inspectSemanticTarget(chrome, tabId, marker);
          var verb = String(req.verb).toLowerCase();
          if (verb === 'text') {
            return { semantic: 'text', text: String(targetState.text || '') };
          }
          await debuggerAttach(chrome, tabId);
          attached = true;
          throwIfCancelled(signal);
          var semNode = await queryNode(chrome, tabId, '[data-pi-atlas-semantic-target="' + marker + '"]');
          throwIfCancelled(signal);
          if (verb === 'click') {
            await clickNode(chrome, tabId, semNode);
            return { semantic: 'clicked' };
          }
          if (verb === 'check') {
            if (targetState.checked !== true) await clickNode(chrome, tabId, semNode);
            return { semantic: 'checked' };
          }
          if (verb === 'hover') {
            await hoverNode(chrome, tabId, semNode);
            return { semantic: 'hovered' };
          }
          if (verb === 'fill') {
            if (typeof req.value !== 'string') {
              throw new Error('chrome_invalid_request: semantic fill needs value');
            }
            throwIfCancelled(signal);
            await focusNode(chrome, tabId, semNode);
            throwIfCancelled(signal);
            var platformInfo = null;
            try {
              if (chrome.runtime && typeof chrome.runtime.getPlatformInfo === 'function') {
                platformInfo = await chrome.runtime.getPlatformInfo();
              }
            } catch (e) {}
            var selectModifier = platformInfo && platformInfo.os === 'mac' ? 4 : 2;
            await cdpSend(chrome, tabId, 'Input.dispatchKeyEvent', { type: 'keyDown', modifiers: selectModifier, key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65 });
            await cdpSend(chrome, tabId, 'Input.dispatchKeyEvent', { type: 'keyUp', modifiers: selectModifier, key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65 });
            throwIfCancelled(signal);
            await cdpSend(chrome, tabId, 'Input.dispatchKeyEvent', { type: 'keyDown', key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8 });
            await cdpSend(chrome, tabId, 'Input.dispatchKeyEvent', { type: 'keyUp', key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8 });
            throwIfCancelled(signal);
            if (req.value.length > 0) await cdpSend(chrome, tabId, 'Input.insertText', { text: req.value });
            return { semantic: 'filled' };
          }
          throw new Error('chrome_invalid_request: unsupported semantic verb ' + String(req.verb).slice(0, 32));
        } finally {
          if (attached) await debuggerDetachBestEffort(chrome, tabId);
          if (marked) await clearSemanticTarget(chrome, tabId, marker);
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
        await chrome.storage.session.remove(OWNED_KEY);
      } catch (e) {}
    }
  }

  function resultEnvelope(cmd, data) {
    return { protocol: PROTOCOL, id: cmd.id, ok: true, data: data };
  }

  function errorEnvelope(cmdOrId, e) {
    var id = typeof cmdOrId === 'string' ? cmdOrId : (cmdOrId && typeof cmdOrId.id === 'string' && cmdOrId.id ? cmdOrId.id : 'unknown');
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
   * Never carries sessionKey/grantId (dual grant travels in commands only).
   * Never carries the pairing secret either: it rides the x-pairing-secret
   * request header (see pairingHeaders), never a URL query string. */
  function pairingHeaders() {
    if (!isNonEmptyString(state.pairingSecret)) return {};
    return { 'x-pairing-secret': state.pairingSecret };
  }
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
    // Session storage survives MV3 worker suspension/restart. Restore the
    // confinement bookkeeping and operator pairing before accepting commands.
    if (chrome && chrome.storage && chrome.storage.session) {
      try { await restoreRuleBase(chrome); } catch (e) {}
      try { await restoreOwnedTab(chrome); } catch (e) {}
      try { await restorePairingSecret(chrome); } catch (e) {}
    }
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
        if ((state.bridgeToken === null || now() - state.lastRegisterAttempt > REGISTER_RETRY_MS) && typeof fetchImpl === 'function') {
          try { await registerCompanion(fetchImpl, chrome, inst, { signal: deps.signal }); } catch (e) {}
        }
        try {
          var pollCtrl = (typeof AbortController !== 'undefined') ? new AbortController() : null;
          var pollTimer = null;
          var pollOnAbort = null;
          if (pollCtrl) {
            if (deps.signal && deps.signal.aborted === true) pollCtrl.abort();
            else {
              pollTimer = setTimeout(function () { try { pollCtrl.abort(); } catch (e) {} }, COMMAND_TIMEOUT_MS + 5000);
              if (deps.signal && typeof deps.signal.addEventListener === 'function') {
                pollOnAbort = function () { try { pollCtrl.abort(); } catch (e) {} };
                deps.signal.addEventListener('abort', pollOnAbort, { once: true });
              }
            }
          }
          var res;
          try {
            res = await fetchImpl(buildNextUrl(COMMAND_TIMEOUT_MS, inst), {
              method: 'GET',
              headers: pairingHeaders(),
              signal: pollCtrl ? pollCtrl.signal : deps.signal,
            });
          } finally {
            if (pollTimer !== null) clearTimeout(pollTimer);
            if (deps.signal && pollOnAbort && typeof deps.signal.removeEventListener === 'function') deps.signal.removeEventListener('abort', pollOnAbort);
          }
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
            headers: Object.assign({ 'content-type': 'application/json' }, pairingHeaders()),
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
    navigationMatchesFrozenHost: navigationMatchesFrozenHost,
    redactSecrets: redactSecrets,
    ensureOwnedTab: ensureOwnedTab,
    forgetOwnedTab: forgetOwnedTab,
    applyDnr: applyDnr,
    removeAllowRules: removeAllowRules,
    dispatchOperation: dispatchOperation,
    revokeLocal: revokeLocal,
    removeDnrRules: removeDnrRules,
    ruleBaseForTab: ruleBaseForTab,
    persistRuleBase: persistRuleBase,
    restoreRuleBase: restoreRuleBase,
    restoreOwnedTab: restoreOwnedTab,
    RULEBASE_KEY: RULEBASE_KEY,
    normalizeVersion: normalizeVersion,
    ownExtensionId: ownExtensionId,
    INSTANCE_KEY: INSTANCE_KEY,
    OWNED_KEY: OWNED_KEY,
    POLL_MS: POLL_MS,
    COMMAND_TIMEOUT_MS: COMMAND_TIMEOUT_MS,
    WAIT_MAX_MS: WAIT_MAX_MS,
    REGISTER_RETRY_MS: REGISTER_RETRY_MS,
    throwIfCancelled: throwIfCancelled,
    detectFamily: detectFamily,
    ensureInstance: ensureInstance,
    heartbeatInstance: heartbeatInstance,
    setPairingSecret: setPairingSecret,
    restorePairingSecret: restorePairingSecret,
    pairingHeaders: pairingHeaders,
    PAIRING_KEY: PAIRING_KEY,
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
      state.pairingSecret = null;
      state.bridgeToken = null;
      state.lastRegisterAttempt = 0;
      ruleBaseNext = 1000;
      ruleBaseByTab = {};
    },
  };

  globalThis.__atlasCompanion = companion;

  // Start the poll loop immediately in a real extension worker (service workers
  // suspend; listeners alone would leave the loop dead after a restart). Only
  // when chrome.runtime.id exists so unit tests loading this file stay inert.
  function restoreExtensionStateAndStart(chrome) {
    Promise.resolve()
      .then(function () { return restoreRuleBase(chrome); })
      .then(function () { return restoreOwnedTab(chrome); })
      .catch(function () {})
      .finally(function () {
        try { startPolling(chrome); } catch (e) {}
      });
  }

  function autostartIfExtensionWorker() {
    try {
      var c = globalThis.chrome;
      if (c && c.runtime && typeof c.runtime.id === 'string' && c.runtime.id.length > 0) {
        restoreExtensionStateAndStart(c);
      }
    } catch (e) {}
  }
  autostartIfExtensionWorker();

  // Register worker listeners only where the chrome API exists.
  try {
    var c = globalThis.chrome;
    if (c && c.runtime && typeof c.runtime.onInstalled === 'object') {
      c.runtime.onInstalled.addListener(function () {
        // Ephemeral state is verified before reuse; never adopt a tab from an
        // unvalidated storage record.
        restoreExtensionStateAndStart(c);
      });
    }
    if (c && c.runtime && c.runtime.onStartup && typeof c.runtime.onStartup.addListener === 'function') {
      c.runtime.onStartup.addListener(function () {
        restoreExtensionStateAndStart(c);
      });
    }
    if (c && c.tabs && c.tabs.onRemoved && typeof c.tabs.onRemoved.addListener === 'function') {
      c.tabs.onRemoved.addListener(function (tabId) {
        if (!ownedMatches(tabId)) return;
        var owned = state.owned;
        forgetOwnedTab(c, owned, false).catch(function () {});
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
