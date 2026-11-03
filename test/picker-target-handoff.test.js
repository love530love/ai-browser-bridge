import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { randomUUID } from 'node:crypto';
import { pageOperation } from '../extension/page.js';
import { nextStepFor } from '../src/next-step.js';

function pickerFixture(texts, { unrelatedInput = null, sharedPointerWrapper = false, nestedTextChildren = false } = {}) {
  const cards = texts.map((text, index) => {
    const title = nestedTextChildren ? {
      nodeType: 1, tagName: 'SPAN', textContent: text, innerText: text, isConnected: true,
      children: [], parentElement: null, getAttribute: () => null, matches: () => false, closest: () => null,
      querySelector: () => null, querySelectorAll: () => [], contains: node => node === title,
      getClientRects: () => [{}], getBoundingClientRect: () => ({ left: 28 + index * 140, top: 48, width: 100, height: 20 })
    } : null;
    const card = {
      nodeType: 1, tagName: 'DIV', textContent: text, innerText: text, isConnected: true,
      children: title ? [title] : [], parentElement: null, className: 'spec-card', id: `card-${index}`,
      getAttribute: name => name === 'aria-label' ? null : null,
      matches: () => false,
      closest: () => null,
      querySelector: () => null,
      querySelectorAll: selector => nestedTextChildren && selector === 'div,span,li,label,td,article,section,figure,p' ? [title] : [],
      contains: node => node === card || node === title,
      getClientRects: () => [{}],
      getBoundingClientRect: () => ({ left: 20 + index * 140, top: 40, width: 120, height: 60 }),
      scrollIntoView: () => {}, clickCount: 0, click() { this.clickCount++; }
    };
    if (title) title.parentElement = card;
    return card;
  });
  const body = { nodeType: 1, tagName: 'BODY', children: [], parentElement: null,
    querySelectorAll: selector => selector === 'div,span,li,label,td,article,section,figure,p' ? cards : [] };
  const wrapper = { nodeType: 1, tagName: 'DIV', textContent: texts.join(' '), innerText: texts.join(' '),
    isConnected: true, children: cards, parentElement: body,
    getAttribute: () => null, matches: () => false, closest: () => null, querySelector: () => null,
    querySelectorAll: selector => selector === 'div,span,li,label,td,article,section,figure,p' ? cards : [],
    contains: node => node === wrapper || cards.includes(node), getClientRects: () => [{}],
    getBoundingClientRect: () => ({ left: 20, top: 40, width: 260, height: 60 }) };
  wrapper.querySelectorAll = selector => selector === 'div,span,li,label,td,article,section,figure,p' ? cards.flatMap(card => nestedTextChildren ? [card, ...card.children] : [card]) : [];
  body.children = sharedPointerWrapper ? [wrapper] : cards;
  if (sharedPointerWrapper) body.querySelectorAll = selector => selector === 'div,span,li,label,td,article,section,figure,p' ? [wrapper, ...cards] : [];
  for (const card of cards) card.parentElement = sharedPointerWrapper ? wrapper : body;
  const document = {
    body,
    documentElement: body,
    querySelectorAll: selector => selector.split(',').includes('input') && unrelatedInput ? [unrelatedInput] : [],
    elementFromPoint: (x, y) => cards.find(card => {
      const rect = card.getBoundingClientRect();
      return x >= rect.left && x <= rect.left + rect.width && y >= rect.top && y <= rect.top + rect.height;
    }) || null
  };
  const context = vm.createContext({
    location: { protocol: 'https:', origin: 'https://fixture.test', href: 'https://fixture.test/order' },
    innerWidth: 800, innerHeight: 600, scrollX: 0, scrollY: 0,
    crypto: { randomUUID }, Map,
    Date: { now: () => 100 },
    performance: { now: () => 10 },
    getComputedStyle: node => ({ visibility: 'visible', display: 'block', opacity: '1', cursor: cards.includes(node) || (sharedPointerWrapper && node === wrapper) ? 'pointer' : 'default', zIndex: '1' }),
    HTMLAnchorElement: class {}, HTMLButtonElement: class {}, HTMLInputElement: class {}, HTMLTextAreaElement: class {}, HTMLSelectElement: class {},
    document
  });
  const run = vm.runInContext(`(${pageOperation.toString()})`, context);
  return { run, cards };
}

