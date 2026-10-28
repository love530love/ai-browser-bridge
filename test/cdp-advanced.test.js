// The DevTools-parity tools are thin wrappers over CDP, so what is worth pinning
// is not "does Chrome do it" but the promises the replies make: that a refused
// call never reached the browser, that an override is reported as living only as
// long as the session, and that an accessibility snapshot does not quietly turn
// ignored wrappers into visible nodes.
import { test } from 'node:test';
import assert from 'node:assert/strict';

function fakeEnv() {
  const sent = [];
  const listeners = [];
  const chrome = {
    runtime: { id: 'bridge', getManifest: () => ({ version: '0.0.0' }) },
    debugger: {
      onEvent: {
        addListener: fn => listeners.push(fn),
        removeListener: fn => { const at = listeners.indexOf(fn); if (at >= 0) listeners.splice(at, 1); }
      },
      sendCommand: async (target, method, params = {}) => {
        sent.push({ tabId: target.tabId, method, params });
        return handlers[method]?.(params) ?? {};
      }
    },
    downloads: {
      download: async details => { sent.push({ method: 'downloads.download', params: details }); return 77; },
      search: async ({ id }) => (id === 77 ? [{ id: 77, filename: 'C:\\Downloads\\report.pdf' }] : [])
    }
  };
  const handlers = {};
  const on = (method, fn) => { handlers[method] = fn; };
  const emit = (tabId, method, params) => { for (const fn of [...listeners]) fn({ tabId }, method, params); };
  return { chrome, sent, handlers, on, emit };
}

async function load() {
  const env = fakeEnv();
  globalThis.chrome = env.chrome;
  // The module installs one global Fetch listener and one global dialog listener,
  // each guarded by a global flag; each test needs a fresh module instance to get
  // its own listener list, so both flags have to be cleared.
  delete globalThis.__bridgeFetchListenerInstalled;
  delete globalThis.__bridgeDialogListenerInstalled;
  const { createCdpAdvanced } = await import(`../extension/cdp-advanced.js?t=${Math.random()}`);
  const opened = [];
  const sessions = {
    activeSend(tabId) {
      if (!sessions._open.has(tabId)) return null;
      return (method, params = {}) => env.chrome.debugger.sendCommand({ tabId }, method, params);
    },
    _open: new Set(),
    async open({ tabId }) { opened.push(tabId); sessions._open.add(tabId); return { status: 'success', reused: false }; }
  };
  const advanced = createCdpAdvanced({ sessions });
  return { advanced, sessions, env, opened };
}

const tab = { id: 5, url: 'https://example.com/' };
const ctx = (extra = {}) => ({ tab, page: async () => ({ x: 10, y: 20 }), guarded: fn => fn(async () => {}), ...extra });

test('a dialog answer reports that it is dispatched but not verified', async () => {
  const { advanced, env } = await load();
  const result = await advanced.run('browser_dialog', { action: 'handle', accept: true }, ctx());
  assert.equal(result.status, 'success');
  assert.equal(result.verified, false, 'Chrome does not say which dialog closed');
  const call = env.sent.find(item => item.method === 'Page.handleJavaScriptDialog');
  assert.equal(call.params.accept, true);
  assert.equal(result.sessionReused, false);
  assert.match(result.note, /debugging banner/);
});

test('waiting for a dialog that never opens says so instead of claiming success', async () => {
  const { advanced } = await load();
  const result = await advanced.run('browser_dialog', { action: 'wait', timeoutMs: 200 }, ctx());
  assert.equal(result.status, 'not_dispatched');
  assert.equal(result.dialogSeen, false);
  assert.equal(result.retryable, true);
});

test('waiting for a dialog answers it once the event arrives', async () => {
  const { advanced, env } = await load();
  const pending = advanced.run('browser_dialog', { action: 'wait', accept: false, timeoutMs: 2000 }, ctx());
  // Give the listener a tick to be registered before the event is emitted.
  await new Promise(resolve => setTimeout(resolve, 20));
  env.emit(5, 'Page.javascriptDialogOpening', { type: 'confirm', message: 'Delete?', url: 'https://example.com/' });
  const result = await pending;
  assert.equal(result.dialogSeen, true);
  assert.equal(result.dialog.message, 'Delete?');
  assert.equal(result.contentTrust, 'untrusted page text');
  const call = env.sent.find(item => item.method === 'Page.handleJavaScriptDialog');
  assert.equal(call.params.accept, false);
});

