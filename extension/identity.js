// Chrome identity.
//
// Two very different things live behind this permission, and conflating them is
// how a caller ends up waiting for a token that will never arrive:
//
//   getAuthToken      needs an "oauth2" block in the manifest: a client_id and a
//                     scope list, both fixed at install time. This bridge ships
//                     without one, because a client_id belongs to whoever is
//                     integrating, not to the base. So the honest answer when it
//                     is missing is oauth2_not_configured plus what to add, not a
//                     retry.
//   launchWebAuthFlow needs nothing preconfigured: the caller supplies the whole
//                     authorize URL, and Chrome supplies the redirect. That makes
//                     it the route an agent can actually use today for any OAuth
//                     provider, and it is why this tool exists even though
//                     getAuthToken is unavailable.
//
// The redirect is bound to this extension's own origin
// (https://<id>.chromiumapp.org/), so the authorization code comes back to
// Chrome and never to a web server the caller controls. That is the property
// that makes this safe to expose: nothing can be redirected to a third party.
const DEFAULT_TIMEOUT_MS = 180000;
const MAX_TIMEOUT_MS = 600000;

function parseRedirect(redirectUrl) {
  let parsed;
  try { parsed = new URL(redirectUrl); } catch { return { error: 'unparseable_redirect', redirectUrl }; }
  const params = Object.fromEntries(parsed.searchParams.entries());
  const hash = parsed.hash?.startsWith('#') ? new URLSearchParams(parsed.hash.slice(1)) : new URLSearchParams();
  const merged = { ...Object.fromEntries(hash.entries()), ...params };
  const error = merged.error ?? null;
  return {
    redirectUrl,
    code: merged.code ?? null,
    accessToken: merged.access_token ?? null,
    idToken: merged.id_token ?? null,
    state: merged.state ?? null,
    tokenType: merged.token_type ?? null,
    expiresIn: merged.expires_in ?? null,
    scope: merged.scope ?? null,
    error,
    errorDescription: merged.error_description ?? null,
    params: Object.keys(merged).slice(0, 40)
  };
}

