import test from 'node:test';
import assert from 'node:assert/strict';
import { capabilityGuide } from '../src/capability-guide.js';
import { createBridge } from '../src/server.js';

test('a backgrounded tab is not treated as a blocker for DOM work', () => {
  const guide = capabilityGuide({ goal: '点击提交按钮并填写表单' });
  assert.equal(guide.focusRequired, false);
  assert.equal(guide.primary.intent, 'write-or-submit');
  assert.equal(guide.primary.backgroundSafe, true);
  assert.ok(guide.focusPolicy.backgroundSafeTools.includes('browser_click'));
  assert.ok(guide.focusPolicy.backgroundSafeTools.includes('browser_fill'));
  assert.match(guide.focusPolicy.guidance, /not as a gate/);
});

test('coordinates no longer claim to need the foreground, and Windows UI Automation still does', () => {
  // This assertion used to be the opposite. It flipped because the coordinate
  // gate was an implementation defect: the token is bound to a DOM element and
  // re-hit-tested, and CDP dispatches by tabId, so a backgrounded tab resolves
  // the same target. Telling agents otherwise made them stall for no reason.
  for (const goal of ['用坐标点一下画布', 'coordinate click on the canvas']) {
    const guide = capabilityGuide({ goal });
    assert.equal(guide.focusRequired, false, goal);
    assert.equal(guide.primary.backgroundSafe, true, goal);
    assert.match(guide.primary.why, /backgrounded|tabId/);
  }
  // The genuine OS-level limit stays honest: chrome:// settings goes through
  // Windows UI Automation, which types into the real screen.
  assert.equal(capabilityGuide({ goal: '打开 chrome://settings 改代理' }).focusRequired, true);
  // Extension reload does not, because its target binding is resolved inside the call.
  assert.equal(capabilityGuide({ goal: 'reload the extension' }).focusRequired, false);
  const policy = capabilityGuide({ goal: '' }).focusPolicy;
  for (const tool of ['browser_prepare_coordinate', 'browser_action']) assert.ok(policy.backgroundSafeTools.includes(tool), tool);
  for (const tool of ['browser_native_snapshot', 'browser_devtools']) {
    assert.ok(policy.foregroundRequiredTools.includes(tool), tool);
  }
  assert.doesNotMatch(policy.guidance, /block the coordinate path/);
});

test('opening a page is answered with reuse, not with a new tab', () => {
  const guide = capabilityGuide({ goal: '打开这个页面看看' });
  assert.equal(guide.primary.intent, 'open-or-reuse-tab');
  assert.match(guide.primary.why, /does not create duplicates|incognito/);
  assert.match(guide.primary.prefer, /active:true|background/);
  assert.equal(guide.focusRequired, false);
});

test('an unknown goal still returns a usable chain instead of nothing', () => {
  const guide = capabilityGuide({ goal: '做一些别的事情' });
  assert.deepEqual(guide.matchedIntents, []);
  assert.equal(guide.primary, null);
  assert.ok(guide.chain.includes('browser_read'));
  assert.ok(guide.chain.includes('browser_click'));
  assert.ok(guide.fallbacks.length > 0);
  assert.match(guide.whenAToolIsMissing, /Do not conclude the task is impossible/);
});

