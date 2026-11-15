// Machine-checkable verdict for the two extension-error evidence layers.
//
// `none_recorded` is absence of evidence, and the on-screen panel is the only
// source that can say "the list is empty right now". This module exists so no
// caller has to infer that from prose: `cleanClaim` is true only when the panel
// was actually read as empty AND the bridge journal recorded no error.

export function buildErrorClaims({ journalState = 'none_recorded', panelState = 'not_inspected' } = {}) {
  const journal = journalState === 'errors_present' ? 'errors_present' : 'no_recorded_events';
  const panel = panelState === 'errors_present' ? 'errors_present'
    : panelState === 'empty' ? 'clean'
      : panelState === 'not_inspected' ? 'not_inspected' : 'unknown';
  let overall;
  if (panel === 'errors_present') overall = 'errors_present';
  else if (journal === 'errors_present') {
    overall = panel === 'clean' ? 'journal_errors_panel_clean'
      : panel === 'unknown' ? 'journal_errors_panel_unknown'
        : 'errors_present';
  } else if (panel === 'clean') overall = 'clean';
  else overall = 'unknown';
  return {
    basis: panel === 'not_inspected' ? 'journal_only' : 'journal_and_panel',
    panel,
    journal,
    overall,
    cleanClaim: overall === 'clean',
    note: overall === 'clean'
      ? 'The chrome://extensions panel was read as empty and the bridge journal recorded no extension error in this window.'
      : overall === 'journal_errors_panel_clean'
        ? 'The panel is currently empty but the journal recorded earlier errors in this window. A clean panel does not erase that evidence.'
        : overall === 'errors_present'
          ? 'At least one evidence layer reports extension errors. Do not report the panel as clean.'
          : 'No layer proves the panel is clean. none_recorded is absence of evidence; an unreadable panel is unknown.'
  };
}
