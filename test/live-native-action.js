// Native control action acceptance against the user's real Chrome window.
//
// browser_native_snapshot proved that native control state can be read. Reading
// is not acting, and the whole point of this project is that the two must never
// be confused. So this script performs exactly one write - expand a menu
// button - reads the result back from the control itself, confirms it with an
// independent snapshot, and closes it again.
//
// The four promises under test:
//
//   1. A ref alone is not an identity. A missing control, or a control whose
//      name is not the one the caller described, is refused with nothing
//      dispatched - not acted on because the ref happened to exist.
//   2. Asking for the state a control is already in dispatches nothing. This is
//      what makes "retry after uncertain" safe, and it is the reason Toggle is
//      not exposed at all: a repeated toggle inverts the effect.
//   3. success means the state was read back from the control, and an
//      independent snapshot agrees. A pattern call that returned without
//      raising is not success.
//   4. The window is left exactly as it was found. The menu that is opened is
//      closed again, and the final snapshot proves it.
//   5. invoke chooses one menu item, and "success" only ever means the item
//      left the tree. A pattern call that returned is not evidence a command
//      ran, so the run also checks the window title afterwards: choosing "New
//      tab" must produce a window that says New tab. That is the only step here
//      that changes anything, and its residue is one new tab which the bridge
//      cannot see (chrome:// tabs are filtered out of browser_tabs) and
//      therefore cannot close - so it is reported instead of hidden.
//
// It also records one fact that was assumed wrongly until it was measured: an
// open Chrome menu is a child of the browser window in the UIA control view, so
// its items are visible to browser_native_snapshot. "Detached popup windows are
// not included" is true of top-level windows, not of the browser's own menus.
//
// Exit codes: 0 = every promise held, 1 = a promise broke, 2 = blocked (no
// eligible window or control, or a version mismatch). 2 is never a pass.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { request } from '../src/client.js';

const expectedVersion = JSON.parse(readFileSync(join(fileURLToPath(new URL('../', import.meta.url)), 'package.json'), 'utf8')).version;
const agent = 'native-action-live';
const call = async (name, args = {}) => (await request('/call', { name, arguments: { ...args, agent } })).result;

const startedAt = Date.now();
const step = message => console.error(`[${((Date.now() - startedAt) / 1000).toFixed(1)}s] ${message}`);
const rows = [];
const skipped = [];
const record = (name, expected, actual, detail) => rows.push({ name, expected, actual, ok: expected === actual, detail });

const status = await call('browser_queue_status', {}).catch(error => ({ error: error.message }));
if (status.version && status.version !== expectedVersion) {
  console.log(`BLOCKED service ${status.version} != source ${expectedVersion}; restart the service first.`);
  process.exit(2);
}
if (status.extensionVersion && status.extensionVersion !== expectedVersion) {
  console.log(`BLOCKED extension ${status.extensionVersion} != source ${expectedVersion}; reload the extension first.`);
  process.exit(2);
}

step('listing visible Chrome windows');
const listed = await call('browser_desktop_windows', {});
if (listed?.status !== 'success' || (listed.windows ?? []).length !== 1) {
  console.log(`BLOCKED expected exactly one visible Chrome window, got ${JSON.stringify(listed?.windows ?? listed)}.`);
  process.exit(2);
}
const target = { processId: listed.windows[0].processId, windowHandle: listed.windows[0].windowHandle };
step(`target ${target.processId}:${target.windowHandle} "${listed.windows[0].title}"`);

// Only a control that opens a browser-drawn menu is eligible: an extension
// toolbar button opens that extension's popup, which runs someone else's code
// and is not this test's business.
const menuButton = control => control.role === 'ControlType.Button' && Boolean(control.state?.expandCollapse) &&
  control.automationId !== 'view_1009' && Boolean(control.name) &&
  /bookmark|书签|customize and control|^chrome$|menu|菜单/i.test(control.name);

const before = await call('browser_native_snapshot', target);
if (before?.status !== 'success') {
  console.log(`BLOCKED native snapshot unavailable: ${JSON.stringify(before).slice(0, 200)}`);
  process.exit(2);
}
const eligible = before.controls.filter(menuButton);
const picked = eligible.find(control => control.name === 'All Bookmarks') ?? eligible[0];
if (!picked) {
  console.log(`BLOCKED no menu-type expand/collapse control among ${before.controls.length} native controls; nothing was dispatched.`);
  process.exit(2);
}
step(`picked "${picked.name}" ${picked.ref} ${picked.automationId} state=${picked.state.expandCollapse}`);

