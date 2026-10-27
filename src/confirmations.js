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