test('capability gaps are stated instead of being hidden behind a refusal', () => {
  const guide = capabilityGuide({ goal: '登录' });
  const gaps = Object.fromEntries(guide.notImplemented.map(entry => [entry.capability, entry]));
  // Reading the saved password is a capability now (browser_credential_lookup).
  // What remains impossible is driving Chrome's own autofill popup, which lives
  // in the browser process, so that is the gap that must be stated.
  assert.equal(gaps['read values stored in the Chrome password manager'], undefined);
  assert.equal(gaps['trigger the Chrome password autofill popup'].status, 'not_implemented');
  // Measured, not assumed: the profile key still opens the profile's own cookies
  // but not one login row, so offline decryption stays a stated limit - while the
  // same value is reachable through the browser's own UI.
  const blocked = gaps['decrypt saved passwords offline from the profile files'];
  assert.equal(blocked.status, 'blocked_by_browser');
  assert.match(blocked.note, /cookies/);
  assert.match(blocked.note, /password_key_not_available/);
  assert.match(blocked.note, /browser_password_manager_reveal/);
  assert.match(guide.primary.prefer, /browser_password_manager_reveal/);
  assert.match(guide.primary.prefer, /browser_login_state/);
  assert.match(guide.primary.prefer, /browser_credential_lookup/);
  // Launching a browser used to be listed here. It is a capability now, so
  // leaving it in the gap list would send agents looking for a workaround.
  assert.equal(gaps['launch a browser when none is running'], undefined);
  // Breakpoints and stepping are a capability now (browser_debugger). Rewriting
  // a script's source is not, and the reason is a browser limit that was
  // measured, so it belongs in the gap list rather than in the feature list.
  assert.equal(gaps['breakpoints, stepping and script editing in Sources'], undefined);
  const liveEdit = gaps['edit a live script in place, the way Sources live-edit does'];
  assert.equal(liveEdit.status, 'blocked_by_browser');
  assert.match(liveEdit.note, /setScriptSource/);
  assert.match(liveEdit.note, /script_edit_removed_by_v8/);
  assert.match(liveEdit.note, /evaluate/);
  // The guidance must send the caller to evaluate and must not let it retry a
  // command the browser has stubbed out.
  const debug = capabilityGuide({ goal: '给这个页面打个断点，然后改一下脚本' });
  assert.equal(debug.primary.intent, 'debug-or-breakpoint');
  assert.match(debug.primary.prefer, /script_edit_removed_by_v8/);
  assert.match(debug.primary.prefer, /Do not retry/);
  // Replay is a capability now, so the old "Capture is read-only" line must be
  // gone; leaving it would send an agent looking for a workaround that exists.
  assert.equal(gaps['request replay from the Network panel'], undefined);
  // What is still missing is replaying from a capture, which is a different
  // feature: capture drops headers and bodies on purpose, so it cannot be the
  // source of a request. The gap has to say which of the two is missing.
  const fromCapture = gaps['replay a request straight out of a capture, with its original headers and body'];
  assert.equal(fromCapture.status, 'not_implemented');
  assert.match(fromCapture.note, /browser_replay_request/);
  assert.match(fromCapture.note, /headers/);
  // IndexedDB records are a gap rather than a browser block: the storage tool
  // exposes schema only, and reading records is page-context work, so the answer
  // has to name the substitute and the trap in it.
  const idb = gaps['read IndexedDB records'];
  assert.equal(idb.status, 'not_implemented');
  assert.match(idb.note, /browser_storage_read/);
  assert.match(idb.note, /evaluate/);
  assert.match(idb.note, /create/i);
  // Select, Toggle and Value were a stated gap and are no longer one: the native
  // action layer now drives all three, each proving itself by reading the
  // control back. A gap entry that outlives the gap teaches callers to work
  // around a capability they actually have.
  assert.equal(gaps['drive a chrome:// control that only exists as a Select, Toggle or Value pattern'], undefined);
  const internal = capabilityGuide({ goal: '把 Chrome 设置里的某个开关拨到开启' });
  assert.equal(internal.primary.intent, 'chrome-internal');
  assert.match(internal.primary.prefer, /desiredState/);
  assert.match(internal.primary.prefer, /browser_native_snapshot/);
  // Storage guidance has to separate the cheap discovery read from the value
  // read, and has to state the two writes that are refused on purpose.
  const storage = capabilityGuide({ goal: '看看这个站点 localStorage 里存了什么，顺便清掉登录 cookie' });
  assert.equal(storage.primary.intent, 'storage-or-cookies');
  assert.match(storage.primary.prefer, /browser_storage_read/);
  assert.match(storage.primary.prefer, /modify_site_storage_once/);
  assert.match(storage.primary.prefer, /verified:false/);
  assert.match(storage.primary.prefer, /IndexedDB/);
  // Replay guidance must say that a timeout is uncertain rather than failed,
  // because the obvious reading of a timeout is "nothing happened" and that is
  // exactly the reading that causes a second, real request.
  const replay = capabilityGuide({ goal: '把这个请求重放一次看看返回什么' });
  assert.equal(replay.primary.intent, 'network');
  assert.match(replay.primary.prefer, /replay_request_once/);
  assert.match(replay.primary.prefer, /replay_timeout/);
  assert.match(replay.primary.prefer, /Never send it twice/);
});