const identity = { name: picked.name, automationId: picked.automationId };
let expanded = false;
try {
  // Start from a known state. If a previous run or the user left this menu
  // open, close it first: collapsing is idempotent, so this cannot invert
  // anything, and the assertions below depend on the starting state.
  if (picked.state.expandCollapse !== 'Collapsed') {
    const reset = await call('browser_native_action', { ...target, ref: picked.ref, action: 'collapse', expect: identity });
    step(`reset to collapsed: ${reset?.status} ${reset?.stateBefore}->${reset?.stateAfter}`);
    if (reset?.stateAfter !== 'Collapsed') {
      console.log(`BLOCKED could not reach a known starting state: ${JSON.stringify(reset).slice(0, 200)}`);
      process.exit(2);
    }
  }
  const missing = await call('browser_native_action', { ...target, ref: '1.2.3.4.5', action: 'expand', expect: identity });
  record('a ref that matches no control is refused without dispatch', 'native_control_not_found', missing?.reason,
    `dispatched=${missing?.dispatched} scanned=${missing?.scanned}`);
  record('...and it says nothing was dispatched', false, missing?.dispatched);

  const wrong = await call('browser_native_action', { ...target, ref: picked.ref, action: 'expand', expect: { name: `${picked.name} (not this control)` } });
  record('a ref whose control has another name is refused', 'native_control_identity_mismatch', wrong?.reason,
    `observed=${JSON.stringify(wrong?.observed?.name)} mismatched=${JSON.stringify(wrong?.mismatched)}`);
  record('...and the observed name is reported instead of guessed at', picked.name, wrong?.observed?.name);

  const bare = await call('browser_native_action', { ...target, ref: picked.ref, action: 'expand', expect: { role: 'ControlType.Button' } })
    .then(value => value?.status ?? 'accepted', error => `refused: ${error.message}`);
  record('a ref with only a role is refused before any dispatch', 'refused', String(bare).startsWith('refused') ? 'refused' : bare,
    String(bare).slice(0, 160));

  const already = await call('browser_native_action', { ...target, ref: picked.ref, action: 'collapse', expect: identity });
  record('asking for the state it is already in succeeds without dispatching', true, already?.status === 'success' && already?.dispatched === false,
    `status=${already?.status} dispatched=${already?.dispatched} alreadyInState=${already?.alreadyInState}`);
  record('...and reports the state it read back', picked.state.expandCollapse, already?.stateAfter);

  const expand = await call('browser_native_action', { ...target, ref: picked.ref, action: 'expand', expect: identity });
  expanded = expand?.status === 'success';
  record('expand verifies the state it read back', true,
    expand?.status === 'success' && expand?.verified === true && expand?.dispatched === true && expand?.stateAfter === 'Expanded',
    `status=${expand?.status} verified=${expand?.verified} ${expand?.stateBefore}->${expand?.stateAfter} settleMs=${expand?.settleMs} ${expand?.reason ?? ''}`);

  const open = await call('browser_native_snapshot', target);
  const openButton = open.controls.find(control => control.name === picked.name && control.state?.expandCollapse);
  record('an independent snapshot agrees the menu is open', 'Expanded', openButton?.state?.expandCollapse);
  const items = open.controls.filter(control => control.role === 'ControlType.MenuItem');
  record('the opened menu is reachable as native menu items', true, items.length > 0,
    `${items.length} menuitem(s), ${open.controls.length} controls total, omittedDocuments=${open.omittedDocuments}`);

  const collapse = await call('browser_native_action', { ...target, ref: openButton?.ref ?? picked.ref, action: 'collapse', expect: identity });
  expanded = !(collapse?.status === 'success');
  record('collapse returns it to the state it started in', true,
    collapse?.status === 'success' && collapse?.verified === true && collapse?.stateAfter === picked.state.expandCollapse,
    `status=${collapse?.status} ${collapse?.stateBefore}->${collapse?.stateAfter} ${collapse?.reason ?? ''}`);

  const closed = await call('browser_native_snapshot', target);
  const closedButton = closed.controls.find(control => control.name === picked.name && control.state?.expandCollapse);
  record('an independent snapshot agrees the menu is closed again', picked.state.expandCollapse, closedButton?.state?.expandCollapse);
  record('no menu was left open', 0, closed.controls.filter(control => control.role === 'ControlType.Menu').length);

  // --- invoke: choose one menu item ---------------------------------------
  // Only an item whose command is harmless and whose effect shows up in the
  // window title is eligible. "New tab" qualifies; "Exit", "Print", "Delete
  // browsing data" and "Settings" do not, and a bookmark would navigate the
  // user's page away.
  const appMenu = closed.controls.find(control => control.automationId === 'view_1007' && control.state?.expandCollapse)
    ?? closed.controls.find(menuButton);
  if (!appMenu) {
    skipped.push('invoke: no browser-drawn menu button was found, so no command was chosen');
  } else {
    const appIdentity = { name: appMenu.name, automationId: appMenu.automationId };
    const reopened = await call('browser_native_action', { ...target, ref: appMenu.ref, action: 'expand', expect: appIdentity });
    step(`reopened "${appMenu.name}" for invoke: ${reopened?.status} ${reopened?.stateBefore}->${reopened?.stateAfter}`);
    const menu = await call('browser_native_snapshot', target);
    const item = (menu.controls ?? []).find(control => control.role === 'ControlType.MenuItem' && /^New tab\b/i.test(control.name ?? ''));
    if (!item) {
      skipped.push('invoke: no MenuItem named "New tab" in this menu (the label is localized), so no command was chosen');
      const tidy = await call('browser_native_action', { ...target, ref: appMenu.ref, action: 'collapse', expect: appIdentity });
      step(`closed the menu again: ${tidy?.status}`);
    } else {
      // The cross-channel check below only proves anything if the window does
      // not already say "New tab". Activating an existing http tab costs
      // nothing (reuse, not create) and makes the pre-state deterministic
      // instead of depending on what the user happened to leave in front.
      const listedTabs = await call('browser_tabs', {});
      const home = (listedTabs.tabs ?? listedTabs)[0];
      let titleBefore = '';
      if (home?.url) {
        const refocus = await call('browser_open', { url: home.url, active: true });
        step(`activated an existing tab as the pre-state: reused=${refocus?.reused} ${refocus?.url ?? ''}`);
        await new Promise(resolve => setTimeout(resolve, 600));
        titleBefore = (await call('browser_desktop_windows', {})).windows?.[0]?.title ?? '';
      }
      if (/new tab|新标签页/i.test(titleBefore)) {
        skipped.push(`invoke: the window still showed a new tab (${JSON.stringify(titleBefore)}) before the invoke, so "the title changed" could not prove the command ran`);
      }
      // Only the attributes the snapshot actually gave are repeated; an empty
      // automationId is not an identity and must not be sent as one.
      const itemIdentity = { name: item.name };
      if (item.automationId) itemIdentity.automationId = item.automationId;
      const invoke = await call('browser_native_action', { ...target, ref: item.ref, action: 'invoke',
        expect: { ...itemIdentity, afterInvoke: 'control_gone' } });
      record('invoke verifies the post-condition it declared', true,
        invoke?.status === 'success' && invoke?.verified === true && invoke?.dispatched === true && invoke?.controlGone === true,
        `status=${invoke?.status} verified=${invoke?.verified} controlGone=${invoke?.controlGone} settleMs=${invoke?.settleMs} ${invoke?.reason ?? ''}`);
      const afterInvoke = await call('browser_native_snapshot', target);
      record('the chosen item is no longer in the tree', false,
        (afterInvoke.controls ?? []).some(control => control.role === 'ControlType.MenuItem' && control.name === item.name));
      record('the menu it lived in closed itself', 'Collapsed',
        (afterInvoke.controls ?? []).find(control => control.automationId === appMenu.automationId)?.state?.expandCollapse);
      // Cross-channel proof that the command ran, not just that a menu closed:
      // UI Automation chose the item, and the window title - read from a
      // different API - is what changed.
      const after = await call('browser_desktop_windows', {});
      const title = after.windows?.[0]?.title ?? '';
      record('the command really ran: the window moved to a new tab', true,
        /new tab|新标签页/i.test(title) && title !== titleBefore, `before=${JSON.stringify(titleBefore)} after=${JSON.stringify(title)}`);
      step('residue: one new tab was opened; chrome:// tabs are invisible to browser_tabs, so it cannot be closed from here');
    }
  }
} catch (error) {
  record('acceptance run', 'no exception', 'error', error.message);
} finally {
  // The only cleanup that matters: leave the user's window as it was found.
  // Collapsing is idempotent, so this is safe even if the run above collapsed it.
  if (expanded) {
    const state = await call('browser_native_action', { ...target, ref: picked.ref, action: 'collapse', expect: identity })
      .catch(error => ({ status: `cleanup error: ${error.message}` }));
    step(`cleanup collapse: ${state?.status} ${state?.stateBefore ?? ''}->${state?.stateAfter ?? ''}`);
  }
}

const failed = rows.filter(row => !row.ok);
console.log('expected | actual | verdict | promise');
for (const row of rows) {
  console.log(`${JSON.stringify(row.expected)} | ${JSON.stringify(row.actual)} | ${row.ok ? 'OK' : 'MISMATCH'} | ${row.name}${row.detail ? ` — ${row.detail}` : ''}`);
}
console.log(`\n${rows.length - failed.length}/${rows.length} native action promises held`);
// A step that did not run is never a pass. The exit code says so, because the
// one thing this project keeps relearning is that a silent skip reads exactly
// like success.
if (skipped.length) {
  for (const line of skipped) console.log(`SKIPPED (not a pass) — ${line}`);
  if (failed.length) process.exit(1);
  process.exit(2);
}
process.exit(failed.length ? 1 : 0);
