// A service that has never started used to leave the panel saying
// "连接已断开，后台自动重连中" - the opposite of the truth, because there is no
// process for the reconnect to ever reach. The fix keeps automaticReconnect but
// chooses the wording from hasEverConnected, a flag persisted in
// chrome.storage.session so a Service Worker wake cannot misreport a working
// install as "never connected".
//
// The extension worker is an ES module full of chrome.* globals, so loading it
// wholesale in node:test is not an option. These assertions combine:
//   * runtime checks of the real, extracted worker helpers running in a vm with
//     chrome stubs - including the exact text that panel.js renders into #status;
//   * static reads that tie those helpers to the real call sites (onclose,
//     ready, connect) and confirm the 4002/4003/4004 wording is untouched.
import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';

const workerSource = readFileSync(new URL('../extension/worker.js', import.meta.url), 'utf8');
const panelJs = readFileSync(new URL('../extension/panel.js', import.meta.url), 'utf8');
const panelHtml = readFileSync(new URL('../extension/panel.html', import.meta.url), 'utf8');

// Pull one top-level function declaration out of a source file. The parameter
// list is located by paren matching first, so a destructured default such as
// disconnect(message, { ... } = {}) does not get mistaken for the body brace.
function extractFunction(source, name) {
  const asyncDecl = `async function ${name}(`;
  const decl = source.includes(asyncDecl) ? asyncDecl : `function ${name}(`;
  const start = source.indexOf(decl);
  assert.ok(start >= 0, `must declare ${decl}`);
  const paramsOpen = source.indexOf('(', start);
  let paren = 0;
  let closeParen = -1;
  for (let i = paramsOpen; i < source.length; i++) {
    if (source[i] === '(') paren++;
    else if (source[i] === ')' && --paren === 0) { closeParen = i; break; }
  }
  assert.ok(closeParen > 0, `${name} parameter list must close`);
  const open = source.indexOf('{', closeParen);
  assert.ok(open > 0, `${name} must have a body`);
  let depth = 0;
  let quote = null;
  for (let i = open; i < source.length; i++) {
    const ch = source[i];
    if (quote) {
      if (ch === '\\') { i++; continue; }
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') { quote = ch; continue; }
    if (ch === '{') depth++;
    else if (ch === '}' && --depth === 0) return source.slice(start, i + 1);
  }
  throw new Error(`could not find the end of ${name}`);
}

function extractOnClose(source) {
  const start = source.indexOf('ws.onclose = event => {');
  assert.ok(start >= 0, 'ws.onclose must exist');
  const open = source.indexOf('{', start);
  let depth = 0;
  for (let i = open; i < source.length; i++) {
    if (source[i] === '{') depth++;
    else if (source[i] === '}' && --depth === 0) return source.slice(start, i + 1);
  }
  throw new Error('could not find the end of ws.onclose');
}

const WORKER_HELPERS = [
  'restoreHasEverConnected',
  'markEverConnected',
  'disconnectHintFor',
  'notifyStatus',
  'disconnect'
].map(name => extractFunction(workerSource, name)).join('\n');

// Run the real worker helpers in a vm with chrome stubs. disconnect() calls
// notifyStatus(), which sends the connection-status message the panel renders;
// capturing that payload is what lets the test assert on rendered text rather
// than on an in-memory flag.
function buildHarness({ storedEverConnected, sessionGetThrows = false } = {}) {
  const sent = [];
  const sessionReads = [];
  const sessionWrites = [];
  const reconnectCalls = [];
  const chrome = {
    runtime: {
      sendMessage: message => { sent.push(message); return Promise.resolve(); }
    },
    storage: {
      session: {
        get: key => {
          sessionReads.push(key);
          if (sessionGetThrows) return Promise.reject(new Error('session read failed'));
          return Promise.resolve(storedEverConnected === undefined ? {} : { hasEverConnected: storedEverConnected });
        },
        set: value => { sessionWrites.push(value); return Promise.resolve(); }
      },
      local: {
        get: () => Promise.resolve({}),
        set: () => Promise.resolve(),
        setAccessLevel: () => Promise.resolve()
      }
    },
    alarms: { clear: () => Promise.resolve(), create: () => {} }
  };
  const context = vm.createContext({
    chrome,
    setTimeout: () => 0,
    clearTimeout: () => {},
    setInterval: () => 0,
    clearInterval: () => {},
    connectionState: '未连接',
    lastAction: '',
    connectionEpoch: 0,
    socket: null,
    keepalive: null,
    connectDeadline: null,
    reconnectTimer: null,
    uiRequests: new Map(),
    reconnectAlarm: 'aib-reconnect',
    applyBadge: () => {},
    maybeNotify: () => {},
    reportExtensionError: () => {},
    clearReconnect: () => {},
    scheduleReconnect: delayMs => { reconnectCalls.push(delayMs); },
    hasEverConnected: false
  });
  vm.runInContext(WORKER_HELPERS, context);
  return {
    context,
    statusMessage: () => sent.find(message => message.type === 'connection-status'),
    sessionReads,
    sessionWrites,
    reconnectCalls
  };
}

// Re-run the real panel.js showStatus() against the captured message and return
// the exact string a user sees in #status. This is the "rendered user-facing
// text" the assertions below check, not connectionState held in memory.
const showStatusSource = extractFunction(panelJs, 'showStatus');
function renderedStatus(message) {
  const elements = { status: { textContent: '' }, activity: { textContent: '' } };
  const context = vm.createContext({ $: id => elements[id] ?? { textContent: '' } });
  vm.runInContext(showStatusSource, context);
  context.showStatus(message);
  return elements.status.textContent;
}

// Mirror the onclose default branch: disconnect() is fed the hint chosen by the
// pure helper, with automaticReconnect still true.
function fireDefaultClose(harness, everConnected) {
  harness.context.disconnect(harness.context.disconnectHintFor(everConnected), { automaticReconnect: true });
}

const NEVER_CONNECTED_HINT = '未连上本机服务：请双击 start.bat；已启动请运行 doctor-lite.bat';
const EVER_CONNECTED_HINT = '连接已断开，后台自动重连中';

test('the pure wording helper returns the actionable hint only when never connected', () => {
  const { context } = buildHarness();
  assert.equal(context.disconnectHintFor(false), NEVER_CONNECTED_HINT);
  assert.equal(context.disconnectHintFor(true), EVER_CONNECTED_HINT);
});

test('never connected: rendered #status text names start.bat and doctor-lite.bat, not a false reconnect promise', () => {
  const harness = buildHarness({ storedEverConnected: false });
  fireDefaultClose(harness, false);
  const message = harness.statusMessage();
  assert.ok(message, 'notifyStatus must emit a connection-status message');
  const rendered = renderedStatus(message);
  // Hard rule: assert the value of the rendered, user-facing text field.
  assert.match(rendered, /start\.bat/, 'the rendered text must tell the user to start the service');
  assert.match(rendered, /doctor-lite\.bat/, 'the rendered text must name the zero-pwsh diagnostic entry');
  assert.doesNotMatch(rendered, /后台自动重连中/, 'never connected must not claim a background reconnect is underway');
  assert.equal(rendered, NEVER_CONNECTED_HINT, 'the rendered text must equal the chosen hint');
  // automaticReconnect must survive the wording change: assert it separately.
  assert.equal(harness.reconnectCalls.length, 1, 'automaticReconnect: true must still schedule a reconnect');
});

test('ever connected: rendered #status text keeps the original disconnect wording', () => {
  const harness = buildHarness({ storedEverConnected: true });
  fireDefaultClose(harness, true);
  const rendered = renderedStatus(harness.statusMessage());
  assert.equal(rendered, EVER_CONNECTED_HINT);
  assert.equal(harness.reconnectCalls.length, 1);
});

test('onclose default branch is wired to the helper and keeps automaticReconnect: true', () => {
  const onClose = extractOnClose(workerSource);
  assert.match(onClose, /disconnect\(disconnectHintFor\(hasEverConnected\), \{ automaticReconnect: true \}\);/,
    'the default branch must choose wording from the persisted flag, not a literal');
  assert.match(onClose, /automaticReconnect: true/, 'the self-healing reconnect must not be disabled');
  assert.doesNotMatch(onClose, /连接已断开，后台自动重连中/,
    'the misleading literal must no longer be hard-coded in the onclose handler');
  // disconnect() must actually turn the hint into the field the panel renders.
  assert.match(extractFunction(workerSource, 'disconnect'), /connectionState = message;/);
});

test('4002 / 4003 / 4004 close-code wording is unchanged', () => {
  const onClose = extractOnClose(workerSource);
  assert.match(onClose, /if \(event\.code === 4002\) \{ disconnect\('配对密钥不匹配，请重新运行 pair\.ps1'\); return; \}/);
  assert.match(onClose, /if \(event\.code === 4003\) \{ disconnect\('本机服务仍是单宿主旧版本，请升级服务后重试', \{ automaticReconnect: true, reconnectDelayMs: 30000 \}\); return; \}/);
  assert.match(onClose, /if \(event\.code === 4004\) \{ disconnect\('同一浏览器的新连接已接管', \{ automaticReconnect: false \}\); return; \}/);
  // Other existing branches keep their wording too.
  assert.match(workerSource, /disconnect\('连接超时，后台自动重连中', \{ automaticReconnect: true \}\)/);
  assert.match(workerSource, /disconnect\('协议错误，后台自动重连中', \{ automaticReconnect: true \}\)/);
});

test('chrome.storage.session is read and written so a worker wake cannot misreport', async () => {
  // Static: the persistence calls and the init path exist.
  assert.match(workerSource, /chrome\.storage\.session\.get\('hasEverConnected'\)/);
  assert.match(workerSource, /chrome\.storage\.session\.set\(\{ hasEverConnected: true \}\)/);
  assert.match(workerSource, /const everConnectedReady = restoreHasEverConnected\(\);/);
  const connectStart = workerSource.indexOf('async function connect(');
  const connectEnd = workerSource.indexOf('chrome.alarms.onAlarm.addListener', connectStart);
  assert.match(workerSource.slice(connectStart, connectEnd), /await everConnectedReady;/,
    'connect must await the restored flag before a socket can close');
  assert.match(workerSource, /markEverConnected\(\);\s*connectionState = '已连接';/,
    'a successful ready handshake must set and persist the flag');

  // Runtime: a fresh wake starts with the flag false; restoring from a session
  // that recorded a prior handshake must bring it back to true.
  const harness = buildHarness({ storedEverConnected: true });
  assert.equal(harness.context.hasEverConnected, false, 'a wake re-evaluates the module with a fresh flag');
  await harness.context.restoreHasEverConnected();
  assert.equal(harness.context.hasEverConnected, true, 'the flag must be restored from chrome.storage.session');
  assert.ok(harness.sessionReads.includes('hasEverConnected'), 'the read must actually be issued');
  assert.equal(harness.context.disconnectHintFor(harness.context.hasEverConnected), EVER_CONNECTED_HINT,
    'after a wake the default close must not claim never-connected');

  // Runtime: the handshake write is issued with the true value.
  harness.context.markEverConnected();
  assert.equal(harness.sessionWrites.length, 1, 'markEverConnected must write to storage.session');
  assert.equal(harness.sessionWrites[0].hasEverConnected, true);
});

test('a failing session read defaults to false without breaking the connect path', async () => {
  assert.match(extractFunction(workerSource, 'restoreHasEverConnected'), /catch[\s\S]*hasEverConnected = false;/,
    'the restore must swallow read errors instead of rejecting the shared promise');
  const harness = buildHarness({ sessionGetThrows: true });
  harness.context.hasEverConnected = true;
  await assert.doesNotReject(harness.context.restoreHasEverConnected(),
    'everConnectedReady is awaited by connect, so a failed read must not reject');
  assert.equal(harness.context.hasEverConnected, false, 'a failed read defaults the flag to false');
});

test('the captured field is the text panel.js renders into #status', () => {
  // Tie the runtime capture to the real UI: notifyStatus sends connectionState
  // in a connection-status message, and showStatus writes it to #status.
  assert.match(workerSource, /sendMessage\(\{ type: 'connection-status', connectionState, lastAction \}\)/);
  assert.match(panelJs, /\$\('status'\)\.textContent = state\.connectionState;/);
  assert.match(panelHtml, /id="status"/);
  assert.match(panelJs, /message\.type === 'connection-status'\) showStatus\(message\)/,
    'the connection-status message is what the panel listens for');
});
