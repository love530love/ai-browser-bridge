// The escape hatch, as one self-contained function.
//
// Why this exists: a field report from a real paid order on a React + antd SPA
// spent 35 of 45 minutes on "how do I select one card inside a modal". Every
// DOM tool the bridge had was blind to the modal's div cards, the coordinate
// path needed a 15-second token and hand-solved scaling, and the one primitive
// that would have answered it in a line - script evaluation - was advertised in
// browser_devtools as "not implemented". It was implemented, in browser_debugger.
// Nobody found it, so nobody used it.
//
// The function below is deliberately written as a single self-contained
// function with no imports and no outer references, because it is used through
// two different channels that both need its exact source:
//
//   1. chrome.scripting.executeScript({ func: evalInPage, world: 'MAIN' }) -
//      no debugger attachment, no banner, works on a background tab. This is
//      the fast path.
//   2. Runtime.evaluate via CDP, with the function's own source wrapped in
//      parentheses and called. That path exists because a page whose CSP
//      forbids 'unsafe-eval' blocks a direct eval in the main world, and CDP
//      evaluation is not subject to the page's CSP.
//
// One implementation, two channels: if the preview logic ever changed in one
// and not the other, the same expression would answer differently depending on
// which channel happened to be used, which is exactly the class of bug this
// project keeps paying for.
//
// Boundaries that are real, not promised:
//   - read mode shadows the primitives that turn a read into a write. It is a
//     scope, not a sandbox: an expression can still reach them through another
//     object (an iframe's contentWindow, a reference the page saved earlier).
//     The reply says which names were shadowed and says it is a guardrail.
//   - the return value is always rendered to text here, never handed back as a
//     live object: the value has to cross a process boundary, and a live object
//     cannot. A DOM node becomes a descriptor, not a copy of the page.
//   - exceptions are returned, not thrown: an expression that throws is a
//     result about the expression, not a failure of the bridge.

