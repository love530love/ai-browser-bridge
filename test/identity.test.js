// Identity has two halves with opposite availability, and the whole value of the
// tool is that it does not blur them: getAuthToken needs a manifest block this
// build deliberately does not ship, while launchWebAuthFlow needs nothing and
// works today. These tests pin that a missing oauth2 block is a structured
// refusal with instructions rather than a retry loop, and that the redirect is
// always bound to this extension's own origin.
import { test } from 'node:test';
import assert from 'node:assert/strict';

async function load({ oauth2 = null, redirect = 'https://abcdefghijklmnopabcdefghijklmnop.chromiumapp.org/', behaviour = {} } = {}) {
  const launched = [];
  const chrome = {
    identity: {
      getRedirectURL: path => `${redirect}${path ?? ''}`,
      async getAuthToken(options) { launched.push({ kind: 'getAuthToken', options }); if (behaviour.token) return behaviour.token(options); return { token: 'ya29.default', grantedScopes: ['scope.a'] }; },
      async launchWebAuthFlow(options) { launched.push({ kind: 'launchWebAuthFlow', options }); return behaviour.launch(options); },
      async getProfileUserInfo() { return behaviour.profile ?? { email: '', id: '' }; },
      async removeCachedAuthToken(options) { launched.push({ kind: 'removeCachedAuthToken', options }); return undefined; }
    }
  };
  globalThis.chrome = chrome;
  const { createIdentity } = await import(`../extension/identity.js?t=${Math.random()}`);
  return { tools: createIdentity({ manifest: oauth2 ? { oauth2 } : {} }), launched, chrome };
}

test('getAuthToken without an oauth2 block is refused with the exact block to add', async () => {
  const { tools, launched } = await load();
  const result = await tools.run('browser_identity', { action: 'token' });
  assert.equal(result.status, 'denied');
  assert.equal(result.reason, 'oauth2_not_configured');
  assert.equal(result.howToConfigure.manifestField, 'oauth2');
  assert.ok(result.howToConfigure.shape.client_id);
  assert.equal(launched.length, 0, 'nothing must be dispatched when the manifest cannot support it');
});

test('getAuthToken works once an oauth2 block exists and marks the token secret', async () => {
  const { tools } = await load({ oauth2: { client_id: 'abc.apps.googleusercontent.com', scopes: ['scope.a'] } });
  const result = await tools.run('browser_identity', { action: 'token' });
  assert.equal(result.status, 'success');
  assert.equal(result.token, 'ya29.default');
  assert.equal(result.secrets, true);
  assert.match(result.note, /secret/);
});

test('an old-style string token is accepted as well as the object form', async () => {
  const { tools } = await load({ oauth2: { client_id: 'abc.apps.googleusercontent.com' }, behaviour: { token: () => 'plain-string-token' } });
  const result = await tools.run('browser_identity', { action: 'token' });
  assert.equal(result.status, 'success');
  assert.equal(result.token, 'plain-string-token');
});

test('a refused grant is retryable and says which refusal it was', async () => {
  const { tools } = await load({ oauth2: { client_id: 'abc.apps.googleusercontent.com' }, behaviour: { token: () => { throw new Error('OAuth2 not granted or revoked.'); } } });
  const result = await tools.run('browser_identity', { action: 'token' });
  assert.equal(result.status, 'denied');
  assert.equal(result.reason, 'oauth2_not_granted');
  assert.equal(result.retryable, true);
});

test('launch injects this extension\'s redirect_uri so a code cannot land elsewhere', async () => {
  const { tools, launched } = await load({ behaviour: { launch: () => 'https://abcdefghijklmnopabcdefghijklmnop.chromiumapp.org/?code=abc123&state=xyz' } });
  const result = await tools.run('browser_identity', { action: 'launch', authorizeUrl: 'https://provider.test/authorize?client_id=c&response_type=code' });
  assert.equal(result.status, 'success');
  assert.equal(result.code, 'abc123');
  assert.equal(result.state, 'xyz');
  assert.equal(result.secrets, true);
  const sent = new URL(launched[0].options.url);
  assert.equal(sent.searchParams.get('redirect_uri'), 'https://abcdefghijklmnopabcdefghijklmnop.chromiumapp.org/');
  assert.equal(sent.searchParams.get('client_id'), 'c', 'the caller\'s own parameters must survive');
});

