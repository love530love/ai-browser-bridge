// Two properties that decide whether a weak caller can act correctly, tested
// without a browser because both are pure functions of a call and two
// fingerprints.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  RECEIPT_TOOLS, DEDUPE_TOOLS, DUPLICATE_WINDOW_MS, duplicateKey, describeChange, suppressionResult
} from '../extension/receipt.js';
import { validateCall } from '../src/tools.js';

const fp = (over = {}) => ({
  url: 'https://app.test/instances', title: 'Instances', readyState: 'complete',
  textLength: 1000, interactive: 20, focus: null, dialog: null, scroll: { x: 0, y: 0 },
  digest: 'aaaaaaaa', ...over
});

test('a receipt says what changed, and says nothing changed rather than nothing happened', () => {
  const before = fp();
  const after = fp({ digest: 'bbbbbbbb', textLength: 1040, interactive: 21, focus: 'button#save' });
  const receipt = describeChange(before, after);
  assert.equal(receipt.changed, true);
  assert.equal(receipt.textDelta, 40);
  assert.equal(receipt.interactiveDelta, 1);
  assert.deepEqual(receipt.focus, { from: null, to: 'button#save' });
  assert.match(receipt.note, /not proof that it was the intended thing/);

  const unchanged = describeChange(before, fp());
  assert.equal(unchanged.changed, false);
  // The wording matters more than the boolean: "no change" is not "did not work".
  assert.match(unchanged.note, /not evidence that the action failed/);
});

test('a missing fingerprint is reported as missing evidence, never as no change', () => {
  const receipt = describeChange(null, fp());
  assert.equal(receipt.changed, null);
  assert.equal(receipt.measured, false);
  assert.match(receipt.note, /not evidence that nothing changed/);
});

test('the duplicate key includes the page state, so a legitimate repeat is not a duplicate', () => {
  const args = { tabId: 3, ref: 'e1' };
  const first = duplicateKey('browser_click', 3, args, 'aaaaaaaa');
  const sameState = duplicateKey('browser_click', 3, args, 'aaaaaaaa');
  const pageMovedOn = duplicateKey('browser_click', 3, args, 'bbbbbbbb');
  assert.equal(first, sameState, 'the same action on the same page state is the same action');
  assert.notEqual(first, pageMovedOn, 'clicking next twice changes the page, so it is a different action');

  // allowRepeat and agent change the caller, not the action.
  assert.equal(duplicateKey('browser_click', 3, { ...args, allowRepeat: true }, 'aaaaaaaa'), first);
  assert.equal(duplicateKey('browser_click', 3, { ...args, agent: 'a1' }, 'aaaaaaaa'), first);
  // The payload itself must matter.
  assert.notEqual(duplicateKey('browser_click', 3, { ...args, ref: 'e2' }, 'aaaaaaaa'), first);
  assert.notEqual(duplicateKey('browser_fill', 3, args, 'aaaaaaaa'), first);
});

test('a re-read between attempts does not make the same click a different action', () => {
  // Measured on the real browser: every read mints a new snapshot uuid, so
  // comparing raw refs meant three identical clicks were three dispatches.
  const a = { tabId: 3, ref: '11111111-2222-3333-4444-555555555555:4' };
  const b = { tabId: 3, ref: '99999999-8888-7777-6666-555555555555:4' };
  assert.equal(duplicateKey('browser_click', 3, a, 'aaaaaaaa'), duplicateKey('browser_click', 3, b, 'aaaaaaaa'));
  // The index still separates different targets, and the fingerprint still
  // separates different page states.
  assert.notEqual(duplicateKey('browser_click', 3, a, 'aaaaaaaa'), duplicateKey('browser_click', 3, { ...a, ref: '11111111-2222-3333-4444-555555555555:5' }, 'aaaaaaaa'));
  assert.notEqual(duplicateKey('browser_click', 3, a, 'aaaaaaaa'), duplicateKey('browser_click', 3, b, 'bbbbbbbb'));
});

