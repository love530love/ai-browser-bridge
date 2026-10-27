import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { randomUUID } from 'node:crypto';
import { pageOperation } from '../extension/page.js';
import { createBridge } from '../src/server.js';

function fixture() {
  const dialog = { textContent: 'P800 1 card 7.94/hour' };
  const el = { tagName: 'BUTTON', innerText: '开始使用', isConnected: true,
    getAttribute: () => null, matches: () => false,
    closest: selector => selector.startsWith('dialog') ? dialog : null,
    getClientRects: () => [{}], getBoundingClientRect: () => ({ left: 10, top: 10, width: 100, height: 40 }) };
  let hit = el, now = 100, visibilityState = 'visible', focused = true;
  const document = { elementFromPoint: () => hit, get visibilityState() { return visibilityState; }, hasFocus: () => focused };
  const context = vm.createContext({ location: { protocol: 'https:', origin: 'https://fixture.test', href: 'https://fixture.test/' },
    innerWidth: 800, innerHeight: 600, scrollX: 0, scrollY: 0, crypto: { randomUUID }, Map,
    Date: { now: () => now }, getComputedStyle: () => ({ visibility: 'visible', display: 'block' }), document });
  const run = vm.runInContext(`(${pageOperation.toString()})`, context);
  const prepare = (opts = {}) => run('browser_prepare_coordinate', { x: 50, y: 50, ...opts }, [], true);
  const validate = (token, opts = {}) => run('browser_validate_coordinate', { coordinateToken: token, x: 50, y: 50, ...opts }, [], true);
  return { prepare, validate, dialog, context, document, el, cover: () => { hit = { tagName: 'DIV', textContent: 'Cover', isConnected: true, getAttribute: () => null, closest: () => null }; },
    hide: () => { visibilityState = 'hidden'; focused = false; }, show: () => { visibilityState = 'visible'; focused = true; }, expire: () => { now += 15001; } };
}

test('coordinate token is single-use and valid only for unchanged target', async () => {
  const f = fixture(), p = await f.prepare();
  assert.ok(p.coordinateToken);
  assert.equal((await f.validate(p.coordinateToken)).status, 'ready');
  assert.equal((await f.validate(p.coordinateToken)).dispatched, false);
});
test('same-URL product changes, overlays, scrolling and expiry prevent dispatch', async () => {
  for (const mutate of [f => { f.dialog.textContent = 'PRO 5000 2 cards'; }, f => f.cover(),
    f => { f.context.scrollY = 40; }, f => { f.context.innerWidth = 900; }, f => f.expire()]) {
    const f = fixture(), p = await f.prepare(); mutate(f);
    const result = await f.validate(p.coordinateToken);
    assert.equal(result.status, 'waiting');
    assert.equal(result.dispatched, false);
  }
  const f = fixture(), p = await f.prepare(); f.cover();
  const changed = await f.validate(p.coordinateToken);
  assert.ok(changed.validationFailures.includes('hit_target_changed'));
  assert.equal(changed.targetChange.expected.tag, 'button');
  assert.equal(changed.targetChange.actual.tag, 'div');

  const sameNode = fixture(), sameNodePrepared = await sameNode.prepare();
  sameNode.el.innerText = 'Different action';
  const changedInPlace = await sameNode.validate(sameNodePrepared.coordinateToken);
  assert.equal(changedInPlace.targetChange.expected.label, '开始使用');
  assert.equal(changedInPlace.targetChange.actual.label, 'Different action');
});
test('a backgrounded document still prepares and reuses coordinate tokens', async () => {
  // Foreground is not a correctness invariant: the token is bound to the DOM
  // element and re-hit-tested at dispatch, so hiding the document must not
  // destroy the token. Only an explicit requireForeground opts back in.
  const f = fixture(); f.hide();
  const prep = await f.prepare();
  assert.ok(prep.coordinateToken, 'a hidden document must still yield a token');
  assert.equal(prep.evidenceQuality, 'stale-frame-possible');
  assert.equal(prep.pageState.visibilityState, 'hidden');
  const reused = await f.validate(prep.coordinateToken);
  assert.equal(reused.status, 'ready');
  assert.equal(reused.dispatched, undefined);

  // A real target change still fails closed while hidden.
  const g = fixture(); const valid = await g.prepare(); g.hide(); g.cover();
  const covered = await g.validate(valid.coordinateToken);
  assert.equal(covered.status, 'waiting');
  assert.ok(covered.validationFailures.includes('hit_target_changed'));
});

