// The extension's Errors panel is the first place a person looks when the
// bridge seems broken, so what lands there has to mean something. Two things
// were filling it with noise that had nothing to do with a defect.
//
// 1. A WebSocket constructor that fails writes a console error the worker
//    cannot catch. Every reconnect against a stopped service left one more
//    ERR_CONNECTION_REFUSED, so restarting the service a few times painted a
//    wall of red that reads as "the extension is broken" when the only fact was
//    that a process was not running.
// 2. Injecting into every frame of an unscriptable tab fails with Chrome's
//    opaque "An unknown error occurred when fetching the script.", which says
//    nothing about the page being chrome://.
//
// Both are fixed by asking a different question first. These assertions are
// static reads of the source on purpose: the failures happen in extension code
// that no unit test loads, and the CSP line that makes the probe possible is one
// line away from the code that depends on it.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const workerSource = readFileSync(new URL('../extension/worker.js', import.meta.url), 'utf8');
const manifest = JSON.parse(readFileSync(new URL('../extension/manifest.json', import.meta.url), 'utf8'));

test('the CSP allows the HTTP probe the connect path depends on', () => {
  const csp = manifest.content_security_policy?.extension_pages ?? '';
  assert.match(csp, /connect-src[^;]*ws:\/\/127\.0\.0\.1:\*/,
    'the WebSocket origin must stay allowed');
  assert.match(csp, /connect-src[^;]*http:\/\/127\.0\.0\.1:\*/,
    'without http://127.0.0.1:* the port probe is blocked by CSP, serviceListening always answers false, and the extension can never connect - the failure would look like a wrong pairing key');
});

test('the port is probed before a WebSocket is constructed', () => {
  const connectBody = workerSource.slice(workerSource.indexOf('async function connect('));
  const probeAt = connectBody.indexOf('await serviceListening(config.port)');
  const socketAt = connectBody.indexOf('new WebSocket(');
  assert.ok(probeAt > 0, 'connect must probe the port');
  assert.ok(socketAt > 0, 'connect must still open the socket');
  assert.ok(probeAt < socketAt, 'the probe has to run first, or the failing constructor still writes the console error this exists to avoid');
  // The probe result must short-circuit: a probe that is awaited but ignored
  // would be pure latency.
  const between = connectBody.slice(probeAt, socketAt);
  assert.match(between, /return;/, 'a closed port must return before the socket is built');
  assert.match(between, /scheduleReconnect/, 'a closed port must schedule the next attempt instead of giving up');
});

test('the probe treats any HTTP answer as listening', () => {
  const start = workerSource.indexOf('async function serviceListening');
  assert.ok(start > 0, 'serviceListening must exist');
  const body = workerSource.slice(start, workerSource.indexOf('\nasync function connect(', start));
  assert.match(body, /await fetch\(/, 'the probe must actually make a request');
  assert.match(body, /catch\s*\{[\s\S]*?return false/, 'a refused fetch is the only "not listening" signal');
  assert.match(body, /AbortController/, 'a probe against a hung port must not stall the connect loop');
  // The service rejects a browser Origin with 403 and needs a bearer token, so
  // the expected reply is a rejection. Reading a status code here would turn
  // every healthy service into "not running".
  assert.doesNotMatch(body, /response\.ok|\.status\s*===\s*200/,
    'a 401/403 still proves a socket accepted the connection; checking for 200 would report a running service as down');
});

test('every allFrames injection goes through injectAllFrames', () => {
  assert.ok(workerSource.includes('async function injectAllFrames('), 'the helper must exist');
  // The helper itself is the one place allowed to name allFrames directly.
  const helperStart = workerSource.indexOf('async function injectAllFrames(');
  const helperEnd = workerSource.indexOf('\nasync function connect(', helperStart);
  const outside = workerSource.slice(0, helperStart) + workerSource.slice(helperEnd);
  const bare = outside.match(/allFrames:\s*true/g) ?? [];
  assert.equal(bare.length, 0,
    'a bare allFrames injection answers Chrome\'s opaque "An unknown error occurred when fetching the script." for chrome:// tabs and tells the caller nothing; route it through injectAllFrames so the reason is named');
});

test('an unscriptable page is reported as a reason, not thrown', () => {
  const start = workerSource.indexOf('async function injectAllFrames(');
  const body = workerSource.slice(start, workerSource.indexOf('\nasync function connect(', start));
  for (const field of ['status', 'reason', 'message', 'recommendedNextAction']) {
    assert.match(body, new RegExp(`${field}:`), `the blocked result must carry ${field}`);
  }
  assert.match(body, /page_not_scriptable/, 'an unscriptable page must be distinguishable from a partial failure');
  assert.match(body, /frames_not_injectable/, 'a partial failure needs its own reason');
  assert.match(body, /chrome:\\\/\\\/|chrome:\/\//, 'the classifier must recognise internal pages');
  assert.match(body, /retryable:\s*false/,
    'a tab that cannot be scripted does not become scriptable by asking again');
});

test('the three frame callers surface the blocked result instead of mapping it', () => {
  // browser_frames, browser_read frame:"all" and browser_find_text all used to
  // call frames.map(...) unconditionally, which would throw on the null frames a
  // blocked injection returns.
  const callers = ['browser_frames', 'browser_read', 'browser_find_text'];
  for (const caller of callers) {
    assert.ok(workerSource.includes(`name === '${caller}'`), `${caller} must still be dispatched`);
  }
  const blockedChecks = workerSource.match(/if \((?:injection\.)?blocked\)/g) ?? [];
  assert.ok(blockedChecks.length >= 3,
    `each frame caller must branch on the blocked result before using frames (found ${blockedChecks.length})`);
});
