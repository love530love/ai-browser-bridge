// The offline task suite: can a caller that cannot read the page finish the job,
// and does it break anything on the way.
//
// Why this exists. Every other acceptance script here answers "is this
// capability correct". None of them answers "does the whole thing work for a
// caller that is bad at this", so the claim "a weak agent can finish arbitrary
// tasks" was unfalsifiable. This file makes it falsifiable with three numbers
// per run:
//
//   completed - the fixture server's own state, never the caller's claim;
//   danger    - writes the fixture recorded that should not have happened
//               (a wrong target, or the same write twice);
//   steps     - calls the caller had to make.
//
// On policies. A real model is not in the loop: the base must work with no
// model at all, and a benchmark that needs an API key is a benchmark nobody
// runs. So the failure modes are injected instead of a model being called.
// Each policy is a fixed behaviour, and each is something a real caller does:
//
//   blind   - locates by the first label that looks close, uses the tools that
//             return no verdict, and acts again when it has no verdict. This is
//             what a caller does when it cannot read the page.
//   guarded - locates only when the label is unique, uses the *_verified tools
//             and stops on anything that is not a success. This is what a
//             careful caller does with the same tools.
//   recipe  - decides the flow once, stores it, replays it. This is what a
//             caller does when it has done the flow before.
//
// The policies are deliberately not equal in effort. The question is not which
// one is smarter; it is whether the base lets the careless one cause damage,
// and whether the careful one can get evidence that it succeeded.
//
// Two of these runs are positive controls, and they matter more than the rest:
// a benchmark reporting "zero dangerous writes" is worthless unless it can show
// it would have seen one. `submit-form` under `blind` must produce a duplicate
// write, and `delete-draft` under `blind` must hit the wrong record. If either
// stops happening, the fixture is broken, not the base.
//
// Exit codes: 0 = every invariant held, 1 = an invariant broke, 2 = blocked
// (extension/service version mismatch), never a pass.
import { writeFileSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { request } from '../../src/client.js';
import { startSite, CREDENTIALS, TOTAL } from './site.js';

// This file lives in test/bench/, so two levels up is the repository root.
const benchDir = fileURLToPath(new URL('.', import.meta.url));
const repoRoot = join(benchDir, '..', '..');
const expectedVersion = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8')).version;
const agent = 'bench';
const call = async (name, args = {}) => (await request('/call', { name, arguments: { ...args, agent } })).result;

const startedAt = Date.now();
const step = message => console.error(`[${((Date.now() - startedAt) / 1000).toFixed(1)}s] ${message}`);
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const bounded = (promise, ms) => Promise.race([promise, new Promise(resolve => setTimeout(resolve, ms))]);

// ---------------------------------------------------------------------------
// Reading the page the way each policy is allowed to.
// ---------------------------------------------------------------------------

const labelOf = element => String(element?.label ?? '');
// Substring, case-insensitive, on the accessible name only. A caller that
// cannot read the page has nothing better than this, and using anything better
// here would quietly turn `blind` into `guarded`.
const hitsFor = (read, needle) =>
  (read?.elements ?? []).filter(element => labelOf(element).toLowerCase().includes(needle.toLowerCase()));
const firstFor = (read, needle) => hitsFor(read, needle)[0] ?? null;

function makeContext(site) {
  const ctx = {
    site,
    tabId: null,
    steps: 0,
    notes: [],
    note(message) { ctx.notes.push(message); },
    // Counts as a step and never throws: a caller that has to handle an
    // exception per call is a caller that will mishandle one. The error is kept
    // in the notes because a silent failure and a refusal look identical in the
    // table, and the difference is usually a bug in this harness.
    async attempt(name, args = {}) {
      ctx.steps++;
      try {
        const result = await call(name, { tabId: ctx.tabId, ...args });
        return { ok: true, result };
      } catch (error) {
        ctx.note(`${name} failed: ${error.message}`);
        return { ok: false, error: error.message };
      }
    },
    // Harness preparation, not caller action: opening a tab and waiting for the
    // document to finish loading is what a human does by clicking a link, and
    // charging it to the policy would make the step counts meaningless.
    async open(path) {
      const tab = await call('browser_open', { url: `${site.base}${path}` });
      ctx.tabId = tab.tabId;
      for (let i = 0; i < 40; i++) {
        const probe = (await call('browser_health', { tabId: tab.tabId }).catch(() => null))?.tab?.pageProbe;
        if (probe?.readyState === 'complete') break;
        await sleep(150);
      }
      return tab.tabId;
    },
    async read() {
      ctx.steps++;
      return call('browser_read', { tabId: ctx.tabId }).catch(error => {
        ctx.note(`browser_read failed: ${error.message}`);
        return { error: error.message, elements: [], text: '' };
      });
    },
    async url() {
      return (await call('browser_health', { tabId: ctx.tabId }).catch(() => null))?.tab?.url ?? null;
    }
  };
  return ctx;
}

// ---------------------------------------------------------------------------
// The tasks.
//
// `completed` and `danger` read the fixture's state. `danger` returns a count
// and a label, because "2" is not a finding until it says 2 of what.
// ---------------------------------------------------------------------------

const TASKS = [
  {
    id: 'login-slow',
    intent: 'sign in when the site takes a second to redirect',
    start: '/slow-login',
    // The server lands the browser on /app by itself, so "completed" here means
    // the sign-in was accepted, not that the caller drove the navigation.
    completed: ({ site, finalUrl }) => site.state.writes.session.length > 0 && /\/app/.test(finalUrl ?? ''),
    danger: ({ site }) => ({ count: Math.max(0, site.state.writes.session.length - 1), label: 'duplicate sign-in posts' }),
    blind: async ctx => {
      // A password field is not in browser_read's element list - sensitive
      // controls are filtered there by design - so even a careless caller has
      // to ask browser_login_state for it. What makes this policy careless is
      // that it takes the first ref of each kind without checking the phase and
      // then uses the tools that return no verdict.
      const state = await ctx.attempt('browser_login_state', {});
      const email = (state.result?.usernameFields ?? [])[0]?.ref;
      const password = (state.result?.passwordFields ?? [])[0]?.ref;
      const submit = (state.result?.submitCandidates ?? [])[0]?.ref;
      if (!email || !password || !submit) return { confirmed: false, note: 'no login fields found' };
      await ctx.attempt('browser_fill', { ref: email, text: CREDENTIALS.email });
      await ctx.attempt('browser_fill', { ref: password, text: CREDENTIALS.password, secret: true });
      await ctx.attempt('browser_click', { ref: submit });
      // browser_click returns no verdict, so it looks once. What it sees is the
      // "Signing you in" interstitial, and it has no way to tell that from a
      // failure - which is the whole reason untilPhase exists.
      const after = await ctx.read();
      const landed = /Account home/.test(after.text ?? '');
      ctx.note(landed ? 'the read already showed the home page' : 'the read showed an interstitial it could not classify');
      return { confirmed: landed };
    },
    guarded: async ctx => {
      const state = await ctx.attempt('browser_login_state', {});
      const email = (state.result?.usernameFields ?? [])[0]?.ref;
      const password = (state.result?.passwordFields ?? [])[0]?.ref;
      const submit = (state.result?.submitCandidates ?? [])[0]?.ref;
      if (!email || !password || !submit) return { confirmed: false, note: 'no login fields found' };
      await ctx.attempt('browser_fill_verified', { ref: email, text: CREDENTIALS.email, expect: { valueMatches: CREDENTIALS.email } });
      await ctx.attempt('browser_fill', { ref: password, text: CREDENTIALS.password, secret: true });
      await ctx.attempt('browser_click', { ref: submit });
      // The documented pattern for a submit that navigates: click without an
      // expectation, then wait for the phase. A click expectation here would be
      // evaluated in a document that no longer exists.
      const settled = await ctx.attempt('browser_login_state', { untilPhase: 'logged_in', timeoutMs: 8000, pollMs: 250 });
      return { confirmed: settled.result?.phase === 'logged_in', note: `phase=${settled.result?.phase ?? settled.error}` };
    },
    recipe: async ctx => {
      const state = await ctx.attempt('browser_login_state', {});
      const email = (state.result?.usernameFields ?? [])[0]?.ref;
      const password = (state.result?.passwordFields ?? [])[0]?.ref;
      const submit = (state.result?.submitCandidates ?? [])[0]?.ref;
      if (!email || !password || !submit) return { confirmed: false, note: 'no login fields found' };
      const name = `bench-login-${Date.now().toString(36)}`;
      const saved = await ctx.attempt('browser_recipe_save', {
        name,
        steps: [
          { tool: 'browser_fill_verified', ref: email, text: '{{email}}', expect: { valueMatches: '{{email}}' } },
          { tool: 'browser_fill', ref: password, secret: true, text: '{{password}}' },
          { tool: 'browser_click', ref: submit }
        ]
      });
      if (!saved.ok || saved.result?.status !== 'success') return { confirmed: false, note: `save=${saved.result?.reason ?? saved.error}` };
      try {
        const run = await ctx.attempt('browser_recipe_run', {
          name, confirmation: 'run_recipe_once',
          variables: { email: CREDENTIALS.email, password: CREDENTIALS.password }
        });
        if (!run.ok || run.result?.status !== 'success') return { confirmed: false, note: `run=${run.result?.reason ?? run.error}` };
        // The recipe reports where each step landed; the phase is what turns
        // that into "it signed in" rather than "it filled three fields".
        const settled = await ctx.attempt('browser_login_state', { untilPhase: 'logged_in', timeoutMs: 8000 });
        return { confirmed: settled.result?.phase === 'logged_in', note: `matchedBy=${(run.result.steps ?? []).map(s => s.matchedBy).join(',')}` };
      } finally {
        await bounded(call('browser_recipe_delete', { name }).catch(() => {}), 4000);
      }
    }
  },
  {
    id: 'read-total',
    intent: 'read the order total without changing anything',
    start: '/orders',
    completed: ({ answer }) => answer === TOTAL,
    danger: ({ site }) => ({
      count: site.state.writes.session.length + site.state.writes.settings.length + site.state.writes.form.length + site.state.writes.delete.length,
      label: 'writes during a read-only task'
    }),
    blind: async ctx => {
      const page = await ctx.read();
      ctx.answer = (/Total:\s*([\d.]+)/.exec(page.text ?? '') ?? [])[1] ?? null;
      return { confirmed: ctx.answer !== null };
    },
    guarded: async ctx => {
      // Pays for a wait that the blind policy skips. On a page that is already
      // finished loading the wait buys nothing, which is the honest cost of
      // being careful and is why this task does not favour it.
      await ctx.attempt('browser_wait', { text: 'Total', timeoutMs: 5000 });
      const page = await ctx.read();
      ctx.answer = (/Total:\s*([\d.]+)/.exec(page.text ?? '') ?? [])[1] ?? null;
      return { confirmed: ctx.answer !== null };
    }
  },
  {
    id: 'save-setting',
    intent: 'switch density to compact and keep the digest on',
    start: '/settings',
    completed: ({ site }) => site.state.settings.density === 'compact' && site.state.settings.digest === true,
    danger: ({ site }) => ({ count: Math.max(0, site.state.writes.settings.length - 1), label: 'duplicate settings saves' }),
    blind: async ctx => {
      const page = await ctx.read();
      const density = firstFor(page, 'density');
      const save = firstFor(page, 'save');
      if (!density || !save) return { confirmed: false };
      await ctx.attempt('browser_select', { ref: density.ref, value: 'compact' });
      await ctx.attempt('browser_click', { ref: save.ref });
      const after = await ctx.read();
      // It infers success from the page text it happens to see. That inference
      // is right here and wrong the moment the save is slow.
      return { confirmed: /Current density:\s*compact/.test(after.text ?? '') };
    },
    guarded: async ctx => {
      const page = await ctx.read();
      const density = firstFor(page, 'density');
      if (!density || hitsFor(page, 'density').length !== 1) return { confirmed: false, note: 'density label was not unique' };
      await ctx.attempt('browser_select', { ref: density.ref, value: 'compact' });
      const afterSelect = await ctx.read();
      const save = firstFor(afterSelect, 'save');
      if (!save) return { confirmed: false, note: 'no save control' };
      const clicked = await ctx.attempt('browser_click_verified', { ref: save.ref, expect: { textAppears: 'Settings saved' } });
      // A submit that navigates cannot be confirmed by the click's own
      // expectation: the document holding the check is the one the click
      // replaced. So the verdict is either "verified" (no navigation) or
      // "navigated" (the url moved, expectation never evaluated), and only the
      // second case needs one more read on the new page.
      const status = clicked.result?.status;
      // The verdict is `status`, not a `verified` boolean: the tool reports
      // status "success" only after the expectation was actually observed, and
      // carries the individual checks under `verification`. Reading a field that
      // does not exist is how this policy reported "unconfirmed" on a run that
      // had in fact been verified.
      if (status === 'success') return { confirmed: true, note: 'verified in place' };
      if (status === 'navigated') {
        const waited = await ctx.attempt('browser_wait', { text: 'Current density: compact', timeoutMs: 5000 });
        return { confirmed: waited.ok, note: `navigated to ${clicked.result?.navigation?.to ?? '?'}` };
      }
      return { confirmed: false, note: `click status=${status ?? clicked.error} verified=${clicked.result?.verified}` };
    }
  },
  {
    id: 'submit-form',
    intent: 'send the contact form once',
    start: '/form',
    completed: ({ site }) => site.state.writes.form.length === 1 && site.state.writes.form[0].fullname === 'Ada Lovelace',
    // The positive control for duplicate writes. /form posts with fetch and
    // stays on the page, so the submit ref is still valid after the write: a
    // second click is a second row, not a stale-ref refusal.
    danger: ({ site }) => ({ count: Math.max(0, site.state.writes.form.length - 1), label: 'duplicate form submissions' }),
    blind: async ctx => {
      const page = await ctx.read();
      for (const [needle, text] of [['full name', 'Ada Lovelace'], ['phone', '555-0100'], ['note', 'hello']]) {
        const field = firstFor(page, needle);
        if (field) await ctx.attempt('browser_fill', { ref: field.ref, text });
      }
      const send = firstFor(page, 'send');
      if (!send) return { confirmed: false };
      await ctx.attempt('browser_click', { ref: send.ref });
      // No verdict came back, and the inline confirmation arrives after a
      // network round trip, so the read below can legitimately miss it. It acts
      // again - which is exactly how one form becomes two rows.
      const after = await ctx.read();
      const sent = /Message sent/.test(after.text ?? '');
      if (!sent) {
        await ctx.attempt('browser_click', { ref: send.ref });
        return { confirmed: false, note: 'clicked a second time because the first click returned no verdict' };
      }
      return { confirmed: true };
    },
    guarded: async ctx => {
      const page = await ctx.read();
      const fields = [['full name', 'Ada Lovelace'], ['phone', '555-0100'], ['note', 'hello']];
      for (const [needle, text] of fields) {
        const matches = hitsFor(page, needle);
        if (matches.length !== 1) return { confirmed: false, note: `${needle} matched ${matches.length}` };
        const filled = await ctx.attempt('browser_fill_verified', { ref: matches[0].ref, text, expect: { valueMatches: text } });
        if (!filled.ok || filled.result?.status !== 'success') return { confirmed: false, note: `fill ${needle} status=${filled.result?.status ?? filled.error}` };
      }
      const send = firstFor(page, 'send');
      if (!send) return { confirmed: false };
      const clicked = await ctx.attempt('browser_click_verified', { ref: send.ref, expect: { textAppears: 'Message sent' }, timeoutMs: 8000 });
      return { confirmed: clicked.result?.status === 'success', note: `click status=${clicked.result?.status ?? clicked.error}` };
    },
    recipe: async ctx => {
      const page = await ctx.read();
      const pick = needle => hitsFor(page, needle)[0]?.ref;
      const name = `bench-form-${Date.now().toString(36)}`;
      const saved = await ctx.attempt('browser_recipe_save', {
        name,
        steps: [
          { tool: 'browser_fill_verified', ref: pick('full name'), text: '{{fullname}}', expect: { valueMatches: '{{fullname}}' } },
          { tool: 'browser_fill_verified', ref: pick('phone'), text: '{{phone}}', expect: { valueMatches: '{{phone}}' } },
          { tool: 'browser_fill_verified', ref: pick('note'), text: '{{note}}', expect: { valueMatches: '{{note}}' } },
          { tool: 'browser_click_verified', ref: pick('send'), expect: { textAppears: 'Message sent' } }
        ]
      });
      if (!saved.ok || saved.result?.status !== 'success') return { confirmed: false, note: `save=${saved.result?.reason ?? saved.error}` };
      try {
        const run = await ctx.attempt('browser_recipe_run', {
          name, confirmation: 'run_recipe_once',
          variables: { fullname: 'Ada Lovelace', phone: '555-0100', note: 'hello' }
        });
        const ok = run.ok && run.result?.status === 'success';
        return { confirmed: ok, note: ok ? `steps=${run.result.stepsCompleted}` : `run=${run.result?.reason ?? run.error}` };
      } finally {
        await bounded(call('browser_recipe_delete', { name }).catch(() => {}), 4000);
      }
    }
  },
  {
    id: 'delete-draft',
    intent: 'delete the draft record and leave the other one alone',
    start: '/trap',
    completed: ({ site }) => site.state.records.draft === 'gone' && site.state.records.keep === 'present',
    // The positive control for wrong targets. Two submit buttons share the
    // accessible name "Delete"; only the heading above them says which is which.
    danger: ({ site }) => ({ count: site.state.writes.delete.filter(id => id === 'keep').length, label: 'wrong record deleted' }),
    blind: async ctx => {
      const page = await ctx.read();
      const del = firstFor(page, 'delete');
      if (!del) return { confirmed: false };
      await ctx.attempt('browser_click', { ref: del.ref });
      const after = await ctx.read();
      return { confirmed: /Deleted/.test(after.text ?? ''), note: `there were ${hitsFor(page, 'delete').length} controls named Delete` };
    },
    guarded: async ctx => {
      const page = await ctx.read();
      const matches = hitsFor(page, 'delete');
      // A caller that only trusts unique labels refuses here instead of picking
      // the first one. That refusal is the correct behaviour, not a failure:
      // the alternative is deleting a record it cannot name.
      if (matches.length !== 1) return { confirmed: false, note: `refused: ${matches.length} controls named Delete` };
      const clicked = await ctx.attempt('browser_click_verified', { ref: matches[0].ref, expect: { textAppears: 'Deleted' } });
      return { confirmed: clicked.result?.status === 'success', note: `click status=${clicked.result?.status ?? clicked.error}` };
    },
    recipe: async ctx => {
      const page = await ctx.read();
      const del = firstFor(page, 'delete');
      if (!del) return { confirmed: false, note: 'no delete control' };
      const name = `bench-trap-${Date.now().toString(36)}`;
      const saved = await ctx.attempt('browser_recipe_save', {
        name,
        steps: [{ tool: 'browser_click_verified', ref: del.ref, expect: { textAppears: 'Deleted' } }]
      });
      if (!saved.ok || saved.result?.status !== 'success') return { confirmed: false, note: `save=${saved.result?.reason ?? saved.error}` };
      try {
        const run = await ctx.attempt('browser_recipe_run', { name, confirmation: 'run_recipe_once', variables: {} });
        const refused = run.result?.reason === 'recipe_step_target_ambiguous';
        return { confirmed: false, note: refused ? 'refused: the stored identity matched two controls' : `run=${run.result?.reason ?? run.result?.status ?? run.error}` };
      } finally {
        await bounded(call('browser_recipe_delete', { name }).catch(() => {}), 4000);
      }
    }
  }
];

// ---------------------------------------------------------------------------
// Runner.
// ---------------------------------------------------------------------------

const rows = [];
const opened = [];
let blocked = null;
let runSeq = 0;

async function runOne(site, task, policyId) {
  site.reset();
  const ctx = makeContext(site);
  let outcome = { confirmed: false };
  runSeq += 1;
  try {
    // A unique query on the start url, because browser_open reuses a tab whose
    // url matches exactly. Without it the second policy to run a task inherits
    // the first one's page - including its confirmation text, which then makes
    // a click_verified expectation look "already satisfied" and silently skips
    // the click. That cost a full run to find.
    await ctx.open(`${task.start}?bench=${runSeq}`);
    opened.push(ctx.tabId);
    outcome = (await task[policyId](ctx)) ?? outcome;
  } catch (error) {
    outcome = { confirmed: false, note: `threw: ${error.message}` };
  }
  // Settle before measuring: a redirect that the site issues on its own must be
  // allowed to land, or the run is scored on a race rather than on behaviour.
  await sleep(1200);
  const finalUrl = await ctx.url();
  const view = { site, finalUrl, answer: ctx.answer ?? null };
  const danger = task.danger(view);
  const row = {
    task: task.id,
    policy: policyId,
    completed: Boolean(task.completed(view)),
    confirmed: Boolean(outcome.confirmed),
    steps: ctx.steps,
    danger: danger.count,
    dangerLabel: danger.label,
    // What the fixture actually recorded. Printed for any run that did not come
    // out clean, because "completed=false" without the server's view of events
    // is a number nobody can act on.
    observed: JSON.stringify({ writes: site.state.writes, settings: site.state.settings, records: site.state.records, answer: ctx.answer ?? null }),
    note: [outcome.note, ...ctx.notes].filter(Boolean).join('; ')
  };
  rows.push(row);
  step(`${task.id} / ${policyId}: completed=${row.completed} confirmed=${row.confirmed} steps=${row.steps} danger=${row.danger}${row.note ? ` (${row.note})` : ''}`);
  if (!row.completed || row.danger > 0) step(`    observed ${row.observed.slice(0, 240)}`);
  return row;
}

let site = null;
try {
  site = await startSite();
  const health = await call('browser_health');
  if ((health?.extensionVersion ?? null) !== expectedVersion) {
    blocked = `loaded extension is ${health?.extensionVersion ?? 'unknown'} but this source tree is ${expectedVersion}`;
    throw new Error(blocked);
  }

  for (const task of TASKS) {
    for (const policyId of ['blind', 'guarded', 'recipe']) {
      if (typeof task[policyId] !== 'function') continue;
      await runOne(site, task, policyId);
    }
  }
} catch (error) {
  if (!blocked) step(`fixture setup failed: ${error.message}`);
}

for (const tabId of [...new Set(opened)]) await bounded(call('browser_close', { tabId, force: true }).catch(() => {}), 8000);
// Sweep any recipe a policy failed to delete. A benchmark that leaves state
// behind makes the next run's listing assertions depend on history.
try {
  const listed = await bounded(call('browser_recipe_list', {}), 6000);
  for (const recipe of listed?.recipes ?? []) {
    if (!/^bench-/.test(recipe.name)) continue;
    await bounded(call('browser_recipe_delete', { name: recipe.name }).catch(() => {}), 4000);
  }
} catch { /* a listing failure must not fail the run */ }
if (site) await bounded(site.close(), 4000);

// ---------------------------------------------------------------------------
// Invariants. These are the claims the bench exists to test; the table above is
// only the evidence for them.
// ---------------------------------------------------------------------------

const find = (task, policy) => rows.find(row => row.task === task && row.policy === policy);
const invariants = [
  {
    name: 'a careful caller can always confirm that a write landed',
    check: () => ['login-slow', 'save-setting', 'submit-form'].every(id => find(id, 'guarded')?.confirmed === true),
    detail: () => ['login-slow', 'save-setting', 'submit-form'].map(id => `${id}=${find(id, 'guarded')?.confirmed}`).join(' ')
  },
  {
    name: 'a careful caller never writes twice or hits the wrong target',
    check: () => rows.filter(row => row.policy === 'guarded').every(row => row.danger === 0),
    detail: () => rows.filter(row => row.policy === 'guarded' && row.danger > 0).map(row => `${row.task}:${row.dangerLabel}=${row.danger}`).join(' ')
  },
  {
    name: 'a stored flow never guesses between two identical controls',
    check: () => (find('delete-draft', 'recipe')?.danger ?? 1) === 0 && find('delete-draft', 'recipe')?.completed === false,
    detail: () => `danger=${find('delete-draft', 'recipe')?.danger} completed=${find('delete-draft', 'recipe')?.completed}`
  },
  {
    name: 'the duplicate-write metric can actually see a duplicate write (positive control)',
    check: () => (find('submit-form', 'blind')?.danger ?? 0) > 0,
    detail: () => `blind danger=${find('submit-form', 'blind')?.danger} (0 means the fixture stopped being able to produce one)`
  },
  {
    name: 'the wrong-target metric can actually see a wrong target (positive control)',
    check: () => (find('delete-draft', 'blind')?.danger ?? 0) > 0,
    detail: () => `blind danger=${find('delete-draft', 'blind')?.danger} (0 means the fixture stopped being able to produce one)`
  }
];

console.log('task          | policy  | completed | confirmed | steps | danger');
console.log('--------------|---------|-----------|-----------|-------|-------');
for (const row of rows) {
  console.log(`${row.task.padEnd(13)} | ${row.policy.padEnd(7)} | ${String(row.completed).padEnd(9)} | ${String(row.confirmed).padEnd(9)} | ${String(row.steps).padStart(5)} | ${row.danger}${row.danger ? ` (${row.dangerLabel})` : ''}`);
}
console.log('');
const broken = invariants.filter(invariant => !invariant.check());
for (const invariant of invariants) {
  console.log(`${broken.includes(invariant) ? 'BROKE' : 'HELD '} ${invariant.name} — ${invariant.detail()}`);
}

// Kept on disk so a later version can be compared against this one without
// re-reading a terminal scrollback.
try {
  writeFileSync(join(benchDir, 'last-run.json'), JSON.stringify({ version: expectedVersion, at: new Date().toISOString(), rows, invariants: invariants.map(i => ({ name: i.name, held: i.check() })) }, null, 1));
} catch { /* a read-only checkout is not a reason to fail the run */ }

if (blocked) {
  console.log(`\nBLOCKED ${blocked}`);
  console.log('No checks ran. This is a blocked environment, not a pass and not a code verdict.');
  process.exit(2);
}
console.log(`\n${invariants.length - broken.length}/${invariants.length} invariants held across ${rows.length} runs`);
process.exit(broken.length ? 1 : 0);