export function evalInPage(expression, options) {
  var opts = options || {};
  var guard = opts.readOnly === true;
  var maxPreview = Number(opts.maxPreviewChars) > 0 ? Number(opts.maxPreviewChars) : 8000;
  var startedAt = (globalThis.performance && performance.now) ? performance.now() : Date.now();
  var g = globalThis;
  var bind = function (fn) { return typeof fn === 'function' ? fn.bind(g) : fn; };

  // Declared unconditionally and assigned conditionally, because `const`/`let`
  // hoisting means a conditional declaration cannot be made to not exist. In
  // read mode these are undefined, so the direct eval below resolves the name
  // to this binding and never reaches the global. In write mode they are the
  // real ones, bound so that a bare fetch(...) does not throw
  // "Illegal invocation" for having lost its receiver.
  var fetch = guard ? undefined : bind(g.fetch);
  var XMLHttpRequest = guard ? undefined : g.XMLHttpRequest;
  var WebSocket = guard ? undefined : g.WebSocket;
  var EventSource = guard ? undefined : g.EventSource;
  var open = guard ? undefined : bind(g.open);
  var alert = guard ? undefined : bind(g.alert);
  var confirm = guard ? undefined : bind(g.confirm);
  var prompt = guard ? undefined : bind(g.prompt);
  var print = guard ? undefined : bind(g.print);
  var sendBeacon = guard ? undefined : bind(g.navigator && g.navigator.sendBeacon);

  var SHADOWED = ['fetch', 'XMLHttpRequest', 'WebSocket', 'EventSource', 'navigator.sendBeacon',
    'window.open', 'alert', 'confirm', 'prompt', 'print'];

  function clip(text, limit) {
    var value = String(text == null ? '' : text);
    return value.length > limit ? value.slice(0, limit) + '\u2026(' + value.length + ' chars)' : value;
  }

  function describeNode(node) {
    var out = { tag: String(node.nodeName || '').toLowerCase() };
    if (node.nodeType !== 1) {
      out.nodeType = node.nodeType;
      out.text = clip(node.nodeValue, 400);
      return out;
    }
    if (node.id) out.id = node.id;
    var cls = node.getAttribute && node.getAttribute('class');
    if (cls) out.className = clip(cls, 200);
    var role = node.getAttribute && node.getAttribute('role');
    if (role) out.role = role;
    var type = node.getAttribute && node.getAttribute('type');
    if (type) out.type = type;
    var rect = node.getBoundingClientRect ? node.getBoundingClientRect() : null;
    if (rect) out.rect = { x: Math.round(rect.left), y: Math.round(rect.top), width: Math.round(rect.width), height: Math.round(rect.height) };
    if ('checked' in node) out.checked = !!node.checked;
    if (typeof node.value === 'string') {
      // A password box is described, never quoted: this is the one channel that
      // could otherwise echo a secret that every other read path filters.
      var secret = node.type === 'password';
      out.valueLength = node.value.length;
      out.value = secret ? null : clip(node.value, 400);
      if (secret) out.secret = true;
    }
    out.text = clip((node.innerText || node.textContent || '').replace(/\s+/g, ' ').trim(), 400);
    return out;
  }

  function preview(value, depth) {
    if (value === undefined) return { type: 'undefined', text: 'undefined', json: false };
    if (value === null) return { type: 'null', text: 'null', json: true };
    var type = typeof value;
    if (type === 'string') {
      var text = value.length > maxPreview ? value.slice(0, maxPreview) + '\u2026(' + value.length + ' chars)' : value;
      return { type: 'string', text: JSON.stringify(text), json: true, truncated: value.length > maxPreview };
    }
    if (type === 'number' || type === 'boolean') return { type: type, text: String(value), json: true };
    if (type === 'bigint') return { type: 'bigint', text: JSON.stringify(String(value) + 'n'), json: false };
    if (type === 'symbol') return { type: 'symbol', text: JSON.stringify(String(value)), json: false };
    if (type === 'function') {
      return { type: 'function', text: JSON.stringify('function ' + (value.name || 'anonymous') + '()'), json: false };
    }
    if (typeof Node !== 'undefined' && value instanceof Node) {
      return { type: 'node', text: JSON.stringify(describeNode(value)), json: false };
    }
    if (typeof NodeList !== 'undefined' && (value instanceof NodeList || value instanceof HTMLCollection)) {
      var items = [];
      for (var i = 0; i < value.length && i < 40; i++) items.push(describeNode(value[i]));
      return { type: 'collection', text: JSON.stringify({ length: value.length, shown: items.length, items: items }), json: false };
    }
    if (Array.isArray(value)) {
      if (depth >= 3) return { type: 'array', text: JSON.stringify('[array length ' + value.length + ']'), json: false };
      var list = [];
      for (var k = 0; k < value.length && k < 40; k++) list.push(JSON.parse(preview(value[k], depth + 1).text || 'null'));
      return { type: 'array', text: JSON.stringify({ length: value.length, shown: list.length, items: list }), json: false };
    }
    if (depth >= 3) return { type: 'object', text: JSON.stringify('[object ' + Object.prototype.toString.call(value) + ']'), json: false };
    try {
      var seen = [];
      var json = JSON.stringify(value, function (key, item) {
        if (typeof item === 'function') return '[function ' + (item.name || 'anonymous') + ']';
        if (typeof item === 'bigint') return String(item) + 'n';
        if (item && typeof item === 'object') {
          if (seen.indexOf(item) !== -1) return '[circular]';
          seen.push(item);
        }
        return item;
      });
      if (typeof json === 'string' && json.length > maxPreview) {
        return { type: 'object', text: JSON.stringify(clip(json, maxPreview)), json: false, truncated: true };
      }
      return { type: 'object', text: typeof json === 'string' ? json : 'null', json: true };
    } catch (error) {
      return { type: 'object', text: JSON.stringify('[unserialisable: ' + String(error && error.message || error) + ']'), json: false };
    }
  }

  var base = {
    readOnly: guard,
    readOnlyEnforced: guard ? SHADOWED : [],
    readOnlyIsGuardrail: guard,
    contentTrust: 'untrusted webpage data',
    url: String(g.location && location.href || '')
  };

  if (typeof expression !== 'string' || !expression.trim()) {
    return Object.assign(base, { ok: false, status: 'denied', reason: 'empty_expression',
      message: 'Pass a non-empty expression. Nothing was evaluated.' });
  }

  var value;
  try {
    // Direct eval on purpose: it resolves names through the scope above, which
    // is what makes read mode's shadowing work at all.
    value = eval(expression);
  } catch (error) {
    var name = String(error && error.name || '');
    var message = String(error && error.message || error);
    var csp = name === 'EvalError' || /unsafe-eval|Content Security Policy|Trusted Type/i.test(message);
    return Object.assign(base, {
      ok: false,
      status: 'failed',
      reason: csp ? 'eval_blocked_by_page_csp' : 'expression_threw',
      exception: { name: name || null, message: clip(message, 1200),
        stack: clip(String(error && error.stack || ''), 2000) || null },
      blockedBy: csp ? 'page_csp' : null,
      message: csp
        ? 'The page\'s Content Security Policy forbids eval in its own world. Retry once through the debugger channel, which is not subject to page CSP.'
        : 'The expression threw. That is a result about the expression, not a bridge failure: nothing was retried.'
    });
  }

  return Promise.resolve(value).then(function (settled) {
    var rendered = preview(settled, 0);
    return Object.assign(base, {
      ok: true,
      status: 'success',
      type: rendered.type,
      valueText: rendered.text,
      valueIsJson: rendered.json === true,
      valueTruncated: rendered.truncated === true,
      elapsedMs: Math.round(((g.performance && performance.now) ? performance.now() : Date.now()) - startedAt)
    });
  }, function (error) {
    return Object.assign(base, {
      ok: false, status: 'failed', reason: 'promise_rejected',
      exception: { name: String(error && error.name || ''), message: clip(String(error && error.message || error), 1200) },
      message: 'The expression returned a promise that rejected. Nothing was retried.'
    });
  });
}

// Kept next to the function so the two cannot drift: the worker uses this to
// decide whether a reply can be parsed back into a value.
export const EVAL_MAX_EXPRESSION_CHARS = 200000;
