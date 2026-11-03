import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { randomUUID } from 'node:crypto';
import { pageOperation } from '../extension/page.js';
import { createBridge } from '../src/server.js';

function fixture({ tagName = 'BUTTON', pointer = false } = {}) {
  const dialog = { textContent: 'P800 1 card 7.94/hour' };
  const el = { nodeType: 1, tagName, innerText: '开始使用', textContent: '开始使用', isConnected: true, children: [], parentElement: null,
    getAttribute: () => null, matches: selector => tagName === 'BUTTON' && selector.includes('button'),
    closest: selector => selector.startsWith('dialog') ? dialog : null,
    contains: node => node === el, scrollIntoView: () => {}, clickCount: 0, click() { this.clickCount++; },
    getClientRects: () => [{}], getBoundingClientRect: () => ({ left: 10, top: 10, width: 100, height: 40 }) };
  let hit = el, now = 100, visibilityState = 'visible', focused = true;
  const document = { elementFromPoint: () => hit, get visibilityState() { return visibilityState; }, hasFocus: () => focused, body: null, documentElement: null };
  const context = vm.createContext({ location: { protocol: 'https:', origin: 'https://fixture.test', href: 'https://fixture.test/' },
    innerWidth: 800, innerHeight: 600, scrollX: 0, scrollY: 0, crypto: { randomUUID }, Map,
    Date: { now: () => now }, getComputedStyle: node => ({ visibility: 'visible', display: 'block', cursor: pointer && node === el ? 'pointer' : 'default' }),
    HTMLAnchorElement: class {}, HTMLButtonElement: class {}, HTMLInputElement: class {}, HTMLTextAreaElement: class {}, HTMLSelectElement: class {}, document });
  const run = vm.runInContext(`(${pageOperation.toString()})`, context);
  const prepare = (opts = {}) => run('browser_prepare_coordinate', { x: 50, y: 50, ...opts }, [], true);
  const validate = (token, opts = {}) => run('browser_validate_coordinate', { coordinateToken: token, x: 50, y: 50, ...opts }, [], true);
  return { run, prepare, validate, dialog, context, document, el, cover: () => { hit = { tagName: 'DIV', textContent: 'Cover', isConnected: true, getAttribute: () => null, closest: () => null }; },
    hide: () => { visibilityState = 'hidden'; focused = false; }, show: () => { visibilityState = 'visible'; focused = true; }, expire: () => { now += 120001; } };
}

test('coordinate preparation also hands off a browser_click ref for the exact semantic target', async () => {
  const f = fixture();
  const prepared = await f.prepare();
  assert.ok(prepared.coordinateToken);
  assert.equal(prepared.target.hitRef, prepared.clickRef);
  assert.equal(prepared.clickRefEvidence.source, 'semantic-control');
  assert.equal(prepared.clickRefEvidence.label, '开始使用');
  const clicked = await f.run('browser_click', { ref: prepared.clickRef }, [], true);
  assert.equal(clicked.clicked, true, JSON.stringify(clicked));
  assert.equal(f.el.clickCount, 1);
});

test('coordinate preparation promotes a pointer-style card hit to a click ref', async () => {
  const f = fixture({ tagName: 'DIV', pointer: true });
  const prepared = await f.prepare();
  assert.ok(prepared.clickRef);
  assert.equal(prepared.clickRefEvidence.source, 'cursor-pointer');
  assert.equal(prepared.clickRefEvidence.confidence, 'inferred');
  const clicked = await f.run('browser_click', { ref: prepared.clickRef }, [], true);
  assert.equal(clicked.clicked, true, JSON.stringify(clicked));
  assert.equal(f.el.clickCount, 1);
});

test('coordinate preparation never claims an unverified generic element is clickable', async () => {
  const f = fixture({ tagName: 'DIV', pointer: false });
  const prepared = await f.prepare();
  assert.ok(prepared.target.hitRef, 'the exact hit may still be inspected');
  assert.equal(prepared.clickRef, null);
  assert.equal(prepared.clickRefEvidence, null);
  assert.match(prepared.note, /no verified semantic-control or cursor:pointer ancestor/);
});

test('a prepared token outlives one agent round trip', async () => {
  // 15 seconds was shorter than the gap between two calls in one real task
  // (measured 10-20s), so prepare-and-tap failed about half the time and the
  // failures looked like bad coordinates. Two minutes, and the caller can ask.
  const f = fixture(), p = await f.prepare();
  assert.equal(p.expiresInMs, 120000);
  f.context.Date.now = () => 100 + 30000;
  assert.equal((await f.validate(p.coordinateToken)).status, 'ready');
  const short = await f.prepare({ ttlMs: 5000 });
  assert.equal(short.expiresInMs, 5000);
});

test('a refused token says whether it expired, was used, or never existed', async () => {
  // One reason string for three different situations made a caller re-prepare
  // when it had simply reused a token, and retry a dead one forever.
  const f = fixture();
  const first = await f.prepare({ ttlMs: 5000 });
  assert.equal((await f.validate(first.coordinateToken)).status, 'ready');
  const reused = await f.validate(first.coordinateToken);
  assert.equal(reused.reason, 'coordinate_token_consumed');
  assert.equal(reused.tokenState, 'consumed');
  assert.equal(reused.dispatched, false);

  const expiring = await f.prepare({ ttlMs: 5000 });
  f.context.Date.now = () => 100 + 6000;
  const expired = await f.validate(expiring.coordinateToken);
  assert.equal(expired.reason, 'coordinate_token_expired');
  assert.equal(expired.tokenLifetimeMs, 5000);

  const invented = await f.validate('00000000-0000-4000-8000-000000000000');
  assert.equal(invented.reason, 'coordinate_token_never_issued');
  assert.equal(invented.dispatched, false);
});
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
