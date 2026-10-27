// The password manager adapter is tested with an injected runner, so no test
// ever opens a real password manager or touches a real password. Every assertion
// here is about the contract: what gets sent, and what is allowed back out.
import test from 'node:test';
import assert from 'node:assert/strict';
import { revealSavedPassword, siteCandidates, passwordManagerSiteHash, PASSWORD_MANAGER_CONFIRMATION } from '../src/password-manager.js';

const OK_CONFIRMATION = { confirmation: PASSWORD_MANAGER_CONFIRMATION };

function runnerReturning(payload, extra = {}) {
  const calls = [];
  const runner = async args => {
    calls.push(args);
    return { stdout: typeof payload === 'string' ? payload : JSON.stringify(payload), code: 0, ...extra };
  };
  return { runner, calls };
}

test('a call without the confirmation attestation is refused before anything runs', async () => {
  const { runner, calls } = runnerReturning({ status: 'success' });
  await assert.rejects(() => revealSavedPassword({ site: 'example.test' }, { runner }), /Invalid confirmation/);
  assert.equal(calls.length, 0);
});

test('one site expands into the spellings Chrome could have named it by', () => {
  const expansion = siteCandidates('https://account.mozilla.com.cn/login?x=1');
  assert.equal(expansion.site, 'account.mozilla.com.cn');
  assert.ok(expansion.altSites.includes('mozilla.com.cn'), 'the site name Chrome actually stores must be tried');
  assert.equal(expansion.expectedOrigin, 'https://account.mozilla.com.cn');
});

test('a bare site name is accepted and does not invent an origin', () => {
  const expansion = siteCandidates('mozilla.com.cn');
  assert.equal(expansion.site, 'mozilla.com.cn');
  assert.equal(expansion.expectedOrigin, null);
});

test('an IP-based entry keeps its scheme, because Chrome lists it that way', () => {
  const expansion = siteCandidates('http://192.168.1.1');
  assert.equal(expansion.site, '192.168.1.1');
  assert.ok(expansion.altSites.includes('http://192.168.1.1'));
  assert.equal(expansion.expectedOrigin, 'http://192.168.1.1');
});

test('a site with whitespace or control characters is denied without running anything', async () => {
  for (const site of ['', '   ', 'exa mple.test', 'example.test\nrm -rf', 'a'.repeat(300)]) {
    const { runner, calls } = runnerReturning({ status: 'success' });
    const result = await revealSavedPassword({ ...OK_CONFIRMATION, site }, { runner });
    assert.equal(result.status, 'denied', site);
    assert.equal(result.reason, 'invalid_site', site);
    assert.equal(calls.length, 0, site);
  }
});

test('the reveal call carries the exact target and closes the tab by default', async () => {
  const { runner, calls } = runnerReturning({ status: 'success', site: 'mozilla.com.cn', username: 'a', password: 'p' });
  await revealSavedPassword({ ...OK_CONFIRMATION, site: 'https://account.mozilla.com.cn' }, { runner });
  assert.equal(calls.length, 1);
  const args = calls[0];
  assert.equal(args[args.indexOf('-Action') + 1], 'reveal');
  assert.equal(args[args.indexOf('-Site') + 1], 'account.mozilla.com.cn');
  assert.match(args[args.indexOf('-AltSites') + 1], /mozilla\.com\.cn/);
  assert.equal(args[args.indexOf('-ExpectedOrigin') + 1], 'https://account.mozilla.com.cn');
  assert.ok(args.includes('-CloseTab'));
});

test('closeTab:false and action:"read" both keep the tab and skip the reveal', async () => {
  const first = runnerReturning({ status: 'success' });
  await revealSavedPassword({ ...OK_CONFIRMATION, site: 'example.test', closeTab: false }, { runner: first.runner });
  assert.equal(first.calls[0].includes('-CloseTab'), false);

  const second = runnerReturning({ status: 'success' });
  await revealSavedPassword({ ...OK_CONFIRMATION, site: 'example.test', action: 'read' }, { runner: second.runner });
  assert.equal(second.calls[0][second.calls[0].indexOf('-Action') + 1], 'read');
  assert.equal(second.calls[0].includes('-CloseTab'), false);
});

