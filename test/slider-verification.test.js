// Slider/jigsaw verification contract. page.js is serialised into the page by
// chrome.scripting and cannot be imported, so the injected half is pinned at
// the source level and the service half through the real schema, validation,
// index and guide functions.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { TOOLS, validateCall } from '../src/tools.js';
import { TOOL_GROUPS, TOOL_ALIASES, groupsForGoal } from '../src/tool-index.js';
import { capabilityGuide } from '../src/capability-guide.js';

const read = relative => readFileSync(new URL('../' + relative, import.meta.url), 'utf8');
const page = read('extension/page.js');
const worker = read('extension/worker.js');
const tools = read('src/tools.js');
const cdp = read('extension/cdp.js');

test('slider tools are registered, indexed and routed from plain language', () => {
  for (const name of ['browser_slider_probe', 'browser_slider_solve_verified']) {
    const tool = TOOLS.find(entry => entry.name === name);
    assert.ok(tool, `${name} missing from the tool catalogue`);
    assert.ok(tool.inputSchema.required.includes('tabId'), `${name} must bind to one tab`);
    assert.ok(TOOL_GROUPS.some(group => group.tools.includes(name)), `${name} missing from the intent index`);
  }
  assert.match(TOOL_ALIASES.act.join(' '), /滑块/, 'a plain-language goal must reach the slider group');
  assert.ok(groupsForGoal('页面出现滑块拼图验证怎么过').some(group => group.id === 'act'));
  const guide = capabilityGuide({ goal: '滑块验证挡住了获取验证码' });
  assert.equal(guide.primary.intent, 'slider-verification');
  assert.equal(guide.focusRequired, false, 'solving does not require the foreground');
  assert.ok(guide.primary.tools.includes('browser_slider_solve_verified'));
});

test('the slider schema refuses ranges its implementation cannot honour', () => {
  assert.doesNotThrow(() => validateCall('browser_slider_solve_verified', { tabId: 1 }));
  assert.doesNotThrow(() => validateCall('browser_slider_solve_verified', {
    tabId: 1, refreshFirst: false, maxAttempts: 3, steps: 24, startInsetPx: 0, requireConfidence: 'high'
  }));
  assert.throws(() => validateCall('browser_slider_solve_verified', { tabId: 1, maxAttempts: 4 }), /Invalid maxAttempts/);
  assert.throws(() => validateCall('browser_slider_solve_verified', { tabId: 1, steps: 1 }), /Invalid steps/);
  assert.throws(() => validateCall('browser_slider_solve_verified', { tabId: 1, requireConfidence: 'certain' }), /Invalid requireConfidence/);
  assert.throws(() => validateCall('browser_slider_probe', {}), /Missing argument: tabId/);
  assert.doesNotThrow(() => validateCall('browser_slider_probe', { tabId: 1, selector: '.verify-wrap' }));
});

test('geometry and attribute expectations are schema-checked and baseline-bound', () => {
  assert.doesNotThrow(() => validateCall('browser_click_verified', {
    tabId: 1, ref: 'abc:0', expect: { elementGeometryChange: { selector: '.verify-move-block', tolerancePx: 3 } }
  }));
  assert.doesNotThrow(() => validateCall('browser_click_verified', {
    tabId: 1, ref: 'abc:0', expect: { anyAttributeChange: { selector: '.verify-wrap', attribute: 'aria-hidden' } }
  }));
  assert.throws(() => validateCall('browser_click_verified', {
    tabId: 1, ref: 'abc:0', expect: { elementGeometryChange: { selector: '.x', bogus: 1 } }
  }), /elementGeometryChange\.bogus/);
  assert.throws(() => validateCall('browser_click_verified', {
    tabId: 1, ref: 'abc:0', expect: { elementGeometryChange: { tolerancePx: 2 } }
  }), /selector is required/);
  assert.throws(() => validateCall('browser_click_verified', {
    tabId: 1, ref: 'abc:0', expect: { elementGeometryChange: { selector: '   ' } }
  }), /elementGeometryChange\.selector/);
  assert.throws(() => validateCall('browser_click_verified', {
    tabId: 1, ref: 'abc:0', expect: { anyAttributeChange: { selector: '.x', attribute: 'a'.repeat(201) } }
  }), /anyAttributeChange\.attribute/);
  // A pre-dispatch evaluation must not receive the pre-dispatch baseline, or a
  // condition designed to fire after the action could satisfy itself before it.
  assert.match(worker, /const pre = await page\('browser_expect', \{ expect: args\.expect, wantBaseline: true \}\);/);
  const carried = [...worker.matchAll(/targetBaseline: pre\?\.targetBaseline \?\? null/g)];
  assert.ok(carried.length >= 2, 'both verified dispatch paths must carry the pre-dispatch baseline');
  assert.match(page, /const targetBaselineFor =/);
  assert.match(page, /deltaPx > tolerancePx/);
  assert.match(page, /baseline\.value !== null && currentValue !== null && baseline\.value !== currentValue/);
});

