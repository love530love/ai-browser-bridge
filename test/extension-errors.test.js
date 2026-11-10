// "Update the extension, then clear the errors" is a maintenance step a person
// performs every time they ship a build, so it has to either work or say why it
// did not. Three ways it used to fail quietly:
//
// 1. With any number of Chrome windows other than exactly one, the clear step
//    returned status "skipped" - while the reload result next to it still said
//    success. Two windows is an ordinary desktop, so this was permanent.
// 2. The page reload that makes the error list readable waited a fixed 1800ms.
//    On a slow page the walk came back empty, and an empty walk was reported as
//    "nothing to clear" - the same answer as a genuinely clean list.
// 3. A reload of the front tab was the only way to create a document, and the
//    front tab was never identified. Reloading a user's page to read an error
//    list is not a trade this tool gets to make.
//
// The assertions below are static reads: the behaviour lives in a PowerShell
// script that drives a real Chrome window, which no unit test can stand up.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describeErrorList, clearExtensionErrors } from '../src/extension-errors.js';

const script = readFileSync(new URL('../scripts/clear-extension-errors.ps1', import.meta.url), 'utf8');
const serverSource = readFileSync(new URL('../src/server.js', import.meta.url), 'utf8');
const workerSource = readFileSync(new URL('../extension/worker.js', import.meta.url), 'utf8');

test('only a page read that found the list empty counts as clean', () => {
  // 0.35.1: a clean verdict is worthless unless the script proved WHICH page
  // it read. These are the fields the real PowerShell result carries.
  const pageEvidence = {
    addressVerified: true,
    documentVisible: true,
    address: 'chrome://extensions',
    targetResolution: 'address_bar_match'
  };

  const cleared = describeErrorList({ status: 'cleared', controlGone: true, errorEntriesAfter: 0, ...pageEvidence });
  assert.equal(cleared.errorListCleared, true);
  assert.equal(cleared.errorList.cleared, true);
  assert.equal(cleared.errorList.controlGone, true);
  assert.equal(cleared.errorList.addressVerified, true);
  assert.equal(cleared.errorListClearStep, undefined, 'a clean result needs no follow-up step');

  const empty = describeErrorList({ status: 'nothing_to_clear', ...pageEvidence });
  assert.equal(empty.errorListCleared, true);

  // A bare status string - or a verdict with only half the evidence - must
  // never read as clean. This is the exact shape that caused the false clear.
  for (const incomplete of [
    { status: 'nothing_to_clear' },
    { status: 'nothing_to_clear', documentVisible: true },
    { status: 'nothing_to_clear', addressVerified: true },
    { status: 'cleared', controlGone: true },
    { status: 'cleared', controlGone: true, documentVisible: true },
    { status: 'cleared', ...pageEvidence }
  ]) {
    const described = describeErrorList(incomplete);
    assert.equal(described.errorListCleared, false, JSON.stringify(incomplete));
    assert.equal(described.errorListClearStep.reason, 'clean_verdict_without_page_evidence');
  }

  // Every other status keeps cleared:false and must carry a way forward.
  for (const status of ['failed', 'uncertain', 'unavailable', 'skipped', 'anything_else']) {
    const described = describeErrorList({ status, reason: 'page_not_ready', nextStep: 'read the page again' });
    assert.equal(described.errorListCleared, false, `${status} must not read as clean`);
    assert.equal(described.errorList.status, status);
    assert.equal(described.errorList.reason, 'page_not_ready');
    assert.equal(described.errorListClearStep.reason, 'page_not_ready');
    assert.equal(described.errorListClearStep.howToRetry, 'read the page again');
  }
});

test('a missing verdict is reported as unknown, never as clean', () => {
  for (const value of [undefined, null, {}, { status: 42 }, 'cleared']) {
    const described = describeErrorList(value);
    assert.equal(described.errorListCleared, false);
    assert.equal(described.errorList.reason, 'no_result_from_clear_step');
    assert.match(described.errorListClearStep.howToRetry, /unknown/);
  }
});

