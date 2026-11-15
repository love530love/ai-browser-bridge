// Two failures that a unit test cannot reach, because both live inside code
// that only runs in a page or in the worker's frame aggregation. Neither was
// caught by the 582-test suite; both were caught by running the tool once
// against a real browser. These tests are static on purpose: they assert the
// shape that makes the runtime behaviour possible, so a later refactor cannot
// quietly delete the only path that produces it.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const page = readFileSync(new URL('../extension/page.js', import.meta.url), 'utf8');
const worker = readFileSync(new URL('../extension/worker.js', import.meta.url), 'utf8');

test('a fill never waits on a frame that a hidden document will not paint', () => {
  // Measured: requestAnimationFrame does not fire in a background tab, so the
  // two-frame settle wait hung until the 20s tool timeout while the field had
  // already been filled. The caller was told "outcome may be unknown" about a
  // write that had succeeded - the exact ambiguity this bridge exists to remove.
  assert.match(page, /document\.visibilityState === 'hidden'/, 'the settle wait must check for a hidden document');
  assert.match(page, /timer_hidden_document/, 'a timer-based wait has to be labelled as such');
  assert.match(page, /timer_animation_frame_starved/, 'a starved frame callback needs a bound, not a hang');
  // The wait is raced, not merely guarded: a visible tab whose frames are
  // throttled (minimised window, occluded surface) hits the same hang otherwise.
  assert.match(page, /requestAnimationFrame\(\(\) => requestAnimationFrame\(\(\) => finish\('animation_frame'\)\)\)/);
  assert.match(page, /settleMode/, 'how the wait ended is evidence and must be reported');
});

test('hidden-document guidance never tells the caller to steal the foreground', () => {
  // Background writes are a supported path, verified live by
  // test/background-concurrency.js. Advice to raise the window would interrupt
  // the human and is exactly what the background contract forbids.
  assert.doesNotMatch(page, /browser_windows_control to activate the window before the next write/);
  assert.match(page, /Do not activate the window for automation/);
  assert.match(page, /DOM and CDP writes keep working in the background/);
});

test('the live background test is wired and measures the OS foreground', () => {
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  const script = readFileSync(new URL('./background-concurrency.js', import.meta.url), 'utf8');
  assert.equal(pkg.scripts['test:background'], 'node test/background-concurrency.js');
  assert.match(script, /GetForegroundWindow/, 'the test must measure the real OS foreground window');
  assert.match(script, /active: false/, 'test tabs must be opened without activation');
  assert.doesNotMatch(script, /active: true/, 'the test must never activate its tabs');
  assert.match(script, /allowRepeat: true/, 'the repeated-click escape hatch must be covered');
});

test('both finders compute the not-rendered diagnostic on a miss', () => {
  const calls = page.match(/notRenderedDiagnostic\(\)/g) || [];
  assert.ok(calls.length >= 2, `expected a call per finder, found ${calls.length}`);
  assert.match(page, /not_rendered_possible/);
  // The diagnostic is only honest when there is something scrollable: without
  // containers it must be absent rather than a generic "maybe try scrolling".
  assert.match(page, /if \(!containers\.length\) return undefined;/);
});

test('the worker carries notRendered across the frame boundary', () => {
  // The diagnostic was computed on every miss and dropped by a per-frame field
  // whitelist, so browser_find_text never showed one while browser_find_element
  // did. A field that only appears on a miss is the one a projection forgets.
  assert.match(worker, /\.\.\.\(result\.notRendered \? \{ notRendered: result\.notRendered \} : \{\}\)/,
    'the find_text frame projection must forward notRendered');
  assert.match(worker, /\.\.\.\(notRendered \? \{ notRendered \} : \{\}\)/,
    'the aggregate result must surface notRendered when nothing matched');
});