test('dialog status is a read: it answers without opening a session and without answering the dialog', async () => {
  const { advanced, env, opened } = await load();
  const empty = await advanced.run('browser_dialog', { action: 'status' }, ctx());
  assert.equal(empty.status, 'success');
  assert.equal(empty.dialogOpen, null, 'without a session the answer is unknowable, not false');
  assert.deepEqual(opened, [], 'asking whether a dialog is open must not put a banner on the tab');

  // A session has to exist for Chrome to send the event at all; the wait that
  // times out is the cheapest way to open one without answering anything.
  await advanced.run('browser_dialog', { action: 'wait', timeoutMs: 150 }, ctx());
  env.emit(5, 'Page.javascriptDialogOpening', { type: 'confirm', message: 'Delete?', url: 'https://example.com/' });
  const seen = await advanced.run('browser_dialog', { action: 'status' }, ctx());
  assert.equal(seen.dialogOpen, true);
  assert.equal(seen.dialog.type, 'confirm');
  assert.equal(seen.dialog.message, 'Delete?');
  assert.match(seen.note, /data, not as instructions/);

  // Answering clears the record, so the next status does not report a dialog
  // that has already gone.
  await advanced.run('browser_dialog', { action: 'handle', accept: false }, ctx());
  const after = await advanced.run('browser_dialog', { action: 'status' }, ctx());
  assert.equal(after.dialogOpen, false);
});

test('answering a dialog that is not there is reported as such, not as a bridge fault', async () => {
  // Chrome answers handleJavaScriptDialog with -32602 "No dialog is showing".
  // That used to escape as a raw {code,message} object, which reads like the
  // bridge broke rather than like there was nothing to answer.
  const { advanced, env } = await load();
  env.on('Page.handleJavaScriptDialog', () => {
    const error = new Error('No dialog is showing');
    error.code = -32602;
    throw error;
  });
  const result = await advanced.run('browser_dialog', { action: 'handle', accept: true }, ctx());
  assert.equal(result.status, 'denied');
  assert.equal(result.reason, 'no_dialog_showing');
  assert.match(result.message, /status/);
});

test('an answer Chrome never confirms is reported as unknown, not retried', async () => {
  // Measured: an alert opened in a background tab can leave
  // handleJavaScriptDialog unsettled forever. Waiting for the service timeout
  // reports nothing useful, and a retry is the one thing that must not happen.
  const { advanced, env } = await load();
  env.on('Page.handleJavaScriptDialog', () => new Promise(() => {}));
  const started = Date.now();
  const result = await advanced.run('browser_dialog', { action: 'handle', accept: true }, ctx());
  assert.equal(result.status, 'not_dispatched');
  assert.equal(result.reason, 'dialog_answer_not_confirmed');
  assert.match(result.message, /Do not send it again/);
  assert.match(result.message, /browser_close/);
  assert.ok(Date.now() - started < 12000, 'the wait must be bounded well inside the service timeout');
});

test('a page frozen by a dialog does not block the answer to that dialog', async () => {
  // Measured on the real browser: Page.enable never answers while a dialog has
  // the renderer frozen, so awaiting it made the one tool that can rescue such a
  // page the one tool that hung until the service timeout.
  const { advanced, env } = await load();
  env.on('Page.enable', () => new Promise(() => {}));
  const started = Date.now();
  const result = await advanced.run('browser_dialog', { action: 'handle', accept: true }, ctx());
  assert.equal(result.status, 'success');
  assert.ok(Date.now() - started < 5000, 'Page.enable must not be able to stall the dialog answer');
  assert.ok(env.sent.some(item => item.method === 'Page.handleJavaScriptDialog'));
});