test('an explicit target is validated instead of silently widened', async () => {
  await assert.rejects(() => clearExtensionErrors({ processId: '11' }), /Exact process required/);
  await assert.rejects(() => clearExtensionErrors({ windowHandle: 0 }), /Exact window required/);
  const unsupported = await clearExtensionErrors({}, { platform: 'linux' });
  assert.equal(unsupported.status, 'unavailable');
  assert.equal(unsupported.retryable, false);
});

test('error-list clearing binds UIA to the process that holds the extension', () => {
  const body = serverSource.slice(serverSource.indexOf('async function clearExtensionErrorsViaUia')).slice(0, 4200);
  assert.match(body, /processId: owner\.pid/, 'the UIA walk must be bound to extensionOwner.pid');
  assert.match(body, /clearExtensionErrors\(boundTarget\)/);
  assert.doesNotMatch(body, /extension_host_not_chrome_ui/,
    'a non-chrome host must not be a blanket refusal; bind by pid and let page evidence decide');
  assert.match(body, /hostBinding/, 'an unreachable host must be reported with its own identity');
});

test('the clear step is not gated on there being exactly one Chrome window', () => {
  // The skip is what turned a normal two-window desktop into a silent no-op.
  const body = serverSource.slice(serverSource.indexOf('async function clearExtensionErrorsViaUia'));
  assert.doesNotMatch(body.slice(0, 1600), /windows\.length !== 1/,
    'the number of Chrome windows must not decide whether the clear runs');
  assert.doesNotMatch(script, /status = 'skipped'/,
    'the script must never return skipped: nothing in it can decide to do nothing and still be right');
  assert.match(script, /reason = 'target_window_ambiguous'/,
    'several windows and no identifiable page must fail with candidates');
  assert.match(script, /reason = 'multiple_errors_pages'/);
});

test('the target window is identified by what it is showing, not by counting windows', () => {
  assert.match(script, /Get-AddressValues/, 'the address bar has to be read to identify the page');
  assert.match(script, /reason = 'errors_page_not_front'/,
    'a front tab that is not the error list must stop the reload instead of reloading the user page');
  const gate = script.indexOf("reason = 'errors_page_not_front'");
  const click = script.indexOf("Find-Button $rows 'Reload'");
  assert.ok(gate > 0 && click > gate, 'the address check must come before the Reload control is looked up');
  // Offscreen is true for every control of a minimised window, so the value
  // still has to be read - the identification must not depend on visibility.
  const reader = script.slice(script.indexOf('function Get-AddressValues'), script.indexOf('function Show-Candidates'));
  assert.doesNotMatch(reader, /IsOffscreen/, 'reading the address must not depend on the window being visible');
});

test('a page that never becomes readable is a failure, not an empty list', () => {
  const notReady = script.indexOf("reason = 'page_not_ready'");
  const nothingToClear = script.indexOf("status = 'nothing_to_clear'");
  assert.ok(notReady > 0, 'the wait for a document has to time out into an explicit reason');
  assert.ok(nothingToClear > notReady, 'nothing_to_clear must only be reachable after the page was read');
  const guard = script.lastIndexOf('if (-not $documentVisible)', nothingToClear);
  assert.ok(guard > 0, 'nothing_to_clear has to sit behind a documentVisible guard');
  const block = script.slice(nothingToClear, script.indexOf('$dispatched = Invoke-Btn $clearAll'));
  assert.match(block, /documentVisible = \$true/, 'the empty verdict must state that the page was actually read');
  // The fixed sleep is what made a slow page indistinguishable from a clean one.
  assert.doesNotMatch(script, /Start-Sleep -Milliseconds 1800/, 'the document wait must poll, not sleep a guessed amount');
  assert.match(script, /do \{[\s\S]{0,400}?Has-Document \$rows[\s\S]{0,200}?\} while \(\$deadline\.ElapsedMilliseconds -lt \$DocumentTimeoutMs\)/,
    'the document wait must be a bounded poll');
});