test('requireForeground restores the strict foreground-only behaviour without consuming the token', async () => {
  const strict = fixture(); strict.hide();
  const refused = await strict.prepare({ requireForeground: true });
  assert.equal(refused.reason, 'page_not_foreground');
  assert.equal(refused.coordinateToken, undefined);

  const f = fixture(); const prepared = await f.prepare(); f.hide();
  const blocked = await f.validate(prepared.coordinateToken, { requireForeground: true });
  assert.equal(blocked.reason, 'page_not_foreground');
  assert.equal(blocked.dispatched, false);
  f.show();
  // The refusal must not burn the token: once visible again it is still usable.
  assert.equal((await f.validate(prepared.coordinateToken)).status, 'ready');
});
test('exact visible text on an anchor without href is discoverable but unverified', async () => {
  class FakeAnchor {
    constructor() { this.tagName = 'A'; this.textContent = '下载报表'; this.innerText = this.textContent; this.children = []; this.isConnected = true; }
    matches(selector) { return selector === 'a:not([href])'; }
    hasAttribute(name) { return name === 'href' ? false : false; }
    getAttribute(name) { return name === 'role' ? null : null; }
    closest() { return null; }
    getClientRects() { return [{}]; }
    getBoundingClientRect() { return { left: 10, top: 10, width: 100, height: 30 }; }
    contains(node) { return node === this; }
  }
  const anchor = new FakeAnchor();
  let walked = false;
  const document = { body: {}, querySelectorAll: () => [], createTreeWalker: () => ({ nextNode: () => walked ? null : (walked = true, anchor) }), elementFromPoint: () => anchor };
  const context = vm.createContext({ location: { protocol: 'https:', origin: 'https://fixture.test', href: 'https://fixture.test/' },
    innerWidth: 800, innerHeight: 600, scrollX: 0, scrollY: 0, crypto: { randomUUID }, Map,
    performance: { now: () => 10 }, NodeFilter: { SHOW_ELEMENT: 1 }, document,
    getComputedStyle: () => ({ visibility: 'visible', display: 'block' }),
    HTMLAnchorElement: FakeAnchor, HTMLButtonElement: class {}, HTMLInputElement: class {}, HTMLTextAreaElement: class {}, HTMLSelectElement: class {} });
  const run = vm.runInContext(`(${pageOperation.toString()})`, context);
  const result = await run('browser_find_element', { query: '下载报表', action: 'click' }, [], true);
  assert.equal(result.found, true);
  assert.equal(result.candidates[0].tag, 'a');
  assert.equal(result.candidates[0].role, 'generic');
  assert.equal(result.candidates[0].clickability, 'unverified');
  assert.match(result.candidates[0].locatorEvidence, /clickability-unverified/);
});
test('unknown extension version cannot bypass coordinate preflight through older worker', async t => {
  const bridge = createBridge({ port: 0, agentToken: 'test', extensionToken: 'ext' }, { leaseStateFile: null, agentPolicyFile: null });
  await bridge.listen(); t.after(() => bridge.close());
  const result = await bridge.call('browser_action', { tabId: 1, action: 'Tap', expectedUrl: 'https://fixture.test/', x: 50, y: 50, coordinateToken: 'token' });
  assert.equal(result.reason, 'coordinate_guard_version_mismatch');
  assert.equal(result.dispatched, false);
  assert.equal(bridge.status().queued, 0);
});
test('dialog form value changes invalidate a target even if all text remains identical', async () => {
  const f = fixture();
  const quantity = { tagName: 'INPUT', value: '1', matches: () => false, closest: () => null, getAttribute: () => null };
  f.dialog.querySelectorAll = () => [quantity];
  const p = await f.prepare(); quantity.value = '2';
  assert.equal((await f.validate(p.coordinateToken)).dispatched, false);
});