export function createIdentity({ manifest } = {}) {
  const oauth2 = manifest?.oauth2 ?? null;

  async function token(args) {
    if (typeof chrome.identity?.getAuthToken !== 'function') {
      return { status: 'unavailable', retryable: false, action: 'token', reason: 'identity_unavailable', message: 'This Chrome build exposes no chrome.identity.getAuthToken.' };
    }
    if (!oauth2?.client_id) {
      return {
        status: 'denied', retryable: false, action: 'token', reason: 'oauth2_not_configured',
        message: 'getAuthToken needs an "oauth2" block (client_id + scopes) in extension/manifest.json. This build ships without one, because the client id belongs to the integrating party. Add it and reload the extension, or use action:"launch" with a full authorize URL, which needs no manifest change.',
        howToConfigure: {
          manifestField: 'oauth2',
          shape: { client_id: '<your-oauth-client-id>.apps.googleusercontent.com', scopes: ['https://www.googleapis.com/auth/userinfo.email'] },
          reload: 'Then call browser_reload_extension so Chrome re-reads the manifest.'
        }
      };
    }
    const interactive = args.interactive !== false;
    const scopes = Array.isArray(args.scopes) && args.scopes.length
      ? args.scopes.filter(item => typeof item === 'string').slice(0, 20)
      : undefined;
    try {
      const value = await chrome.identity.getAuthToken({ interactive, ...(scopes ? { scopes } : {}) });
      // Chrome returns a plain string on older builds and { token, grantedScopes }
      // on newer ones. Both are accepted because the difference is a Chrome
      // version, not a caller decision.
      const record = typeof value === 'string' ? { token: value } : (value ?? {});
      return {
        status: 'success', retryable: false, action: 'token', interactive,
        token: record.token ?? null,
        grantedScopes: Array.isArray(record.grantedScopes) ? record.grantedScopes : (scopes ?? oauth2.scopes ?? null),
        expiresAt: null,
        secrets: true,
        note: 'The token is a bearer credential for the account signed into this Chrome profile. It is not written to disk or logged. Treat it as a secret: pass it to the site, never into a report.',
        nextStep: 'Call action:"remove_token" when finished so the cached token stops being reusable from this profile.'
      };
    } catch (error) {
      const text = String(error?.message ?? error);
      const notGranted = /not granted|revoked|invalid_client|bad client id|OAuth2/i.test(text);
      return {
        status: notGranted ? 'denied' : 'failed', retryable: notGranted, action: 'token',
        reason: notGranted ? 'oauth2_not_granted' : 'oauth2_token_failed',
        message: notGranted
          ? 'Chrome refused because the oauth2 block is not granted for this profile, the client id is not valid for this extension, or the user has not consented. With interactive:false this is expected before a first interactive grant.'
          : 'getAuthToken failed for a reason Chrome did not attribute to consent.',
        detail: text
      };
    }
  }

  async function launch(args) {
    if (typeof chrome.identity?.launchWebAuthFlow !== 'function') {
      return { status: 'unavailable', retryable: false, action: 'launch', reason: 'identity_unavailable', message: 'This Chrome build exposes no chrome.identity.launchWebAuthFlow.' };
    }
    const authorizeUrl = String(args.authorizeUrl ?? args.url ?? '');
    if (!/^https:\/\//i.test(authorizeUrl)) {
      return { status: 'denied', retryable: false, action: 'launch', reason: 'https_url_required', message: 'Pass the provider authorize URL as an https:// URL in authorizeUrl. http, chrome:// and data: are refused, because a flow that is not over TLS cannot be trusted with a code.' };
    }
    let parsed;
    try { parsed = new URL(authorizeUrl); } catch {
      return { status: 'denied', retryable: false, action: 'launch', reason: 'unparseable_url', message: 'authorizeUrl is not a parseable URL.' };
    }
    if (parsed.username || parsed.password) {
      return { status: 'denied', retryable: false, action: 'launch', reason: 'credentials_in_url', message: 'authorizeUrl must not carry a username or password.' };
    }
    // The redirect has to be this extension's own chromiumapp.org origin; Chrome
    // refuses to complete a flow whose redirect_uri is anything else, and a
    // caller that guessed wrong would otherwise see an opaque failure.
    const extensionOrigin = chrome.identity.getRedirectURL?.() ?? null;
    const redirectUri = extensionOrigin ? chrome.identity.getRedirectURL(typeof args.redirectPath === 'string' ? args.redirectPath.replace(/^\/+/, '') : '') : null;
    if (redirectUri && !parsed.searchParams.has('redirect_uri') && args.injectRedirectUri !== false) {
      parsed.searchParams.set('redirect_uri', redirectUri);
    }
    const requested = Number(args.timeoutMs);
    const timeoutMs = Number.isFinite(requested) ? Math.min(MAX_TIMEOUT_MS, Math.max(5000, Math.trunc(requested))) : DEFAULT_TIMEOUT_MS;
    const interactive = args.interactive !== false;
    const started = Date.now();
    // The guard timer is cleared whichever side wins. A flow that completes in
    // two seconds must not leave a six-minute timer holding the process open.
    let timer = null;
    const outcome = await Promise.race([
      chrome.identity.launchWebAuthFlow({ url: parsed.toString(), interactive })
        .then(redirectUrl => ({ redirectUrl }), error => ({ error: String(error?.message ?? error) })),
      new Promise(resolve => { timer = setTimeout(() => resolve({ timedOut: true }), timeoutMs); })
    ]).finally(() => clearTimeout(timer));
    if (outcome.timedOut) {
      return {
        status: 'uncertain', retryable: false, action: 'launch', dispatched: true,
        reason: 'auth_flow_no_result', timeoutMs,
        message: 'The flow was opened and did not come back within the timeout, so the outcome is unknown. The window may still be open for the user. Do not start a second flow blindly: it would open a second window and the two codes could be confused.'
      };
    }
    if (outcome.error) {
      const text = String(outcome.error);
      const cancelled = /cancel|did not approve|closed by the user|user/i.test(text);
      return {
        status: cancelled ? 'denied' : 'failed', retryable: false, action: 'launch',
        reason: cancelled ? 'auth_flow_cancelled' : 'auth_flow_failed',
        message: cancelled ? 'The user closed the sign-in window without approving. Nothing was granted.' : 'Chrome reported a failure while completing the flow.',
        detail: text, durationMs: Date.now() - started
      };
    }
    const parsedRedirect = parseRedirect(String(outcome.redirectUrl ?? ''));
    if (parsedRedirect.error) {
      return {
        status: 'denied', retryable: false, action: 'launch',
        reason: 'provider_returned_error', durationMs: Date.now() - started,
        ...parsedRedirect, secrets: true,
        note: 'The provider redirected back with an error instead of a code. The error fields are the provider\'s own words.'
      };
    }
    if (!parsedRedirect.code && !parsedRedirect.accessToken) {
      return {
        status: 'uncertain', retryable: false, action: 'launch',
        reason: 'redirect_without_credential', durationMs: Date.now() - started,
        ...parsedRedirect,
        message: 'The flow came back but the redirect carried neither code nor access_token. Check the provider\'s response_type and that the registered redirect URI matches this extension.'
      };
    }
    return {
      status: 'success', retryable: false, action: 'launch', durationMs: Date.now() - started,
      redirectUri, interactive, ...parsedRedirect,
      secrets: true,
      note: 'A code or token came back to this extension\'s own chromiumapp.org origin, never to a third party. The authorization code is single-use and short-lived; exchange it for a token yourself, because the exchange needs the client secret and this bridge never holds one.',
      nextStep: 'Exchange the code at the provider token endpoint, then navigate the tab. Do not put the code in a report or a URL that gets logged.'
    };
  }

  async function profile() {
    if (typeof chrome.identity?.getProfileUserInfo !== 'function') {
      return { status: 'unavailable', retryable: false, action: 'profile', reason: 'identity_unavailable', message: 'This Chrome build exposes no chrome.identity.getProfileUserInfo.' };
    }
    try {
      const info = await chrome.identity.getProfileUserInfo({ accountStatus: 'ANY' });
      const empty = !info?.email;
      return {
        status: 'success', retryable: false, action: 'profile',
        email: info?.email || null, id: info?.id || null,
        available: !empty,
        contentTrust: 'untrusted profile metadata',
        note: empty
          ? 'Chrome returned no email even though this build requests identity.email, so no Google account is signed into this Chrome profile (or the profile is signed out). That is a real reading, not a missing permission.'
          : 'This is the account signed into the Chrome profile, which is not proof of being signed into the site you are on.'
      };
    } catch (error) {
      return { status: 'failed', retryable: false, action: 'profile', reason: 'profile_info_failed', message: String(error?.message ?? error) };
    }
  }

  async function removeToken(args) {
    const token = String(args.token ?? '');
    if (!token) return { status: 'denied', retryable: false, action: 'remove_token', reason: 'token_required', message: 'Pass the token to drop from the cache.' };
    if (typeof chrome.identity?.removeCachedAuthToken !== 'function') {
      return { status: 'unavailable', retryable: false, action: 'remove_token', reason: 'identity_unavailable', message: 'This Chrome build exposes no chrome.identity.removeCachedAuthToken.' };
    }
    try {
      await chrome.identity.removeCachedAuthToken({ token });
      return {
        status: 'success', retryable: false, action: 'remove_token',
        note: 'The token is out of Chrome\'s cache, so this profile can no longer hand it out. It is not revoked at the provider: revoke it there as well if it may have been exposed.'
      };
    } catch (error) {
      return { status: 'failed', retryable: false, action: 'remove_token', reason: 'remove_token_failed', message: String(error?.message ?? error) };
    }
  }

  const HANDLERS = { token, launch, profile, remove_token: removeToken };

  return {
    names: new Set(['browser_identity']),
    oauth2Configured: Boolean(oauth2?.client_id),
    async run(name, args = {}) {
      if (name !== 'browser_identity') return null;
      const action = args.action ?? 'profile';
      const handler = HANDLERS[action];
      if (!handler) {
        return { status: 'denied', retryable: false, reason: 'unknown_action', tool: name, message: `Unknown action "${String(action)}"; use profile, token, launch or remove_token.` };
      }
      try {
        return await handler(args);
      } catch (error) {
        return { status: 'failed', retryable: false, reason: 'identity_failed', tool: name, message: String(error?.message ?? error) };
      }
    }
  };
}
