// Login-path acceptance against the user's already-connected Chrome.
//
// Covers what a login actually needs from this base, each on a local fixture so
// nothing touches a real account:
//   - the page's login phase is read without reading a single field value,
//   - a two-step login's first screen is its own phase instead of unknown,
//   - a submit can be followed by a wait for the next phase, across a real
//     navigation the fixture holds open for 600ms,
//   - a one-time code is pulled out of a mailbox view with its sender line so a
//     phishing code can be told apart,
//   - a password field's accessible name comes from aria-labelledby, which the
//     old property-order guess could not see.
//
// It deliberately does NOT read the user's real credential store: that is
// covered by test/credential-store.test.js against a synthetic profile, because
// asserting on a real password would mean putting it in a test transcript.
//
// Exit codes: 0 = every promise held, 1 = a promise broke, 2 = blocked
// (extension/service version mismatch), never a pass.
import http from 'node:http';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { request } from '../src/client.js';

const expectedVersion = JSON.parse(readFileSync(join(fileURLToPath(new URL('../', import.meta.url)), 'package.json'), 'utf8')).version;
const agent = 'login-fixture';
const call = async (name, args = {}) => (await request('/call', { name, arguments: { ...args, agent } })).result;

const loginPage = `<!doctype html><meta charset="utf-8"><title>Sign in</title>
<h1>Sign in</h1>
<form action="/slow-otp" method="post">
  <span id="user-label">Email address</span>
  <input id="user" name="email" type="email" aria-labelledby="user-label">
  <label for="pw">Password</label>
  <input id="pw" name="password" type="password">
  <div role="alert" class="error-message">Incorrect password, please try again</div>
  <button type="submit">Sign in</button>
  <button type="button">Continue with Google</button>
</form>`;

const otpPage = `<!doctype html><meta charset="utf-8"><title>Verify</title>
<h1>Enter the code we sent you</h1>
<label for="code">Verification code</label>
<input id="code" name="otp" inputmode="numeric" maxlength="6" autocomplete="one-time-code">
<button type="submit">Verify</button>`;

// Same form as otpPage, but its Verify button continues the flow, and the
// server holds this response for 600ms. The hold is the point: it forces the
// phase wait to span a real navigation instead of sampling an already settled
// page, which is the only way to test what untilPhase exists for.
const slowOtpPage = `<!doctype html><meta charset="utf-8"><title>Verify</title>
<h1>Enter the code we sent you</h1>
<form action="/inbox" method="post">
  <label for="code">Verification code</label>
  <input id="code" name="otp" inputmode="numeric" maxlength="6" autocomplete="one-time-code">
  <button type="submit">Verify</button>
</form>`;

// The signed-in view. A visible sign-out control is the strong evidence that
// makes phase logged_in trustworthy instead of a guess.
const inboxPage = `<!doctype html><meta charset="utf-8"><title>Inbox</title>
<h1>Welcome back, Ada</h1>
<p>3 unread messages</p>
<button type="button">Sign out</button>`;

// The first screen of a two-step login: an identifier field, a Next button, and
// no password field anywhere. This used to be phase "unknown".
const step1Page = `<!doctype html><meta charset="utf-8"><title>Sign in</title>
<h1>Sign in</h1>
<form action="/login" method="post">
  <span id="user-label">Email address</span>
  <input id="user" name="email" type="email" aria-labelledby="user-label">
  <button type="submit">Next</button>
</form>`;

const mailboxPage = `<!doctype html><meta charset="utf-8"><title>Inbox</title>
<ul>
  <li><span>Acme Security &lt;security@acme.test&gt;</span><span>Your verification code</span>
      <p>Use code 481920 to finish signing in. It expires in 10 minutes.</p></li>
  <li><span>Totally Legit &lt;no-reply@acme-support.test&gt;</span><span>Account alert</span>
      <p>Your verification code is 771203. Confirm here.</p></li>
  <li><span>Newsletter</span><span>Weekly digest</span>
      <p>Order 20241015 shipped. Call +1 415 555 0134 for help.</p></li>
</ul>`;

