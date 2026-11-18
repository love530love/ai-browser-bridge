// The strings a caller has to echo back before a tool is allowed to change
// something it cannot observe from the DOM.
//
// They live in one file because two places need them: the tool schema advertises
// the allowed value, and the service refuses the call when the value does not
// match. If those two ever drifted, the tool would become uncallable while every
// individual test still passed - the schema would reject the only value the
// service accepts. test/confirmation-schemas.test.js pins them together.
export const STORAGE_WRITE_CONFIRMATION = 'modify_site_storage_once';
export const REPLAY_REQUEST_CONFIRMATION = 'replay_request_once';
// A recipe run performs an unbounded number of writes from one call, so the
// approval is for the run as a whole and each recorded step must not carry its
// own confirmation (src/recipes.js refuses a step that does).
export const RECIPE_RUN_CONFIRMATION = 'run_recipe_once';

// Browser-wide authority (extension/browser-authority.js). These tools change
// state that is not inside any document - the bookmark tree, the history
// database, saved cookies, which extensions are enabled, the browser's own
// settings, the window frame. There is no page to re-observe afterwards that
// would tell a caller "the thing you changed is now different", so each write
// carries its own attestation instead of borrowing the storage one.
export const BOOKMARKS_WRITE_CONFIRMATION = 'modify_bookmarks_once';
export const HISTORY_DELETE_CONFIRMATION = 'modify_history_once';
export const DOWNLOADS_CONTROL_CONFIRMATION = 'modify_downloads_once';
export const EXTENSION_STATE_CONFIRMATION = 'modify_extension_state_once';
export const COOKIES_WRITE_CONFIRMATION = 'modify_cookies_once';
export const BROWSING_DATA_CONFIRMATION = 'modify_browsing_data_once';
export const SITE_SETTINGS_WRITE_CONFIRMATION = 'modify_site_setting_once';
export const PRIVACY_SETTING_WRITE_CONFIRMATION = 'modify_privacy_setting_once';
export const WINDOW_CONTROL_CONFIRMATION = 'modify_window_once';
export const PROXY_CONFIRMATION = 'modify_proxy_once';

// The clipboard is the one place where "modify" means "destroy something the
// user cannot see". Replacing what a person copied loses work that was never on
// screen, so a write gets its own attestation. Reading is not gated: it changes
// nothing, and the reply marks the payload as secret instead.
export const CLIPBOARD_WRITE_CONFIRMATION = 'modify_clipboard_once';

// The native host is the only channel that leaves the browser sandbox. Every
// message on it is a program invocation, so the whole tool is gated rather than
// trying to classify individual messages: a generic transport cannot tell a
// harmless ping from a state-changing command, and pretending otherwise would
// make the gate decorative.
export const NATIVE_MESSAGING_CONFIRMATION = 'run_native_host_once';

// Registering a host writes a registry key that Chrome reads at launch, so it is
// a machine change rather than a browser change. It is separate from the send
// gate above because registering a host and using one are different decisions:
// a caller may be allowed to talk to a host an administrator installed without
// being allowed to install one.
export const NATIVE_HOST_CONFIRMATION = 'modify_native_host_once';

// Certificates live in the operating system store, outside the browser, and a
// root that gets added or removed changes what every application on the machine
// trusts. Reads (stores, list, inspect) are not gated; the two writes are.
export const CERTIFICATE_WRITE_CONFIRMATION = 'modify_certificates_once';

// A virtual authenticator is a test double for a security key. Adding one
// changes what a relying party sees in this tab, and exporting its private key
// exports live key material, so those actions are gated. Creating/removing the
// authenticator or reading credential metadata without the private key is not:
// it changes only the test environment and reveals no secret.
export const WEBAUTHN_WRITE_CONFIRMATION = 'modify_webauthn_once';

// Installing or uninstalling a PWA changes what is installed on the machine,
// and the browser may show its own confirmation. Reads (inspect, list) are not
// gated. The install itself is bound to the existing tab's prompt; this string
// attests that the caller asked for a real installation.
export const PWA_WRITE_CONFIRMATION = 'modify_pwa_once';

// Loading an unpacked extension gives a folder of code the extension APIs of
// this browser profile. That is a program installation, not a page change, so
// it gets its own attestation. Uninstalling stays under EXTENSION_STATE.
export const EXTENSION_INSTALL_CONFIRMATION = 'modify_extension_install_once';

// Request headers can contain Authorization, Cookie and CSRF tokens. The
// capture is bounded to one tab and never persisted, but the reply is still a
// secret, so the caller has to ask for it explicitly.
export const REQUEST_HEADERS_CONFIRMATION = 'reveal_request_headers_once';