test('a success carries the value and the handling constraint', async () => {
  const { runner } = runnerReturning({
    status: 'success', site: 'mozilla.com.cn', origin: 'https://account.mozilla.com.cn',
    username: 'someone@example.test', password: 'correct horse', requiresUserAuth: false,
    evidence: { method: 'windows_ui_automation', revealInvoked: true }
  });
  const result = await revealSavedPassword({ ...OK_CONFIRMATION, site: 'https://account.mozilla.com.cn' }, { runner });
  assert.equal(result.status, 'success');
  assert.equal(result.password, 'correct horse');
  assert.equal(result.username, 'someone@example.test');
  assert.equal(result.requiresUserAuth, false);
  assert.equal(result.method, 'windows_ui_automation');
  assert.match(result.handling, /not written to disk/i);
});

test('an operating-system prompt is reported, never worked around', async () => {
  const { runner } = runnerReturning({
    status: 'waiting_for_user_auth', reason: 'os_auth_prompt_observed',
    site: 'mozilla.com.cn', foregroundOwnerProcessId: 4242,
    note: 'Ask the user to complete it, then call again with action:"read".'
  });
  const result = await revealSavedPassword({ ...OK_CONFIRMATION, site: 'mozilla.com.cn' }, { runner });
  assert.equal(result.status, 'waiting_for_user_auth');
  assert.equal(result.foregroundOwnerProcessId, 4242);
  assert.equal(result.password, undefined);
  assert.match(result.note, /action:"read"/);
});

test('a miss reports the entries it saw, so the caller can retry deliberately', async () => {
  const { runner } = runnerReturning({
    status: 'not_found', reason: 'no_exact_entry', visibleEntries: ['mozilla.com.cn', 'mozilla.org']
  });
  const result = await revealSavedPassword({ ...OK_CONFIRMATION, site: 'account.mozilla.com.cn' }, { runner });
  assert.equal(result.status, 'not_found');
  assert.deepEqual(result.visibleEntries, ['mozilla.com.cn', 'mozilla.org']);
  assert.equal(result.password, undefined);
});

test('a timeout is uncertain, not retried, and carries no value', async () => {
  let calls = 0;
  const runner = async () => { calls += 1; return { stdout: '', timedOut: true }; };
  const result = await revealSavedPassword({ ...OK_CONFIRMATION, site: 'example.test' }, { runner });
  assert.equal(result.status, 'uncertain');
  assert.equal(result.reason, 'ui_automation_timeout');
  assert.equal(result.retryable, false);
  assert.equal(calls, 1, 'an unknown outcome must never be replayed automatically');
});

test('empty output is a retryable environment failure, not a silent pass', async () => {
  const runner = async () => ({ stdout: '', stderr: 'pwsh: not found', code: 1 });
  const result = await revealSavedPassword({ ...OK_CONFIRMATION, site: 'example.test' }, { runner });
  assert.equal(result.status, 'unavailable');
  assert.equal(result.reason, 'ui_automation_unavailable');
  assert.equal(result.retryable, true);
  assert.match(result.detail, /not found/);
});

test('unparseable output is uncertain rather than being interpreted', async () => {
  const { runner } = runnerReturning('not json at all');
  const result = await revealSavedPassword({ ...OK_CONFIRMATION, site: 'example.test' }, { runner });
  assert.equal(result.status, 'uncertain');
  assert.equal(result.reason, 'unreadable_ui_automation_output');
});

test('the site hash is stable and reveals nothing about the site', () => {
  const a = passwordManagerSiteHash('https://account.mozilla.com.cn');
  const b = passwordManagerSiteHash('https://account.mozilla.com.cn');
  const c = passwordManagerSiteHash('https://other.test');
  assert.equal(a, b);
  assert.notEqual(a, c);
  assert.equal(a.length, 16);
  assert.equal(a.includes('mozilla'), false);
  assert.equal(PASSWORD_MANAGER_CONFIRMATION, 'reveal_password_once');
});