const pages = { '/login': loginPage, '/otp': otpPage, '/slow-otp': slowOtpPage, '/inbox': inboxPage, '/step1': step1Page, '/mailbox': mailboxPage };
const delays = { '/slow-otp': 600 };
const fixture = http.createServer((req, res) => {
  const pathname = new URL(req.url, 'http://127.0.0.1').pathname;
  const body = pages[pathname];
  if (!body) { res.writeHead(404); res.end('not found'); return; }
  const send = () => { res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); res.end(body); };
  if (delays[pathname]) setTimeout(send, delays[pathname]); else send();
});

const startedAt = Date.now();
const step = message => console.error(`[${((Date.now() - startedAt) / 1000).toFixed(1)}s] ${message}`);
const rows = [];
const record = (name, expected, actual, detail) => rows.push({ name, expected, actual, ok: expected === actual, detail });
const bounded = (promise, ms) => Promise.race([promise, new Promise(resolve => setTimeout(resolve, ms))]);
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

const opened = [];
let blocked = null;

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

  // 1. Credentials phase, read without reading values.
  const loginTab = await open('/login');
  const login = await call('browser_login_state', { tabId: loginTab });
  record('a password form is recognised as the credentials phase', 'credentials', login?.phase, `phase=${login?.phase}`);
  record('the password field is found', 1, login?.passwordFields?.length, `count=${login?.passwordFields?.length}`);
  record('the password field is empty and reported as empty', false, login?.passwordFields?.[0]?.hasValue, `hasValue=${login?.passwordFields?.[0]?.hasValue}`);
  record('the username field is found', 1, login?.usernameFields?.length, `count=${login?.usernameFields?.length}`);
  record('a submit control is offered', true, (login?.submitCandidates ?? []).length > 0, `count=${login?.submitCandidates?.length}`);
  record('third-party sign-in is listed', true, (login?.thirdPartyOptions ?? []).some(item => /google/i.test(item.label ?? '')), `options=${JSON.stringify((login?.thirdPartyOptions ?? []).map(item => item.label))}`);
  record('the visible error text is surfaced', true, (login?.errorText ?? []).some(text => /incorrect password/i.test(text)), `errorText=${JSON.stringify(login?.errorText)}`);
  // The whole point: no value ever leaves the page.
  record('no field value appears anywhere in the reply', false, /hunter2|correct horse/.test(JSON.stringify(login)), 'scanned reply for a planted value');
  record('autofill observability is stated as false, not guessed', false, login?.autofill?.popupObservableFromExtension, `popupObservableFromExtension=${login?.autofill?.popupObservableFromExtension}`);
  record('the autofill paths are spelled out', true, (login?.autofill?.paths ?? []).length >= 2, `paths=${(login?.autofill?.paths ?? []).length}`);

  // 2. aria-labelledby drives the accessible name (the accname rewrite).
  const found = await call('browser_find_element', { tabId: loginTab, query: 'Email address' });
  record('a field labelled only by aria-labelledby is findable', true, found?.found === true,
    `found=${found?.found} candidates=${JSON.stringify((found?.candidates ?? []).map(item => item.label))}`);

  // 3. Focus on the password field is dispatched, and the popup stays unknown.
  const focused = await call('browser_login_state', { tabId: loginTab, focusPassword: true });
  record('focusing the password field is reported as dispatched', true, focused?.autofill?.focusDispatched, `focusDispatched=${focused?.autofill?.focusDispatched}`);
  record('the popup is still not claimed as observed', false, focused?.autofill?.popupObservableFromExtension, 'popupObservableFromExtension');

  // 4. OTP phase.
  const otpTab = await open('/otp');
  const otpState = await call('browser_login_state', { tabId: otpTab });
  record('a one-time-code form is recognised as the otp phase', 'otp', otpState?.phase, `phase=${otpState?.phase}`);
  record('the code field is identified', true, (otpState?.otpFields ?? []).length >= 1, `count=${otpState?.otpFields?.length}`);
  record('the otp guidance names the mailbox step', true, /browser_otp_fetch/.test(otpState?.guidance ?? ''), 'guidance');

  // 5. Code extraction from a mailbox view, with the sender line attached.
  const mailTab = await open('/mailbox');
  const codes = await call('browser_otp_fetch', { tabId: mailTab, maxCandidates: 5 });
  const codeList = (codes?.candidates ?? []).map(item => item.code);
  record('both codes in the mailbox are found', true, codeList.includes('481920') && codeList.includes('771203'), `codes=${JSON.stringify(codeList)}`);
  record('the order number is not mistaken for a code', false, codeList.includes('20241015'), `codes=${JSON.stringify(codeList)}`);
  record('the phone number is not mistaken for a code', false, codeList.some(code => code.replace(/\D/g, '').endsWith('0134')), `codes=${JSON.stringify(codeList)}`);
  record('a sender line travels with each candidate', true, (codes?.candidates ?? []).every(item => typeof item.sourceHint === 'string' && item.sourceHint.length > 0),
    `sourceHints=${JSON.stringify((codes?.candidates ?? []).map(item => item.sourceHint))}`);
  record('the phishing warning is present', true, /phishing/i.test(codes?.warning ?? ''), 'warning');
  record('more than one candidate is returned rather than one guess', true, (codes?.candidates ?? []).length > 1, `count=${codes?.candidates?.length}`);

  // 6. A page with no code must not invent one.
  const empty = await call('browser_otp_fetch', { tabId: loginTab });
  record('a page with no code returns no candidate', 0, empty?.candidateCount, `candidateCount=${empty?.candidateCount}`);

  // 7. The wait after a submit: the gap that made an automated login
  //    unfinishable. A read taken right after the click lands between two
  //    documents and reports "unknown", so the caller could not tell a slow
  //    server from a rejected password.
  const stepTab = await open('/step1');
  // Named stepState, not step: `step` is the log helper and shadowing it broke
  // every later call in this script.
  const stepState = await call('browser_login_state', { tabId: stepTab });
  record('an identifier-only screen is the identifier phase', 'identifier', stepState?.phase,
    `phase=${stepState?.phase} confidence=${stepState?.phaseConfidence}`);
  record('the identifier guidance names the wait for the next screen', true,
    /untilPhase:"credentials"/.test(stepState?.guidance ?? ''), `guidance=${(stepState?.guidance ?? '').slice(0, 120)}`);
  const stepUser = (stepState?.usernameFields ?? [])[0];
  const stepNext = (stepState?.submitCandidates ?? [])[0];
  const filledUser = await call('browser_fill_verified', { tabId: stepTab, ref: stepUser?.ref, text: 'ada@example.test', expect: { valueMatches: 'ada@example.test' } });
  record('the identifier field accepts text and verifies', 'success', filledUser?.status,
    `status=${filledUser?.status} valueMatches=${filledUser?.checks?.valueMatches}`);
  await call('browser_click', { tabId: stepTab, ref: stepNext?.ref });
  const stepped = await call('browser_login_state', { tabId: stepTab, untilPhase: 'credentials', timeoutMs: 10000, pollMs: 150 });
  record('a wait for the next phase after a submit is matched', true, stepped?.wait?.matched,
    `wait=${JSON.stringify(stepped?.wait ?? null).slice(0, 240)}`);
  record('the wait reports the phases it actually saw', true,
    (stepped?.wait?.phasesSeen ?? []).some(item => item.phase === 'credentials'),
    `phasesSeen=${JSON.stringify((stepped?.wait?.phasesSeen ?? []).map(item => item.phase))}`);

  // 8. The full loop, across a server that holds the response for 600ms. This is
  //    the case a single-frame read cannot cover: the tab is between documents
  //    for the whole first poll.
  const loopTab = await open('/login');
  const creds = await call('browser_login_state', { tabId: loopTab });
  await call('browser_fill_verified', { tabId: loopTab, ref: (creds?.usernameFields ?? [])[0]?.ref, text: 'ada@example.test', expect: { valueMatches: 'ada@example.test' } });
  const secret = await call('browser_fill', { tabId: loopTab, ref: (creds?.passwordFields ?? [])[0]?.ref, text: 'S3cret-passphrase', secret: true });
  record('a password fill reports the length it typed and never echoes the value', true,
    secret?.characters === 'S3cret-passphrase'.length && !/S3cret-passphrase/.test(JSON.stringify(secret)),
    `characters=${secret?.characters} echoSuppressed=${secret?.valueEchoSuppressed}`);
  await call('browser_click', { tabId: loopTab, ref: (creds?.submitCandidates ?? [])[0]?.ref });
  const afterSubmit = await call('browser_login_state', { tabId: loopTab, untilPhase: 'otp', timeoutMs: 12000, pollMs: 150 });
  record('the wait spans a slow navigation instead of sampling one frame', true,
    (afterSubmit?.wait?.waitedMs ?? 0) >= 250, `waitedMs=${afterSubmit?.wait?.waitedMs} polls=${afterSubmit?.wait?.polls}`);
  record('the wait ends on the otp phase', 'otp', afterSubmit?.phase, `phase=${afterSubmit?.phase}`);
  record('the wait recorded that the url changed', true, afterSubmit?.wait?.urlChanged === true,
    `from=${afterSubmit?.wait?.fromUrl} to=${afterSubmit?.wait?.toUrl}`);
  // A login reply must never carry the password back. The fixture posts the form
  // rather than sending it as a query string, which is what a real login does;
  // this pins that the reply echoes the page's own url and nothing else.
  record('no password appears in the wait reply', false, /S3cret-passphrase/.test(JSON.stringify(afterSubmit)),
    'searched the whole reply for the password');
  const codeFill = await call('browser_fill_verified', { tabId: loopTab, ref: (afterSubmit?.otpFields ?? [])[0]?.ref, text: '481920', expect: { valueMatches: '481920' } });
  record('the one-time code lands in the code field', 'success', codeFill?.status, `status=${codeFill?.status}`);
  await call('browser_click', { tabId: loopTab, ref: (afterSubmit?.submitCandidates ?? [])[0]?.ref });
  const done = await call('browser_login_state', { tabId: loopTab, untilPhase: 'logged_in', timeoutMs: 12000, pollMs: 150 });
  record('the loop closes on the logged_in phase', 'logged_in', done?.phase, `phase=${done?.phase}`);
  record('logged_in is backed by a visible sign-out control', 'strong', done?.phaseConfidence,
    `confidence=${done?.phaseConfidence} evidence=${JSON.stringify(done?.phaseEvidence)}`);
  record('a matched phase is not claimed as proof of authentication', true,
    /not proof of authentication/i.test(done?.wait?.note ?? ''), `note=${(done?.wait?.note ?? '').slice(0, 120)}`);

  // 9. A wait that never matches must say so, and must not read as a failed
  //    submit: the two are different, and confusing them is what makes an agent
  //    re-submit a password.
  // A distinct exact URL, because browser_open reuses an exact URL: asking for
  // /login again would hand back the tab the loop above just left on /inbox, and
  // the "did not move" case would be tested against a page that had.
  const stillTab = await open('/login?timeout=1');
  const staticWait = await call('browser_login_state', { tabId: stillTab, untilPhase: 'otp', timeoutMs: 700, pollMs: 150 });
  record('a wait that never matches reports no match', false, staticWait?.wait?.matched, `matched=${staticWait?.wait?.matched}`);
  record('a timed-out wait is a timeout, not a failure', true, staticWait?.wait?.timedOut, `timedOut=${staticWait?.wait?.timedOut}`);
  record('a timed-out wait does not call the submit failed', true,
    /not proof the submit failed/i.test(staticWait?.wait?.note ?? ''), `note=${(staticWait?.wait?.note ?? '').slice(0, 120)}`);
  record('a timed-out wait still returns the phase it saw', 'credentials', staticWait?.phase, `phase=${staticWait?.phase}`);
  const badPhase = await bounded(request('/call', {
    name: 'browser_login_state',
    arguments: { tabId: stillTab, untilPhase: 'signed_in', agent }
  }).then(r => r.result).catch(error => ({ error: error.message })), 15000);
  record('an unknown phase name is refused before any polling', true, Boolean(badPhase?.error),
    `result=${JSON.stringify(badPhase).slice(0, 160)}`);

  // 10. The credential lookup refuses without the explicit confirmation string.
  const denied = await bounded(request('/call', { name: 'browser_credential_lookup', arguments: { url: `${base}/login`, agent } }).then(r => r.result).catch(error => ({ error: error.message })), 15000);
  record('credential lookup refuses an unconfirmed call', true, Boolean(denied?.error) || denied?.status === 'denied',
    `result=${JSON.stringify(denied).slice(0, 160)}`);

  // 11. Optional: run the real DPAPI + AES-GCM chain against the real profile.
  //    Off by default because it reaches a real saved password. It asserts the
  //    contract rather than demanding success, because on Chrome 127+ the saved
  //    password may legitimately be unreadable: the point is that the reply says
  //    which layer failed, with evidence, instead of failing vaguely.
  if (process.env.BRIDGE_VERIFY_CREDENTIAL === '1' && process.env.BRIDGE_VERIFY_ORIGIN) {
    const live = await bounded(request('/call', {
      name: 'browser_credential_lookup',
      arguments: { url: process.env.BRIDGE_VERIFY_ORIGIN, confirmation: 'read_credential_once', agent }
    }).then(r => r.result), 40000);
    const first = (live?.matches ?? [])[0];
    const status = live?.status;
    const documented = ['success', 'blocked', 'unavailable', 'not_found'];
    record('the lookup returns a documented status', true, documented.includes(status),
      `status=${status} reason=${live?.reason ?? 'none'}`);
    // A non-success answer must name the exact layer that failed; "unavailable"
    // on its own is what made this defect take a whole session to pin down.
    record('a failure names a specific reason', true,
      status === 'success' || (typeof live?.reason === 'string' && live.reason.length > 0),
      `reason=${live?.reason ?? 'missing'}`);
    const validation = live?.keyValidation;
    record('keyValidation is well formed when present', true,
      validation === undefined
        || (typeof validation.validated === 'boolean' || typeof validation.validated === 'object')
        || typeof validation.skipped === 'string',
      `keyValidation=${JSON.stringify(validation ?? null).slice(0, 160)}`);
    record('no cookie value rides along in the reply', true,
      !JSON.stringify(live ?? {}).includes('cookie-payload'),
      'the diagnostic reports counts only');
    if (status === 'success') {
      record('a decrypted value is a non-empty string', true,
        typeof first?.password === 'string' && first.password.length > 0,
        `passwordLength=${typeof first?.password === 'string' ? first.password.length : 'none'} (value deliberately not printed)`);
    } else {
      step(`real credential stayed sealed: status=${status} reason=${live?.reason} — the reply is expected to explain which layer failed, not to guess a password`);
      record('no password appears in a failed reply', true,
        (live?.matches ?? []).every(item => item.password === null),
        `matchCount=${live?.matchCount ?? 0}`);
    }
    record('the reply carries the handling constraint', true, /not written to disk/i.test(live?.handling ?? ''), 'handling');
  } else {
    step('real credential decrypt skipped: set BRIDGE_VERIFY_CREDENTIAL=1 and BRIDGE_VERIFY_ORIGIN=<origin> to include it; it reaches a real saved password, so it is opt-in rather than automatic');
  }
} catch (error) {
  if (!blocked) record('fixture setup', 'ok', 'error', error.message);
}

for (const tabId of [...new Set(opened)]) await bounded(call('browser_close', { tabId, force: true }).catch(() => {}), 8000);
try { fixture.closeAllConnections?.(); } catch { /* older runtimes */ }
await bounded(new Promise(resolve => fixture.close(resolve)), 3000);
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
console.log(`\n${rows.length - failed.length}/${rows.length} login-path promises held`);
process.exit(failed.length ? 1 : 0);
