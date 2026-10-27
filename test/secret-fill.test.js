// Locks the secret-fill path, which exists because the login flow was a dead
// end: browser_login_state hands out a real ref for a password field, but every
// write through that ref was refused — the shared guard at page.js:950 rejected
// it as "Element unavailable or protected" and browser_fill's type whitelist
// rejected type=password as unsupported. Discovery promised a target that no
// tool could write to.
//
// pageOperation is serialised into the page by chrome.scripting.executeScript,
// so it cannot be imported into a DOM. These assertions run it inside node:vm
// against hand-built elements, the same way test/accname.test.js does.
//
// What is a real path here and what is a substitute:
//   * Ref acquisition, the guard, the type whitelist, the write, the returned
//     shape and the verification are all the real code paths. Refs for the
//     password and text fields come from a real browser_login_state call, which
//     is exactly the deadlock under test.
//   * input[type=hidden] cannot be reached that way: browser_login_state,
//     browser_read, browser_find_element and browser_scan_overlays all filter
//     sensitive() elements, so no operation will ever mint a ref for one. That
//     case seeds the snapshot map directly with the fingerprint page.js would
//     have computed, and asserts on the exact rejection message — a fingerprint
//     mismatch would surface as "Stale element reference", not as a pass.
//   * InputEvent/Event are stubs, so nothing here proves the page's own handlers
//     reacted. That is why the assertions are about el.value and the returned
//     object, never about "no exception was thrown".
import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { randomUUID } from 'node:crypto';
import { pageOperation } from '../extension/page.js';

const HREF = 'https://fixture.test/login';
const SECRET = 'S3cret-passphrase';
const PRIVATE = { private: true };

function build(specs) {
  const Input = class HTMLInputElement {};
  const TextArea = class HTMLTextAreaElement {};
  const Select = class HTMLSelectElement {};
  // page.js writes through the prototype setter, so the sandbox classes need a
  // real value accessor rather than a plain property.
  for (const ctor of [Input, TextArea]) {
    Object.defineProperty(ctor.prototype, 'value', {
      configurable: true,
      get() { return this._value ?? ''; },
      set(next) { this._value = String(next); }
    });
  }
  const make = (spec) => {
    const attrs = { ...(spec.attrs ?? {}) };
    const tag = spec.tag ?? 'INPUT';
    const node = Object.create(tag === 'TEXTAREA' ? TextArea.prototype : Input.prototype);
    Object.assign(node, {
      tagName: tag,
      id: attrs.id ?? '',
      type: attrs.type ?? 'text',
      disabled: false,
      readOnly: false,
      isConnected: true,
      labels: [],
      innerText: spec.text ?? '',
      textContent: spec.text ?? '',
      parentElement: null,
      _value: spec.value ?? '',
      getAttribute: name => (name in attrs ? attrs[name] : null),
      // Comma-separated selectors are evaluated part by part: sensitive() asks
      // for 'input[type=password],input[type=hidden]' in one string, and a
      // prefix match on that would mark every input as sensitive.
      matches: selector => String(selector).split(',').some(part => {
        const s = part.trim();
        if (s === 'input[type=password]') return tag === 'INPUT' && attrs.type === 'password';
        if (s === 'input[type=hidden]') return tag === 'INPUT' && attrs.type === 'hidden';
        if (s === 'input[type=file]') return tag === 'INPUT' && attrs.type === 'file';
        if (s === 'input') return tag === 'INPUT';
        return false;
      }),
      closest: selector => (spec.privateRegion && selector === '[data-ai-private]' ? PRIVATE : null),
      getClientRects: () => [{}],
      getBoundingClientRect: () => ({ left: 0, top: 0, width: 100, height: 30 }),
      focus: () => {},
      scrollIntoView: () => {},
      dispatchEvent: () => true,
      ownerDocument: { getElementById: () => null }
    });
    return node;
  };
  const nodes = specs.map(make);
  const document = {
    title: 'fixture',
    querySelectorAll: () => nodes,
    getElementById: () => null
  };
  const context = vm.createContext({
    location: { protocol: 'https:', origin: 'https://fixture.test', href: HREF },
    innerWidth: 800, innerHeight: 600, scrollX: 0, scrollY: 0,
    crypto: { randomUUID }, Map, Date: { now: () => 1000 }, console,
    setTimeout, clearTimeout,
    performance: { now: () => 0 },
    getComputedStyle: () => ({ visibility: 'visible', display: 'block', contentVisibility: 'visible', opacity: '1', position: 'static', zIndex: 'auto' }),
    InputEvent: class InputEvent { constructor(type, init) { this.type = type; Object.assign(this, init ?? {}); } },
    Event: class Event { constructor(type, init) { this.type = type; Object.assign(this, init ?? {}); } },
    MouseEvent: class MouseEvent { constructor(type, init) { this.type = type; Object.assign(this, init ?? {}); } },
    // Never constructed on the success paths below; present so a future
    // regression that reaches verify()'s wait loop fails on an assertion
    // instead of a ReferenceError.
    MutationObserver: class MutationObserver { observe() {} disconnect() {} },
    HTMLInputElement: Input, HTMLTextAreaElement: TextArea, HTMLSelectElement: Select,
    document
  });
  const run = vm.runInContext(`(${pageOperation.toString()})`, context);
  return { run, nodes, context };
}

