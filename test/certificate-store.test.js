// Certificate management is the one capability the project used to list as not
// implemented, so what matters here is not "does the store list certificates"
// but the honesty of the envelope: reads are ungated, writes need their own
// attestation, success means the store was read back, and a Windows consent
// dialog is reported as waiting for the user rather than as a failure or, worse,
// as success.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runCertificateStore, CERTIFICATE_STORES } from '../src/certificate-store.js';
import { CERTIFICATE_WRITE_CONFIRMATION } from '../src/confirmations.js';

const ok = payload => ({ stdout: `warning: something\n${JSON.stringify(payload)}\n`, stderr: '', code: 0 });

function runnerReturning(result, record = []) {
  return async (args, timeoutMs) => { record.push({ args, timeoutMs }); return result; };
}

test('reads are ungated and pass the store result through', async () => {
  const record = [];
  const result = await runCertificateStore({ action: 'list', store: 'Root' }, {
    runner: runnerReturning(ok({ status: 'success', action: 'list', total: 3, returned: 3, certificates: [{ thumbprint: 'AB' }] }), record)
  });
  assert.equal(result.status, 'success');
  assert.equal(result.total, 3);
  assert.equal(result.certificates.length, 1);
  assert.equal(result.method, 'windows_certificate_store');
  assert.equal(result.appliesTo.includes('every application'), true);
  assert.ok(record[0].args.includes('-Action'));
  assert.ok(record[0].args.includes('list'));
});

test('an import without the confirmation string never reaches the store', async () => {
  const record = [];
  const result = await runCertificateStore({ action: 'import', path: 'C:\\certs\\ca.cer' }, {
    runner: runnerReturning(ok({ status: 'success' }), record)
  });
  assert.equal(result.status, 'denied');
  assert.equal(result.reason, 'confirmation_required');
  assert.equal(result.dispatched, false);
  assert.equal(record.length, 0);
});

test('a confirmed import is verified by the store read-back the script performs', async () => {
  const result = await runCertificateStore({ action: 'import', path: 'C:\\certs\\ca.cer', confirmation: CERTIFICATE_WRITE_CONFIRMATION }, {
    runner: runnerReturning(ok({ status: 'success', action: 'import', thumbprint: 'ABC123', verified: true }))
  });
  assert.equal(result.status, 'success');
  assert.equal(result.verified, true);
  assert.equal(result.dispatched, true);
});

test('a consent dialog that does not finish is waiting for the user, not a failure', async () => {
  const result = await runCertificateStore({ action: 'import', path: 'C:\\certs\\ca.cer', confirmation: CERTIFICATE_WRITE_CONFIRMATION }, {
    runner: runnerReturning({ stdout: '', stderr: '', code: null, timedOut: true })
  });
  assert.equal(result.status, 'waiting_for_user_auth');
  assert.equal(result.reason, 'windows_consent_dialog_open');
  assert.equal(result.retryable, true);
  assert.match(result.message, /do not repeat the import/);
});

test('a read that times out is uncertain and asks for one retry, not for a user', async () => {
  const result = await runCertificateStore({ action: 'list' }, { runner: runnerReturning({ stdout: '', stderr: '', code: null, timedOut: true }) });
  assert.equal(result.status, 'uncertain');
  assert.equal(result.reason, 'certificate_read_timeout');
});

test('unparseable output is reported with the interpreter requirement', async () => {
  const result = await runCertificateStore({ action: 'list' }, { runner: runnerReturning({ stdout: 'not json at all', stderr: 'pwsh: not found', code: 1 }) });
  assert.equal(result.status, 'failed');
  assert.equal(result.reason, 'certificate_store_unreadable');
  assert.match(result.message, /pwsh/);
});

test('the last JSON line wins, so progress text above it is harmless', async () => {
  const stdout = '{"status":"partial"}\nreading...\n{"status":"success","total":9}\n';
  const result = await runCertificateStore({ action: 'list' }, { runner: runnerReturning({ stdout, stderr: '', code: 0 }) });
  assert.equal(result.status, 'success');
  assert.equal(result.total, 9);
});

test('an unknown store, action or thumbprint is refused before the script runs', async () => {
  const record = [];
  const runner = runnerReturning(ok({ status: 'success' }), record);
  assert.equal((await runCertificateStore({ action: 'list', store: 'Nope' }, { runner })).reason, 'unknown_store');
  assert.equal((await runCertificateStore({ action: 'rotate' }, { runner })).reason, 'unknown_action');
  assert.equal((await runCertificateStore({ action: 'inspect' }, { runner })).reason, 'thumbprint_required');
  assert.equal((await runCertificateStore({ action: 'remove', confirmation: CERTIFICATE_WRITE_CONFIRMATION }, { runner })).reason, 'thumbprint_required');
  assert.equal(record.length, 0);
});

test('a thumbprint is normalised, so colons and spaces are accepted', async () => {
  const record = [];
  await runCertificateStore({ action: 'inspect', thumbprint: 'ab:cd:ef:01' }, { runner: runnerReturning(ok({ status: 'success' }), record) });
  const at = record[0].args.indexOf('-Thumbprint');
  assert.equal(record[0].args[at + 1], 'ABCDEF01');
});

test('the store list is the one Windows actually exposes', () => {
  assert.deepEqual(CERTIFICATE_STORES, ['Root', 'CA', 'My', 'TrustedPeople', 'TrustedPublisher', 'Disallowed', 'AuthRoot']);
});

test('a machine scope is passed through as LocalMachine and a bare machine string is understood', async () => {
  const record = [];
  await runCertificateStore({ action: 'list', scope: 'LocalMachine' }, { runner: runnerReturning(ok({ status: 'success' }), record) });
  assert.equal(record[0].args[record[0].args.indexOf('-Scope') + 1], 'LocalMachine');
  await runCertificateStore({ action: 'list', scope: 'machine' }, { runner: runnerReturning(ok({ status: 'success' }), record) });
  assert.equal(record[1].args[record[1].args.indexOf('-Scope') + 1], 'LocalMachine');
});
