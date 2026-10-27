// Locks the login phase classification, because "which screen am I on" is the
// question every step of an automated login depends on and the old answer had
// two holes: a two-step login (identifier field, no password field, a Next
// button) fell through to "unknown", whose guidance says "no login form was
// recognised" and sends the caller hunting for a shadow root instead of typing
// the username; and a signed-in page that keeps "sign out" inside a closed
// avatar menu also read as "unknown", so a completed login could not be
// confirmed from the DOM at all.
//
// pageOperation is serialised into the page by chrome.scripting.executeScript,
// so it cannot be imported into a real DOM. These assertions run it inside
// node:vm against hand-built elements, the same way test/accname.test.js does.
//
// What is real here and what is a substitute: the phase ordering, the
// confidence and evidence fields, the guidance text and the returned shape are
// the real code. The DOM is hand-built, so nothing here proves how a real
// browser lays out a form - test/live-login.js covers that.
import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { pageOperation } from '../extension/page.js';

const HREF = 'https://fixture.test/login';
const ORIGIN = 'https://fixture.test';

function build({ controls = [], accounts = [], errors = [] } = {}) {
  const make = (spec) => {
    const attrs = { ...(spec.attrs ?? {}) };
    const tag = spec.tag ?? 'INPUT';
    const node = {
      tagName: tag,
      id: attrs.id ?? '',
      type: attrs.type ?? 'text',
      value: spec.value ?? '',
      disabled: false,
      readOnly: false,
      labels: [],
      innerText: spec.text ?? '',
      textContent: spec.text ?? '',
      parentElement: null,
      getAttribute: name => (name in attrs ? attrs[name] : null),
      // Comma-separated selectors are evaluated part by part: sensitive() asks
      // for 'input[type=password],input[type=hidden]' in one string, and a
      // prefix match on that would mark every input as sensitive.
      matches: selector => String(selector).split(',').some(part => {
        const s = part.trim();
        if (s === 'input[type=password]') return tag === 'INPUT' && attrs.type === 'password';
        if (s === 'input[type=hidden]') return tag === 'INPUT' && attrs.type === 'hidden';
        if (s === 'input[type=file]') return tag === 'INPUT' && attrs.type === 'file';
        if (s === 'input[type=submit]') return tag === 'INPUT' && attrs.type === 'submit';
        if (s === 'button[type=submit]') return tag === 'BUTTON' && attrs.type === 'submit';
        if (s === 'input') return tag === 'INPUT';
        if (s === 'button') return tag === 'BUTTON';
        if (s === 'a[role=button]' || s === '[role=button]') return attrs.role === 'button';
        return false;
      }),
      closest: () => null,
      getClientRects: () => [{}],
      getBoundingClientRect: () => ({ left: 0, top: 0, width: 100, height: 30 }),
      focus: () => {},
      dispatchEvent: () => true,
      ownerDocument: { getElementById: () => null }
    };
    return node;
  };
  const nodes = controls.map(make);
  const accountNodes = accounts.map(make);
  const errorNodes = errors.map(make);
  const document = {
    title: 'fixture',
    // The login block issues three different queries; answering all of them with
    // one list would let an avatar element count as a password field.
    querySelectorAll: selector => {
      if (String(selector).startsWith('[class*=avatar')) return accountNodes;
      if (String(selector).startsWith('[role=alert')) return errorNodes;
      return nodes;
    },
    getElementById: () => null
  };
  const context = vm.createContext({
    location: { protocol: 'https:', origin: ORIGIN, href: HREF },
    innerWidth: 800, innerHeight: 600, scrollX: 0, scrollY: 0,
    crypto: { randomUUID }, Map, Date, console,
    setTimeout, clearTimeout,
    performance: { now: () => 0 },
    getComputedStyle: () => ({ visibility: 'visible', display: 'block', contentVisibility: 'visible', opacity: '1', position: 'static', zIndex: 'auto' }),
    InputEvent: class InputEvent { constructor(type, init) { this.type = type; Object.assign(this, init ?? {}); } },
    Event: class Event { constructor(type, init) { this.type = type; Object.assign(this, init ?? {}); } },
    MouseEvent: class MouseEvent { constructor(type, init) { this.type = type; Object.assign(this, init ?? {}); } },
    MutationObserver: class MutationObserver { observe() {} disconnect() {} },
    HTMLInputElement: class HTMLInputElement {},
    HTMLTextAreaElement: class HTMLTextAreaElement {},
    HTMLSelectElement: class HTMLSelectElement {},
    document
  });
  const run = vm.runInContext(`(${pageOperation.toString()})`, context);
  return { run, nodes };
}

// pageOperation is async, so every assertion awaits the same promise shape the
// extension gets back from chrome.scripting.executeScript.
const stateOf = (fixture) => fixture.run('browser_login_state', { tabId: 1 }, [ORIGIN], false);

const email = { attrs: { id: 'user', name: 'email', type: 'email', placeholder: 'Email address' } };
const password = { attrs: { id: 'pw', name: 'password', type: 'password' }, text: 'Password' };
const nextButton = { tag: 'BUTTON', attrs: { type: 'submit' }, text: 'Next' };
const signInButton = { tag: 'BUTTON', attrs: { type: 'submit' }, text: 'Sign in' };
const signOutButton = { tag: 'BUTTON', attrs: { type: 'button' }, text: 'Sign out' };

