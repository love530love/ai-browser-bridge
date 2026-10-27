// Recipe acceptance against the user's already-connected Chrome.
//
// The point of a recipe is that a caller who cannot reason about a page can
// still complete a flow: the flow is decided once, stored as durable target
// descriptors, and replayed. So the assertions here are about the two ways that
// promise breaks in practice:
//
//   1. The page changed. /v1 and /v2 are the same form with different ids, which
//      is what a rebuild does. A recipe recorded on /v1 must still run on /v2,
//      and must say which tier matched.
//   2. The page is ambiguous or the input is wrong. Two buttons with the same
//      name must be refused, not resolved by position; a missing variable must
//      be refused before step 1, not halfway through.
//
// Nothing here touches a real account: every page is a local fixture, and the
// only secret is a literal in this file.
//
// Exit codes: 0 = every promise held, 1 = a promise broke, 2 = blocked
// (extension/service version mismatch), never a pass.
import http from 'node:http';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { request } from '../src/client.js';

const expectedVersion = JSON.parse(readFileSync(join(fileURLToPath(new URL('../', import.meta.url)), 'package.json'), 'utf8')).version;
const agent = 'recipe-fixture';
const call = async (name, args = {}) => (await request('/call', { name, arguments: { ...args, agent } })).result;

const form = (suffix, action) => `<!doctype html><meta charset="utf-8"><title>Sign in</title>
<h1>Sign in</h1>
<form action="${action}" method="post">
  <label for="user-${suffix}">Email address</label>
  <input id="user-${suffix}" name="email" type="email">
  <label for="pw-${suffix}">Password</label>
  <input id="pw-${suffix}" name="password" type="password">
  <button type="submit">Sign in</button>
</form>`;

// Same visible form, different ids: the rebuild that breaks a selector-based
// recording but must not break an identity-based one.
const v1 = form('1', '/v1/done');
const v2 = form('2', '/v2/done');
// The done page echoes back the email that was actually posted, which is the
// only way to prove the variable was substituted and the field really carried
// it: a form posts and navigates whether the field was filled or empty.
const done = `<!doctype html><meta charset="utf-8"><title>Done</title><h1>Welcome back, Ada</h1><!--echo-->`;
// Two controls with the same accessible name. A recipe that matched by position
// here would click whichever came first.
const ambiguous = `<!doctype html><meta charset="utf-8"><title>Two saves</title>
<button type="button">Save</button><button type="button">Save</button>`;

