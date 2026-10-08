import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TOOLS } from '../src/tools.js';
import { createAgentPolicy, requiredScope, SCOPES } from '../src/policy.js';
import { LEASE_TOOLS, WRITE_TOOLS } from '../src/leases.js';

const tmp = () => mkdtempSync(join(tmpdir(), 'aib-policy-'));
const byName = new Map(TOOLS.map(tool => [tool.name, tool]));
const policy = (options = {}) => createAgentPolicy({ file: join(tmp(), 'agents.json'), ...options });
const evalCall = (p, name, agent, args = {}) => p.evaluate({ name, tool: byName.get(name), args, agent });

test('scope derivation agrees with the lease layer', () => {
  for (const name of LEASE_TOOLS) {
    const scope = requiredScope(name, byName.get(name));
    // browser_tab_lease is the documented recovery poll for every conflict, so
    // it stays a read; only state-changing lease tools need the lease scope.
    assert.equal(scope, name === 'browser_tab_lease' ? 'read' : 'lease', `${name} mapped to ${scope}`);
  }
  // Upload tools are lease-governed writes but need the stricter upload scope,
  // so they are asserted separately instead of as plain 'write'.
  for (const name of WRITE_TOOLS) {
    const scope = requiredScope(name, byName.get(name));
    assert.ok(scope === 'write' || scope === 'upload', `${name} should be write or upload, got ${scope}`);
  }
  assert.equal(requiredScope('browser_click', byName.get('browser_click')), 'write');
  assert.equal(requiredScope('browser_upload', byName.get('browser_upload')), 'upload');
  assert.equal(requiredScope('browser_upload_verified', byName.get('browser_upload_verified')), 'upload');
  assert.equal(requiredScope('browser_read', byName.get('browser_read')), 'read');
  for (const tool of TOOLS.filter(item => item.annotations?.readOnlyHint)) {
    assert.equal(requiredScope(tool.name, tool), 'read', `${tool.name} is read-only and must need only read`);
  }
});

test('every derived scope is a known scope', () => {
  for (const tool of TOOLS) assert.ok(SCOPES.includes(requiredScope(tool.name, tool)), `${tool.name} maps to an unknown scope`);
});

// The default must stay open: a single-user install that never registers an
// agent must not lose any capability, otherwise this layer bricks the tool.
test('an unnamed or unregistered agent is allowed by default', () => {
  const p = policy();
  assert.equal(evalCall(p, 'browser_click', null).allowed, true);
  assert.equal(evalCall(p, 'browser_click', 'nobody').allowed, true);
  assert.equal(evalCall(p, 'browser_click', 'nobody').registered, false);
  assert.equal(evalCall(p, 'browser_upload', 'nobody', { ref: 'r', filePath: 'f', sha256: 's' }).allowed, true);
});

test('a registered agent is limited to its granted scopes', () => {
  const p = policy();
  p.set('reader', { scopes: ['read'] });
  assert.equal(evalCall(p, 'browser_read', 'reader').allowed, true);
  assert.equal(evalCall(p, 'browser_observe', 'reader').allowed, true);
  // The conflict-recovery poll must survive even for a read-only agent.
  assert.equal(evalCall(p, 'browser_tab_lease', 'reader', { tabId: 1 }).allowed, true);

  const write = evalCall(p, 'browser_click', 'reader', { tabId: 1, ref: 'r' });
  assert.equal(write.allowed, false);
  assert.equal(write.status, 'denied');
  assert.equal(write.retryable, false);
  assert.equal(write.reason, 'agent_scope_denied');
  assert.equal(write.requiredScope, 'write');
  assert.deepEqual(write.grantedScopes, ['read']);

  const lease = evalCall(p, 'browser_claim_tab', 'reader', { tabId: 1 });
  assert.equal(lease.reason, 'agent_scope_denied');
  assert.equal(lease.requiredScope, 'lease');
});

test('upload requires its own scope and is not implied by write', () => {
  const p = policy();
  p.set('writer', { scopes: ['read', 'write', 'lease'] });
  assert.equal(evalCall(p, 'browser_click', 'writer', { tabId: 1, ref: 'r' }).allowed, true);
  const upload = evalCall(p, 'browser_upload', 'writer', { tabId: 1, ref: 'r', filePath: 'f', sha256: 's' });
  assert.equal(upload.allowed, false);
  assert.equal(upload.requiredScope, 'upload');

  p.set('shipper', { scopes: ['read', 'write', 'lease', 'upload'] });
  assert.equal(evalCall(p, 'browser_upload', 'shipper', { tabId: 1, ref: 'r', filePath: 'f', sha256: 's' }).allowed, true);
});