const failureOf = (result) => {
  assert.ok(result && typeof result.__aibError === 'string', `expected a refusal, got ${JSON.stringify(result)}`);
  return result.__aibError;
};

// browser_login_state is the only operation that mints a ref for a password
// field, so the tests use it rather than fabricating one.
async function passwordRef(run) {
  const state = await run('browser_login_state', {}, [], true);
  assert.equal(state.passwordFields.length, 1, `expected one password field, got ${JSON.stringify(state.passwordFields)}`);
  return state.passwordFields[0].ref;
}

// A hidden input can never receive a ref from a real operation (every read path
// filters sensitive elements), so this seeds the snapshot the way page.js would
// have stored it. fingerprint() is [tagName, type, label, href, formaction];
// label() is empty for a bare input with no labelling attribute.
function seedHiddenRef(context, node) {
  const snapshot = 'seeded';
  const state = {
    snapshot,
    url: HREF,
    refs: new Map([[`${snapshot}:1`, { el: node, fingerprint: JSON.stringify(['INPUT', 'hidden', '', null, null]) }]])
  };
  context.__aiBrowserBridgeSnapshots = new Map([[snapshot, state]]);
  context.__aiBrowserBridge = state;
  return `${snapshot}:1`;
}

test('browser_fill without secret still refuses a password field', async () => {
  const { run } = build([{ attrs: { type: 'password', name: 'pw', placeholder: 'Password' } }]);
  const ref = await passwordRef(run);
  const result = await run('browser_fill', { ref, text: SECRET }, [], true);
  assert.equal(failureOf(result), 'Element unavailable or protected');
});

test('secret fill really writes the password into the field', async () => {
  const { run, nodes } = build([{ attrs: { type: 'password', name: 'pw', placeholder: 'Password' } }]);
  const ref = await passwordRef(run);
  const result = await run('browser_fill', { ref, text: SECRET, secret: true }, [], true);
  assert.ok(!result.__aibError, `secret fill was refused: ${result.__aibError}`);
  assert.equal(result.filled, true);
  assert.equal(result.secret, true);
  assert.equal(nodes[0].value, SECRET, 'the DOM value must hold the text, not just a success flag');
});

test('secret fill result never carries the value back', async () => {
  const { run } = build([{ attrs: { type: 'password', name: 'pw', placeholder: 'Password' } }]);
  const ref = await passwordRef(run);
  const result = await run('browser_fill', { ref, text: SECRET, secret: true }, [], true);
  const serialised = JSON.stringify(result);
  assert.ok(!serialised.includes(SECRET), `the value leaked through the tool result: ${serialised}`);
  assert.equal(result.characters, SECRET.length);
  assert.equal(result.valueMatches, true);
  assert.equal(result.valueEchoSuppressed, true);
  assert.ok(!('observed' in result), 'the observed value must not be part of the result');
});

