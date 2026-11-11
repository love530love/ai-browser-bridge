import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  EFFECTS,
  classifyEffect,
  summarizeDiagnoseFlow,
  summarizeDialogFlow,
  makeRefGeneration,
  isStaleRef
} from '../src/action-diagnostics.js';

const zeroCounts = () => ({
  xhr: 0, fetch: 0, dom: 0, fileInputs: 0,
  consoleErrors: 0, downloads: 0, dialogs: 0
});

const full = (over = {}) => ({
  domDelta: 0, requests: 0, fileInputs: 0, downloads: 0, dialogs: 0,
  observed: true, ...over
});

test('EFFECTS is a frozen list of the six effect labels', () => {
  assert.ok(Object.isFrozen(EFFECTS));
  assert.deepEqual([...EFFECTS], ['dom', 'network', 'download', 'dialog', 'none', 'unknown']);
});

test('classifyEffect priority: download > dialog > network > dom > none', () => {
  assert.equal(classifyEffect(full({ downloads: 1, dialogs: 1, requests: 1, domDelta: 1 })), 'download');
  assert.equal(classifyEffect(full({ dialogs: 1, requests: 1, domDelta: 1 })), 'dialog');
  // network wins over dom even when both are positive and fileInputs is positive
  assert.equal(classifyEffect(full({ requests: 1, domDelta: 1, fileInputs: 1 })), 'network');
  assert.equal(classifyEffect(full({ domDelta: 1 })), 'dom');
  assert.equal(classifyEffect(full({ fileInputs: 1 })), 'dom');
  assert.equal(classifyEffect(full()), 'none');
});

test('classifyEffect: all 0 -> none, all undefined -> unknown, observed:false -> unknown', () => {
  assert.equal(classifyEffect(full()), 'none');
  assert.equal(classifyEffect({}), 'unknown');
  assert.equal(classifyEffect({ observed: false, downloads: 9, requests: 4, domDelta: 2 }), 'unknown');
});

test('classifyEffect never fabricates missing fields into zeros', () => {
  assert.equal(classifyEffect({ observed: true }), 'unknown');
  assert.equal(classifyEffect({ requests: 0, observed: true }), 'unknown');
  assert.equal(classifyEffect(null), 'unknown');
  assert.equal(classifyEffect('bad'), 'unknown');
  // a partial, fully-zero observation is still not a complete 'none'
  assert.equal(classifyEffect({ downloads: 0, dialogs: 0 }), 'unknown');
});

test('summarizeDiagnoseFlow redacts 64-hex tokens and Bearer details and clamps to 200', () => {
  const hex = 'a'.repeat(64);
  const secret = 'token=' + hex + ' auth=Bearer eyJhbGciOiJIUzI1NiJ9.payload.sig';
  const long = 'x'.repeat(260);
  const result = summarizeDiagnoseFlow([
    { type: 'xhr', detail: secret, at: 1 },
    { type: 'dom', detail: long, at: 2 }
  ], 10);

  const details = result.recent.map((event) => event.detail);
  assert.ok(!details.includes(secret), 'the raw secret detail must not appear');
  assert.ok(!details.some((detail) => detail.includes(hex)), 'hex token must be redacted');
  assert.ok(!details.some((detail) => /Bearer/i.test(detail)), 'Bearer value must be redacted');
  assert.ok(details.some((detail) => detail.includes('[redacted]')), 'redaction marker must be present');
  assert.ok(result.recent.every((event) => event.detail.length <= 200), 'detail must be clamped to 200 chars');
  assert.equal(result.recent.find((event) => event.at === 2).detail.length, 200);
});

test('summarizeDiagnoseFlow keeps normal details intact', () => {
  const result = summarizeDiagnoseFlow([{ type: 'dom', detail: 'node added', at: 1 }], 5);
  assert.equal(result.recent[0].detail, 'node added');
});

test('summarizeDiagnoseFlow respects limit and sorts by at descending (default 5)', () => {
  const events = Array.from({ length: 9 }, (_, i) => ({ type: 'dom', detail: 'd' + i, at: i }));
  const limited = summarizeDiagnoseFlow(events, 3);
  assert.deepEqual(limited.recent.map((event) => event.at), [8, 7, 6]);
  assert.equal(limited.counts.dom, 9, 'counts cover all events, not just recent');
  assert.equal(limited.effect, 'dom');

  const defaulted = summarizeDiagnoseFlow(events);
  assert.equal(defaulted.recent.length, 5);
  assert.deepEqual(defaulted.recent.map((event) => event.at), [8, 7, 6, 5, 4]);
});

test('summarizeDiagnoseFlow counts, effect mapping and whitelist filtering', () => {
  const events = [
    { type: 'xhr', detail: 'a', at: 1 },
    { type: 'xhr', detail: 'b', at: 2 },
    { type: 'fetch', detail: 'c', at: 3 },
    { type: 'dom', detail: 'd', at: 4 },
    { type: 'file-input', detail: 'e', at: 5 },
    { type: 'console', detail: 'f', at: 6 },
    { type: 'mystery', detail: 'g', at: 7 }
  ];
  const result = summarizeDiagnoseFlow(events, 50);
  assert.deepEqual(result.counts, {
    xhr: 2, fetch: 1, dom: 1, fileInputs: 1,
    consoleErrors: 1, downloads: 0, dialogs: 0
  });
  // requests = xhr + fetch = 3 beats dom (domDelta = dom + fileInputs = 2)
  assert.equal(result.effect, 'network');
  assert.ok(!result.recent.some((event) => event.type === 'mystery'));
  assert.equal(result.recent.length, 6);
});