test('an origin allowlist governs navigation only', () => {
  const p = policy();
  p.set('scoped', { scopes: ['read', 'write', 'lease', 'upload'], origins: ['example.com', 'internal.dev'] });
  assert.equal(evalCall(p, 'browser_open', 'scoped', { url: 'https://example.com/a' }).allowed, true);
  assert.equal(evalCall(p, 'browser_open', 'scoped', { url: 'https://sub.internal.dev/x' }).allowed, true);
  assert.equal(evalCall(p, 'browser_navigate', 'scoped', { tabId: 1, url: 'https://example.com' }).allowed, true);

  const denied = evalCall(p, 'browser_open', 'scoped', { url: 'https://evil.test/a' });
  assert.equal(denied.allowed, false);
  assert.equal(denied.reason, 'agent_origin_denied');
  assert.equal(denied.host, 'evil.test');

  // Non-navigation tools are unaffected by the origin list.
  assert.equal(evalCall(p, 'browser_click', 'scoped', { tabId: 1, ref: 'r' }).allowed, true);
});

test('a lease ceiling is reported so the service can clamp the TTL', () => {
  const p = policy();
  p.set('quick', { scopes: ['read', 'write', 'lease'], maxLeaseMs: 5000 });
  const decision = evalCall(p, 'browser_claim_tab', 'quick', { tabId: 1, ttlMs: 120000 });
  assert.equal(decision.allowed, true);
  assert.equal(decision.maxLeaseMs, 5000);
});

test('requireIdentity refuses governed calls that name no agent, reads stay open', () => {
  const p = policy({ requireIdentity: true });
  assert.equal(evalCall(p, 'browser_read', null).allowed, true, 'reads must stay usable without an identity');
  const denied = evalCall(p, 'browser_click', null, { tabId: 1, ref: 'r' });
  assert.equal(denied.allowed, false);
  assert.equal(denied.reason, 'agent_identity_required');
  assert.equal(evalCall(p, 'browser_click', 'named', { tabId: 1, ref: 'r' }).allowed, true);
  assert.equal(evalCall(p, 'browser_claim_tab', null, { tabId: 1 }).allowed, false);
});

test('invalid scopes are dropped and defaults stay safe', () => {
  const p = policy();
  const saved = p.set('odd', { scopes: ['read', 'root', 'write'], note: 'x'.repeat(400) });
  assert.deepEqual(saved.scopes, ['read', 'write']);
  assert.ok(saved.note.length <= 200);
  assert.equal(p.set('bare', {}).scopes.length > 0, true);
  assert.equal(p.get('bare').scopes.includes('upload'), false, 'upload must be opt-in');
});

// Identity travels with the call so the audit log can attribute it. If a tool
// forgets the parameter, reads silently become unattributable again.
test('every tool accepts an optional agent identity, lease tools require it', () => {
  const leaseManaged = new Set(['browser_claim_tab', 'browser_renew_tab', 'browser_release_tab']);
  for (const tool of TOOLS) {
    assert.ok(Object.hasOwn(tool.inputSchema.properties, 'agent'), `${tool.name} cannot carry an agent identity`);
    const required = tool.inputSchema.required.includes('agent');
    assert.equal(required, leaseManaged.has(tool.name), `${tool.name} agent required=${required}`);
  }
});

// A policy that grants only write/lease is unusual but explicit: denying the
// read keeps scopes meaningful instead of silently widening them.
test('a registered agent without the read scope cannot read', () => {
  const p = policy();
  p.set('blind-writer', { scopes: ['write', 'lease'] });
  const denied = evalCall(p, 'browser_read', 'blind-writer', { tabId: 1 });
  assert.equal(denied.allowed, false);
  assert.equal(denied.reason, 'agent_scope_denied');
  assert.equal(denied.requiredScope, 'read');
  assert.equal(evalCall(p, 'browser_click', 'blind-writer', { tabId: 1, ref: 'r' }).allowed, true);
});

test('the registry persists and is readable by a fresh instance', () => {
  const dir = tmp();
  const file = join(dir, 'agents.json');
  const first = createAgentPolicy({ file });
  first.set('reader', { scopes: ['read'] });
  first.set('shipper', { scopes: ['read', 'write', 'lease', 'upload'] });

  const second = createAgentPolicy({ file });
  assert.equal(second.size(), 2);
  assert.deepEqual(second.get('reader').scopes, ['read']);
  assert.equal(second.get('shipper').scopes.includes('upload'), true);
  assert.equal([...readFileSync(file, 'utf8').matchAll(/shipper/g)].length >= 1, true);

  second.remove('reader');
  assert.equal(createAgentPolicy({ file }).size(), 1);
  assert.deepEqual(createAgentPolicy({ file }).list().map(item => item.agent), ['shipper']);
});

test('an operator edit to the file is picked up without a restart', () => {
  const file = join(tmp(), 'agents.json');
  const live = createAgentPolicy({ file });
  live.set('reader', { scopes: ['read'] });
  assert.equal(live.evaluate({ name: 'browser_click', tool: byName.get('browser_click'), args: { tabId: 1, ref: 'r' }, agent: 'reader' }).allowed, false);

  // A second process (the CLI) widens the scope on disk.
  createAgentPolicy({ file }).set('reader', { scopes: ['read', 'write'] });
  assert.equal(live.evaluate({ name: 'browser_click', tool: byName.get('browser_click'), args: { tabId: 1, ref: 'r' }, agent: 'reader' }).allowed, true);
});
