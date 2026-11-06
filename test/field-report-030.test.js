// Every test here comes from one field report: a real paid order on a React +
// antd SPA where 35 of 45 minutes were spent on "select one card inside a
// modal", because the tool that would have answered it in a line was described
// as not existing.
//
// The report is the specification, so the assertions are behavioural where they
// can be and structural only where the behaviour needs a browser this suite does
// not have.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { evalInPage } from '../extension/eval-main.js';
import { describeChange, suppressionResult } from '../extension/receipt.js';
import { TOOLS } from '../src/tools.js';
import { toolIndex } from '../src/tool-index.js';
import { nextStepFor } from '../src/next-step.js';
import { capabilityGuide } from '../src/capability-guide.js';

const tool = name => TOOLS.find(entry => entry.name === name);
const page = readFileSync(new URL('../extension/page.js', import.meta.url), 'utf8');
const worker = readFileSync(new URL('../extension/worker.js', import.meta.url), 'utf8');

// ---------------------------------------------------------------- P0-0: eval

test('browser_eval exists as a first-class tool, not a mode of another one', () => {
  const entry = tool('browser_eval');
  assert.ok(entry, 'the escape hatch must be discoverable by name');
  // 0.36.0 gives every tool two optional routing arguments. They are consumed
  // by the service and never forwarded to the page, so they must not become
  // required and must not change the tool's own contract.
  assert.deepEqual(Object.keys(entry.inputSchema.properties).sort(),
    ['agent', 'commandId', 'expression', 'hostId', 'maxChars', 'mode', 'tabId']);
  assert.deepEqual(entry.inputSchema.required, ['tabId', 'expression']);
  assert.ok(!entry.inputSchema.required.includes('hostId'));
  assert.ok(!entry.inputSchema.required.includes('commandId'));
  // Read mode is the default, so the schema has to name both values.
  assert.deepEqual(entry.inputSchema.properties.mode.enum, ['read', 'write']);
  // It can write, so policy must not treat it as a read.
  assert.equal(entry.annotations.readOnlyHint, false);
});

test('the tool index puts eval next to reading, where a stuck caller looks', () => {
  const read = toolIndex({ group: 'read', format: 'json' });
  assert.ok(read.groups[0].tools.includes('browser_eval'));
  // A goal phrased as "I cannot reach it" must land on eval.
  const guide = capabilityGuide({ goal: '这个卡片点不中，扫不到' });
  assert.equal(guide.primary.intent, 'script-or-escape-hatch');
  assert.deepEqual(guide.primary.tools, ['browser_eval']);
  assert.equal(guide.focusRequired, false);
});

test('browser_devtools no longer claims script execution is unimplemented', () => {
  const description = tool('browser_devtools').description;
  // The exact sentence that cost 40 minutes. It was true of this tool and false
  // of the product, which is the worst combination: a caller trusts it and
  // stops looking.
  assert.ok(!/Console\/script execution are not implemented/i.test(description));
  assert.match(description, /browser_eval/);
  assert.match(description, /browser_debugger/);
});

test('browser_debugger says evaluate works without pausing', () => {
  const description = tool('browser_debugger').description;
  assert.match(description, /GLOBAL context/);
  assert.match(description, /evaluatedOn:"global"/);
  assert.match(description, /prefer browser_eval/);
});

test('an expression is evaluated and its value rendered', async () => {
  const result = await evalInPage('1 + 1', {});
  assert.equal(result.status, 'success');
  assert.equal(result.type, 'number');
  assert.equal(result.valueText, '2');
  assert.equal(result.valueIsJson, true);

  const text = await evalInPage('"VeryAI"', {});
  assert.equal(text.type, 'string');
  assert.equal(text.valueText, '"VeryAI"');

  const object = await evalInPage('({ a: 1, b: [2, 3] })', {});
  assert.equal(object.type, 'object');
  assert.deepEqual(JSON.parse(object.valueText), { a: 1, b: [2, 3] });

  const nothing = await evalInPage('undefined', {});
  assert.equal(nothing.type, 'undefined');
  assert.equal(nothing.valueIsJson, false);
});