test('secret fill leaves an ordinary text field working', async () => {
  const { run, nodes } = build([{ attrs: { type: 'text', name: 'user', placeholder: 'Username' } }]);
  const state = await run('browser_login_state', {}, [], true);
  assert.equal(state.usernameFields.length, 1);
  const result = await run('browser_fill', { ref: state.usernameFields[0].ref, text: 'alice@example.test', secret: true }, [], true);
  assert.ok(!result.__aibError, `secret fill on a text field was refused: ${result.__aibError}`);
  assert.equal(result.filled, true);
  assert.equal(nodes[0].value, 'alice@example.test');
});

test('secret fill does not unlock input[type=hidden]', async () => {
  const { run, nodes, context } = build([{ attrs: { type: 'hidden', name: 'csrf' } }]);
  const ref = seedHiddenRef(context, nodes[0]);
  const result = await run('browser_fill', { ref, text: 'injected-token', secret: true }, [], true);
  assert.equal(failureOf(result), 'Element unavailable or protected', 'secret must widen password only, never hidden');
  assert.equal(nodes[0].value, '', 'nothing may be written to a hidden input');
});

test('secret fill does not unlock a region declared [data-ai-private]', async () => {
  const { run, nodes } = build([{ attrs: { type: 'text', name: 'user', placeholder: 'Username' }, privateRegion: true }]);
  const state = await run('browser_login_state', {}, [], true);
  assert.equal(state.usernameFields.length, 1);
  const result = await run('browser_fill', { ref: state.usernameFields[0].ref, text: 'alice@example.test', secret: true }, [], true);
  assert.equal(failureOf(result), 'Element unavailable or protected', 'a third party declaring the region private must still win over secret');
  assert.equal(nodes[0].value, '');
});

test('secret:true on browser_click does not unlock a password field', async () => {
  // The guard that secret relaxes is shared with click, scroll_element and
  // dismiss_overlay. If the relaxation is not bound to the fill operation by
  // name, this is the assertion that catches it.
  const { run } = build([{ attrs: { type: 'password', name: 'pw', placeholder: 'Password' } }]);
  const ref = await passwordRef(run);
  const result = await run('browser_click', { ref, secret: true }, [], true);
  assert.equal(failureOf(result), 'Element unavailable or protected', 'a relaxation that is not bound to the fill operation would dispatch the click here');
});

test('fill_verified ignores a caller-supplied expectation for a secret fill', async () => {
  const { run } = build([{ attrs: { type: 'password', name: 'pw', placeholder: 'Password' } }]);
  const ref = await passwordRef(run);
  const callerCopy = 'caller-supplied-plaintext-copy';
  const result = await run('browser_fill_verified', { ref, text: SECRET, secret: true, expect: { valueMatches: callerCopy } }, [], true);
  assert.ok(!result.__aibError, `secret fill_verified was refused: ${result.__aibError}`);
  assert.match(result.expectValueMatchesIgnored, /compares against the text that was sent/);
  const serialised = JSON.stringify(result);
  assert.ok(!serialised.includes(callerCopy), `the caller's copy leaked through the verification: ${serialised}`);
  assert.ok(!serialised.includes(SECRET), `the value leaked through the verification: ${serialised}`);
});

test('fill_verified reports success for a secret fill that landed', async () => {
  const { run, nodes } = build([{ attrs: { type: 'password', name: 'pw', placeholder: 'Password' } }]);
  const ref = await passwordRef(run);
  const result = await run('browser_fill_verified', { ref, text: SECRET, secret: true }, [], true);
  assert.ok(!result.__aibError, `secret fill_verified was refused: ${result.__aibError}`);
  assert.equal(result.status, 'success');
  assert.equal(result.verification.checks.valueMatches, true);
  assert.equal(result.filled.valueMatches, true);
  assert.equal(nodes[0].value, SECRET);
});

test('login_state guidance points at secret:true instead of a fill that cannot work', async () => {
  const { run } = build([{ attrs: { type: 'password', name: 'pw', placeholder: 'Password' } }]);
  const state = await run('browser_login_state', {}, [], true);
  const guidance = state.autofill.paths.join(' ');
  assert.match(guidance, /secret:true/);
  assert.match(guidance, /browser_password_manager_reveal/);
  assert.ok(!/fill it with browser_fill_verified: that is faster/.test(guidance), 'the dead-end instruction is back');
});