test('summarizeDiagnoseFlow tolerates non-array input without throwing', () => {
  for (const bad of [null, undefined, {}, 'nope', 42, () => {}]) {
    const result = summarizeDiagnoseFlow(bad);
    assert.deepEqual(result.counts, zeroCounts());
    assert.equal(result.effect, 'unknown');
    assert.deepEqual(result.recent, []);
  }
});

test('summarizeDialogFlow reports non-negative deltas and maps domNodes to domDelta', () => {
  const before = { fileInputs: 0, requests: 2, domNodes: 100, downloads: 0, consoleErrors: 1 };
  const after = { fileInputs: 1, requests: 5, domNodes: 140, downloads: 2, consoleErrors: 3 };
  assert.deepEqual(summarizeDialogFlow(before, after), {
    fileInputs: 1, requests: 3, domDelta: 40, downloads: 2, consoleErrors: 2
  });
});

test('summarizeDialogFlow clamps negatives and treats missing fields as 0', () => {
  assert.deepEqual(summarizeDialogFlow({ requests: 5, domNodes: 50 }, {}), {
    fileInputs: 0, requests: 0, domDelta: 0, downloads: 0, consoleErrors: 0
  });
  assert.deepEqual(summarizeDialogFlow(null, undefined), {
    fileInputs: 0, requests: 0, domDelta: 0, downloads: 0, consoleErrors: 0
  });
  assert.equal(summarizeDialogFlow({ fileInputs: 3 }, { fileInputs: 1 }).fileInputs, 0);
});

test('makeRefGeneration / isStaleRef: same generation is live, changed or malformed is stale', () => {
  assert.equal(makeRefGeneration('e1', 3), 'e1#g3');
  assert.equal(isStaleRef(makeRefGeneration('e1', 3), 3), false);
  assert.equal(isStaleRef(makeRefGeneration('e1', 3), 4), true);
  assert.equal(isStaleRef('e1#g3', 3), false);
  assert.equal(isStaleRef('garbage', 3), true);
  assert.equal(isStaleRef('e1#g', 3), true);
  assert.equal(isStaleRef('e1#g3extra', 3), true);
  assert.equal(isStaleRef(null, 3), true);
  assert.equal(isStaleRef('e1#g03', 3), true, 'non-canonical generation is stale');
  assert.equal(isStaleRef('e1#g3', -1), true);
  // a ref that itself contains '#g' still parses from the last segment
  assert.equal(isStaleRef(makeRefGeneration('a#g1', 2), 2), false);
});

test('makeRefGeneration rejects invalid ref or generation', () => {
  const invalid = /Invalid ref generation/;
  assert.throws(() => makeRefGeneration('', 1), invalid);
  assert.throws(() => makeRefGeneration(123, 1), invalid);
  assert.throws(() => makeRefGeneration('e1', -1), invalid);
  assert.throws(() => makeRefGeneration('e1', 1.5), invalid);
  assert.throws(() => makeRefGeneration('e1', '3'), invalid);
  assert.throws(() => makeRefGeneration('e1', NaN), invalid);
  assert.throws(() => makeRefGeneration('e1', Infinity), invalid);
  assert.equal(makeRefGeneration('e1', 0), 'e1#g0');
});

test('NDJSON round-trip: events written to a temp file feed the flow correctly', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'action-diagnostics-'));
  try {
    const file = path.join(dir, 'events.ndjson');
    const rows = [
      { type: 'xhr', detail: 'GET /api', at: 1 },
      { type: 'fetch', detail: 'POST /submit', at: 2 },
      { type: 'dom', detail: 'node added', at: 3 },
      { type: 'file-input', detail: 'input appeared', at: 4 },
      { type: 'console', detail: 'oops', at: 5 },
      { type: 'download', detail: 'file.zip', at: 6 },
      { type: 'dialog', detail: 'confirm', at: 7 },
      { type: 'xhr', detail: 'GET /api2', at: 8 }
    ];
    writeFileSync(file, rows.map((row) => JSON.stringify(row)).join('\n') + '\n', 'utf8');

    const events = readFileSync(file, 'utf8')
      .split('\n')
      .filter((line) => line.trim().length > 0)
      .map((line) => JSON.parse(line));

    const result = summarizeDiagnoseFlow(events, 20);
    assert.deepEqual(result.counts, {
      xhr: 2, fetch: 1, dom: 1, fileInputs: 1,
      consoleErrors: 1, downloads: 1, dialogs: 1
    });
    assert.equal(result.recent.length, 8);
    assert.equal(result.recent[0].at, 8);
    assert.equal(result.recent.at(-1).at, 1);
    // downloads>0 wins the priority even though dialog/request/dom are present
    assert.equal(result.effect, 'download');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