test('a thrown expression is a result about the expression, not a bridge failure', async () => {
  const thrown = await evalInPage('(() => { throw new TypeError("nope"); })()', {});
  assert.equal(thrown.ok, false);
  assert.equal(thrown.status, 'failed');
  assert.equal(thrown.reason, 'expression_threw');
  assert.equal(thrown.exception.name, 'TypeError');
  assert.match(thrown.exception.message, /nope/);
});

test('a rejected promise is reported as rejected, not as success', async () => {
  const rejected = await evalInPage('Promise.reject(new Error("late"))', {});
  assert.equal(rejected.ok, false);
  assert.equal(rejected.reason, 'promise_rejected');
  assert.match(rejected.exception.message, /late/);
});

test('read mode shadows the primitives that turn a read into a write', async () => {
  // The shadowing is a scope, not a sandbox, and the reply says so. What it must
  // do is stop the obvious accidental write.
  const read = await evalInPage('[typeof fetch, typeof XMLHttpRequest, typeof WebSocket].join(",")', { readOnly: true });
  assert.equal(read.valueText, '"undefined,undefined,undefined"');
  assert.deepEqual(read.readOnlyEnforced, ['fetch', 'XMLHttpRequest', 'WebSocket', 'EventSource', 'navigator.sendBeacon', 'window.open', 'alert', 'confirm', 'prompt', 'print']);
  assert.equal(read.readOnlyIsGuardrail, true);

  // In Node there is no page fetch to bind, so this asserts the shadow is
  // conditional rather than always-on: write mode does not shadow the names.
  const write = await evalInPage('[typeof alert].join(",")', { readOnly: false });
  assert.equal(write.valueText, '"undefined"');
  assert.deepEqual(write.readOnlyEnforced, []);
});

test('an empty expression is refused without evaluating anything', async () => {
  const empty = await evalInPage('   ', {});
  assert.equal(empty.status, 'denied');
  assert.equal(empty.reason, 'empty_expression');
});

