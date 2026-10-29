// Covers the surfaces that a DOM read cannot see and a click cannot safely
// reach: transient notices (toast / snackbar / aria-live) and popups (tooltip /
// popover / popconfirm). Two kinds of assertion live here.
//
// The behavioural ones run pageOperation inside a vm with a hand-built DOM and a
// MutationObserver that the test drives directly, because the capture logic only
// exists once a mutation arrives.
//
// The contract ones are static reads of the source. They exist because a real
// failure happened during development that no behavioural test would have
// caught: the extension dispatches tools through an explicit name list in
// worker.js, and a tool that is registered in src/tools.js but missing from that
// list answers "Unknown command" on the real browser while every unit test
// passes. A static check is the only thing that sees both sides at once.
import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { pageOperation } from '../extension/page.js';
import { TOOLS } from '../src/tools.js';
import { WRITE_TOOLS } from '../src/leases.js';
import { capabilityGuide } from '../src/capability-guide.js';

const pageSource = readFileSync(new URL('../extension/page.js', import.meta.url), 'utf8');
const workerSource = readFileSync(new URL('../extension/worker.js', import.meta.url), 'utf8');
const tool = name => TOOLS.find(entry => entry.name === name);

// --- a DOM just large enough for the capture path -------------------------
function buildDom() {
  const observers = [];
  class FakeMutationObserver {
    constructor(callback) { this.callback = callback; this.disconnected = false; observers.push(this); }
    observe() {}
    disconnect() { this.disconnected = true; }
    emit(records) { if (!this.disconnected) this.callback(records, this); }
  }
  const style = (overrides = {}) => ({ visibility: 'visible', display: 'block', contentVisibility: 'visible', opacity: '1', position: 'fixed', ...overrides });
  // A real matcher for the handful of selector shapes the capture uses:
  // [attr], [attr=value], [attr*=value i], .class, #id and a tag name. A stub
  // that answered false for everything made the capture look broken when the
  // only broken thing was the stub.
  const matchesAny = (spec, attrs, selector) => selector.split(',').some(part => {
    const s = part.trim();
    if (s.startsWith('[') && s.endsWith(']')) {
      const parsed = s.slice(1, -1).match(/^([\w-]+)(?:([*^$]?=)("?)([^"\]]*)\3)?\s*(i?)$/);
      if (!parsed) return false;
      const [, attr, op, , rawValue, flag] = parsed;
      if (!(attr in attrs)) return false;
      if (!op) return true;
      let actual = String(attrs[attr]);
      let expected = rawValue;
      if (flag === 'i') { actual = actual.toLowerCase(); expected = expected.toLowerCase(); }
      if (op === '*=') return actual.includes(expected);
      if (op === '^=') return actual.startsWith(expected);
      if (op === '$=') return actual.endsWith(expected);
      if (op === '=') return actual === expected;
      return false;
    }
    if (s.startsWith('.')) return String(spec.className || '').split(/\s+/).includes(s.slice(1));
    if (s.startsWith('#')) return attrs.id === s.slice(1);
    return String(spec.tag || 'DIV').toLowerCase() === s.toLowerCase();
  });
  const element = (spec = {}) => {
    const attrs = { ...(spec.attrs ?? {}) };
    if (spec.className) attrs.class = spec.className;
    const node = {
      nodeType: 1,
      tagName: spec.tag ?? 'DIV',
      id: attrs.id ?? '',
      className: spec.className ?? '',
      textContent: spec.text ?? '',
      innerText: spec.text ?? '',
      parentElement: null,
      hasAttribute: name => name in attrs,
      getAttribute: name => (name in attrs ? attrs[name] : null),
      matches: selector => matchesAny(spec, attrs, selector),
      querySelector: () => null,
      querySelectorAll: () => [],
      contains: other => other === node,
      closest: () => null,
      getClientRects: () => [{}],
      getBoundingClientRect: () => ({ left: 0, top: 0, width: 100, height: 30 }),
      focus: () => {},
      dispatchEvent: () => true,
      style: {},
      _style: style(spec.style)
    };
    return node;
  };
  const root = element({ tag: 'HTML' });
  root.querySelectorAll = () => [];
  root.matches = () => false;
  const document = {
    title: 'fixture',
    documentElement: root,
    body: root,
    querySelectorAll: () => [],
    getElementById: () => null
  };
  const context = vm.createContext({
    location: { protocol: 'https:', origin: 'https://fixture.test', href: 'https://fixture.test/app' },
    innerWidth: 900, innerHeight: 700, scrollX: 0, scrollY: 0,
    crypto: { randomUUID }, Map, Set, WeakMap, Date, Promise, Array, Object, JSON, Math, Number, String, RegExp, Error, console,
    setTimeout: () => 0,
    getComputedStyle: el => (el && el._style) || style(),
    MutationObserver: FakeMutationObserver,
    document,
    HTMLInputElement: class {}, HTMLTextAreaElement: class {}, HTMLSelectElement: class {},
    Event: class { constructor(type) { this.type = type; } }
  });
  const run = vm.runInContext(`(${pageOperation.toString()})`, context);
  return { run, document, root, element, observers };
}

