// Locks the accessible-name precedence, because the previous implementation was
// a property-order guess: it read aria-label, then the first native label, then
// placeholder, and never read aria-labelledby at all. These assertions run
// pageOperation inside a vm with hand-built elements, which is the only way to
// reach a function that is normally serialised into a page.
import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { randomUUID } from 'node:crypto';
import { pageOperation } from '../extension/page.js';

function build(elements) {
  // Filled after the nodes exist: make() closes over the map, and the lookup only
  // runs when aria-labelledby is actually resolved.
  const byId = new Map();
  const make = (spec) => {
    const attrs = spec.attrs ?? {};
    const node = {
      tagName: spec.tag ?? 'INPUT',
      id: attrs.id ?? '',
      type: attrs.type ?? 'text',
      value: spec.value ?? '',
      disabled: false,
      readOnly: false,
      labels: spec.labels ?? [],
      innerText: spec.text ?? '',
      textContent: spec.text ?? '',
      parentElement: null,
      getAttribute: name => (name in attrs ? attrs[name] : null),
      matches: selector => {
        if (selector === 'input[type=password]') return spec.tag !== 'BUTTON' && attrs.type === 'password';
        if (selector === 'input[type=hidden]') return attrs.type === 'hidden';
        if (selector.startsWith('input')) return (spec.tag ?? 'INPUT') === 'INPUT';
        if (selector.startsWith('button')) return spec.tag === 'BUTTON';
        return false;
      },
      closest: () => null,
      getClientRects: () => [{}],
      getBoundingClientRect: () => ({ left: 0, top: 0, width: 100, height: 30 }),
      focus: () => {},
      dispatchEvent: () => true,
      ownerDocument: { getElementById: id => byId.get(id) ?? null }
    };
    return node;
  };
  const controls = elements.map(make);
  for (const node of controls) if (node.id) byId.set(node.id, node);
  const document = {
    title: 'fixture',
    querySelectorAll: selector => (selector.includes('role=alert') ? [] : controls),
    getElementById: id => byId.get(id) ?? null
  };
  const context = vm.createContext({
    location: { protocol: 'https:', origin: 'https://fixture.test', href: 'https://fixture.test/login' },
    innerWidth: 800, innerHeight: 600, scrollX: 0, scrollY: 0,
    crypto: { randomUUID }, Map, Date: { now: () => 1000 }, console,
    getComputedStyle: () => ({ visibility: 'visible', display: 'block', contentVisibility: 'visible', opacity: '1' }),
    // pageOperation runs inside a real page where these constructors exist. The
    // vm sandbox has to supply them or the existing instanceof checks throw
    // before any of the behaviour under test runs.
    HTMLInputElement: class HTMLInputElement {},
    HTMLTextAreaElement: class HTMLTextAreaElement {},
    HTMLSelectElement: class HTMLSelectElement {},
    document
  });
  const run = vm.runInContext(`(${pageOperation.toString()})`, context);
  return { run, byId };
}

test('aria-labelledby wins over aria-label, native label, placeholder and title', async () => {
  const { run } = build([
    { tag: 'SPAN', attrs: { id: 'lbl' }, text: 'Email address' },
    { attrs: {
      id: 'user', type: 'email',
      'aria-labelledby': 'lbl',
      'aria-label': 'Ignored label',
      placeholder: 'Ignored placeholder',
      title: 'Ignored title'
    } }
  ]);
  const state = await run('browser_login_state', {}, [], true);
  assert.equal(state.usernameFields.length, 1);
  assert.equal(state.usernameFields[0].label, 'Email address');
});

test('a native <label> beats placeholder and title', async () => {
  const labelNode = { textContent: 'Account password' };
  const { run } = build([
    { attrs: { type: 'password', placeholder: 'Enter password', title: 'Password field' }, labels: [labelNode] }
  ]);
  const state = await run('browser_login_state', {}, [], true);
  assert.equal(state.passwordFields.length, 1);
  assert.equal(state.passwordFields[0].label, 'Account password');
});

test('placeholder is used only when nothing better exists', async () => {
  const { run } = build([
    { attrs: { type: 'email', placeholder: 'you@example.test' } }
  ]);
  const state = await run('browser_login_state', {}, [], true);
  assert.equal(state.usernameFields[0].label, 'you@example.test');
});

test('input[type=submit] is named by its value, not by its type', async () => {
  const { run } = build([
    { attrs: { type: 'submit' }, value: 'Sign in' }
  ]);
  const state = await run('browser_login_state', {}, [], true);
  const submit = state.submitCandidates.find(item => item.label === 'Sign in');
  assert.ok(submit, `expected a submit candidate named "Sign in", got ${JSON.stringify(state.submitCandidates)}`);
});

test('a missing aria-labelledby target falls through instead of naming the field empty', async () => {
  const { run } = build([
    { attrs: { type: 'email', 'aria-labelledby': 'does-not-exist', placeholder: 'Email' } }
  ]);
  const state = await run('browser_login_state', {}, [], true);
  assert.equal(state.usernameFields[0].label, 'Email');
});
