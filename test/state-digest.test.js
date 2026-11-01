// The digest exists because a weak caller cannot hold a full page read. That
// makes two things load-bearing: the shape must not grow with the page, and it
// must not become a channel that echoes what the user typed. Both are tested
// here as properties of the projection, with no browser involved.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { digestState } from '../extension/state-digest.js';
import { TOOLS, validateCall } from '../src/tools.js';

const element = (over = {}) => ({
  ref: 'e1', tag: 'button', role: null, label: 'Save', type: null, value: null, readOnly: false, disabled: false,
  ...over
});

const read = (over = {}) => ({
  url: 'https://app.test/instances', title: 'Instances', readyState: 'complete',
  viewport: { width: 1280, height: 800 },
  text: 'A short page.',
  elements: [element(), element({ ref: 'e2', tag: 'a', label: 'Next page' })],
  ...over
});

test('the digest keeps the shape small no matter how big the page is', () => {
  const many = Array.from({ length: 300 }, (_, i) => element({ ref: `e${i}`, label: `Item ${i}` }));
  const digest = digestState(read({ elements: many, text: 'x'.repeat(9000) }), { tabId: 7 });
  assert.equal(digest.status, 'success');
  assert.ok(digest.actions.length <= 8, `expected at most 8 actions, got ${digest.actions.length}`);
  assert.ok(digest.text.length <= 420, `expected at most 420 chars of text, got ${digest.text.length}`);
  assert.deepEqual(digest.counts, { elements: 300, actionable: 300, shown: digest.actions.length });
  // Saying it is a sample is the difference between a caller that reads more and
  // a caller that concludes the page only has eight controls.
  assert.equal(digest.truncated, true);
});

test('a page that fits is not marked truncated', () => {
  const digest = digestState(read(), { tabId: 7 });
  assert.equal(digest.truncated, undefined);
  assert.equal(digest.counts.shown, 2);
  assert.equal(digest.url, 'https://app.test/instances');
});

test('the digest never carries a field value, only whether there is one', () => {
  const digest = digestState(read({
    elements: [element({ ref: 'e1', tag: 'input', type: 'text', label: 'Email', value: 'user@example.test' })]
  }), { tabId: 7 });
  const [action] = digest.actions;
  assert.equal(action.hasValue, true);
  assert.equal(action.value, undefined);
  assert.ok(!JSON.stringify(digest).includes('user@example.test'), 'the digest must not echo typed text');
  // The label is page content and stays, because it is how a caller chooses.
  assert.equal(action.label, 'Email');
});

test('only actionable, enabled elements are offered as actions', () => {
  const digest = digestState(read({
    elements: [
      element({ ref: 'e1', tag: 'div', label: 'Decoration' }),
      element({ ref: 'e2', tag: 'button', label: 'Disabled', disabled: true }),
      element({ ref: 'e3', tag: 'div', role: 'button', label: 'Custom control' }),
      element({ ref: 'e4', tag: 'a', label: 'Link' })
    ]
  }), { tabId: 7 });
  assert.deepEqual(digest.actions.map(item => item.ref), ['e3', 'e4']);
  assert.equal(digest.counts.elements, 4);
  assert.equal(digest.counts.actionable, 2);
});

test('maxActions and maxTextChars are honoured and still reported honestly', () => {
  const many = Array.from({ length: 12 }, (_, i) => element({ ref: `e${i}` }));
  const digest = digestState(read({ elements: many, text: 'y'.repeat(300) }), { tabId: 7, maxActions: 3, maxTextChars: 100 });
  assert.equal(digest.actions.length, 3);
  assert.equal(digest.text.length, 100);
  assert.equal(digest.truncated, true);
  assert.equal(digest.counts.actionable, 12);
});

test('an unreadable page is a failure with one next step, not an empty success', () => {
  const digest = digestState(null, { tabId: 7 });
  assert.equal(digest.status, 'failed');
  assert.equal(digest.retryable, true);
  assert.equal(digest.reason, 'state_unavailable');
  // An empty action list would read as "this page has no controls".
  assert.equal(digest.actions, undefined);
  assert.equal(digest.nextStep.tool, 'browser_read');
  assert.equal(digest.nextStep.arguments.tabId, 7);
});

test('browser_at is a registered read-only tool that accepts the digest knobs', () => {
  const entry = TOOLS.find(tool => tool.name === 'browser_at');
  assert.ok(entry, 'browser_at must exist');
  assert.equal(entry.annotations.readOnlyHint, true);
  validateCall('browser_at', { tabId: 1 });
  validateCall('browser_at', { tabId: 1, maxActions: 5, maxTextChars: 300, mode: 'cheap' });
  assert.throws(() => validateCall('browser_at', { tabId: 1, maxActions: 0 }), /maxActions/);
  assert.throws(() => validateCall('browser_at', { tabId: 1, maxTextChars: 10 }), /maxTextChars/);
  // No allowRepeat: a read has no effect to repeat.
  assert.throws(() => validateCall('browser_at', { tabId: 1, allowRepeat: true }), /Unknown argument: allowRepeat/);
});

test('the worker summarises the same read rather than reading the page a second way', () => {
  const worker = readFileSync(new URL('../extension/worker.js', import.meta.url), 'utf8');
  // The dispatch whitelist sits before the branch, so a tool that is registered
  // in src/tools.js but missing here dies with "Unknown command" and every unit
  // test still passes. That has happened before with browser_transient and
  // browser_popup; browser_at hit it too, on the real browser.
  const listLine = worker.split('\n').find(line => line.includes("throw new Error('Unknown command')"));
  assert.ok(listLine?.includes("'browser_at'"), 'browser_at must be in the worker dispatch list');
  const start = worker.indexOf("if (name === 'browser_at') {");
  assert.ok(start > 0, 'the worker must handle browser_at');
  const body = worker.slice(start, worker.indexOf('const target = Number.isInteger(routedArgs.frame)', start));
  // One reader: the digest path must go through pageOperation with browser_read,
  // or "the digest agrees with the read" stops being true by construction.
  assert.match(body, /func: pageOperation, args: \['browser_read'/);
  assert.match(body, /digestState\(/);
  assert.match(body, /__aibError/);
});