test('launching and reloading are both advertised as background-safe', () => {
  const launch = capabilityGuide({ goal: '浏览器没启动，帮我拉起来' });
  assert.equal(launch.primary.intent, 'launch-browser');
  assert.equal(launch.focusRequired, false);
  assert.match(launch.primary.why, /second profile|incognito/);
  const policy = capabilityGuide({ goal: '' }).focusPolicy;
  assert.ok(policy.backgroundSafeTools.includes('browser_launch'));
  assert.ok(policy.backgroundSafeTools.includes('browser_reload_extension'));
  assert.ok(!policy.foregroundRequiredTools.includes('browser_reload_extension'));
});

test('reload guidance points at the capability itself, not at a manual step', () => {
  const guide = capabilityGuide({ goal: '扩展版本不匹配，需要 reload' });
  assert.equal(guide.primary.intent, 'extension-reload-or-deploy');
  // 扩展 also matches the chrome:// intent, which does need the foreground; the
  // primary path must not inherit that requirement.
  assert.equal(guide.focusRequired, false);
  assert.ok(guide.alsoMatches.some(entry => entry.intent === 'chrome-internal' && entry.focusRequired === true));
  assert.match(guide.primary.prefer, /confirmation only/);
});

// The seven DevTools-parity tools are only useful if a caller can find them, so
// the routing is pinned here rather than left to the tool descriptions. Each of
// these goals used to fall through to a generic read/network answer, which is
// exactly the stall the guide exists to prevent.
test('the DevTools-parity capabilities are routed to by goal, not by name', () => {
  const cases = [
    ['把这个页面模拟成手机，并限速到 3G', 'device-or-network-mock', 'browser_emulation'],
    ['拦截这个接口，返回一个假的 JSON', 'device-or-network-mock', 'browser_network_rules'],
    ['有个确认对话框挡住了，帮我点掉', 'native-dialog', 'browser_dialog'],
    ['这个按钮对屏幕阅读器来说叫什么', 'accessibility-tree', 'browser_ax_snapshot'],
    ['把这张卡片拖到回收站里', 'drag-and-drop', 'browser_drag'],
    ['把这一页打印成 PDF', 'print-to-pdf', 'browser_pdf_save'],
    ['在页面加载前注入一段脚本，改掉 navigator.webdriver', 'init-script', 'browser_init_script']
  ];
  for (const [goal, intent, tool] of cases) {
    const guide = capabilityGuide({ goal });
    assert.equal(guide.primary?.intent, intent, goal);
    assert.equal(guide.focusRequired, false, goal);
    assert.ok(guide.primary.tools.includes(tool), `${goal} must name ${tool}`);
    assert.ok(guide.focusPolicy.backgroundSafeTools.includes(tool), tool);
  }
  // The keywords had to stay narrow: 网络, 请求 and 脚本 belong to existing
  // intents, and a loose match here would re-route those goals silently.
  assert.equal(capabilityGuide({ goal: '把这个请求重放一次看看返回什么' }).primary.intent, 'network');
  assert.equal(capabilityGuide({ goal: '给这个页面打个断点，然后改一下脚本' }).primary.intent, 'debug-or-breakpoint');
  assert.equal(capabilityGuide({ goal: '下载这个 pdf 附件' }).primary.intent, 'upload-or-download');
  // Each reply has to carry its own uncertainty rather than a bare success.
  assert.match(capabilityGuide({ goal: '有个确认对话框挡住了，帮我点掉' }).primary.prefer, /verified:false/);
  assert.match(capabilityGuide({ goal: '把这张卡片拖到回收站里' }).primary.prefer, /verified is always false/);
  assert.match(capabilityGuide({ goal: '把这张卡片拖到回收站里' }).primary.prefer, /synthetic/);
  assert.match(capabilityGuide({ goal: '把这个页面模拟成手机，并限速到 3G' }).primary.prefer, /clear/);
});

test('the guide is answered locally, so it survives a disconnected extension', async t => {
  const bridge = createBridge({ port: 0, agentToken: 'fixture', extensionToken: 'fixture' }, {
    leaseStateFile: null, agentPolicyFile: null, audit: () => {}
  });
  await bridge.listen(); t.after(() => bridge.close());
  const result = await bridge.call('browser_capability_guide', { goal: '读取页面内容' });
  assert.equal(result.status, 'ok');
  assert.equal(result.primary.intent, 'read-or-locate');
  assert.equal(result.focusRequired, false);
});