test('an out-of-range latitude is refused before any command is sent', async () => {
  const { advanced, env } = await load();
  const result = await advanced.run('browser_emulation', {
    action: 'set', geolocation: { latitude: 120, longitude: 10 }
  }, ctx());
  assert.equal(result.status, 'denied');
  assert.equal(result.reason, 'latitude_out_of_range');
  assert.equal(env.sent.length, 0);
});

test('an emulation call with no field is refused rather than opening a session for nothing', async () => {
  const { advanced, opened } = await load();
  const result = await advanced.run('browser_emulation', { action: 'set' }, ctx());
  assert.equal(result.status, 'denied');
  assert.equal(result.reason, 'nothing_to_apply');
  assert.deepEqual(opened, [], 'a refusal must not open a debugger session');
});

test('emulation applies what was asked and reports what it skipped', async () => {
  const { advanced, env } = await load();
  const result = await advanced.run('browser_emulation', {
    action: 'set',
    geolocation: { latitude: 31.23, longitude: 121.47 },
    timezone: 'Asia/Shanghai',
    colorScheme: 'dark',
    cpuThrottling: 4
  }, ctx());
  assert.equal(result.status, 'success');
  assert.deepEqual(result.applied, ['geolocation', 'timezone', 'colorScheme', 'cpuThrottling']);
  assert.ok(result.skipped.includes('deviceMetrics'));
  const media = env.sent.find(item => item.method === 'Emulation.setEmulatedMedia');
  assert.deepEqual(media.params.features, [{ name: 'prefers-color-scheme', value: 'dark' }]);
  assert.equal(result.debuggerBanner, true, 'the cost of a sticky override has to be stated');
});

test('clearing with no session reports that nothing was in effect', async () => {
  const { advanced } = await load();
  const result = await advanced.run('browser_emulation', { action: 'clear' }, ctx());
  assert.equal(result.status, 'not_dispatched');
  assert.equal(result.reason, 'no_debugger_session');
});

test('a clear is verified by reading the page, not by the reset command returning', async () => {
  // Measured on Chrome 156: after the full reset sequence the viewport was still
  // overridden, and it stayed that way even after the debugger detached. A reset
  // command being accepted is not an override being gone, so the reply has to
  // come from a read - and the read only means something when it is compared
  // against what the page saw before the override, because a user whose machine
  // already matches the emulated value would otherwise look "still overridden".
  const { advanced, env } = await load();
  const probe = values => () => ({ result: { value: JSON.stringify(values) } });
  env.on('Runtime.evaluate', probe({ tz: 'Europe/Berlin', lang: 'en-US', ua: 'x', w: 1280, h: 720, dark: false, touch: 0 }));
  const set = await advanced.run('browser_emulation', { action: 'set', timezone: 'Asia/Shanghai' }, ctx());
  assert.equal(set.status, 'success');
  assert.equal(set.baseline.tz, 'Europe/Berlin', 'the pre-override reading is what makes the check meaningful');

  env.on('Runtime.evaluate', probe({ tz: 'Asia/Shanghai', lang: 'en-US', ua: 'x', w: 1280, h: 720, dark: false, touch: 0 }));
  const result = await advanced.run('browser_emulation', { action: 'clear' }, ctx());
  assert.equal(result.status, 'success');
  assert.equal(result.verified, false, 'the page still reports the emulated timezone');
  assert.deepEqual(result.stillInEffect, ['timezone']);
  assert.match(result.note, /reload the tab/);

  // And when the page agrees, the reply says verified.
  env.on('Runtime.evaluate', probe({ tz: 'Europe/Berlin', lang: 'en-US', ua: 'x', w: 1280, h: 720, dark: false, touch: 0 }));
  await advanced.run('browser_emulation', { action: 'set', timezone: 'Asia/Shanghai' }, ctx());
  env.on('Runtime.evaluate', probe({ tz: 'Europe/Berlin', lang: 'en-US', ua: 'x', w: 1280, h: 720, dark: false, touch: 0 }));
  const second = await advanced.run('browser_emulation', { action: 'clear' }, ctx());
  assert.equal(second.verified, true);
  assert.deepEqual(second.stillInEffect, []);
});

