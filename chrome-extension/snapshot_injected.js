/* Pi-Northstar companion snapshot collector (isolated world).
 *
 * Runs via chrome.scripting.executeScript with structured args only; this
 * file never interpolates caller strings into code. No chrome APIs, no
 * network, no storage access here. Form values are redacted at the source:
 * input/textarea/select values never leave this function verbatim.
 *
 * Exposes: globalThis.__atlasSnapshot(compact boolean) -> string
 */
(function () {
  'use strict';

  var REDACTED = '[redacted]';
  var MAX_NODES = 300;
  var MAX_TEXT = 30000;

  function roleOf(el) {
    if (typeof el.getAttribute === 'function') {
      var explicit = el.getAttribute('role');
      if (explicit) return explicit;
    }
    var tag = (el.tagName || '').toLowerCase();
    if (tag === 'a') return 'link';
    if (tag === 'button') return 'button';
    if (tag === 'input') {
      var type = ((el.getAttribute && el.getAttribute('type')) || 'text').toLowerCase();
      if (type === 'submit') return 'button';
      if (type === 'checkbox') return 'checkbox';
      if (type === 'radio') return 'radio';
      return 'textbox';
    }
    if (tag === 'textarea') return 'textbox';
    if (tag === 'select') return 'combobox';
    if (tag === 'img') return 'img';
    if (tag === 'h1' || tag === 'h2' || tag === 'h3') return 'heading';
    return tag || 'generic';
  }

  function labelOf(el) {
    var candidates = [];
    var tag = (el.tagName || '').toLowerCase();
    var skipText = tag === 'textarea' || tag === 'select';
    if (typeof el.getAttribute === 'function') {
      var aria = el.getAttribute('aria-label');
      if (aria) candidates.push(aria);
    }
    if (!skipText && el.innerText) candidates.push(el.innerText);
    if (!skipText && el.textContent) candidates.push(el.textContent);
    if (typeof el.getAttribute === 'function') {
      var alt = el.getAttribute('alt');
      if (alt) candidates.push(alt);
      var title = el.getAttribute('title');
      if (title) candidates.push(title);
      var name = el.getAttribute('name');
      if (name) candidates.push(name);
    }
    for (var i = 0; i < candidates.length; i++) {
      var s = String(candidates[i]).replace(/\s+/g, ' ').trim();
      if (s) return s.slice(0, 120);
    }
    return '';
  }

  function isVisible(el) {
    // Best-effort visibility without layout thrash; hidden inputs excluded.
    if (typeof el.getAttribute === 'function') {
      var type = el.getAttribute('type');
      if (type && String(type).toLowerCase() === 'hidden') return false;
      if (el.hasAttribute && el.hasAttribute('hidden')) return false;
      var aria = el.getAttribute('aria-hidden');
      if (aria === 'true') return false;
    }
    if (el.style && (el.style.display === 'none' || el.style.visibility === 'hidden')) return false;
    return true;
  }

  function collect(doc, compact) {
    var selector = 'a, button, input, textarea, select, [role], h1, h2';
    var list = [];
    try {
      list = doc.querySelectorAll(selector);
    } catch (e) {
      list = [];
    }
    var lines = [];
    var ref = 0;
    var count = 0;
    for (var i = 0; i < list.length; i++) {
      if (count >= MAX_NODES) break;
      try {
        var el = list[i];
        if (!isVisible(el)) continue;
        ref += 1;
        count += 1;
        var role = roleOf(el);
        var label = labelOf(el);
        // Form values are never echoed: value always redacted for value-bearing nodes.
        var tag = (el.tagName || '').toLowerCase();
        var suffix = '';
        if (tag === 'input' || tag === 'textarea' || tag === 'select') {
          suffix = ' value=' + REDACTED;
        }
        var line = '@e' + ref + ' ' + role + (label ? ' ' + JSON.stringify(label) : '') + suffix;
        lines.push(line);
        if (compact && count >= 80) break;
      } catch (e) {
        continue;
      }
    }
    var title = '';
    try {
      title = String(doc.title || '');
    } catch (e) {
      title = '';
    }
    var header = '# Atlas snapshot' + (title ? ' ' + JSON.stringify(title.slice(0, 120)) : '');
    var out = header + '\n' + lines.join('\n');
    return out.slice(0, MAX_TEXT);
  }

  function snapshot(compact) {
    try {
      return collect(globalThis.document, compact === true);
    } catch (e) {
      return '# Atlas snapshot\n# unavailable';
    }
  }

  globalThis.__atlasSnapshot = snapshot;
})();
