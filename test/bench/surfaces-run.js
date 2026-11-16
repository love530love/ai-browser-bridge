// Cross-surface benchmark runner.
//
// `run.js` asks whether a weak caller damages a page. This asks a different
// question: can the bridge actually drive the surfaces a real page is built
// from, in the background, and does it ever claim a success the server did not
// see.
//
// The scoring source is the fixture's own write record, never a tool's status
// field. Two numbers come out of that:
//
//   false_success - a write tool returned a verified success while the server
//                   recorded no matching write. This is the dangerous class.
//   foreground    - the task tab became active, or its window gained focus,
//                   between opening it and finishing the task. A background
//                   benchmark that quietly takes focus is not background.
//
// The policy is "guarded with one recovery": each task takes the documented
// route once, checks whether the outcome actually landed, and is allowed a
// single recovery step. The drag task is the positive control for that - the
// native path degrades to a mouse sequence that reports success, and only the
// synthetic dispatch makes the drop happen.
//
// Exit codes: 0 = every invariant held, 1 = an invariant broke, 2 = blocked
// (extension build does not match this source tree), never a pass.
import { writeFileSync, readFileSync, unlinkSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { request } from '../../src/client.js';
import { startSurfaceSite } from './surfaces.js';

const benchDir = fileURLToPath(new URL('.', import.meta.url));
const repoRoot = join(benchDir, '..', '..');
const expectedVersion = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8')).version;
const agent = 'surfaces-bench';
const call = async (name, args = {}) => (await request('/call', { name, arguments: { ...args, agent } })).result;

const startedAt = Date.now();
const step = message => console.error(`[${((Date.now() - startedAt) / 1000).toFixed(1)}s] ${message}`);
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const bounded = (promise, ms) => Promise.race([promise, new Promise(resolve => setTimeout(resolve, ms))]);

// A write here means a call that can change page or server state and whose
// reply can claim it did. browser_eval is deliberately absent: it is the
// trigger for the dialog surface, and scheduling a click is not itself a claim
// that the click's outcome happened.
const WRITE_TOOLS = new Set([
  'browser_click', 'browser_click_verified', 'browser_fill', 'browser_fill_verified',
  'browser_select', 'browser_select_verified', 'browser_choose', 'browser_choose_verified',
  'browser_dismiss_overlay', 'browser_drag', 'browser_dialog', 'browser_upload_verified'
]);

const statusOf = attempt => {
  if (!attempt) return 'none';
  if (!attempt.ok) return `error:${attempt.error}`;
  return attempt.result?.status ?? (attempt.result?.clicked === true ? 'clicked' : 'no_status');
};

function makeContext(site) {
  const ctx = {
    site,
    tabId: null,
    steps: 0,
    notes: [],
    writes: [],
    note(message) { if (message) ctx.notes.push(message); },
    async attempt(name, args = {}, { injectTab = true } = {}) {
      ctx.steps++;
      const at = Date.now();
      try {
        // Not every tool takes a tabId: the download tools answer from the
        // browser's download manager and reject the argument, which used to fail
        // the whole probe under a status of no_status.
        const result = await call(name, {
          ...(ctx.tabId !== null && injectTab ? { tabId: ctx.tabId } : {}),
          ...args
        });
        return { ok: true, result, ms: Date.now() - at };
      } catch (error) {
        ctx.note(`${name} failed: ${error.message}`);
        return { ok: false, error: error.message, ms: Date.now() - at };
      }
    },
    // Counts as a step and records what the reply actually claimed. The status
    // is normalised only where a tool reports its outcome without a status
    // field; nothing is upgraded.
    async write(name, args = {}) {
      const attempt = await ctx.attempt(name, args);
      if (WRITE_TOOLS.has(name)) {
        const result = attempt.result ?? null;
        let status = result?.status ?? null;
        let verified = result?.verified ?? null;
        if (name === 'browser_dismiss_overlay') {
          status = result?.verification?.status === 'gone' ? 'success' : 'unconfirmed';
          verified = status === 'success';
        }
        ctx.writes.push({ tool: name, status, verified, reason: result?.reason ?? null, ms: attempt.ms });
      }
      return attempt;
    },
    async open(path) {
      const target = `${site.base}${path}`;
      const tab = await call('browser_open', { url: target });
      ctx.tabId = tab.tabId;
      // readyState alone is not enough: a freshly created tab reports the
      // complete state of about:blank before the navigation starts. A CDP
      // session that attaches in that window misses every scriptParsed event,
      // which made the source-map probe report "script_not_found" on a page that
      // had its script. Wait for the URL and the document together.
      for (let i = 0; i < 60; i++) {
        const health = await call('browser_health', { tabId: tab.tabId }).catch(() => null);
        const current = String(health?.tab?.url ?? '');
        const probe = health?.tab?.pageProbe;
        if (current.startsWith(target) && probe?.readyState === 'complete') break;
        await sleep(150);
      }
      return tab.tabId;
    },
    async read(args = {}) {
      return ctx.attempt('browser_read', args);
    },
    async snapshot() {
      const health = await call('browser_health', { tabId: ctx.tabId }).catch(() => null);
      const tab = health?.tab ?? null;
      if (!tab) return null;
      return {
        active: tab.active === true ? true : tab.active === false ? false : null,
        windowFocused: tab.windowFocused === true ? true : tab.windowFocused === false ? false : null,
        visibilityState: tab.pageProbe?.visibilityState ?? null,
        hasFocus: tab.pageProbe?.hasFocus ?? tab.pageProbe?.focused ?? null
      };
    }
  };
  return ctx;
}

const elementsOf = attempt => attempt?.result?.elements ?? [];
const labeled = (elements, pattern) => elements.find(element => pattern.test(String(element?.label ?? '')));

// ---------------------------------------------------------------------------
// One task per surface. Each returns { note, recovered } and must not read the
// oracle itself except where delivery decides whether a recovery is safe (drag
// would write twice if it did).
// ---------------------------------------------------------------------------

const TASKS = [
  {
    id: 'shadow-dom',
    start: '/surface/shadow',
    intent: 'click a button inside an open shadow root',
    oracle: site => site.state.writes.shadow === 1,
    async run(ctx) {
      const tree = await ctx.attempt('browser_shadow_tree', { includeClickable: true });
      const approve = (tree.result?.controls ?? []).find(control => /approve shadow/i.test(control.label ?? ''));
      if (!approve?.ref) return { note: `no shadow control ref (roots=${tree.result?.shadowRootCount ?? '?'})` };
      const click = await ctx.write('browser_click_verified', {
        ref: approve.ref, expect: { textAppears: 'Shadow approved' }, timeoutMs: 8000
      });
      return { note: `roots=${tree.result?.shadowRootCount} click=${statusOf(click)}` };
    }
  },
  {
    id: 'iframe-form',
    start: '/surface/iframe',
    intent: 'fill and submit a form inside a same-origin iframe',
    oracle: site => site.state.writes.iframe.length === 1 && site.state.writes.iframe[0].note === 'hello frame',
    async run(ctx) {
      const read = await ctx.read({ frame: 'all' });
      // frame:'all' returns one result per frame, not a merged element list.
      // Refs inside each result are already decorated with @frame<id>.
      const elements = (read.result?.frameResults ?? []).flatMap(frame => frame.result?.elements ?? []);
      const input = labeled(elements, /frame note/i);
      const send = labeled(elements, /send from frame/i);
      if (!input?.ref?.includes('@frame') || !send?.ref?.includes('@frame')) {
        return { note: `frame refs missing (elements=${elements.length})` };
      }
      const fill = await ctx.write('browser_fill_verified', {
        ref: input.ref, text: 'hello frame', expect: { valueMatches: 'hello frame' }, timeoutMs: 6000
      });
      const click = await ctx.write('browser_click_verified', {
        ref: send.ref, expect: { textAppears: 'Frame sent: hello frame' }, timeoutMs: 8000
      });
      const parent = await ctx.read();
      const crossed = /Frame sent: hello frame/.test(parent.result?.text ?? '');
      return { note: `fill=${statusOf(fill)} click=${statusOf(click)} parentSaw=${crossed}` };
    }
  },
  {
    id: 'roleless-card',
    start: '/surface/roleless',
    intent: 'click a div with a click handler and no role, href or tabindex',
    oracle: site => site.state.writes.roleless === 1,
    async run(ctx) {
      const found = await ctx.attempt('browser_find_text', { query: 'Archive project', includeMatchElement: true });
      const hit = (found.result?.matchElements ?? []).find(element => element.covered !== true);
      if (!hit?.ref) return { note: `no uncovered text match (found=${found.result?.found})` };
      const click = await ctx.write('browser_click_verified', {
        ref: hit.ref, expect: { textAppears: 'Archived roleless' }, timeoutMs: 8000
      });
      return { note: `match=${hit.tag} click=${statusOf(click)}` };
    }
  },
  {
    id: 'virtual-list',
    start: '/surface/virtual',
    intent: 'scroll a nested virtualized list to item 157 and select it',
    oracle: site => site.state.writes.virtual.length === 1 && site.state.writes.virtual[0].id === '157',
    async run(ctx) {
      const scan = await ctx.attempt('browser_scan_overlays', {});
      const containers = scan.result?.scrollContainers ?? [];
      const scroller = containers.find(container => (container.scrollHeight ?? 0) >= 5000) ?? containers[0];
      if (!scroller?.ref) return { note: `no scroll container (count=${containers.length})` };
      const scrolled = await ctx.attempt('browser_scroll_element', { ref: scroller.ref, deltaY: 4580 });
      const found = await ctx.attempt('browser_find_element', { query: 'Item 157', action: 'click', maxResults: 5 });
      const target = (found.result?.candidates ?? []).find(candidate => candidate.covered !== true) ?? found.result?.candidates?.[0];
      if (!target?.ref) return { note: `item 157 not found after scrollTop=${scrolled.result?.scrollTop ?? '?'}` };
      const click = await ctx.write('browser_click_verified', {
        ref: target.ref, expect: { textAppears: 'Selected 157' }, timeoutMs: 8000
      });
      return { note: `scrollTop=${scrolled.result?.scrollTop} click=${statusOf(click)}` };
    }
  },
  {
    id: 'overlay-dismiss',
    start: '/surface/overlay',
    intent: 'dismiss a guide overlay, then accept the terms behind it',
    oracle: site => site.state.writes.overlay === 1,
    async run(ctx) {
      const findParts = scan => {
        const overlay = (scan.result?.overlays ?? []).find(item => /guide|welcome/i.test(`${item.label ?? ''} ${item.hint ?? ''} ${item.selector ?? ''}`))
          ?? scan.result?.overlays?.[0];
        const close = (overlay?.closeCandidates ?? []).find(candidate => /close/i.test(candidate.label ?? ''));
        return { overlay, close };
      };
      let scan = await ctx.attempt('browser_scan_overlays', {});
      let { overlay, close } = findParts(scan);
      if (!overlay?.ref || !close?.ref) return { note: `overlay or close ref missing (overlays=${scan.result?.overlays?.length ?? 0})` };
      let dismissed = await ctx.write('browser_dismiss_overlay', {
        ref: close.ref, expectGoneRef: overlay.ref, timeoutMs: 4000
      });
      let recovered = false;
      if (dismissed.result?.verification?.status !== 'gone') {
        // One recovery: the overlay may have re-rendered between the scan and
        // the click, which invalidates the close ref. Re-scan and retry once.
        recovered = true;
        scan = await ctx.attempt('browser_scan_overlays', {});
        ({ overlay, close } = findParts(scan));
        if (close?.ref) dismissed = await ctx.write('browser_dismiss_overlay', { ref: close.ref, expectGoneRef: overlay?.ref, timeoutMs: 4000 });
      }
      const page = await ctx.read();
      const accept = labeled(elementsOf(page), /accept terms/i);
      if (!accept?.ref) return { recovered, note: `accept control missing after dismiss (${statusOf(dismissed)})` };
      const click = await ctx.write('browser_click_verified', {
        ref: accept.ref, expect: { textAppears: 'Terms accepted' }, timeoutMs: 8000
      });
      return { recovered, note: `dismiss=${statusOf(dismissed)} click=${statusOf(click)}` };
    }
  },
  {
    id: 'native-dialog',
    start: '/surface/dialog',
    intent: 'answer a native confirm() and let its write land',
    oracle: site => site.state.writes.dialog === 1,
    async run(ctx) {
      const scheduled = await ctx.attempt('browser_eval', {
        // The trigger is a delayed network callback, not a timer: a hidden tab
        // throttles setTimeout (the first live run lost the dialog for 12s)
        // while network response tasks still run. mode:"write" is required:
        // the default read mode shadows fetch and confirm.
        mode: 'write',
        expression: "fetch('/surface/ping').then(() => document.getElementById('confirm').click()); 'scheduled'"
      });
      if (!scheduled.ok) return { note: `trigger failed: ${scheduled.error}` };
      const answered = await ctx.write('browser_dialog', { action: 'wait', accept: true, timeoutMs: 12000 });
      if (answered.result?.code === 'TAB_OCCLUDED'
          || answered.result?.reason === 'dialog_suppressed_in_background_tab') {
        // Chrome suppresses JavaScript dialogs in a hidden tab: confirm()
        // returned without showing anything, so there is no dialog to answer and
        // no write to record. Score the refusal's honesty, not a write that the
        // platform makes impossible without the foreground.
        await sleep(400);
        const alive = await ctx.attempt('browser_eval', { mode: 'read', expression: '1+1' });
        const pageWritable = alive.ok && alive.result?.value === 2;
        return {
          skipped: pageWritable,
          recovered: false,
          note: `background=${answered.result.reason} pageResponsive=${pageWritable}`
        };
      }
      let recovered = false;
      if (answered.result?.status !== 'success') {
        recovered = true;
        await ctx.attempt('browser_dialog', { action: 'status' });
        await ctx.write('browser_dialog', { action: 'handle', accept: true });
      }
      let seen = false;
      for (let i = 0; i < 10; i++) {
        await sleep(300);
        const after = await ctx.read();
        if (/Archive deleted/.test(after.result?.text ?? '')) { seen = true; break; }
      }
      return { recovered, note: `answer=${statusOf(answered)} textSeen=${seen}` };
    }
  },
  {
    id: 'html5-drag',
    start: '/surface/drag',
    intent: 'drag a draggable ticket onto a drop zone and confirm the drop was accepted',
    oracle: site => site.state.writes.drag === 1,
    async run(ctx) {
      // Both endpoints are plain divs with no role, so browser_read does not
      // list them. includeMatchElement is what turns visible text into a ref.
      const fromFound = await ctx.attempt('browser_find_text', { query: 'Task ticket', includeMatchElement: true });
      const toFound = await ctx.attempt('browser_find_text', { query: 'Done', includeMatchElement: true });
      const from = (fromFound.result?.matchElements ?? []).find(element => element.covered !== true);
      const to = (toFound.result?.matchElements ?? []).find(element => element.covered !== true);
      if (!from?.ref || !to?.ref) return { note: `drag endpoints missing (from=${!!from} to=${!!to})` };
      const native = await ctx.write('browser_drag', { fromRef: from.ref, toRef: to.ref, mode: 'auto', steps: 16 });
      await sleep(600);
      // The auto path reports success even when it degraded to a press-move-
      // release that the page ignored. Check the server before recovering, so a
      // native drag that did work is never replayed into a duplicate.
      if (ctx.site.state.writes.drag === 1) return { note: `delivered on auto (${statusOf(native)})` };
      const synthetic = await ctx.write('browser_drag', { fromRef: from.ref, toRef: to.ref, mode: 'synthetic' });
      await sleep(600);
      return { recovered: true, note: `auto=${statusOf(native)} synthetic=${statusOf(synthetic)}` };
    }
  }
];

// ---------------------------------------------------------------------------
// Read probes: no server write, but a claimed success still has to be true.
// ---------------------------------------------------------------------------

async function probeCanvas(site, ctx) {
  await ctx.open(`/surface/canvas?surface=${++probeSeq}`);
  const ocr = await ctx.attempt('browser_ocr', {});
  const result = ocr.result ?? {};
  if (result.status === 'success') {
    const text = String(result.text ?? '');
    return {
      id: 'canvas-ocr',
      status: 'success',
      ok: text.includes('7319'),
      claimConsistent: text.includes('7319'),
      detail: `coords=${result.coordinatesAvailable} lines=${result.lineCount ?? '?'} found=${text.includes('7319')}`
    };
  }
  if (['unavailable', 'denied', 'blocked', 'timeout'].includes(result.status)) {
    return {
      id: 'canvas-ocr', status: result.status, ok: true, claimConsistent: true, skipped: true,
      detail: `structured ${result.status}${result.reason ? ` (${result.reason})` : ''}; no success claimed`
    };
  }
  return { id: 'canvas-ocr', status: result.status ?? 'no_status', ok: false, claimConsistent: true, detail: `unexpected status; ${ocr.error ?? result.reason ?? ''}` };
}

async function probeSourceMap(site, ctx) {
  await ctx.open(`/surface/source?surface=${++probeSeq}`);
  const map = await ctx.attempt('browser_source_map', { url: `${site.base}/surface/app.js`, settleMs: 600 });
  const sources = map.result?.sources ?? [];
  const found = sources.includes('src/app.ts');
  return {
    id: 'source-map',
    status: map.result?.status ?? (map.ok ? 'no_status' : 'error'),
    ok: found,
    detail: `sources=${sources.length} via=${map.result?.via ?? '?'} mapped=${found}${map.result?.reason ? ` reason=${map.result.reason}` : ''}${map.error ? ` error=${map.error}` : ''}`
  };
}

async function probeDownload(site, ctx) {
  // Attachment navigation is a site-level automatic download, and Chrome blocks
  // the second one from the same host without a user gesture - measured here:
  // the first run produced a row, every later run was silently dropped. The
  // bridge's own PDF save hands the bytes to the download manager directly, so
  // that is the route this probe scores. The attachment fixture stays for a
  // manual check that already has a human gesture.
  await ctx.open(`/surface/report?surface=${++probeSeq}`);
  const name = `bridge-bench-report-${Date.now()}.pdf`;
  const before = await ctx.attempt('browser_downloads', { query: 'bridge-bench-report', limit: 20 }, { injectTab: false });
  const known = new Set((before.result?.downloads ?? []).map(row => row.id));
  const printed = await ctx.attempt('browser_pdf_save', { filename: name });
  // The downloadId is the anchor: Chrome does not keep the requested name for a
  // data-URL download (measured: it lands as "download (n).pdf"), so selecting a
  // row by filename only ever works by accident.
  let item = Number.isInteger(printed.result?.downloadId)
    ? { id: printed.result.downloadId, filename: null }
    : null;
  for (let i = 0; i < 40 && !item; i++) {
    await sleep(300);
    const list = await ctx.attempt('browser_downloads', { query: 'bridge-bench-report', limit: 20 }, { injectTab: false });
    item = (list.result?.downloads ?? []).find(row => !known.has(row.id) && /\.pdf$/i.test(String(row.filename ?? ''))) ?? null;
  }
  if (!item) {
    return {
      id: 'download', status: 'not_found', ok: false,
      detail: `no download row (print=${statusOf(printed)}${printed.error ? ` printError=${printed.error}` : ''})`
    };
  }
  const waited = await ctx.attempt('browser_download_wait', { downloadId: item.id, timeoutMs: 12000 }, { injectTab: false });
  let download = waited.result?.download ?? null;
  if (!download?.filename) {
    const byId = await ctx.attempt('browser_downloads', { downloadId: item.id }, { injectTab: false });
    download = (byId.result?.downloads ?? [])[0] ?? download;
  }
  download = download ?? item;
  let magic = null;
  let deleted = false;
  let deleteError = null;
  try {
    if (download.filename && existsSync(download.filename)) {
      magic = readFileSync(download.filename).subarray(0, 5).toString('latin1');
      unlinkSync(download.filename);
      deleted = true;
    }
  } catch (error) {
    deleteError = error.message;
  }
  const complete = download.state === 'complete';
  return {
    id: 'download',
    status: waited.result?.status ?? download.state ?? 'no_status',
    ok: complete && magic === '%PDF-' && deleted,
    deleted,
    detail: `print=${statusOf(printed)} wait=${statusOf(waited)} state=${download.state} magic=${magic ?? 'none'} fileExists=${download.exists ?? waited.result?.fileExists} deleted=${deleted}${deleteError ? ` deleteError=${deleteError}` : ''}${waited.error ? ` waitError=${waited.error}` : ''}`
  };
}

// ---------------------------------------------------------------------------
// Runner.
// ---------------------------------------------------------------------------

let site = null;
let probeSeq = 0;
let runSeq = 0;
let blocked = null;
const opened = [];
const rows = [];
const probes = [];
const globalBefore = { at: Date.now(), snapshot: null };
const globalLast = { snapshot: null };

function foregroundChange(before, after) {
  if (!before || !after) return { changed: null, detail: 'state not observable' };
  const becameActive = before.active === false && after.active === true;
  const gainedFocus = before.windowFocused === false && after.windowFocused === true;
  return {
    changed: becameActive || gainedFocus,
    becameActive,
    gainedFocus,
    detail: `active ${before.active}->${after.active}, windowFocused ${before.windowFocused}->${after.windowFocused}, visibility ${before.visibilityState}->${after.visibilityState}`
  };
}

async function runOne(task) {
  site.reset();
  const ctx = makeContext(site);
  runSeq += 1;
  const taskStart = Date.now();
  let outcome = { note: '', recovered: false };
  let baseline = null;
  let after = null;
  try {
    await ctx.open(`${task.start}?surface=${runSeq}`);
    opened.push(ctx.tabId);
    baseline = await ctx.snapshot();
    if (!globalBefore.snapshot) globalBefore.snapshot = baseline;
    outcome = (await task.run(ctx)) ?? outcome;
    await sleep(1200);
    after = await ctx.snapshot();
    globalLast.snapshot = after;
  } catch (error) {
    outcome = { note: `threw: ${error.message}`, recovered: false };
  }
  const ok = Boolean(task.oracle(site));
  const claimed = ctx.writes.filter(write => write.status === 'success' && write.verified !== false);
  const unverified = ctx.writes.filter(write => write.status === 'success' && write.verified === false);
  const foreground = foregroundChange(baseline, after);
  const row = {
    task: task.id,
    intent: task.intent,
    oracleOk: ok,
    skipped: outcome.skipped === true,
    skipReason: outcome.skipped ? outcome.note : null,
    firstWrite: ctx.writes[0] ? { tool: ctx.writes[0].tool, status: ctx.writes[0].status, verified: ctx.writes[0].verified } : null,
    recovered: Boolean(outcome.recovered),
    falseSuccess: !ok && claimed.length > 0,
    claimedVerifiedWrites: claimed.length,
    unverifiedSuccesses: unverified.length,
    writes: ctx.writes,
    steps: ctx.steps,
    durationMs: Date.now() - taskStart,
    foregroundChanged: foreground.changed,
    foregroundDetail: foreground.detail,
    observed: JSON.stringify(site.state.writes),
    note: [outcome.note, ...ctx.notes].filter(Boolean).join('; ')
  };
  rows.push(row);
  step(`${task.id}: oracle=${row.skipped ? 'skipped' : row.oracleOk} first=${row.firstWrite?.tool ?? 'none'}/${row.firstWrite?.status ?? '-'} recovered=${row.recovered} falseSuccess=${row.falseSuccess} steps=${row.steps} foreground=${row.foregroundChanged}${row.note ? ` (${row.note})` : ''}`);
  if (!row.oracleOk) step(`    observed ${row.observed.slice(0, 240)}`);
  return row;
}

try {
  site = await startSurfaceSite();
  const health = await call('browser_health');
  if ((health?.extensionVersion ?? null) !== expectedVersion) {
    blocked = `loaded extension is ${health?.extensionVersion ?? 'unknown'} but this source tree is ${expectedVersion}`;
    throw new Error(blocked);
  }

  for (const task of TASKS) await runOne(task);

  const probeTabCtx = makeContext(site);
  probes.push(await probeCanvas(site, probeTabCtx));
  opened.push(probeTabCtx.tabId);
  const sourceCtx = makeContext(site);
  probes.push(await probeSourceMap(site, sourceCtx));
  opened.push(sourceCtx.tabId);
  const downloadCtx = makeContext(site);
  probes.push(await probeDownload(site, downloadCtx));
  opened.push(downloadCtx.tabId);
} catch (error) {
  if (!blocked) step(`fixture setup failed: ${error.message}`);
}

// Close only tabs this run opened. A tab that Chrome already closed for a
// download answers an error, which is not a failure.
for (const tabId of [...new Set(opened)].filter(Number.isInteger)) {
  await bounded(call('browser_close', { tabId, force: true }).catch(() => {}), 8000);
}
if (site) await bounded(site.close(), 4000);

const globalForeground = foregroundChange(globalBefore.snapshot, globalLast.snapshot);

// ---------------------------------------------------------------------------
// Invariants.
// ---------------------------------------------------------------------------

const writeRows = rows;
const totalFalseSuccess = writeRows.filter(row => row.falseSuccess).length;
const foregroundRows = writeRows.filter(row => row.foregroundChanged === true);
const drag = writeRows.find(row => row.task === 'html5-drag');
const overlay = writeRows.find(row => row.task === 'overlay-dismiss');
const dialog = writeRows.find(row => row.task === 'native-dialog');
const canvas = probes.find(probe => probe.id === 'canvas-ocr');
const source = probes.find(probe => probe.id === 'source-map');
const download = probes.find(probe => probe.id === 'download');
const recoveredRows = writeRows.filter(row => row.recovered);

const invariants = [
  {
    name: 'every surface produced the write the server recorded',
    // A skipped surface is only acceptable as a structured background refusal:
    // no verified claim, and the reason is recorded. It is never counted as a
    // success.
    check: () => writeRows.length === TASKS.length && writeRows.every(row =>
      row.oracleOk === true || (row.skipped === true && row.claimedVerifiedWrites === 0)),
    detail: () => writeRows.map(row => `${row.task}=${row.oracleOk}${row.skipped ? '(skipped)' : ''}`).join(' ')
  },
  {
    name: 'no write claimed a verified success the server did not see',
    check: () => totalFalseSuccess === 0,
    detail: () => totalFalseSuccess ? writeRows.filter(row => row.falseSuccess).map(row => `${row.task}:claimed=${row.claimedVerifiedWrites}`).join(' ') : 'false_success=0'
  },
  {
    name: 'no task changed tab activation or window focus',
    check: () => foregroundRows.length === 0 && globalForeground.changed !== true,
    detail: () => foregroundRows.length
      ? foregroundRows.map(row => `${row.task}(${row.foregroundDetail})`).join(' ')
      : `global ${globalForeground.detail}`
  },
  {
    name: 'one recovery kept the write count at exactly one',
    check: () => Boolean(drag?.recovered) && drag?.oracleOk === true && writeRows.find(row => row.task === 'html5-drag')?.writes?.length >= 2,
    detail: () => `drag recovered=${drag?.recovered} oracle=${drag?.oracleOk} writes=${drag?.writes?.length}`
  },
  {
    name: 'a guarded recovery did not duplicate the overlay or dialog write',
    check: () => overlay?.oracleOk === true && (dialog?.oracleOk === true || dialog?.skipped === true),
    detail: () => `overlay=${overlay?.oracleOk} dialog=${dialog?.oracleOk}${dialog?.skipped ? '(skipped)' : ''} recovered=${recoveredRows.map(row => row.task).join(',') || 'none'}`
  },
  {
    name: 'OCR never claimed text it did not read',
    check: () => canvas?.claimConsistent !== false,
    detail: () => `canvas status=${canvas?.status} ${canvas?.detail ?? 'probe did not run'}`
  },
  {
    name: 'the source map resolved to its original source',
    check: () => source?.ok === true,
    detail: () => `source-map ${source?.detail ?? 'probe did not run'}`
  },
  {
    name: 'the download completed and this run removed the file it created',
    check: () => download?.ok === true && download?.deleted === true,
    detail: () => `download ${download?.detail ?? 'probe did not run'}`
  }
];

console.log('task            | oracle | first write              | recovered | false-success | steps | fg');
console.log('----------------|--------|--------------------------|-----------|---------------|-------|----');
for (const row of writeRows) {
  const first = row.firstWrite ? `${row.firstWrite.tool}/${row.firstWrite.status}` : 'none';
  console.log(`${row.task.padEnd(15)} | ${(row.skipped ? 'skipped' : String(row.oracleOk)).padEnd(6)} | ${first.padEnd(24)} | ${String(row.recovered).padEnd(9)} | ${String(row.falseSuccess).padEnd(13)} | ${String(row.steps).padStart(5)} | ${row.foregroundChanged}`);
}
for (const probe of probes) {
  console.log(`probe ${probe.id.padEnd(10)} | ok=${probe.ok} status=${probe.status} ${probe.detail ?? ''}`);
}
console.log('');
const broken = invariants.filter(invariant => !invariant.check());
for (const invariant of invariants) {
  console.log(`${broken.includes(invariant) ? 'BROKE' : 'HELD '} ${invariant.name} — ${invariant.detail()}`);
}

try {
  writeFileSync(join(benchDir, 'surfaces-run.json'), JSON.stringify({
    version: expectedVersion,
    at: new Date().toISOString(),
    durationMs: Date.now() - startedAt,
    totals: {
      tasks: writeRows.length,
      oracleOk: writeRows.filter(row => row.oracleOk).length,
      skipped: writeRows.filter(row => row.skipped).length,
      steps: writeRows.reduce((sum, row) => sum + row.steps, 0),
      recovered: recoveredRows.length,
      falseSuccess: totalFalseSuccess,
      foregroundChanges: foregroundRows.length
    },
    globalForeground,
    rows: writeRows,
    probes,
    invariants: invariants.map(invariant => ({ name: invariant.name, held: invariant.check(), detail: invariant.detail() }))
  }, null, 1));
} catch { /* a read-only checkout is not a reason to fail the run */ }

if (blocked) {
  console.log(`\nBLOCKED ${blocked}`);
  console.log('No checks ran. This is a blocked environment, not a pass and not a code verdict.');
  process.exit(2);
}
console.log(`\n${invariants.length - broken.length}/${invariants.length} invariants held across ${writeRows.length} surfaces`);
process.exit(broken.length ? 1 : 0);
