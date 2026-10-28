import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { delimiter, join } from 'node:path';
import { existsSync } from 'node:fs';

// Expand and collapse only dispatch a state, invoke dispatches a command.
// Toggle is deliberately absent: a toggle that is dispatched twice returns the
// control to where it started, so an uncertain result cannot be retried safely.
// Expand and collapse are idempotent - asking for a state the control is already
// in dispatches nothing - which is what makes "retry after uncertain" a safe
// instruction instead of a hazard. Invoke is the opposite: it is not idempotent,
// so it is only offered together with a declared post-condition the result can
// be judged against, and an uncertain invoke must never be repeated.
export const NATIVE_ACTION_NAMES = ['expand', 'collapse', 'invoke'];
// The one thing this layer can observe after an invoke: the item it just chose
// is no longer in the tree, which is what closing a menu does. Anything about
// the command the item runs happens outside UI Automation.
export const INVOKE_POST_CONDITIONS = ['control_gone'];
const EXPAND_COLLAPSE_STATES = ['Collapsed', 'Expanded', 'PartiallyExpanded', 'LeafNode'];
const RESULT_STATUSES = ['success', 'not_dispatched', 'uncertain', 'failed'];

// Invoke evidence. Narrower than the expand/collapse rules on purpose:
//   * success means the declared post-condition was observed, never that the
//     pattern call returned without raising;
//   * "failed" is not available, because "the item is still there" is an
//     absence of evidence, not evidence that the command did not run;
//   * a non-success may not claim verification or report the control as gone.
function validateInvokeResult(value) {
  if (!INVOKE_POST_CONDITIONS.includes(value.postCondition)) {
    throw new Error('An invoke result must name the post-condition it was checked against');
  }
  if (value.status === 'failed') {
    throw new Error('An invoke cannot report failed: the command behind the item is not observable here');
  }
  if (value.status !== 'success') {
    if (value.verified === true) throw new Error('A non-success result cannot claim verification');
    if (value.status === 'not_dispatched' && value.dispatched !== false) throw new Error('not_dispatched must report no dispatch');
    if (value.status === 'uncertain' && value.dispatched === false) throw new Error('An uncertain invoke must report that it was dispatched');
    if (value.controlGone === true) throw new Error('A non-success invoke cannot report the control as gone');
    return value;
  }
  if (value.verified !== true || value.dispatched !== true || value.controlGone !== true ||
      !Number.isFinite(value.settleMs) || value.settleMs < 0) {
    throw new Error('Invalid native invoke verification');
  }
  return value;
}

// The result is the evidence, so it is validated like one. The rules encode the
// three things a caller must be able to trust:
//   * success means the state was read back from the control, not that a call
//     returned without raising;
//   * "already in state" can never be reported as a dispatch;
//   * a result that did not succeed can never claim verification.
export function validateNativeActionResult(value, target) {
  if (!value || !RESULT_STATUSES.includes(value.status) ||
      value.processId !== target.processId || value.windowHandle !== target.windowHandle ||
      ![true, false, null].includes(value.dispatched) ||
      !NATIVE_ACTION_NAMES.includes(value.action)) {
    throw new Error('Invalid native action evidence');
  }
  if (value.action === 'invoke') return validateInvokeResult(value);
  if (value.postCondition !== undefined) throw new Error('A post-condition only applies to invoke');

  if (value.stateBefore !== undefined && value.stateBefore !== null && !EXPAND_COLLAPSE_STATES.includes(value.stateBefore)) {
    throw new Error('Invalid native action state before');
  }
  if (value.stateAfter !== undefined && value.stateAfter !== null && !EXPAND_COLLAPSE_STATES.includes(value.stateAfter)) {
    throw new Error('Invalid native action state after');
  }
  const satisfied = state => value.action === 'expand'
    ? ['Expanded', 'PartiallyExpanded'].includes(state)
    : state === 'Collapsed';
  if (value.status !== 'success') {
    if (value.verified === true) throw new Error('A non-success result cannot claim verification');
    if (value.status === 'not_dispatched' && value.dispatched !== false) throw new Error('not_dispatched must report no dispatch');
    if (value.status === 'not_dispatched' && value.stateAfter) throw new Error('not_dispatched cannot report an after-state');
    // A result may carry the state it observed after dispatching, but it may
    // never carry the state it says it failed to reach.
    if (value.status === 'failed' && value.stateAfter && satisfied(value.stateAfter)) {
      throw new Error('A failed result cannot report the requested state as reached');
    }
    return value;
  }
  if (value.verified !== true || typeof value.alreadyInState !== 'boolean' ||
      !satisfied(value.stateAfter) ||
      (value.alreadyInState ? value.dispatched !== false : value.dispatched !== true) ||
      (value.alreadyInState && value.stateBefore !== value.stateAfter)) {
    throw new Error('Invalid native action verification');
  }
  return value;
}