test('an override the user already had is not reported as still in effect', async () => {
  // The false positive that the baseline read exists to prevent: emulating the
  // timezone the machine is already in must not make clear report a leak.
  const { advanced, env } = await load();
  const probe = values => () => ({ result: { value: JSON.stringify(values) } });
  env.on('Runtime.evaluate', probe({ tz: 'Asia/Shanghai', lang: 'zh-CN', ua: 'x', w: 1280, h: 720, dark: false, touch: 0 }));
  await advanced.run('browser_emulation', { action: 'set', timezone: 'Asia/Shanghai' }, ctx());
  const result = await advanced.run('browser_emulation', { action: 'clear' }, ctx());
  assert.equal(result.verified, true);
  assert.deepEqual(result.stillInEffect, []);
});

test('an accessibility snapshot splices ignored wrappers and keeps semantic roles', async () => {
  const { advanced, env } = await load();
  env.on('Accessibility.getFullAXTree', () => ({
    nodes: [
      { nodeId: '1', role: { value: 'RootWebArea' }, name: { value: 'Page' }, childIds: ['2', '3'] },
      { nodeId: '2', role: { value: 'generic' }, ignored: true, childIds: ['4'] },
      { nodeId: '3', role: { value: 'button' }, name: { value: 'Save' }, childIds: [], properties: [{ name: 'disabled', value: { value: false } }] },
      { nodeId: '4', role: { value: 'textbox' }, name: { value: 'Email' }, childIds: [], backendDOMNodeId: 42 }
    ]
  }));
  const result = await advanced.run('browser_ax_snapshot', {}, ctx());
  assert.equal(result.status, 'success');
  const roles = result.nodes.map(node => node.role);
  assert.ok(roles.includes('textbox'), 'the child of an ignored wrapper must survive');
  assert.ok(!roles.includes('generic'), 'an ignored wrapper must not be listed as a node');
  const textbox = result.nodes.find(node => node.role === 'textbox');
  assert.equal(textbox.backendNodeId, 42);
  assert.equal(textbox.name, 'Email', 'the accessible name is the whole point of this tree');
  assert.equal(result.nodes.find(node => node.role === 'button').name, 'Save');
  assert.equal(result.contentTrust, 'untrusted page content');
});

test('interactiveOnly drops structure and keeps what a caller can act on', async () => {
  const { advanced, env } = await load();
  env.on('Accessibility.getFullAXTree', () => ({
    nodes: [
      { nodeId: '1', role: { value: 'RootWebArea' }, name: { value: 'Page' }, childIds: ['2', '3'] },
      { nodeId: '2', role: { value: 'heading' }, name: { value: 'Title' }, childIds: [] },
      { nodeId: '3', role: { value: 'link' }, name: { value: 'Docs' }, childIds: [] }
    ]
  }));
  const result = await advanced.run('browser_ax_snapshot', { interactiveOnly: true }, ctx());
  const roles = result.nodes.map(node => node.role);
  assert.ok(roles.includes('link'));
  assert.ok(!roles.includes('heading'), 'a heading with no children is not actionable');
});

test('interactiveOnly drops a container whose children are only text', async () => {
  // Measured on example.com: the first version kept a paragraph because it had
  // children, then dropped those children as non-interactive, leaving an empty
  // paragraph row. "Has children" is not the question - "has something
  // actionable underneath" is.
  const { advanced, env } = await load();
  env.on('Accessibility.getFullAXTree', () => ({
    nodes: [
      { nodeId: '1', role: { value: 'RootWebArea' }, childIds: ['2', '5'] },
      { nodeId: '2', role: { value: 'paragraph' }, childIds: ['3'] },
      { nodeId: '3', role: { value: 'StaticText' }, name: { value: 'hello' }, childIds: [] },
      { nodeId: '5', role: { value: 'button' }, name: { value: 'Go' }, childIds: [] }
    ]
  }));
  const result = await advanced.run('browser_ax_snapshot', { interactiveOnly: true }, ctx());
  const roles = result.nodes.map(node => node.role);
  assert.ok(roles.includes('button'));
  assert.ok(!roles.includes('paragraph'), 'a container of text is not a target');
  assert.ok(!roles.includes('StaticText'), 'text runs are not targets');
});