const pages = { '/v1/login': v1, '/v2/login': v2, '/v1/done': done, '/v2/done': done, '/ambiguous': ambiguous };
const fixture = http.createServer((req, res) => {
  const pathname = new URL(req.url, 'http://127.0.0.1').pathname;
  let body = pages[pathname];
  if (!body) { res.writeHead(404); res.end('not found'); return; }
  let raw = '';
  req.on('data', chunk => { raw += chunk; if (raw.length > 4096) raw = raw.slice(0, 4096); });
  req.on('end', () => {
    if (body.includes('<!--echo-->')) {
      // Only the email is echoed. The password is in the same body, and putting
      // it back on the page would spread the fixture secret for no reason.
      const posted = new URLSearchParams(raw);
      const email = (posted.get('email') ?? '').replace(/[<>&"]/g, '');
      body = body.replace('<!--echo-->', `<p id="echo">posted email: ${email}</p>`);
    }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(body);
  });
});

const startedAt = Date.now();
const step = message => console.error(`[${((Date.now() - startedAt) / 1000).toFixed(1)}s] ${message}`);
const rows = [];
const record = (name, expected, actual, detail) => rows.push({ name, expected, actual, ok: expected === actual, detail });
const bounded = (promise, ms) => Promise.race([promise, new Promise(resolve => setTimeout(resolve, ms))]);
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

const opened = [];
let blocked = null;
const RECIPE = `live-login-${Date.now().toString(36)}`;

async function open(pathname) {
  const tab = await call('browser_open', { url: `${base}${pathname}` });
  opened.push(tab.tabId);
  for (let i = 0; i < 40; i++) {
    const probe = (await call('browser_health', { tabId: tab.tabId }))?.tab?.pageProbe;
    if (probe?.readyState === 'complete') break;
    await sleep(150);
  }
  return tab.tabId;
}

let base = '';
try {
  await new Promise(resolve => fixture.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${fixture.address().port}`;

  const health = await call('browser_health');
  if ((health?.extensionVersion ?? null) !== expectedVersion) {
    blocked = `loaded extension is ${health?.extensionVersion ?? 'unknown'} but this source tree is ${expectedVersion}`;
    throw new Error(blocked);
  }

  // 1. Record the flow on /v1 from refs a normal read hands out.
  const v1Tab = await open('/v1/login');
  const state = await call('browser_login_state', { tabId: v1Tab });
  const userRef = (state?.usernameFields ?? [])[0]?.ref;
  const passRef = (state?.passwordFields ?? [])[0]?.ref;
  const submitRef = (state?.submitCandidates ?? [])[0]?.ref;
  record('the login form offers the three refs a recipe needs', true, Boolean(userRef && passRef && submitRef),
    `user=${Boolean(userRef)} pass=${Boolean(passRef)} submit=${Boolean(submitRef)}`);

  const saved = await call('browser_recipe_save', {
    name: RECIPE,
    tabId: v1Tab,
    origin: `${base}/v1/login`,
    note: 'fixture login, two fields and a submit',
    steps: [
      { tool: 'browser_fill_verified', ref: userRef, text: '{{email}}', expect: { valueMatches: '{{email}}' } },
      { tool: 'browser_fill', ref: passRef, secret: true, text: '{{password}}' },
      { tool: 'browser_click_verified', ref: submitRef, expect: { textAppears: 'Welcome back' } }
    ]
  });
  record('the flow is stored as a recipe', 'success', saved?.status, `status=${saved?.status} reason=${saved?.reason ?? 'none'}`);
  record('the refs became durable descriptors', 3, (saved?.steps ?? []).length, `steps=${JSON.stringify(saved?.steps ?? null).slice(0, 200)}`);
  record('the variable list is derived, not declared', 'email,password', (saved?.variables ?? []).join(','), `variables=${JSON.stringify(saved?.variables)}`);
  record('the saved recipe holds no literal secret', false, /hunter2/.test(JSON.stringify(saved)), 'searched the reply for the fixture password');

  // 2. A rebuild with new ids must not break the replay.
  const v2Tab = await open('/v2/login');
  const replayed = await call('browser_recipe_run', {
    name: RECIPE, tabId: v2Tab, confirmation: 'run_recipe_once',
    variables: { email: 'ada@example.test', password: 'hunter2-fixture' }
  });
  record('the recipe replays on a page whose ids changed', 'success', replayed?.status,
    `status=${replayed?.status} reason=${replayed?.reason ?? 'none'} failedAtStep=${replayed?.failedAtStep ?? 'none'}`);
  record('every step ran', 3, replayed?.stepsCompleted, `steps=${JSON.stringify(replayed?.steps ?? null).slice(0, 300)}`);
  record('the replay reports how each target was found', true,
    (replayed?.steps ?? []).every(item => typeof item.matchedBy === 'string' && item.matchedBy.length > 0),
    `matchedBy=${JSON.stringify((replayed?.steps ?? []).map(item => item.matchedBy))}`);
  record('the renamed ids were matched by name, not by id', false,
    (replayed?.steps ?? []).some(item => item.matchedBy === 'id'),
    `matchedBy=${JSON.stringify((replayed?.steps ?? []).map(item => item.matchedBy))}`);
  record('the flow reached the next page', true, /\/v2\/done/.test(replayed?.finalUrl ?? ''),
    `finalUrl=${replayed?.finalUrl}`);
  record('no password appears in the run reply', false, /hunter2-fixture/.test(JSON.stringify(replayed)), 'searched the whole reply');
  // The value actually reached the server: the done page echoes the posted email.
  const doneRead = await call('browser_read', { tabId: v2Tab });
  record('the substituted value reached the server', true, /posted email: ada@example\.test/.test(doneRead?.text ?? ''),
    `pageText=${(doneRead?.text ?? '').slice(0, 120)}`);

  // 3. A missing variable must be refused before anything runs.
  const v2Again = await open('/v2/login');
  const missing = await call('browser_recipe_run', {
    name: RECIPE, tabId: v2Again, confirmation: 'run_recipe_once', variables: { email: 'ada@example.test' }
  });
  record('a missing variable is refused', 'recipe_variables_missing', missing?.reason, `reason=${missing?.reason}`);
  record('the refusal names the missing variable', 'password', (missing?.missing ?? []).join(','), `missing=${JSON.stringify(missing?.missing)}`);
  const stillThere = await call('browser_login_state', { tabId: v2Again });
  record('nothing ran when a variable was missing', 'credentials', stillThere?.phase, `phase=${stillThere?.phase} url=${stillThere?.url}`);

  // 4. Two controls with the same name must be refused, not resolved by position.
  const ambTab = await open('/ambiguous');
  const ambName = `ambiguous-${Date.now().toString(36)}`;
  const ambSaved = await call('browser_recipe_save', {
    name: ambName, tabId: ambTab,
    steps: [{ tool: 'browser_click', target: { tag: 'button', role: null, type: 'button', name: 'Save', id: null, attrName: null, selector: 'button', text: 'Save' } }]
  });
  record('a descriptor can be supplied without a ref', 'success', ambSaved?.status, `status=${ambSaved?.status}`);
  const ambRun = await call('browser_recipe_run', { name: ambName, tabId: ambTab, confirmation: 'run_recipe_once', variables: {} });
  record('an ambiguous target is refused', 'recipe_step_target_ambiguous', ambRun?.reason, `reason=${ambRun?.reason} detail=${JSON.stringify(ambRun?.detail ?? null).slice(0, 200)}`);
  record('an ambiguous refusal names no target to act on', 0, ambRun?.stepsCompleted, `stepsCompleted=${ambRun?.stepsCompleted}`);
  await call('browser_recipe_delete', { name: ambName });

  // 5. A secret step may not store a literal password.
  const literal = await call('browser_recipe_save', {
    name: `literal-${Date.now().toString(36)}`, tabId: v1Tab,
    steps: [{ tool: 'browser_fill', target: { tag: 'input', role: null, type: 'password', name: 'Password', id: 'pw', attrName: 'password', selector: 'input#pw', text: '' }, secret: true, text: 'hunter2-fixture' }]
  });
  record('a literal value on a secret step is refused', 'secret_value_not_storable', literal?.reason, `reason=${literal?.reason}`);
  record('the refusal explains why', true, /never contain a password/.test(literal?.message ?? ''), `message=${(literal?.message ?? '').slice(0, 120)}`);

  // 6. A step whose tool cannot be re-resolved is refused.
  const nav = await call('browser_recipe_save', {
    name: `nav-${Date.now().toString(36)}`, tabId: v1Tab,
    steps: [{ tool: 'browser_navigate', target: { tag: 'input', name: 'Email address', id: 'user-1', selector: 'input#user-1', text: '' }, url: `${base}/v1/done` }]
  });
  record('a navigation step is refused', 'step_tool_not_replayable', nav?.reason, `reason=${nav?.reason}`);

  // 7. Listing and deleting.
  const listed = await call('browser_recipe_list', {});
  record('the saved recipe is listed', true, (listed?.recipes ?? []).some(item => item.name === RECIPE),
    `names=${JSON.stringify((listed?.recipes ?? []).map(item => item.name))}`);
  const removed = await call('browser_recipe_delete', { name: RECIPE });
  record('deleting a recipe works', 'success', removed?.status, `status=${removed?.status}`);
  const afterDelete = await call('browser_recipe_list', {});
  record('the deleted recipe is gone', false, (afterDelete?.recipes ?? []).some(item => item.name === RECIPE),
    `names=${JSON.stringify((afterDelete?.recipes ?? []).map(item => item.name))}`);
  const gone = await call('browser_recipe_run', { name: RECIPE, tabId: v2Tab, confirmation: 'run_recipe_once', variables: {} });
  record('running a deleted recipe is refused by name', 'recipe_not_found', gone?.reason, `reason=${gone?.reason}`);
  const unconfirmed = await call('browser_recipe_run', { name: RECIPE, tabId: v2Tab, variables: {} }).catch(error => ({ error: error.message }));
  record('a run without confirmation is refused', true, Boolean(unconfirmed?.error) || unconfirmed?.status === 'denied',
    `result=${JSON.stringify(unconfirmed).slice(0, 160)}`);
} catch (error) {
  if (!blocked) record('fixture setup', 'ok', 'error', error.message);
}

for (const tabId of [...new Set(opened)]) await bounded(call('browser_close', { tabId, force: true }).catch(() => {}), 8000);
try { fixture.closeAllConnections?.(); } catch { /* older runtimes */ }
await bounded(new Promise(resolve => fixture.close(resolve)), 3000);
await bounded(call('browser_recipe_delete', { name: RECIPE }).catch(() => {}), 4000);
step('cleanup done');

const failed = rows.filter(row => !row.ok);
console.log('expected | actual | verdict | promise');
for (const row of rows) {
  console.log(`${JSON.stringify(row.expected)} | ${JSON.stringify(row.actual)} | ${row.ok ? 'OK' : 'MISMATCH'} | ${row.name}${row.detail ? ` — ${row.detail}` : ''}`);
}
if (blocked) {
  console.log(`\nBLOCKED ${blocked}`);
  console.log('No checks ran. This is a blocked environment, not a pass and not a code verdict.');
  process.exit(2);
}
console.log(`\n${rows.length - failed.length}/${rows.length} recipe promises held`);
process.exit(failed.length ? 1 : 0);
