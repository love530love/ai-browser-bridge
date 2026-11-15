import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { evaluateGates, runGateCheck, EVIDENCE_SCHEMA, CONFIRMATION } from '../poc/playwright-fallback/gate-check.mjs';

const unavailable = { reachable: false, state: 'service_down', error: 'connect ECONNREFUSED 127.0.0.1:19387' };
const evidence = {
  schema: EVIDENCE_SCHEMA,
  capturedAt: '2026-11-15T00:00:00Z',
  service: { reachable: false },
  attempts: [{ tool: 'browser_health', reason: 'service down' }]
};
const allowedInput = {
  live: unavailable,
  evidence,
  authorizationScope: 'playwright temporary profile against a local fixture only',
  confirmation: CONFIRMATION
};

test('a healthy bridge denies the fallback even with complete evidence', () => {
  const gate = evaluateGates({ ...allowedInput, live: { reachable: true, httpStatus: 200 } });
  assert.equal(gate.allowed, false);
  assert.equal(gate.reason, 'bridge_reachable');
  assert.equal(gate.defaultProfileTouched, false);
  assert.equal(gate.playwrightStarted, false);
});

test('an unknown bridge state is not treated as unavailable', () => {
  assert.equal(evaluateGates({ ...allowedInput, live: {} }).reason, 'bridge_state_unknown');
});

test('evidence is required and must show an unreachable service with an attempt', () => {
  assert.equal(evaluateGates({ ...allowedInput, evidence: null }).reason, 'missing_bridge_unavailable_evidence');
  assert.equal(evaluateGates({ ...allowedInput, evidence: { ...evidence, schema: 'other' } }).reason, 'bridge_unavailable_evidence_schema_mismatch');
  assert.equal(evaluateGates({ ...allowedInput, evidence: { ...evidence, service: { reachable: true } } }).reason, 'evidence_does_not_show_bridge_unavailable');
  assert.equal(evaluateGates({ ...allowedInput, evidence: { ...evidence, attempts: [] } }).reason, 'evidence_has_no_failed_attempts');
  assert.equal(evaluateGates({ ...allowedInput, evidenceError: 'ENOENT' }).reason, 'bridge_unavailable_evidence_unreadable');
});

test('an empty, forbidden or unconfirmed scope is refused', () => {
  assert.equal(evaluateGates({ ...allowedInput, authorizationScope: '  ' }).reason, 'missing_authorization_scope');
  assert.equal(evaluateGates({ ...allowedInput, authorizationScope: 'use the default profile login state' }).reason, 'unsupported_scope');
  assert.equal(evaluateGates({ ...allowedInput, confirmation: 'yes' }).reason, 'confirmation_mismatch');
});

test('only all gates together allow the temporary-profile fixture', () => {
  const gate = evaluateGates(allowedInput);
  assert.equal(gate.allowed, true);
  assert.equal(gate.gate0, 'met');
  assert.equal(gate.launchScope, 'temporary_profile_local_fixture_only');
  assert.equal(gate.defaultProfileTouched, false);
  assert.equal(gate.confirmationAttestation, true);
});

test('runGateCheck re-probes the live bridge instead of trusting the evidence file', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'bridge-pw-gate-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, 'evidence.json');
  writeFileSync(file, JSON.stringify(evidence));

  const healthy = await runGateCheck({
    evidencePath: file,
    authorizationScope: allowedInput.authorizationScope,
    confirmation: CONFIRMATION,
    probeLive: async () => ({ reachable: true, httpStatus: 200 })
  });
  assert.equal(healthy.allowed, false);
  assert.equal(healthy.reason, 'bridge_reachable');

  const down = await runGateCheck({
    evidencePath: file,
    authorizationScope: allowedInput.authorizationScope,
    confirmation: CONFIRMATION,
    probeLive: async () => unavailable
  });
  assert.equal(down.allowed, true);
});