export async function nativeUiAction(target, {
  ref, action, expect = {}, platform = process.platform, timeoutMs = 12000
} = {}) {
  if (platform !== 'win32') return { status: 'unavailable', dispatched: false, reason: 'platform_unsupported' };
  if (![target.processId, target.windowHandle].every(n => Number.isSafeInteger(n) && n > 0)) throw new Error('Exact process and window required');
  if (typeof ref !== 'string' || !ref || !NATIVE_ACTION_NAMES.includes(action)) throw new Error('A snapshot ref and a supported action are required');
  // Refused before anything is spawned: an invoke without a declared
  // post-condition has no success criterion, and a caller that cannot say what
  // it expects to see afterwards is not ready to run a command it cannot undo.
  if (action === 'invoke' && !INVOKE_POST_CONDITIONS.includes(expect.afterInvoke)) {
    throw new Error('invoke requires expect.afterInvoke (control_gone): a pattern call that returned is not evidence the command ran');
  }
  if (action !== 'invoke' && expect.afterInvoke !== undefined) {
    throw new Error('expect.afterInvoke only applies to invoke');
  }
  const executable = (process.env.PATH ?? '').split(delimiter).map(p => join(p.replace(/^"|"$/g, ''), 'pwsh.exe')).find(existsSync);
  if (!executable) return { status: 'unavailable', dispatched: false, reason: 'powershell7_unavailable' };
  const script = fileURLToPath(new URL('../scripts/native-ui-action.ps1', import.meta.url));
  const args = ['-NoProfile', '-NonInteractive', '-File', script,
    '-ChromeProcessId', String(target.processId), '-ChromeWindowHandle', String(target.windowHandle),
    '-Ref', ref, '-Action', action];
  if (expect.name) args.push('-ExpectName', String(expect.name));
  if (expect.role) args.push('-ExpectRole', String(expect.role));
  if (expect.automationId) args.push('-ExpectAutomationId', String(expect.automationId));
  if (expect.afterInvoke) args.push('-ExpectAfterInvoke', String(expect.afterInvoke));
  return new Promise(resolve => {
    let output = '';
    let settled = false;
    let timer;
    const done = result => { if (!settled) { settled = true; clearTimeout(timer); resolve(result); } };
    const failed = reason => ({ status: 'failed', reason, dispatched: false, retryable: true,
      processId: target.processId, windowHandle: target.windowHandle });
    const child = spawn(executable, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
    timer = setTimeout(() => { child.kill(); done(failed('native_action_timeout')); }, timeoutMs);
    child.stdout.on('data', chunk => {
      output += chunk.toString('utf8');
      if (output.length > 65536) { child.kill(); done(failed('native_action_output_limit')); }
    });
    child.on('error', () => done(failed('native_action_spawn_failed')));
    child.on('close', code => {
      if (settled) return;
      try { if (code !== 0) throw Error(); done(validateNativeActionResult(JSON.parse(output), target)); }
      catch { done(failed('native_action_invalid_result')); }
    });
  });
}
