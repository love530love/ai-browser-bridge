// The panel is the only source that can say "empty right now"; the journal is
// absence-of-evidence when it recorded nothing. cleanClaim must encode exactly
// that, so no caller can read `none_recorded` as a clean panel.

import test from 'node:test';
import assert from 'node:assert/strict';
import { buildErrorClaims } from '../src/extension-error-claims.js';

test('journal-only none_recorded is unknown and never a clean claim', () => {
  const claims = buildErrorClaims({ journalState: 'none_recorded', panelState: 'not_inspected' });
  assert.equal(claims.basis, 'journal_only');
  assert.equal(claims.overall, 'unknown');
  assert.equal(claims.cleanClaim, false);
  assert.match(claims.note, /absence of evidence/);
});

test('journal-only errors are errors_present', () => {
  const claims = buildErrorClaims({ journalState: 'errors_present', panelState: 'not_inspected' });
  assert.equal(claims.overall, 'errors_present');
  assert.equal(claims.journal, 'errors_present');
  assert.equal(claims.cleanClaim, false);
});

test('only a readable empty panel plus a clean journal is a clean claim', () => {
  const claims = buildErrorClaims({ journalState: 'none_recorded', panelState: 'empty' });
  assert.equal(claims.basis, 'journal_and_panel');
  assert.equal(claims.panel, 'clean');
  assert.equal(claims.overall, 'clean');
  assert.equal(claims.cleanClaim, true);
});

test('an empty panel does not erase earlier journal errors', () => {
  const claims = buildErrorClaims({ journalState: 'errors_present', panelState: 'empty' });
  assert.equal(claims.overall, 'journal_errors_panel_clean');
  assert.equal(claims.cleanClaim, false);
});

test('an unreadable panel keeps the journal verdict separate', () => {
  const withErrors = buildErrorClaims({ journalState: 'errors_present', panelState: 'unknown' });
  assert.equal(withErrors.overall, 'journal_errors_panel_unknown');
  assert.equal(withErrors.cleanClaim, false);

  const withoutErrors = buildErrorClaims({ journalState: 'none_recorded', panelState: 'unknown' });
  assert.equal(withoutErrors.overall, 'unknown');
  assert.equal(withoutErrors.cleanClaim, false);
  assert.equal(withoutErrors.panel, 'unknown');
});

test('panel errors dominate regardless of the journal', () => {
  const claims = buildErrorClaims({ journalState: 'none_recorded', panelState: 'errors_present' });
  assert.equal(claims.overall, 'errors_present');
  assert.equal(claims.cleanClaim, false);
});