// --- transient capture ----------------------------------------------------
test('a notice already on screen is captured as pre-existing, not as a result', async () => {
  const { run, root, element } = buildDom();
  const existing = element({ className: 'toast', text: '旧提示', attrs: { role: 'alert' } });
  root.querySelectorAll = selector => (selector.includes('role=alert') ? [existing] : []);
  const result = await run('browser_transient', { action: 'read' }, [], true);
  assert.equal(result.entries.length, 1);
  assert.equal(result.entries[0].text, '旧提示');
  assert.equal(result.entries[0].preExisting, true);
  assert.equal(result.entries[0].kind, 'alert');
});

test('a toast that is added and then removed keeps its text and a goneAt', async () => {
  const { run, root, element, observers } = buildDom();
  root.querySelectorAll = () => [];
  await run('browser_transient', { action: 'read' }, [], true);
  assert.equal(observers.length, 1, 'the observer is installed by the first call');
  const toast = element({ className: 'toast', text: '保存成功', attrs: { role: 'alert' } });
  observers[0].emit([{ type: 'childList', addedNodes: [toast], removedNodes: [] }]);
  const live = await run('browser_transient', { action: 'read' }, [], true);
  assert.equal(live.entries.length, 1);
  assert.equal(live.entries[0].goneAt, null, 'still on screen');
  observers[0].emit([{ type: 'childList', addedNodes: [], removedNodes: [toast] }]);
  const gone = await run('browser_transient', { action: 'read' }, [], true);
  assert.equal(gone.entries.length, 1, 'the notice survives its own removal');
  assert.equal(gone.entries[0].text, '保存成功');
  assert.ok(gone.entries[0].goneAt, 'goneAt records when it disappeared');
});

test('a notice whose text changes keeps both versions and links them', async () => {
  const { run, root, element, observers } = buildDom();
  root.querySelectorAll = () => [];
  await run('browser_transient', { action: 'read' }, [], true);
  const region = element({ tag: 'DIV', id: 'live', text: '提交中', attrs: { 'aria-live': 'polite' } });
  observers[0].emit([{ type: 'childList', addedNodes: [region], removedNodes: [] }]);
  region.textContent = '提交成功';
  observers[0].emit([{ type: 'characterData', target: { parentElement: region } }]);
  const result = await run('browser_transient', { action: 'read' }, [], true);
  assert.equal(result.entries.length, 2);
  assert.equal(result.entries[0].text, '提交中');
  assert.equal(result.entries[1].text, '提交成功');
  assert.equal(result.entries[0].supersededBy, result.entries[1].id);
  assert.ok(result.entries[0].goneAt, 'the replaced entry is closed at the moment it was replaced');
});

test('a text node replacing the previous one is read as an update, not ignored', async () => {
  // Assigning textContent removes the old text node and inserts a new one, so a
  // live region written that way never produces a characterData mutation. The
  // first implementation only looked at elements and missed exactly this.
  const { run, root, element, observers } = buildDom();
  root.querySelectorAll = () => [];
  await run('browser_transient', { action: 'read' }, [], true);
  const region = element({ tag: 'DIV', text: '', attrs: { 'aria-live': 'polite' } });
  observers[0].emit([{ type: 'childList', addedNodes: [region], removedNodes: [] }]);
  region.textContent = '已复制到剪贴板';
  observers[0].emit([{ type: 'childList', addedNodes: [{ nodeType: 3, parentElement: region }], removedNodes: [] }]);
  const result = await run('browser_transient', { action: 'read' }, [], true);
  assert.equal(result.entries.length, 1, 'the empty placeholder is not returned');
  assert.equal(result.entries[0].text, '已复制到剪贴板');
});

test('an ordinary in-flow element called "message" is not recorded as a notice', async () => {
  // Chat panes are full of elements whose class contains "message". A class name
  // alone is not evidence: the node has to be taken out of flow.
  const { run, root, element, observers } = buildDom();
  root.querySelectorAll = () => [];
  await run('browser_transient', { action: 'read' }, [], true);
  const bubble = element({ className: 'chat-message', text: '你好', style: { position: 'static' } });
  observers[0].emit([{ type: 'childList', addedNodes: [bubble], removedNodes: [] }]);
  const result = await run('browser_transient', { action: 'read' }, [], true);
  assert.equal(result.entries.length, 0);
});