test('a minimised window is restored without taking the foreground, and the restore is verified', () => {
  assert.match(script, /ShowWindow\(\$target\.Handle, 4\)/, 'SW_SHOWNOACTIVATE is what avoids stealing focus');
  assert.match(script, /\$restoredFromMinimized = -not \[BridgeChromeWindows\]::IsIconic\(\$target\.Handle\)/,
    'ShowWindow returns the previous visibility, so the restore has to be confirmed by asking the window');
});

test('only a step that clicked nothing may be retried', () => {
  const body = serverSource.slice(serverSource.indexOf('async function clearExtensionErrorsViaUia'));
  const loop = body.slice(0, body.indexOf('return { ...entry, attempts }'));
  assert.match(loop, /entry\?\.status !== 'failed' \|\| entry\.retryable !== true/,
    'a retry must require both a failure and the script saying it is retryable');
  assert.match(loop, /attempt <= 2/, 'the retry has to be bounded');
  assert.doesNotMatch(loop, /status === 'uncertain'[\s\S]{0,120}?continue/,
    'an uncertain Invoke may have landed and must not be repeated');
});

test('the reload result separates "the reload worked" from "the list is gone"', () => {
  assert.match(serverSource, /described\.errorListCleared \? \{\} : \{ partial: true \}/,
    'a verified reload with a red list must be marked partial instead of reported as a clean success');
  assert.doesNotMatch(workerSource, /errorsClearedBy/,
    'the worker must not claim the reload clears the list: Chrome keeps those entries per extension id, outside the worker');
});

test('a failed clear step reports unknown with a read-only next step, never "reload again"', () => {
  // Extract the REAL nextStep literals from the shipped PowerShell script. A
  // test that invents its own wording stays green while the string the caller
  // actually sees regresses - the projection bug this contract exists to stop.
  const literals = [...script.matchAll(/nextStep = '([^']*)'/g)].map(m => m[1]);
  assert.ok(literals.length >= 10, `every failure branch must carry a nextStep, got ${literals.length}`);
  for (const text of literals) {
    assert.doesNotMatch(text, /call browser_reload_extension again|then repeat/i,
      `a clear-step failure must not tell the caller to repeat the extension reload: ${text}`);
    assert.match(text, /browser_extension_errors/, 'must name the read-only error-list page');
    assert.match(text, /unknown, not proof that errors remain/i,
      'must say the list state is unknown rather than implying errors are still there');
    assert.match(text, /Do not repeat browser_reload_extension/, 'must warn against a second reload');
  }

  // Rendered-text assertion: no_chrome_window is the exact branch that fired
  // on a host with no visible Chrome window. Check what describeErrorList()
  // actually hands back as howToRetry, not just the in-memory input object.
  const noWindow = literals.find(t => /not showing any visible window/i.test(t));
  assert.ok(noWindow, 'the no_chrome_window wording must exist');
  const described = describeErrorList({
    status: 'failed', reason: 'no_chrome_window', documentVisible: false,
    scanned: 0, nextStep: noWindow
  });
  assert.equal(described.errorListCleared, false);
  assert.equal(described.errorListClearStep.reason, 'no_chrome_window');
  assert.equal(described.errorListClearStep.howToRetry, noWindow,
    'the projected text must be the shipped wording verbatim');
  assert.doesNotMatch(described.errorListClearStep.howToRetry, /call browser_reload_extension again/i);
  assert.match(described.errorListClearStep.howToRetry, /browser_extension_errors/);
  assert.match(described.errorListClearStep.howToRetry, /unknown/i);
  assert.equal(described.errorList.nextStep, noWindow,
    'the evidence whitelist must not drop nextStep');
});
