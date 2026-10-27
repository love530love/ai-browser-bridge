// Locks browser_otp_fetch's ageHint to "evidence, never a filter".
//
// The tempting feature is sinceMinutes: drop every row older than N minutes and
// return the one code that is left. It was rejected because its failure mode is
// silent and it is the worst possible failure here. A wrong timezone, a locale
// the patterns do not know, or a row that says "yesterday 23:58" removes the
// code that works, and the reply then says "no code found" - indistinguishable
// from "the mailbox has no code", which sends the caller to re-request a code
// and burn a rate limit. So the row's own time words travel with the candidate
// and nothing is excluded.
//
// pageOperation is serialised into the page, so it cannot be imported into a
// real DOM; these assertions run it inside node:vm against hand-built rows, the
// same way test/login-phase.test.js does. What is real here is the classification
// and the "nothing was filtered" property, not the DOM.
import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { randomUUID } from 'node:crypto';
import { pageOperation } from '../extension/page.js';

const HREF = 'https://mail.fixture.test/inbox';
const ORIGIN = 'https://mail.fixture.test';

function row(text) {
  return {
    tagName: 'LI',
    innerText: text,
    textContent: text,
    disabled: false,
    readOnly: false,
    labels: [],
    parentElement: null,
    getAttribute: () => null,
    matches: selector => String(selector).split(',').some(part => {
      const s = part.trim();
      if (s === 'input[type=password]' || s === 'input[type=hidden]') return false;
      if (s === 'input[type=file]') return false;
      return false;
    }),
    closest: () => null,
    getClientRects: () => [{}],
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 400, height: 40 }),
    focus: () => {},
    dispatchEvent: () => true,
    ownerDocument: { getElementById: () => null }
  };
}

function fetchCodes(rows) {
  const nodes = rows.map(row);
  const document = {
    title: 'Inbox',
    body: { innerText: nodes.map(node => node.innerText).join('\n') },
    querySelectorAll: () => nodes,
    getElementById: () => null
  };
  const context = vm.createContext({
    location: { protocol: 'https:', origin: ORIGIN, href: HREF },
    innerWidth: 900, innerHeight: 700, scrollX: 0, scrollY: 0,
    crypto: { randomUUID }, Map, Set, Date, console,
    setTimeout, clearTimeout,
    performance: { now: () => 0 },
    getComputedStyle: () => ({ visibility: 'visible', display: 'block', contentVisibility: 'visible', opacity: '1', position: 'static', zIndex: 'auto' }),
    InputEvent: class InputEvent { constructor(type, init) { this.type = type; Object.assign(this, init ?? {}); } },
    Event: class Event { constructor(type, init) { this.type = type; Object.assign(this, init ?? {}); } },
    MouseEvent: class MouseEvent { constructor(type, init) { this.type = type; Object.assign(this, init ?? {}); } },
    MutationObserver: class MutationObserver { observe() {} disconnect() {} },
    HTMLInputElement: class HTMLInputElement {},
    HTMLTextAreaElement: class HTMLTextAreaElement {},
    HTMLSelectElement: class HTMLSelectElement {},
    document
  });
  const run = vm.runInContext(`(${pageOperation.toString()})`, context);
  return run('browser_otp_fetch', { tabId: 1, requireKeyword: true }, [ORIGIN], false);
}

const ageOf = (result, code) => (result.candidates.find(candidate => candidate.code === code) ?? {}).ageHint ?? null;

test('a row that says "just now" is just_now', async () => {
  const result = await fetchCodes(['Just now\nYour verification code is 482913']);
  const age = ageOf(result, '482913');
  assert.equal(age?.kind, 'just_now');
  assert.match(age.text, /just now/i);
});

test('a row that says "5 minutes ago" is minutes', async () => {
  const result = await fetchCodes(['5 minutes ago\nYour one-time code is 731204']);
  assert.equal(ageOf(result, '731204')?.kind, 'minutes');
});

test('a Chinese row that says 3分钟前 is minutes, not not_stated', async () => {
  // The mailbox is usually in the caller's own language, so the patterns cannot
  // be English-only.
  const result = await fetchCodes(['3分钟前\n您的验证码是 889900，请勿泄露']);
  const age = ageOf(result, '889900');
  assert.equal(age?.kind, 'minutes');
  assert.match(age.text, /3分钟前/);
});

test('hours and days are distinguished from each other', async () => {
  const result = await fetchCodes([
    '2 hours ago\nYour login code is 918273',
    'yesterday 23:58\nYour verification code is 550011'
  ]);
  assert.equal(ageOf(result, '918273')?.kind, 'hours');
  assert.equal(ageOf(result, '550011')?.kind, 'days');
});

test('a bare clock time is clock_only, not guessed into today', async () => {
  // "14:32" can be today or any other day. Guessing "today" is exactly the kind
  // of silent inference this field exists to avoid.
  const result = await fetchCodes(['14:32\nYour verification code is 770033']);
  assert.equal(ageOf(result, '770033')?.kind, 'clock_only');
});

test('a row with no time words says not_stated rather than inventing one', async () => {
  const result = await fetchCodes(['Your verification code is 660022']);
  assert.equal(ageOf(result, '660022')?.kind, 'not_stated');
  assert.equal(ageOf(result, '660022')?.text, null);
});

test('an old-looking row is still returned, with its age attached', async () => {
  // The whole point: age is evidence. A three-week-old code must not be dropped,
  // because the caller may be looking at a mailbox where that is the only code.
  const result = await fetchCodes(['3 weeks ago\nYour verification code is 110044']);
  assert.equal(result.candidates.some(candidate => candidate.code === '110044'), true);
  assert.equal(ageOf(result, '110044')?.kind, 'weeks_or_more');
});

test('every candidate carries the note that nothing was filtered by age', async () => {
  const result = await fetchCodes([
    'Just now\nYour verification code is 482913',
    '2026-10-20\nYour verification code is 660022'
  ]);
  assert.match(result.ageHintNote, /nothing was filtered/i);
  assert.match(result.ageHintNote, /sinceMinutes/);
  // Two candidates, two different ages: if a filter had been applied by accident
  // only one of them would be here.
  assert.equal(result.candidates.length, 2);
  assert.notEqual(ageOf(result, '482913')?.kind, ageOf(result, '660022')?.kind);
});