test('clear empties the record without touching the page', async () => {
  const { run, root, element } = buildDom();
  const existing = element({ className: 'toast', text: '提示', attrs: { role: 'alert' } });
  root.querySelectorAll = selector => (selector.includes('role=alert') ? [existing] : []);
  const cleared = await run('browser_transient', { action: 'clear' }, [], true);
  assert.equal(cleared.cleared, 1);
  const after = await run('browser_transient', { action: 'read' }, [], true);
  assert.equal(after.entries.length, 0);
});

test('a document without MutationObserver answers unavailable instead of failing the tool', async () => {
  // Every page tool installs the capture, so a document that cannot support it
  // must not break the tools that have nothing to do with notices.
  const { run } = buildDom();
  const result = await run('browser_transient', { action: 'read' }, [], true);
  assert.ok(result.counts, 'the capture is available in this fixture');
  const bare = buildDom();
  bare.observers.length = 0;
  // Rebuild a context without the constructor.
  const context = vm.createContext({
    location: { protocol: 'https:', origin: 'https://fixture.test', href: 'https://fixture.test/app' },
    innerWidth: 900, innerHeight: 700, scrollX: 0, scrollY: 0,
    crypto: { randomUUID }, Map, Set, WeakMap, Date, Promise, Array, Object, JSON, Math, Number, String, RegExp, Error, console,
    setTimeout: () => 0,
    getComputedStyle: () => ({ visibility: 'visible', display: 'block', contentVisibility: 'visible', opacity: '1' }),
    document: bare.document
  });
  const runBare = vm.runInContext(`(${pageOperation.toString()})`, context);
  const unavailable = await runBare('browser_transient', { action: 'read' }, [], true);
  assert.equal(unavailable.status, 'unavailable');
  assert.equal(unavailable.retryable, false);
});

// --- tool contracts -------------------------------------------------------
test('both surfaces are registered with the right read/write annotation', () => {
  const transient = tool('browser_transient');
  const popup = tool('browser_popup');
  assert.ok(transient, 'browser_transient is registered');
  assert.ok(popup, 'browser_popup is registered');
  assert.equal(transient.annotations.readOnlyHint, true, 'reading a record changes nothing');
  assert.equal(popup.annotations.readOnlyHint, false, 'open and choose click');
  assert.deepEqual(popup.inputSchema.required, ['tabId', 'action']);
});

test('the notice kinds in the schema match the kinds the page can produce', () => {
  // Drift here is silent: a kind the page never returns is dead, and a kind the
  // page returns but the schema rejects cannot be filtered on.
  const body = pageSource.slice(pageSource.indexOf('const transientKind = el =>'));
  const produced = new Set([...body.slice(0, body.indexOf('\n  };')).matchAll(/return '([a-z-]+)'/g)].map(match => match[1]));
  const declared = new Set(tool('browser_transient').inputSchema.properties.kind.items.enum);
  assert.deepEqual([...declared].sort(), [...produced].sort());
});

test('the popup actions in the schema match the branches the page implements', () => {
  const declared = new Set(tool('browser_popup').inputSchema.properties.action.enum);
  for (const action of declared) {
    assert.ok(pageSource.includes(`action === '${action}'`) || pageSource.includes(`'${action}'`),
      `page.js handles browser_popup action ${action}`);
  }
});

test('the extension dispatches both tools instead of answering Unknown command', () => {
  // This is the failure that happened: registered in src/tools.js, missing from
  // the worker's name list, and every unit test still passed.
  const listLine = workerSource.split('\n').find(line => line.includes("throw new Error('Unknown command')"));
  assert.ok(listLine, 'the dispatch list is where it was');
  for (const name of ['browser_transient', 'browser_popup']) {
    assert.ok(listLine.includes(`'${name}'`), `${name} is in the worker dispatch list`);
  }
});

test('the page implements a branch for each new tool', () => {
  for (const name of ['browser_transient', 'browser_popup']) {
    assert.ok(pageSource.includes(`name === '${name}'`), `page.js has a branch for ${name}`);
  }
});

test('browser_popup is lease-governed because its confirm is usually a delete', () => {
  assert.ok(WRITE_TOOLS.has('browser_popup'));
  assert.ok(!WRITE_TOOLS.has('browser_transient'), 'a read-only timeline is not a write');
});

test('the capability guide routes tooltip and toast questions to these tools', () => {
  for (const goal of ['页面上出现 toast 提示', 'tooltip 看不全', 'popconfirm 要点确定', '气泡确认框怎么点']) {
    const guide = capabilityGuide({ goal });
    assert.ok(guide.matchedIntents.includes('transient-and-popup-ui'), `"${goal}" matches the intent`);
  }
});