test('an ignored wrapper promotes every surviving child, not just one', async () => {
  const { advanced, env } = await load();
  env.on('Accessibility.getFullAXTree', () => ({
    nodes: [
      { nodeId: '1', role: { value: 'RootWebArea' }, childIds: ['2'] },
      { nodeId: '2', role: { value: 'generic' }, ignored: true, childIds: ['3', '4'] },
      { nodeId: '3', role: { value: 'button' }, name: { value: 'A' }, childIds: [] },
      { nodeId: '4', role: { value: 'button' }, name: { value: 'B' }, childIds: [] }
    ]
  }));
  const result = await advanced.run('browser_ax_snapshot', {}, ctx());
  const names = result.nodes.map(node => node.name).filter(Boolean);
  assert.deepEqual(names.sort(), ['A', 'B'], 'both children of a spliced wrapper must survive');
});

test('adding an init script tracks its identifier and says when it takes effect', async () => {
  const { advanced, env } = await load();
  env.on('Page.addScriptToEvaluateOnNewDocument', () => ({ identifier: 'script-1' }));
  const added = await advanced.run('browser_init_script', { action: 'add', source: 'window.__x = 1;' }, ctx());
  assert.equal(added.status, 'success');
  assert.equal(added.identifier, 'script-1');
  assert.match(added.note, /NEXT navigation|next navigation/i);
  const listed = await advanced.run('browser_init_script', { action: 'list' }, ctx());
  assert.equal(listed.count, 1);
  const removed = await advanced.run('browser_init_script', { action: 'remove', identifier: 'script-1' }, ctx());
  assert.equal(removed.status, 'success');
  assert.equal(removed.tracked, 0);
});

test('removing an init script without an identifier is refused', async () => {
  const { advanced } = await load();
  const result = await advanced.run('browser_init_script', { action: 'remove' }, ctx());
  assert.equal(result.status, 'denied');
  assert.equal(result.reason, 'identifier_required');
});

test('a mock rule fulfils only the URLs it matches and continues everything else', async () => {
  const { advanced, env } = await load();
  await advanced.run('browser_network_rules', {
    action: 'mock', pattern: 'https://api.example.com/user/*', status: 200,
    headers: { 'content-type': 'application/json' }, body: '{"ok":true}'
  }, ctx());
  assert.ok(env.sent.some(item => item.method === 'Fetch.enable'));
  env.emit(5, 'Fetch.requestPaused', { requestId: 'r1', request: { url: 'https://api.example.com/user/42' } });
  env.emit(5, 'Fetch.requestPaused', { requestId: 'r2', request: { url: 'https://example.com/app.js' } });
  await new Promise(resolve => setTimeout(resolve, 20));
  const fulfil = env.sent.find(item => item.method === 'Fetch.fulfillRequest');
  assert.ok(fulfil, 'the matching request must be fulfilled');
  assert.equal(fulfil.params.requestId, 'r1');
  const continues = env.sent.filter(item => item.method === 'Fetch.continueRequest').map(item => item.params.requestId);
  assert.deepEqual(continues, ['r2'], 'a non-matching request must be continued, never left hanging');
});

test('a mock body over the limit is refused instead of buffered', async () => {
  const { advanced, env } = await load();
  const result = await advanced.run('browser_network_rules', {
    action: 'mock', pattern: 'https://api.example.com/*', body: 'x'.repeat(200001)
  }, ctx());
  assert.equal(result.status, 'denied');
  assert.equal(result.reason, 'body_too_large');
  assert.equal(env.sent.length, 0);
});

