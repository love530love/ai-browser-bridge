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
  let hit = el, now = 100;
  const context = vm.createContext({ location: { protocol: 'https:', origin: 'https://fixture.test', href: 'https://fixture.test/' },
    innerWidth: 800, innerHeight: 600, scrollX: 0, scrollY: 0, crypto: { randomUUID }, Map,
    Date: { now: () => now }, getComputedStyle: () => ({ visibility: 'visible', display: 'block' }),
    document: { elementFromPoint: () => hit } });
  const run = vm.runInContext(`(${pageOperation.toString()})`, context);
  const prepare = () => run('browser_prepare_coordinate', { x: 50, y: 50 }, [], true);
  const validate = token => run('browser_validate_coordinate', { coordinateToken: token, x: 50, y: 50 }, [], true);
  return { prepare, validate, dialog, context, cover: () => { hit = {}; }, expire: () => { now += 15001; } };
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