test('the worker dispatches browser_eval instead of answering Unknown command', () => {
  const listLine = worker.split('\n').find(line => line.includes("throw new Error('Unknown command')"));
  assert.ok(listLine?.includes("'browser_eval'"), 'browser_eval must be in the worker dispatch list');
  assert.match(worker, /if \(name === 'browser_eval'\) \{/);
  // Two channels, and the fast one first: a debugger attach costs a banner.
  assert.match(worker, /world: 'MAIN'/);
  assert.match(worker, /Runtime\.evaluate/);
  assert.match(worker, /shape\(first, 'main_world'\)/);
  assert.match(worker, /shape\(value, 'cdp'\)/);
});

// ------------------------------------------------- P0-3: changed:false was a lie

test('a toggle that flipped is a change even when the page digest did not move', () => {
  const before = {
    url: 'https://x.test/', title: 't', textLength: 100, interactive: 5, focus: null, dialog: null,
    scroll: { x: 0, y: 0 }, digest: 'aaaa',
    watch: { resolved: true, connected: true, checked: false, ariaChecked: null, ariaSelected: null, ariaExpanded: null, ariaPressed: null, disabled: false }
  };
  const after = { ...before, watch: { ...before.watch, checked: true } };
  const receipt = describeChange(before, after);
  assert.equal(receipt.digestBefore, receipt.digestAfter, 'the digest really did not move');
  assert.equal(receipt.changed, true, 'a checkbox flip must not be reported as no change');
  assert.equal(receipt.stateChanged, true);
  assert.deepEqual(receipt.stateFieldsChanged, ['checked']);
  assert.equal(receipt.stateAfter.checked, true);
  assert.match(receipt.note, /control changed/);
});

test('a genuine no-op still says no change, and says it is not a verdict', () => {
  const state = {
    url: 'https://x.test/', title: 't', textLength: 100, interactive: 5, focus: null, dialog: null,
    scroll: { x: 0, y: 0 }, digest: 'aaaa',
    watch: { resolved: true, connected: true, checked: false, ariaChecked: null, ariaSelected: null, ariaExpanded: null, ariaPressed: null, disabled: false }
  };
  const receipt = describeChange(state, { ...state, watch: { ...state.watch } });
  assert.equal(receipt.changed, false);
  assert.equal(receipt.stateChanged, false);
  assert.match(receipt.note, /not evidence that the action failed/);
});

test('the page fingerprint hashes toggle state, because nothing else moves', () => {
  const start = page.indexOf('const pageFingerprint = (');
  const body = page.slice(start, page.indexOf("if (name === 'browser_receipt')"));
  assert.match(body, /feed\(controls\.digest\)/);
  const controlStart = page.indexOf('const controlState = () => {');
  const controlBody = page.slice(controlStart, page.indexOf('const watchState = ref => {'));
  assert.match(controlBody, /aria-checked/);
  assert.match(controlBody, /aria-selected/);
  assert.match(controlBody, /aria-expanded/);
  assert.match(controlBody, /aria-pressed/);
});

test('the acted-on element travels with the fingerprint', () => {
  assert.match(worker, /watchRef \? \{ watchRef \}/);
  assert.match(page, /pageFingerprint\(\{ watchRef: args\.watchRef \}\)/);
});

// ------------------------------------------- P0-1: the modal was invisible

test('browser_read scans a dialog before the background page', () => {
  const start = page.indexOf("if (name === 'browser_read') {");
  const body = page.slice(start, page.indexOf("if (name === 'browser_find_text') {"));
  assert.match(body, /const overlayFirst = !!overlay && scopeArg !== 'page'/);
  // Order is the whole point: the dialog is taken first, then the document.
  assert.ok(body.indexOf('if (overlayFirst) take(overlay.el)') < body.indexOf('take(document)'),
    'the overlay must be scanned before the document');
  assert.match(body, /scopeUsed/);
  assert.match(body, /overlaySettling/);
});

test('the overlay candidates keep the outermost container and the topmost layer', () => {
  const start = page.indexOf('const OVERLAY_SELECTOR =');
  const body = page.slice(start, page.indexOf('const renderedTextNode ='));
  // Keeping the innermost would miss siblings inside the same antd wrap.
  assert.match(body, /other\.el\.contains\(item\.el\)/);
  assert.match(body, /a\.zIndex - b\.zIndex/);
  assert.match(body, /ant-modal-wrap/);
});

test('browser_read exposes the scope switch a caller needs', () => {
  assert.deepEqual(tool('browser_read').inputSchema.properties.scope.enum, ['auto', 'overlay', 'page']);
  assert.match(tool('browser_read').description, /scope/);
  assert.match(tool('browser_read').description, /overlaySettling/);
});

test('find_element searches the dialog first and never calls a partial scan conclusive', () => {
  const start = page.indexOf('const findElementCandidates = (args = {}) => {');
  const body = page.slice(start, page.indexOf('const pageText = ()'));
  assert.match(body, /overlay\.el\.querySelectorAll\(actionSelector\)/);
  assert.ok(body.indexOf('overlay.el.querySelectorAll(actionSelector)') < body.indexOf('document.querySelectorAll(actionSelector)'),
    'overlay candidates must be inserted before the document ones');
  assert.match(body, /diagnostics\.overlayControls\+\+/);
  // A wall-clock deadline used to stop the scan at a different point each call,
  // so the same DOM answered found:false and found:true.
  assert.match(body, /performance\.now\(\) \+ 600/);
  assert.match(page, /concluded: !partial/);
});

test('shadow_tree reports clickable containers, not only controls', () => {
  const description = tool('browser_shadow_tree').description;
  assert.match(description, /cursor/);
  assert.match(description, /kind:"clickable"/);
  assert.match(description, /React onClick/);
  const start = page.indexOf("if (name === 'browser_shadow_tree') {");
  const body = page.slice(start, page.indexOf('const elementRole = el =>'));
  // A React onClick leaves no attribute; cursor:pointer is what a person sees.
  assert.match(body, /getComputedStyle\(el\)\.cursor !== 'pointer'/);
  // cursor is inherited, so the outermost pointer element must win.
  assert.match(body, /getComputedStyle\(up\)\.cursor === 'pointer'/);
  assert.match(body, /kind: isControl \? 'control' : 'clickable'/);
  assert.equal(tool('browser_shadow_tree').inputSchema.properties.includeClickable.type, 'boolean');
});

// -------------------------------------------------- P0-2: coordinate aiming

test('prepare_coordinate returns enough geometry to judge the aim', () => {
  const description = tool('browser_prepare_coordinate').description;
  assert.match(description, /target\.rect/);
  assert.match(description, /offsetFromCenter/);
  assert.match(description, /targetLooksLikeContainer/);
  assert.match(description, /120 seconds/);
  const start = page.indexOf('const targetEvidence = el => {');
  const body = page.slice(start, page.indexOf("if (name === 'browser_validate_coordinate')"));
  for (const field of ['rect', 'path', 'textLength', 'childCount']) assert.match(body, new RegExp(field));
  assert.match(page, /offsetFromCenter:/);
  assert.match(page, /targetLooksLikeContainer: evidence\.textLength > 120/);
});

test('the token lifetime is two minutes and belongs to the token', () => {
  const start = page.indexOf("if (name === 'browser_prepare_coordinate' || name === 'browser_validate_coordinate') {");
  const body = page.slice(start, page.indexOf("if (name === 'browser_viewport')"));
  assert.match(body, /Number\(args\.ttlMs\) \|\| 120000/);
  // A token prepared with ttlMs:5000 must not live 120s because the dispatch
  // call left ttlMs out, so expiry is stored on the record.
  assert.match(body, /expiresAt: now \+ ttlMs/);
  assert.match(body, /now > \(record\.expiresAt/);
  assert.equal(tool('browser_prepare_coordinate').inputSchema.properties.ttlMs.maximum, 300000);
});

test('a refused token names which kind of failure it was', () => {
  const start = page.indexOf("if (name === 'browser_prepare_coordinate' || name === 'browser_validate_coordinate') {");
  const body = page.slice(start, page.indexOf("if (name === 'browser_viewport')"));
  assert.match(body, /coordinate_token_\$\{retiredMeta\.reason\}/);
  assert.match(body, /coordinate_token_never_issued/);
  assert.ok(!/coordinate_token_missing_or_expired/.test(body), 'one reason for three situations is what made retrying a coin flip');
});

// -------------------------------------- P1-4 / P1-5 / P2-6: dead-end errors

test('a failed pick lists what it actually saw', () => {
  const start = page.indexOf('const pickFailureHint = (exact) => {');
  assert.ok(start > 0);
  const body = page.slice(start, page.indexOf("if (name === 'browser_prepare_coordinate'"));
  assert.match(body, /Visible option texts seen/);
  assert.match(body, /clickable non-option elements/);
  // The hint must name a way out, not just describe the failure.
  assert.match(body, /browser_shadow_tree|browser_eval/);
  assert.match(page, /throw new Error\(pickFailureHint\(exact\)\)/);
});

test('find_text can return the element that holds the match', () => {
  const properties = tool('browser_find_text').inputSchema.properties;
  assert.equal(properties.includeMatchElement.type, 'boolean');
  assert.equal(properties.maxMatchElements.maximum, 20);
  const start = page.indexOf('const findMatchElements = (needles');
  const body = page.slice(start, page.indexOf("if (name === 'browser_find_text') {"));
  // The deepest element that still contains the text is the smallest clickable
  // target, and a click on it bubbles to whichever card owns the handler.
  assert.match(body, /node\.children\]\.some/);
  assert.match(body, /state\.refs\.set\(ref/);
  assert.match(page, /matchElements: matchElements\.elements/);
});

test('find_text matchElements survives the frame projection', () => {
  // A field that only exists when it was asked for is exactly the field a
  // whitelist projection forgets. notRendered was dropped this way once already.
  assert.match(worker, /item\.result\.matchElements/);
  assert.match(worker, /args\.includeMatchElement \? \{ matchElements, matchElementsPartial \}/);
  assert.match(worker, /args\.maxMatchElements \?\? 5/);
});

test('a covered target inside the dialog is not answered with Escape', () => {
  const start = page.indexOf("if (name === 'browser_click') {");
  const body = page.slice(start, page.indexOf("if (name === 'browser_click_verified') {"));
  assert.match(body, /sameDialog/);
  assert.match(body, /Do NOT press Escape/);
  assert.match(body, /targetInsideCoverDialog/);
  // The old message told the caller refs were one-shot. They are not.
  assert.ok(!/Refs are one-shot/.test(body));
});

// ------------------------------------------------ next step stays executable

test('the new failure modes each produce one executable step', () => {
  const expired = nextStepFor('browser_action', { tabId: 7, x: 10, y: 20 }, { status: 'waiting', reason: 'coordinate_token_expired' });
  assert.equal(expired.kind, 'retry_with_changes');
  assert.equal(expired.tool, 'browser_prepare_coordinate');
  assert.deepEqual(expired.arguments, { tabId: 7, x: 10, y: 20, ttlMs: 300000 });

  const invented = nextStepFor('browser_action', { tabId: 7 }, { status: 'waiting', reason: 'coordinate_token_never_issued' });
  assert.equal(invented.kind, 'stop');

  const threw = nextStepFor('browser_eval', { tabId: 7, expression: 'x.y' }, { status: 'failed', reason: 'expression_threw' });
  assert.equal(threw.kind, 'stop');

  const settling = nextStepFor('browser_read', { tabId: 7 }, { overlaySettling: { selector: '.ant-modal' } });
  assert.equal(settling.tool, 'browser_wait');
  assert.deepEqual(settling.arguments, { tabId: 7, ms: 400 });

  const coveredInside = nextStepFor('browser_click', { tabId: 7, ref: 'a:1' },
    { status: 'covered', reason: 'element_covered', targetInsideCoverDialog: true });
  assert.equal(coveredInside.tool, 'browser_read');
  assert.equal(coveredInside.arguments.scope, 'overlay');
});

test('every step the new rules emit passes the target tool schema', () => {
  // A step that the very next call refuses is worse than no step: it costs a
  // round trip and teaches the caller that the guide cannot be trusted.
  for (const [name, args, result] of [
    ['browser_action', { tabId: 1, x: 5, y: 5 }, { status: 'waiting', reason: 'coordinate_token_consumed' }],
    ['browser_read', { tabId: 1 }, { overlaySettling: { selector: '.x' } }],
    ['browser_click', { tabId: 1, ref: 'a:1' }, { status: 'covered', reason: 'element_covered', targetInsideCoverDialog: true }],
    ['browser_eval', { tabId: 1, expression: '1' }, { status: 'failed', reason: 'debugger_channel_failed' }]
  ]) {
    const step = nextStepFor(name, args, result);
    if (!step?.tool) continue;
    const schema = tool(step.tool)?.inputSchema;
    assert.ok(schema, `step names a real tool: ${step.tool}`);
    for (const key of schema.required) assert.ok(Object.hasOwn(step.arguments, key), `${step.tool} step must supply ${key}`);
  }
});

test('a suppression receipt still says the action did not run', () => {
  const before = { url: 'u', title: 't', textLength: 1, interactive: 1, focus: null, dialog: null, scroll: { x: 0, y: 0 }, digest: 'd' };
  const suppressed = suppressionResult({ name: 'browser_click', before, prior: { at: Date.now() - 10, status: 'success' }, now: Date.now() });
  assert.equal(suppressed.dispatched, false);
  assert.equal(suppressed.receipt.suppressed, true);
});
