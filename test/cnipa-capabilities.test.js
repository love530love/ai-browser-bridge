// CNIPA M1-M3 capability contract. The page script cannot be imported into a
// Node test (it is serialised into the page by chrome.scripting), so these are
// source-level contracts plus REAL projections: extract the shipped text, feed
// it to the actual classifier, and assert what the caller would see.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { errorCategory } from '../src/diagnostics.js';
import { classifyEffect, EFFECTS, summarizeDiagnoseFlow } from '../src/action-diagnostics.js';
import { TOOLS } from '../src/tools.js';
import { TOOL_GROUPS } from '../src/tool-index.js';

const read = relative => readFileSync(new URL('../' + relative, import.meta.url), 'utf8');
const page = read('extension/page.js');
const worker = read('extension/worker.js');
const server = read('src/server.js');
const tools = read('src/tools.js');

test('browser_wait_for_selector reaches schema, index, worker whitelist and page', () => {
  assert.ok(TOOLS.some(tool => tool.name === 'browser_wait_for_selector'), 'missing tool schema');
  assert.ok(TOOL_GROUPS.some(group => group.tools.includes('browser_wait_for_selector')), 'missing intent index entry');
  // The whitelist at worker.js:1528 rejects any unmapped command with
  // "Unknown command" on a real browser, while every unit test stays green.
  const whitelist = worker.slice(worker.indexOf("['browser_read', 'browser_at'"), worker.indexOf('Unknown command'));
  assert.match(whitelist, /'browser_wait_for_selector'/, 'worker dispatch whitelist not updated');
  assert.match(page, /name === 'browser_wait_for_selector'/, 'page-side implementation missing');
  assert.match(page, /status: 'timeout'/, 'a timeout must be reported, not fabricated into a match');
});

test('M1 upload: one MIME module, one ceiling, and three exact targets', () => {
  assert.match(server, /import \{ mimeFor \} from '\.\/upload-mime\.js'/);
  assert.match(server, /mimeFor\(filePath, args\.mimeType\)/);
  assert.match(server, /uploadMaxBytes/);
  assert.match(server, /liveUploadPolicy\(\)/);
  assert.match(server, /sameConfig = fresh\.agentToken === config\.agentToken/,
    'hot reload must be bound to the same config identity, not any file on disk');
  assert.match(page, /const applyUpload =/);
  assert.match(page, /args\.uploadMaxBytes/, 'the page script must enforce the configured ceiling too');
  assert.match(page, /targetSource = 'selector'/);
  assert.match(page, /targetSource = 'inputIndex'/);
  assert.match(tools, /selector: text\(1000\)/);
  assert.match(tools, /mimeType: text\(255\)/);
  assert.match(tools, /mimeSource/);
});

test('M2: the stale-ref text shipped by page.js projects to a structured reason', () => {
  const match = page.match(/throw new Error\(`(Stale element reference[^`]*)`\)/);
  assert.ok(match, 'page.js must emit the stale-ref message');
  const rendered = match[1].replace('${generation}', 'snap-abc');
  assert.match(rendered, /\[stale_ref generation=snap-abc\]/);
  assert.equal(errorCategory(rendered), 'STALE_REF', 'a stale ref must be distinguishable from a generic stale-sounding error');
  assert.equal(errorCategory('Stale element reference'), 'STALE_REFERENCE', 'older messages keep their category');
});

test('M2: effect enum and diagnoseFlow stay consistent between module and page', () => {
  assert.deepEqual(EFFECTS, ['dom', 'network', 'download', 'dialog', 'none', 'unknown']);
  assert.equal(classifyEffect({ domDelta: 2, requests: 0, fileInputs: 0, downloads: 0, dialogs: 0, observed: true }), 'dom');
  assert.equal(classifyEffect({ domDelta: 0, requests: 0, fileInputs: 0, downloads: 0, dialogs: 0, observed: true }), 'none');
  assert.equal(classifyEffect({ observed: false }), 'unknown');
  const secret = 'a'.repeat(64);
  const flow = summarizeDiagnoseFlow([{ type: 'xhr', detail: `Bearer ${secret}`, at: 1 }]);
  assert.doesNotMatch(JSON.stringify(flow.recent), new RegExp(secret));
  assert.match(flow.recent[0].detail, /\[redacted\]/);
  // The page-side branch must produce the same fields the module consumes.
  for (const field of ['effect:', 'diagnoseFlow:', 'flow:', 'throttledInfo\(\)']) {
    assert.match(page, new RegExp(field), `page.js missing ${field}`);
  }
  assert.match(page, /'\$1\[redacted\]'/, 'recent resource URLs must be redacted before leaving the page');
});

test('M3: includeFormValues, auto-scroll retry and throttled read are all present', () => {
  assert.match(page, /args\.includeFormValues === true && args\.mode !== 'cheap'/);
  assert.match(page, /filter\(node => !sensitive\(node\)\)/, 'form values must never echo secrets');
  assert.match(page, /formValuesNote:/);
  assert.match(page, /autoScrolled: true/);
  assert.match(page, /timersThrottled: document\.visibilityState !== 'visible'/);
  assert.match(tools, /includeFormValues: \{ type: 'boolean' \}/);
});