test('a suppression is a refusal with a name, not a failure', () => {
  const now = Date.now();
  const result = suppressionResult({ name: 'browser_click', before: fp(), prior: { at: now - 1200, status: 'success' }, now });
  assert.equal(result.status, 'duplicate_suppressed');
  assert.equal(result.dispatched, false);
  assert.equal(result.retryable, false);
  assert.equal(result.duplicateOf.ageMs, 1200);
  assert.equal(result.receipt.suppressed, true);
  assert.match(result.recommendedNextAction, /allowRepeat:true/);
  assert.ok(DUPLICATE_WINDOW_MS > 0 && DUPLICATE_WINDOW_MS <= 30000);
});

test('every tool that can produce a receipt is a real tool, and dedupe is a subset', async () => {
  const { TOOLS } = await import('../src/tools.js');
  const names = new Set(TOOLS.map(tool => tool.name));
  for (const name of RECEIPT_TOOLS) assert.ok(names.has(name), `${name} must exist`);
  for (const name of DEDUPE_TOOLS) {
    assert.ok(RECEIPT_TOOLS.has(name), `${name} cannot be deduped without a receipt`);
  }
});

test('the escape hatch is in the schema, so a caller that means to repeat can say so', () => {
  for (const name of DEDUPE_TOOLS) {
    const args = { tabId: 1, allowRepeat: true };
    // validateCall also enforces the other required arguments, so this asserts
    // only that allowRepeat itself is accepted rather than unknown.
    try {
      validateCall(name, args);
    } catch (error) {
      assert.ok(!/Unknown argument: allowRepeat/.test(error.message), `${name} must accept allowRepeat`);
    }
  }
  assert.throws(() => validateCall('browser_read', { tabId: 1, allowRepeat: true }), /Unknown argument: allowRepeat/);
});

test('the worker takes the fingerprint on both sides and only remembers dispatched actions', () => {
  const worker = readFileSync(new URL('../extension/worker.js', import.meta.url), 'utf8');
  assert.match(worker, /args: \['browser_receipt'/, 'the worker must ask the page for a fingerprint');
  assert.match(worker, /const before = wantsReceipt \? await readFingerprint\(\) : null;/);
  assert.match(worker, /let after = await readFingerprint\(\);/);
  // One sample taken immediately after dispatch lands before an async render, so
  // "changed:false" was a false negative on every tab switch and every submit.
  // The worker must take a second, settled sample before it calls it unchanged.
  assert.match(worker, /after\.digest === before\.digest/, 'an unchanged fingerprint must trigger a settle');
  assert.match(worker, /receipt\.pending = true/);
  assert.match(worker, /settledMs/);
  // A refused click must not make the next correct click look like a repeat.
  assert.match(worker, /if \(before && dispatched\) \{/);
  assert.match(worker, /routedArgs\.allowRepeat !== true/);
});

test('the page-side fingerprint never reads what was typed', () => {
  const page = readFileSync(new URL('../extension/page.js', import.meta.url), 'utf8');
  const start = page.indexOf('const pageFingerprint = (');
  assert.ok(start > 0, 'pageFingerprint must exist');
  const body = page.slice(start, page.indexOf('if (name === \'browser_receipt\')'));
  assert.ok(!/\.value\b/.test(body), 'a receipt must not include input values');
  assert.ok(!/innerText/.test(body), 'innerText would force layout twice per action');
  assert.match(body, /digest/, 'the comparison needs a cheap digest');
  // A checkbox flipping changes none of url/title/text-length/interactive, so a
  // digest built from those alone reported changed:false for an action that
  // visibly changed the page. The control state has to be part of the digest.
  assert.match(body, /controlState/, 'the digest must include toggle state');
});

test('the acted-on element is reported by state, never by value', () => {
  const page = readFileSync(new URL('../extension/page.js', import.meta.url), 'utf8');
  const start = page.indexOf('const watchState = ref => {');
  assert.ok(start > 0, 'watchState must exist');
  const body = page.slice(start, page.indexOf('const pageFingerprint = ('));
  assert.match(body, /valueLength/, 'the length is the only signal a caller needs');
  assert.match(body, /ariaChecked/, 'aria state is what a div-based toggle reports');
  assert.ok(!/value:\s*[^,\n]*el\.value/.test(body), 'watchState may read the length, never the value itself');
});
