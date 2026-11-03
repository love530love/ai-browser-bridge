// These are the seven defects a real login exposed, in the order they cost time.
// Every one of them was reachable while 624 unit tests passed, because each test
// built its own result object and none of them asked the page for a ref.
//
// What can be tested without a browser is tested properly; what cannot is pinned
// to the line of code that has to exist, so a later refactor that removes it fails
// here instead of in someone's login.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { applyObserveBudget } from '../extension/observe-budget.js';
import { nextStepForError } from '../src/next-step.js';
import { validateCall } from '../src/tools.js';

const page = readFileSync(new URL('../extension/page.js', import.meta.url), 'utf8');
const worker = readFileSync(new URL('../extension/worker.js', import.meta.url), 'utf8');

test('P0: a password field gets a ref, a length, and no value', () => {
  // The documentation promised "browser_fill with secret:true", and the only read
  // path that minted a ref for a password field was browser_login_state. So the
  // promised route had no ref to take: observe reported 12 of 32 candidates and
  // the password box was among the missing.
  assert.match(page, /const secretField = el => el\.matches\('input\[type=password\]'\) && !el\.closest\('\[data-ai-private\]'\)/);
  assert.match(page, /if \(\(!visible\(el\) && !fileInput\(el\)\) \|\| \(sensitive\(el\) && !isSecret\)\) continue;/);
  // The value must never be in the payload, and the length must be.
  assert.match(page, /value: null, valueLength: length, hasValue: length > 0, secret: true/);
  // [data-ai-private] stays a hard exclusion: a length would leak from it too.
  assert.match(page, /el\.closest\('\[data-ai-private\]'\)/);
});

test('P0: searching for a password field finds it', () => {
  assert.match(page, /\['text', 'email', 'search', 'url', 'tel', 'number', 'password', ''\]/);
  assert.match(page, /const isSecret = el\.matches\('input\[type=password\]'\) && !el\.closest\('\[data-ai-private\]'\);/);
  assert.match(page, /needsSecretFill: true/);
  // A password field only accepts a secret fill, so the recommendation says so.
  assert.match(page, /tool: 'browser_fill_verified', args: \{ secret: true \}/);
});

test('P0: a plain fill on a password field names the flag instead of "protected"', () => {
  // "Element unavailable or protected" was true and unusable: the field was
  // visible, had a ref, and the only missing piece was one flag.
  assert.match(page, /Password field\. A plain fill is refused by design: call browser_fill or browser_fill_verified on this same ref with secret:true/);
  const step = nextStepForError('browser_fill', { tabId: 7, ref: 'a:1', text: 'x' }, 'Password field. A plain fill is refused by design: call browser_fill or browser_fill_verified on this same ref with secret:true and the same text.');
  assert.equal(step.rule, 'password_needs_secret_fill');
  assert.equal(step.kind, 'retry_with_changes');
  // The step must not carry the value it is advising about.
  assert.equal(step.tool, null);
  assert.deepEqual(step.arguments, {});
  assert.ok(!JSON.stringify(step).includes('"x"'), 'a step must never echo the secret');
});

test('P0: a key reports where it landed, so a paste can be judged', () => {
  assert.match(worker, /focusedElement = await page\('browser_active_element'\)/);
  assert.match(worker, /focusedElementUnreadable: true/);
  assert.match(page, /if \(name === 'browser_active_element'\)/);
  // Length, not value - and the secret branch must null the value out.
  assert.match(page, /valueLength: length, hasValue: length > 0/);
  assert.match(page, /\.\.\.\(isSecret \? \{ value: null, secret: true \}/);
});

test('P1: refs survive a re-read when the element list is unchanged', () => {
  // Nine observes for one login, nine different prefixes, not one element moved.
  // Validity was never the uuid: it is the fingerprint, checked on every use.
  assert.match(page, /const signature = picked\.map/);
  assert.match(page, /const reusable = !!previous && previous\.signature === signature && previous\.url === location\.href/);
  assert.match(page, /const snapshot = reusable \? previous\.state\.snapshot : crypto\.randomUUID\(\);/);
  assert.match(page, /sameAsPrevious: reusable, refsReusable: reusable/);
  assert.match(page, /globalThis\.__aiBrowserBridgeLastRead = \{ signature, url: location\.href, state \}/);
});

test('P1: the observe budget covers the whole payload, not just the text', () => {
  const read = {
    title: 't', url: 'https://example.test/', text: 'x'.repeat(4000),
    elements: Array.from({ length: 60 }, (_, i) => ({ ref: `s:${i + 1}`, tag: 'button', label: `b${i}` })),
    notices: []
  };
  const debug = { activeElement: null, roleCounts: { button: 60 }, visibleOptions: [], comboboxes: [], fileInputs: [], dialogs: [] };
  const geometry = read.elements.map(el => ({ ref: el.ref, width: 10, height: 10 }));
  const payload = { read, debug, geometry };
  assert.ok(JSON.stringify(payload).length > 5000);

  const out = applyObserveBudget(payload, 150);
  assert.ok(out.payloadChars <= 150, `payloadChars ${out.payloadChars} must respect the budget`);
  assert.equal(out.maxChars, 150);
  // Geometry goes first: it is read.elements plus boxes.
  assert.ok(out.trimmed.includes('geometry'));
  assert.equal(out.geometry, undefined);
  assert.equal(out.truncated, true);
  // The input is untouched, because the same observation also built the refs.
  assert.ok(payload.geometry.length > 0);
  assert.ok(payload.read.elements.length > 0);
});

test('P1: a payload inside the budget is returned unchanged', () => {
  const payload = { read: { text: 'hello', elements: [{ ref: 's:1' }] }, debug: { activeElement: null }, geometry: [] };
  const out = applyObserveBudget(payload, 16000);
  assert.equal(out.payloadChars, JSON.stringify(payload).length);
  assert.equal(out.trimmed, undefined);
  assert.deepEqual(out.geometry, []);
});

test('P2: a form error is its own field, not a text diff', () => {
  assert.match(page, /const NOTICE_SELECTOR = /);
  assert.match(page, /const collectNotices = \(limit = 5, deadline = Infinity\) =>/);
  assert.match(page, /notices, text: collected\.text/);
  // A container holding form controls is not a notice.
  assert.match(page, /if \(el\.querySelector\('input,textarea,select,button\[type=submit\]'\)\) continue;/);
});

test('P2: browser_wait can wait for time alone', () => {
  assert.match(page, /if \(!args\.text\) \{/);
  assert.match(page, /waitedMs: ms, matched: null/);
  // A delay is not evidence that the page settled, and the reply must say so.
  assert.match(page, /A delay is not evidence that the page settled/);
  // ms alone is a legal call now; tabId is the only required argument. The
  // "text or ms" rule lives in the page, because a schema cannot say "one of two".
  validateCall('browser_wait', { tabId: 3, ms: 600 });
  validateCall('browser_wait', { tabId: 3 });
  assert.match(page, /browser_wait needs text \(wait for visible text\) or ms \(a plain delay in milliseconds\)/);
});

test('P2: an unchanged fingerprint is settled before it is called unchanged', () => {
  assert.match(worker, /for \(const delay of \[120, 200\]\)/);
  assert.match(worker, /receipt\.pending = true/);
  assert.match(worker, /An asynchronous update may still be in flight/);
});

test('P3: an empty mount points at an expired session before it points at routes', () => {
  assert.match(page, /const settled = document\.readyState === 'complete';/);
  assert.match(page, /Reload the current URL first/);
  assert.match(page, /still be hydrating/);
});