test('browser_pick returns a fresh clickable ref and one validated next step for one exact card', async () => {
  const f = pickerFixture(['8 x 昆仑芯 P800', '1 x 昆仑芯 P800']);
  const result = await f.run('browser_pick', { chooseText: '1 x 昆仑芯 P800' }, [], true);
  assert.equal(result.status, 'not_found');
  assert.equal(result.reason, 'picker_card_candidates');
  assert.equal(result.dispatched, false);
  assert.equal(result.candidateCount, 1);
  assert.equal(result.candidates[0].match, 'exact');
  assert.equal(result.candidates[0].clickability, 'cursor-pointer');
  assert.equal(JSON.stringify(result.candidates[0].rect), JSON.stringify({ left: 160, top: 40, width: 120, height: 60 }));
  assert.match(result.candidates[0].path, /div\[1\]/);

  const step = nextStepFor('browser_pick', { tabId: 23, chooseText: '1 x 昆仑芯 P800' }, result);
  assert.equal(step.rule, 'picker_card_candidates');
  assert.equal(step.tool, 'browser_click');
  assert.deepEqual(step.arguments, { tabId: 23, ref: result.candidates[0].ref });
  assert.equal(f.cards[1].clickCount, 0, 'candidate discovery must never click the card');

  const clicked = await f.run('browser_click', { ref: result.candidates[0].ref }, [], true);
  assert.equal(clicked.clicked, true);
  assert.equal(f.cards[1].clickCount, 1);
});

test('browser_pick never clicks an unrelated bare checkbox while looking for a picker', async () => {
  let checked = false;
  const checkbox = {
    nodeType: 1, tagName: 'INPUT', type: 'checkbox', disabled: false, value: '', isConnected: true,
    getAttribute: () => null, matches: selector => selector.includes('input[type=password]') || selector.includes('input[type=hidden]') ? false : selector.split(',').includes('input'),
    closest: () => null, getClientRects: () => [{}], getBoundingClientRect: () => ({ left: 5, top: 5, width: 16, height: 16 }),
    scrollIntoView() {}, focus() {}, click() { checked = !checked; }
  };
  const f = pickerFixture(['1 x 昆仑芯 P800'], { unrelatedInput: checkbox });
  const result = await f.run('browser_pick', { chooseText: '1 x 昆仑芯 P800' }, [], true);
  assert.equal(checked, false);
  assert.equal(result.dispatched, false);
  assert.equal(result.reason, 'picker_card_candidates');
  assert.equal(result.candidates[0].match, 'exact');
});

test('a shared pointer wrapper ignores inherited cursor on small title spans', async () => {
  const f = pickerFixture(['1 x 昆仑芯 P800'], { sharedPointerWrapper: true, nestedTextChildren: true });
  const result = await f.run('browser_pick', { chooseText: '1 x 昆仑芯 P800' }, [], true);
  assert.equal(result.candidateCount, 1, 'the card is deduplicated from its small title span');
  assert.equal(result.candidates[0].tag, 'div');
  assert.equal(result.candidates[0].path.endsWith('div[0]'), true);
});

test('shared pointer wrapper yields individual card targets rather than the broad wrapper', async () => {
  const f = pickerFixture(['1 x 昆仑芯 P800', '8 x 昆仑芯 P800'], { sharedPointerWrapper: true });
  const result = await f.run('browser_pick', { chooseText: '1 x 昆仑芯 P800' }, [], true);
  assert.equal(result.candidateCount, 1);
  assert.match(result.candidates[0].path, /div\[0\]$/);
  assert.equal(nextStepFor('browser_pick', { tabId: 23, chooseText: '1 x 昆仑芯 P800' }, result).tool, 'browser_click');
});

test('picker card fallback does not turn substring or duplicate matches into a click recommendation', async () => {
  const substring = pickerFixture(['昆仑芯 P800 1 卡｜7.94 元/时']);
  const contains = await substring.run('browser_pick', { chooseText: '1 卡' }, [], true);
  assert.equal(contains.candidates[0].match, 'contains');
  assert.equal(nextStepFor('browser_pick', { tabId: 23, chooseText: '1 卡' }, contains).tool, 'browser_read');

  const duplicate = pickerFixture(['1 x 昆仑芯 P800', '1 x 昆仑芯 P800']);
  const ambiguous = await duplicate.run('browser_pick', { chooseText: '1 x 昆仑芯 P800' }, [], true);
  assert.equal(ambiguous.candidateCount, 2);
  assert.equal(nextStepFor('browser_pick', { tabId: 23, chooseText: '1 x 昆仑芯 P800' }, ambiguous).tool, 'browser_read');
});
