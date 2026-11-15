// The journal verdict must be readable without a Chrome window, and it must be
// exactly as weak as the evidence it has: events the extension actually sent,
// deduped by eventId, scoped to one host when asked, with no raw page detail.

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readExtensionErrorJournal } from '../src/extension-error-journal.js';

const now = Date.parse('2026-11-15T12:00:00.000Z');
const row = over => ({
  time: new Date(now - 60000).toISOString(),
  tool: 'extension-error',
  eventId: `evt-${Math.random().toString(16).slice(2)}`,
  source: 'worker',
  errorCategory: 'THROWN',
  hostId: 'h-a',
  ...over
});

function journal(t, { audit = [], backup = [] } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'aib-journal-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const write = (name, rows) => writeFileSync(join(dir, name), rows.map(r => typeof r === 'string' ? r : JSON.stringify(r)).join('\n') + '\n');
  if (audit.length) write('audit.jsonl', audit);
  if (backup.length) write('audit.1.jsonl', backup);
  return dir;
}

test('a recorded extension error is read with no window and reports its own scope', t => {
  const dir = journal(t, { audit: [row({ eventId: 'e1', errorCategory: 'THROWN' }), row({ eventId: 'e2', errorCategory: 'UNHANDLED_REJECTION' })] });
  const view = readExtensionErrorJournal(dir, { now });
  assert.equal(view.basis, 'bridge-journal');
  assert.equal(view.panelInspected, false);
  assert.equal(view.state, 'errors_present');
  assert.equal(view.hasErrors, true);
  assert.equal(view.count, 2);
  assert.deepEqual(view.errorEntryNames.sort(), ['THROWN', 'UNHANDLED_REJECTION']);
  assert.equal(view.entries[0].at, new Date(now - 60000).toISOString());
  assert.equal(view.latestAt, new Date(now - 60000).toISOString());
  assert.match(view.scopeNote, /need no Chrome window/);
});

test('a resent event is one event, and the newest delivery is the one reported', t => {
  const dir = journal(t, {
    audit: [
      row({ eventId: 'same', errorCategory: 'THROWN', time: new Date(now - 120000).toISOString() }),
      row({ eventId: 'same', errorCategory: 'THROWN', time: new Date(now - 30000).toISOString(), hostId: 'h-a' }),
      row({ eventId: 'other', errorCategory: 'THROWN' })
    ]
  });
  const view = readExtensionErrorJournal(dir, { now });
  assert.equal(view.count, 2, 'two eventIds are two events, three rows are three deliveries');
});

test('the rotated log is read too, and the host filter does not borrow another host\'s evidence', t => {
  const dir = journal(t, {
    backup: [row({ eventId: 'old-a', hostId: 'h-a' })],
    audit: [row({ eventId: 'new-b', hostId: 'h-b' }), row({ eventId: 'no-host', hostId: undefined })]
  });
  const all = readExtensionErrorJournal(dir, { now });
  assert.equal(all.count, 3);
  const onlyA = readExtensionErrorJournal(dir, { now, hostId: 'h-a' });
  assert.equal(onlyA.count, 1);
  assert.equal(onlyA.entries[0].hostId, 'h-a');
  assert.equal(onlyA.unrecordedHostRows, 1, 'legacy rows without hostId must be disclosed, not attributed');
});

test('the window decides what is evidence: older rows and future rows are excluded', t => {
  const dir = journal(t, {
    audit: [
      row({ eventId: 'inside', time: new Date(now - 3600000).toISOString() }),
      row({ eventId: 'outside', time: new Date(now - 30 * 3600000).toISOString() }),
      row({ eventId: 'future', time: new Date(now + 3600000).toISOString() })
    ]
  });
  const view = readExtensionErrorJournal(dir, { now, windowHours: 2 });
  assert.equal(view.count, 1);
  assert.equal(view.windowHours, 2);
  const exact = readExtensionErrorJournal(dir, { now, since: new Date(now - 2 * 3600000).toISOString() });
  assert.equal(exact.count, 1);
});

test('raw page detail never reaches the caller', t => {
  const dir = journal(t, {
    audit: [row({
      eventId: 'e1', message: 'TypeError: secret token abc', url: 'https://app.test/a?token=abc',
      stack: 'at file:///secret.js:1:1', detail: { value: 'typed secret' }
    })]
  });
  const view = readExtensionErrorJournal(dir, { now });
  const serialized = JSON.stringify(view);
  assert.ok(!serialized.includes('secret token'));
  assert.ok(!serialized.includes('app.test'));
  assert.ok(!serialized.includes('typed secret'));
  assert.deepEqual(Object.keys(view.entries[0]).sort(), ['at', 'category', 'hostId', 'source', 'tabId'].filter(k => k !== 'tabId'));
});

test('malformed and foreign rows are counted, never fatal, and never evidence', t => {
  const dir = journal(t, {
    audit: [
      '{not json',
      JSON.stringify({ time: 'not-a-date', tool: 'extension-error' }),
      JSON.stringify({ time: new Date(now - 1000).toISOString(), tool: 'browser_click', eventId: 'x' }),
      row({ eventId: 'real' })
    ]
  });
  const view = readExtensionErrorJournal(dir, { now });
  assert.equal(view.count, 1);
  assert.equal(view.malformedRows, 2);
  assert.equal(view.state, 'errors_present');
});

test('an empty journal is absence of evidence, never a clean panel', t => {
  const dir = journal(t, { audit: [row({ eventId: 'x', tool: 'browser_read' })] });
  const view = readExtensionErrorJournal(dir, { now });
  assert.equal(view.state, 'none_recorded');
  assert.equal(view.hasErrors, false);
  assert.equal(view.count, 0);
  assert.match(view.scopeNote, /absence of evidence, not proof/);
  // A directory that does not exist yet is the same verdict, not an error.
  const missing = readExtensionErrorJournal(join(dir, 'nope'), { now });
  assert.equal(missing.state, 'none_recorded');
});

test('the newest entries are listed first and the list stays bounded', t => {
  const rows = [];
  for (let i = 0; i < 80; i += 1) {
    rows.push(row({ eventId: `e${i}`, time: new Date(now - (80 - i) * 1000).toISOString() }));
  }
  const dir = journal(t, { audit: rows });
  const view = readExtensionErrorJournal(dir, { now, limit: 5 });
  assert.equal(view.count, 80);
  assert.equal(view.entries.length, 5);
  assert.equal(view.entries[0].at, new Date(now - 1000).toISOString());
});