test('an explicit redirect_uri from the caller is left alone', async () => {
  const { tools, launched } = await load({ behaviour: { launch: () => 'https://abcdefghijklmnopabcdefghijklmnop.chromiumapp.org/?code=abc' } });
  await tools.run('browser_identity', { action: 'launch', authorizeUrl: 'https://provider.test/authorize?redirect_uri=https%3A%2F%2Fx.test%2Fcb' });
  const sent = new URL(launched[0].options.url);
  assert.equal(sent.searchParams.get('redirect_uri'), 'https://x.test/cb');
});

test('a code delivered in the fragment is read too', async () => {
  const { tools } = await load({ behaviour: { launch: () => 'https://abcdefghijklmnopabcdefghijklmnop.chromiumapp.org/#access_token=at-1&token_type=Bearer' } });
  const result = await tools.run('browser_identity', { action: 'launch', authorizeUrl: 'https://provider.test/authorize' });
  assert.equal(result.accessToken, 'at-1');
  assert.equal(result.tokenType, 'Bearer');
});

test('an insecure or credentialed authorize URL is refused before anything opens', async () => {
  const { tools, launched } = await load({ behaviour: { launch: () => '' } });
  assert.equal((await tools.run('browser_identity', { action: 'launch', authorizeUrl: 'http://provider.test/authorize' })).reason, 'https_url_required');
  assert.equal((await tools.run('browser_identity', { action: 'launch', authorizeUrl: 'https://user:pw@provider.test/authorize' })).reason, 'credentials_in_url');
  assert.equal(launched.length, 0);
});

test('a cancelled window is denied, not failed, because nothing was granted', async () => {
  const { tools } = await load({ behaviour: { launch: () => { throw new Error('The user did not approve access.'); } } });
  const result = await tools.run('browser_identity', { action: 'launch', authorizeUrl: 'https://provider.test/authorize' });
  assert.equal(result.status, 'denied');
  assert.equal(result.reason, 'auth_flow_cancelled');
});

test('a provider error in the redirect is reported in the provider\'s own words', async () => {
  const { tools } = await load({ behaviour: { launch: () => 'https://abcdefghijklmnopabcdefghijklmnop.chromiumapp.org/?error=access_denied&error_description=User+refused' } });
  const result = await tools.run('browser_identity', { action: 'launch', authorizeUrl: 'https://provider.test/authorize' });
  assert.equal(result.status, 'denied');
  assert.equal(result.reason, 'provider_returned_error');
  assert.equal(result.error, 'access_denied');
  assert.equal(result.errorDescription, 'User refused');
});

test('a redirect with no credential is uncertain rather than success', async () => {
  const { tools } = await load({ behaviour: { launch: () => 'https://abcdefghijklmnopabcdefghijklmnop.chromiumapp.org/?state=only' } });
  const result = await tools.run('browser_identity', { action: 'launch', authorizeUrl: 'https://provider.test/authorize' });
  assert.equal(result.status, 'uncertain');
  assert.equal(result.reason, 'redirect_without_credential');
});

test('a flow that never returns is uncertain and warns against a second window', async () => {
  const { tools } = await load({ behaviour: { launch: () => new Promise(() => {}) } });
  const result = await tools.run('browser_identity', { action: 'launch', authorizeUrl: 'https://provider.test/authorize', timeoutMs: 5000 });
  assert.equal(result.status, 'uncertain');
  assert.equal(result.reason, 'auth_flow_no_result');
  assert.match(result.message, /Do not start a second flow/);
});

test('an empty profile is reported as unavailable rather than as a sign-out', async () => {
  const { tools } = await load({ behaviour: { profile: { email: '', id: '' } } });
  const result = await tools.run('browser_identity', { action: 'profile' });
  assert.equal(result.status, 'success');
  assert.equal(result.available, false);
  assert.match(result.note, /identity\.email/);
});

test('remove_token needs the token and says it does not revoke at the provider', async () => {
  const { tools, launched } = await load();
  assert.equal((await tools.run('browser_identity', { action: 'remove_token' })).reason, 'token_required');
  const result = await tools.run('browser_identity', { action: 'remove_token', token: 'ya29.default' });
  assert.equal(result.status, 'success');
  assert.match(result.note, /not revoked/);
  assert.equal(launched[0].options.token, 'ya29.default');
});
