// Opening DevTools used to be refused on purpose.
//
// 0.9 removed it because the only path was a synthesised F12, and a global
// keystroke races with whatever window gains focus between the check and the
// key. The removal note also wrote down what would be needed to bring it back:
// a native action bound to the target window that can be read back, plus
// adequate negative evidence. This module is that path - expand the browser's
// own menu through element-bound patterns, invoke the item, then decide by
// observing DevTools rather than by trusting that a click happened.
//
// The menu item is a toggle (Ctrl+Shift+I in menu form), so it is never exposed
// as a toggle. The caller asks for a state; the current state is read first; a
// request for the state that already holds dispatches nothing. That is the same
// idempotent shape as expand/collapse, and the reason a retry is safe here even
// though the underlying control is not idempotent.

export const DEVTOOLS_TARGET_STATES = ['open', 'closed'];

const APP_MENU_ID = 'view_1007';
// Names are localized, so both spellings are accepted. The id is preferred
// because it is what the version baseline tracks; the name is the fallback for
// the build that renames it.
const APP_MENU_NAME = /customize and control|自定义及控制/i;
const MORE_TOOLS = /^more tools$|^更多工具$/i;
const DEVELOPER_TOOLS = /^developer tools\b|^开发者工具/i;

const summary = observation => {
  const evidence = observation?.evidence ?? {};
  return {
    devtoolsState: evidence.devtoolsState ?? null,
    devtoolsOpen: evidence.devtoolsOpen === true,
    partial: evidence.partial === true,
    devtoolsDocumentCount: Number.isSafeInteger(evidence.devtoolsDocumentCount) ? evidence.devtoolsDocumentCount : null,
    nodesVisited: Number.isSafeInteger(evidence.nodesVisited) ? evidence.nodesVisited : null,
    panels: Array.isArray(evidence.panels) ? evidence.panels : null
  };
};

const identityOf = control => {
  const identity = { name: control.name };
  if (control.automationId) identity.automationId = control.automationId;
  return identity;
};

const refused = (reason, extra = {}) => ({ status: 'not_dispatched', dispatched: false, retryable: false, reason, ...extra });

// A menu button is the only control this needs to find by role, and there are
// usually several (bookmarks, extensions, profile). The app menu is the one the
// version baseline tracks; if its id changes, exactly one candidate must match
// the accessible name, otherwise this refuses instead of opening a stranger's
// menu.
function findAppMenu(controls) {
  const expandable = controls.filter(control => control.role === 'ControlType.Button' &&
    control.state?.expandCollapse && control.name);
  const byId = expandable.find(control => control.automationId === APP_MENU_ID);
  if (byId) return { control: byId, matchedBy: `automationId:${APP_MENU_ID}` };
  const byName = expandable.filter(control => APP_MENU_NAME.test(control.name));
  if (byName.length === 1) return { control: byName[0], matchedBy: 'role+name:app menu' };
  return { control: null, matchedBy: 'not_found', candidates: expandable.length };
}

