import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { randomUUID } from 'node:crypto';
import { pageOperation } from '../extension/page.js';

test('plain portal text receives a ref; covered clones and zero geometry stay excluded', async () => {
  function element(tag, text, x, width = 30) {
    return { tagName: tag.toUpperCase(), textContent: text, innerText: text, children: [],
      getAttribute: () => null, closest: () => null,
      matches: selector => selector === 'span,div,li' && tag === 'span',
      getClientRects: () => [{}],
      getBoundingClientRect: () => ({ left: x, top: 20, width, height: 20 }),
      contains: () => false };
  }
  const portal = element('span', '关机', 10);
  const clone = element('input', '选择实例', 100);
  const top = element('input', '选择实例', 100);
  const zero = element('span', '零尺寸', 0, 0);
  const outside = element('span', '屏外', 2000);
  const elements = [portal, clone, top, zero, outside];
  const context = vm.createContext({
    location: { protocol: 'https:', origin: 'https://fixture.test', href: 'https://fixture.test/' },
    innerWidth: 800, innerHeight: 600, crypto: { randomUUID }, performance, Map,
    getComputedStyle: () => ({ visibility: 'visible', display: 'block' }),
    HTMLInputElement: class {}, HTMLButtonElement: class {}, HTMLAnchorElement: class {},
    HTMLTextAreaElement: class {}, HTMLSelectElement: class {}, NodeFilter: { SHOW_ELEMENT: 1 },
    document: { title: 'fixture', body: {}, querySelectorAll: () => [clone, top],
      elementFromPoint: x => x < 80 ? portal : top,
      createTreeWalker: () => { let i = 0; return { nextNode: () => elements[i++] }; } }
  });
  const run = vm.runInContext(`(${pageOperation.toString()})`, context);
  const find = query => run('browser_find_element', { query, action: 'click' }, [], true);
  const found = await find('关机');
  assert.equal(found.candidates.length, 1);
  assert.ok(found.candidates[0].ref);
  assert.match(found.candidates[0].locatorEvidence, /clickability-unverified/);
  assert.equal((await find('选择实例')).candidates.length, 1);
  assert.equal((await find('零尺寸')).candidates.length, 0);
  assert.equal((await find('屏外')).candidates.length, 0);
  assert.equal((await find('不存在')).candidates.length, 0);
  const rowA = { innerText: 'instance-A running', matches: () => false, closest: () => null };
  const rowB = { innerText: 'instance-B running', matches: () => false, closest: () => null };
  clone.closest = selector => selector.startsWith('tr,') ? rowA : null;
  top.closest = selector => selector.startsWith('tr,') ? rowB : null;
  top.isConnected = true;
  const scoped = rowText => run('browser_find_element', { query: '选择实例', action: 'click', rowText }, [], true);
  assert.equal((await scoped('instance-A')).candidates.length, 0, 'must not substitute a foreground checkbox from another row');
  const target = (await scoped('instance-B')).candidates[0];
  assert.equal(target.rowText, 'instance-B running');
  rowB.innerText = 'instance-C running';
  assert.match((await run('browser_click', { ref: target.ref }, [], true)).__aibError, /Stale row reference/);
  assert.equal(found.partial, false);
  // A budget cutoff is not proof of absence. Force the desired node beyond it.
  context.document.createTreeWalker = () => {
    let i = 0;
    return { nextNode: () => ++i <= 5001 ? element('span', 'other', 10) : i === 5002 ? portal : null };
  };
  const partial = await find('关机');
  assert.equal(partial.found, false);
  assert.equal(partial.partial, true);
  assert.equal(partial.diagnostics.textScanPartial, true);
  assert.match(partial.guidance, /incomplete/);
});