test('anyChange now sees style and class movement, not only text and nodes', () => {
  assert.match(page, /style: attributeSignature\('style', 200\)/);
  assert.match(page, /classes: attributeSignature\('class', 300\)/);
  assert.match(page, /baseline\.style !== current\.style\) changes\.push\('style'\)/);
  assert.match(page, /baseline\.classes !== current\.classes\) changes\.push\('class'\)/);
  assert.match(tools, /inline-style signature or class-attribute signature/);
});

test('the page-side slider operations report evidence instead of a verdict', () => {
  assert.match(page, /\.verify-wrap/);
  assert.match(page, /\.verify-move-block/);
  assert.match(page, /reason: 'slider_not_visible'/);
  // Refresh clicks once, then waits for the image token to move.
  assert.match(page, /control\.click\(\);/);
  assert.match(page, /afterToken !== beforeToken/);
  // URLs are page content and may carry a session token; only origin+path.
  assert.match(page, /url\.split\('\?'\)\[0\]/);
  assert.match(page, /kind: 'data_url', length: url\.length/);
  // The offset is computed locally, with a confidence and a margin.
  assert.match(page, /covariance \/ denominator/);
  assert.match(page, /const confidence = bestScore < 0\.35 \? 'low' : \(bestScore < 0\.6 \? 'medium' : 'high'\)/);
  assert.match(page, /tolerancePx: 5/);
  // Cross-origin fallbacks are explicit, and a canvas is declared unsupported
  // rather than guessed at.
  assert.match(page, /credentials: 'include'/);
  assert.match(page, /reason: 'canvas_background'/);
  assert.match(page, /status: 'solved'/);
  assert.match(page, /never assume success from dispatch alone/);
  // Outcome phases are observed from the widget, not inferred from dispatch.
  assert.match(page, /phase = !rootVisible \? 'closed' : \(passText \? 'passed' : \(failText \|\| imageChanged \? 'failed' : 'pending'\)\)/);
  assert.match(page, /resendVisible/);
});

test('the worker solves once per observed failure and never replays an uncertain drag', () => {
  const solveAt = worker.indexOf("if (name === 'browser_slider_solve_verified')");
  const whitelistAt = worker.indexOf('Unknown command');
  assert.ok(solveAt > 0 && solveAt < whitelistAt, 'the slider orchestration must run before the dispatch whitelist');
  assert.match(worker, /const refreshFirst = args\.refreshFirst !== false;/);
  assert.match(worker, /const maxAttempts = Math\.min\(3, Math\.max\(1,/);
  assert.match(worker, /await page\('browser_slider_refresh'/);
  assert.match(worker, /const solved = await page\('browser_slider_solve'/);
  assert.match(worker, /reason: 'confidence_below_requirement', dispatched: false, retryable: false/);
  assert.match(worker, /selector: solved\.pieceSelector/);
  assert.match(worker, /status\?\.phase === 'closed' \|\| status\?\.phase === 'passed'/);
  assert.match(worker, /reason: 'slider_outcome_not_observed'/);
  const uncertain = worker.slice(worker.indexOf("reason: 'slider_outcome_not_observed'"), worker.indexOf("reason: 'slider_failed_after_attempts'"));
  assert.match(uncertain, /retryable: false/, 'an unobserved outcome must not be marked retryable');
  const exhausted = worker.slice(worker.indexOf("reason: 'slider_failed_after_attempts'"));
  assert.match(exhausted, /retryable: false/);
  // The drag itself is one synchronous page tick, so hidden-tab throttling
  // cannot stop it halfway.
  assert.match(page, /target\.dispatchEvent\(new MouseEvent\('mousedown', base\)\)/);
  assert.match(page, /synchronous: true/);
  assert.match(cdp, /release\('watchdog'\)/);
});

test('a hidden-tab eval timeout names timer throttling instead of blaming the page', () => {
  assert.match(worker, /TIMER_OR_PAINT_DEPENDENT_EVAL = new Set\(\['browser_eval', 'browser_eval_verified'\]\)/);
  assert.match(worker, /timerThrottling: \{/);
  assert.match(worker, /visibilityState: 'hidden'/);
  assert.match(worker, /hidden documents throttle timers/);
});