export async function setDevToolsState(target, { want, observe, snapshot, act } = {}) {
  if (!DEVTOOLS_TARGET_STATES.includes(want)) throw new Error('want must be "open" or "closed"');
  for (const [name, fn] of Object.entries({ observe, snapshot, act })) {
    if (typeof fn !== 'function') throw new Error(`${name} is required`);
  }

  const beforeObservation = await observe(target);
  const before = summary(beforeObservation);
  const isOpen = before.devtoolsOpen === true;
  if (want === 'open' ? isOpen : !isOpen) {
    return { status: 'success', dispatched: false, alreadyInState: true, verified: true,
      state: want, method: 'chrome_menu_uia', focusRequired: false, before, after: before, steps: [],
      note: `DevTools was already ${want}, so nothing was dispatched.` };
  }

  const steps = [];
  const record = (step, result) => { steps.push({ step, status: result?.status ?? 'unknown', reason: result?.reason ?? null }); return result; };
  const dispatchFailure = (step, result) => {
    record(step, result);
    // Whatever the primitive said, it is the truth about that step. Copying its
    // dispatch state is what keeps "nothing happened" from being reported as an
    // uncertain click.
    return { status: result?.status === 'uncertain' ? 'uncertain' : 'not_dispatched',
      dispatched: result?.dispatched ?? false, verified: false, state: want,
      method: 'chrome_menu_uia', focusRequired: false, reason: result?.reason ?? `${step}_failed`,
      failedStep: step, before, after: null, steps };
  };

  const first = await snapshot(target);
  if (first?.status !== 'success') return dispatchFailure('snapshot_window', first);
  const appMenu = findAppMenu(first.controls ?? []);
  if (!appMenu.control) return dispatchFailure('find_app_menu', refused('chrome_menu_not_found', { candidates: appMenu.candidates ?? 0 }));

  const opened = await act({ ...target, ref: appMenu.control.ref, action: 'expand', expect: identityOf(appMenu.control) });
  if (!['success'].includes(opened?.status)) return dispatchFailure('expand_app_menu', opened);

  const menuSnapshot = await snapshot(target);
  if (menuSnapshot?.status !== 'success') return dispatchFailure('snapshot_menu', menuSnapshot);
  const moreTools = (menuSnapshot.controls ?? []).find(control => control.role === 'ControlType.MenuItem' && MORE_TOOLS.test(control.name ?? ''));
  if (!moreTools) return dispatchFailure('find_more_tools', refused('more_tools_item_not_found'));
  const submenu = await act({ ...target, ref: moreTools.ref, action: 'expand', expect: identityOf(moreTools) });
  if (!['success'].includes(submenu?.status)) return dispatchFailure('expand_more_tools', submenu);

  const subSnapshot = await snapshot(target);
  if (subSnapshot?.status !== 'success') return dispatchFailure('snapshot_submenu', subSnapshot);
  const devtoolsItem = (subSnapshot.controls ?? []).find(control => control.role === 'ControlType.MenuItem' && DEVELOPER_TOOLS.test(control.name ?? ''));
  if (!devtoolsItem) return dispatchFailure('find_developer_tools', refused('developer_tools_item_not_found'));

  // The only dispatch in this whole flow. It is not idempotent: the item toggles
  // DevTools, so running it twice returns the browser to where it started.
  const invoked = await act({ ...target, ref: devtoolsItem.ref, action: 'invoke',
    expect: { ...identityOf(devtoolsItem), afterInvoke: 'control_gone' } });
  record('invoke_developer_tools', invoked);
  if (invoked?.status !== 'success') {
    return { status: invoked?.status === 'uncertain' ? 'uncertain' : 'not_dispatched',
      dispatched: invoked?.dispatched ?? false, verified: false, state: want,
      method: 'chrome_menu_uia', focusRequired: false, reason: invoked?.reason ?? 'developer_tools_invoke_failed',
      failedStep: 'invoke_developer_tools', before, after: null, steps,
      note: 'The menu item was not confirmed as chosen. Do not repeat this call: the item toggles DevTools, so a second dispatch may undo the first.' };
  }

  const after = summary(await observe(target));
  // Opening is confirmed by positive evidence only. Closing is confirmed by a
  // complete walk that finds no DevTools document: "not positively open" alone
  // would also describe a walk that gave up early, which is why partial has to
  // be false for the closed claim to stand.
  const reached = want === 'open' ? after.devtoolsOpen : (!after.devtoolsOpen && after.partial === false);
  const reason = reached ? 'devtools_state_reached'
    : want === 'closed' && after.partial ? 'devtools_close_unverified_partial_walk'
      : want === 'open' ? 'devtools_did_not_open' : 'devtools_still_open';
  return {
    status: reached ? 'success' : 'uncertain', dispatched: true, verified: reached,
    state: want, method: 'chrome_menu_uia', focusRequired: false, reason,
    before, after, steps,
    note: reached
      ? (want === 'open'
        ? 'DevTools is open and was observed through the desktop channel, not inferred from the menu item being chosen.'
        : 'DevTools is no longer observed open after a complete walk of the window.')
      : 'The menu item was chosen but the observation does not confirm the requested state. Do not repeat: the item toggles DevTools.'
  };
}