test('printing to PDF hands the file to the download manager', async () => {
  const { advanced, env } = await load();
  env.on('Page.printToPDF', () => ({ data: Buffer.from('%PDF-1.4 test').toString('base64') }));
  const result = await advanced.run('browser_pdf_save', { filename: 'report.pdf' }, ctx());
  assert.equal(result.status, 'success');
  assert.equal(result.downloadId, 77);
  const download = env.sent.find(item => item.method === 'downloads.download');
  assert.equal(download.params.filename, 'report.pdf');
  // A service worker has no URL.createObjectURL, so the bytes have to travel as
  // a data URL - the only scheme downloads.download accepts from a worker.
  assert.match(download.params.url, /^data:application\/pdf;base64,/);
  assert.ok(result.bytes > 0);
  // The name in the argument is a request, not a fact: Chrome saved a data URL as
  // download.pdf on the real browser, so the path is read back.
  assert.equal(result.filename, 'C:\\Downloads\\report.pdf');
});

test('a PDF the download manager refuses is reported as such, not as a print failure', async () => {
  const { advanced, env } = await load();
  env.on('Page.printToPDF', () => ({ data: Buffer.from('%PDF-1.4 test').toString('base64') }));
  globalThis.chrome.downloads.download = async () => { throw new Error('Invalid URL'); };
  const result = await advanced.run('browser_pdf_save', {}, ctx());
  assert.equal(result.status, 'failed');
  assert.match(result.hint, /data URL/);
});

test('a drag reports which path ran and never claims the page accepted it', async () => {
  const { advanced } = await load();
  const result = await advanced.run('browser_drag', { fromRef: 'r1', toX: 200, toY: 300, mode: 'mouse' }, ctx());
  assert.equal(result.status, 'success');
  assert.equal(result.mode, 'mouse');
  assert.equal(result.verified, false);
  assert.match(result.note, /press-move-release/);
});

test('a drag that asks for the native path and gets none says nothing was dropped', async () => {
  // mode:"html5" is a request for that path, so quietly doing a mouse drag
  // instead would be a different operation than the one asked for.
  const { advanced } = await load();
  const result = await advanced.run('browser_drag', { fromRef: 'r1', toX: 200, toY: 300, mode: 'html5' }, ctx());
  assert.equal(result.status, 'not_dispatched');
  assert.equal(result.reason, 'no_native_drag_intercepted');
});

test('a synthetic drag reports whether a listener accepted the drop', async () => {
  const { advanced, env } = await load();
  env.on('Runtime.evaluate', () => ({ result: { value: { found: true, started: true, dropped: true, srcTag: 'DIV', dstTag: 'DIV' } } }));
  const accepted = await advanced.run('browser_drag', { fromRef: 'r1', toX: 200, toY: 300, mode: 'synthetic' }, ctx());
  assert.equal(accepted.status, 'success');
  assert.equal(accepted.mode, 'synthetic');
  assert.equal(accepted.accepted, true);
  assert.equal(accepted.verified, false);

  env.on('Runtime.evaluate', () => ({ result: { value: { found: true, started: true, dropped: false } } }));
  const ignored = await advanced.run('browser_drag', { fromRef: 'r1', toX: 200, toY: 300, mode: 'synthetic' }, ctx());
  assert.equal(ignored.accepted, false);
  assert.match(ignored.note, /ignored/);

  env.on('Runtime.evaluate', () => ({ result: { value: { found: false } } }));
  const nowhere = await advanced.run('browser_drag', { fromRef: 'r1', toX: 200, toY: 300, mode: 'synthetic' }, ctx());
  assert.equal(nowhere.reason, 'endpoint_unresolved');
});

test('an input dispatch that never settles cannot deadlock the drag', async () => {
  // Measured: with drag interception on, the mousePressed that starts a native
  // drag never settled, and awaiting it hung the whole call until the service
  // timeout. Dispatch is fire-and-observe here.
  const { advanced, env } = await load();
  env.on('Input.dispatchMouseEvent', () => new Promise(() => {}));
  const started = Date.now();
  const result = await advanced.run('browser_drag', { fromRef: 'r1', toX: 200, toY: 300, mode: 'mouse', steps: 2 }, ctx());
  assert.equal(result.status, 'success');
  assert.ok(Date.now() - started < 15000, 'bounded dispatch must return control');
});