test('an identifier-only screen is the identifier phase, not unknown', async () => {
  const state = await stateOf(build({ controls: [email, nextButton] }));
  assert.equal(state.phase, 'identifier');
  assert.equal(state.phaseConfidence, 'strong');
  assert.equal(state.usernameFields.length, 1);
  assert.equal(state.passwordFields.length, 0);
  // The whole point of the new phase: the next step must be named, and the wait
  // for it must be a wait, not a second single-frame sample.
  assert.match(state.guidance, /untilPhase:"credentials"/);
});

test('the identifier phase warns that it may not be a login at all', async () => {
  const state = await stateOf(build({ controls: [email, nextButton] }));
  // A newsletter or search field produces the same shape, so the guidance has to
  // carry the doubt instead of letting the caller type a password into it.
  assert.match(state.guidance, /not a login|heading/i);
  assert.ok(state.phaseEvidence.some(item => /identifier field/.test(item)), JSON.stringify(state.phaseEvidence));
});

test('a password field wins over a sign-out control in the same document', async () => {
  // Footers of login pages carry a sign-out link for other sessions; a password
  // field must not be overridden by it.
  const state = await stateOf(build({ controls: [email, password, signInButton, signOutButton] }));
  assert.equal(state.phase, 'credentials');
  assert.ok(state.phaseEvidence.some(item => /visible sign-out control/.test(item)));
});

test('the credentials guidance asks for a wait on the otp phase', async () => {
  const state = await stateOf(build({ controls: [email, password, signInButton] }));
  assert.equal(state.phase, 'credentials');
  assert.match(state.guidance, /untilPhase:"otp"/);
});

test('a visible sign-out control is strong logged_in evidence', async () => {
  const state = await stateOf(build({ controls: [signOutButton] }));
  assert.equal(state.phase, 'logged_in');
  assert.equal(state.phaseConfidence, 'strong');
});

test('an avatar element with no sign-out control is weak logged_in evidence', async () => {
  const state = await stateOf(build({
    controls: [],
    accounts: [{ tag: 'DIV', attrs: { 'aria-label': 'Account menu' }, text: 'A' }]
  }));
  assert.equal(state.phase, 'logged_in');
  // Weak, because "no login form plus an avatar" is a negative inference. The
  // reply must not claim a session was proven.
  assert.equal(state.phaseConfidence, 'weak');
  assert.match(state.guidance, /weak negative inference/);
});

test('an account element whose own text says sign in is not account evidence', async () => {
  // Every marketing header has one of these. Counting it would report logged_in
  // on a page nobody is signed in to.
  const state = await stateOf(build({
    controls: [],
    accounts: [{ tag: 'A', attrs: { 'aria-label': 'Sign in' }, text: 'Sign in' }]
  }));
  assert.equal(state.phase, 'unknown');
  assert.equal(state.phaseConfidence, 'none');
  assert.equal(state.accountHints.length, 0);
});

test('a page with nothing recognisable stays unknown with no confidence', async () => {
  const state = await stateOf(build({ controls: [] }));
  assert.equal(state.phase, 'unknown');
  assert.equal(state.phaseConfidence, 'none');
  assert.match(state.guidance, /shadow_tree/);
});

test('the error text and its evidence travel with the phase', async () => {
  const state = await stateOf(build({
    controls: [email, password, signInButton],
    errors: [{ tag: 'DIV', attrs: { role: 'alert' }, text: 'Incorrect password, please try again' }]
  }));
  assert.equal(state.phase, 'credentials');
  assert.ok(state.errorText.some(text => /incorrect password/i.test(text)), JSON.stringify(state.errorText));
  assert.ok(state.phaseEvidence.some(item => /error message/.test(item)));
});

test('no field value is returned in any phase', async () => {
  const fixture = build({ controls: [email, password, signInButton] });
  fixture.nodes[1].value = 'S3cret-passphrase';
  const state = await stateOf(fixture);
  assert.equal(state.passwordFields[0].hasValue, true);
  assert.equal(/S3cret-passphrase/.test(JSON.stringify(state)), false);
});

// The wait itself cannot be exercised here: it runs in the service worker, on
// purpose, because an in-page promise is destroyed by the navigation it is
// supposed to observe. These two assertions pin that placement, so a later
// change cannot quietly move the loop back into the page and pass its unit
// tests while failing every full-page login.
const root = join(fileURLToPath(new URL('../', import.meta.url)));
const pageSource = readFileSync(join(root, 'extension/page.js'), 'utf8');
const workerSource = readFileSync(join(root, 'extension/worker.js'), 'utf8');
const serverSource = readFileSync(join(root, 'src/server.js'), 'utf8');

test('the phase wait lives in the service worker, not in the page', () => {
  assert.match(workerSource, /name === 'browser_login_state' && typeof args\.untilPhase === 'string'/);
  assert.match(workerSource, /phasesSeen/);
  // page.js names untilPhase only inside guidance text; it must never read it,
  // because a wait that lives in the page cannot survive the navigation it waits
  // for.
  assert.equal(/args\.untilPhase/.test(pageSource), false, 'page.js must stay a single-frame read');
});

test('a phase wait that outlives the default job budget is not killed by it', () => {
  // The default 20s job timer would otherwise fire before a 30s wait finishes and
  // turn a deliberate wait into a read_timeout.
  assert.match(serverSource, /browser_login_state' && Number\.isFinite\(args\.timeoutMs\)/);
});
