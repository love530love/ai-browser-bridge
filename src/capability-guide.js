// Deterministic capability guidance.
//
// An agent that does not know the primitive set used to stall: it would observe
// a backgrounded tab, see tabActive=false, and stop even though every DOM and
// CDP primitive works fine there. This module answers "for this goal, which
// primitive, does it need the foreground, and what is the fallback" without any
// model, so it keeps working when every optional service is offline.

const READ = ['browser_read', 'browser_find_text', 'browser_find_element'];
const WRITE = ['browser_click', 'browser_click_verified', 'browser_fill', 'browser_fill_verified'];
const PICK = ['browser_select', 'browser_choose', 'browser_pick'];
const COORDINATE = ['browser_prepare_coordinate', 'browser_action'];

// Ordered: the first matching intent wins, so put the specific ones first.
const INTENTS = [
  { id: 'coordinate-or-canvas', match: /坐标|画布|canvas|webgl|坐标点击|coordinate|无法定位元素/i,
    tools: COORDINATE, focusRequired: false,
    why: 'The coordinate token is bound to the DOM element under the point and re-hit-tested before the press, and CDP dispatches into the target by tabId, so a backgrounded tab still resolves the same element. Foreground is only needed if you explicitly ask for it with requireForeground:true.',
    backgroundSafe: true,
    prefer: 'Try browser_find_element or browser_find_text first; a ref-based browser_click needs no coordinate token at all. If you must use coordinates, prepare them from the geometry browser_find_element already returned instead of guessing a point, and check the returned target.',
    fallback: ['browser_find_element', 'browser_screenshot', 'browser_scan_overlays'] },
  { id: 'launch-browser', match: /启动浏览器|浏览器没启动|浏览器未启动|没开浏览器|没有浏览器|launch|start chrome|chrome.*not running|not running/i,
    tools: ['browser_launch', 'browser_queue_status'], focusRequired: false,
    why: 'browser_launch starts the user\'s own Chrome with no profile directory and no incognito flag, so the same cookies and logins apply. It refuses when any chrome process already exists, because a second instance means a second profile and that is what kicks accounts out.',
    backgroundSafe: true,
    prefer: 'Call browser_launch and read extensionConnected. If it returns not_dispatched/chrome_already_running, the browser is already up: use browser_open instead of launching again.',
    fallback: ['browser_launch', 'browser_wait_until_ready', 'browser_queue_status'] },
  { id: 'open-or-reuse-tab', match: /新标签|新窗口|复用|重复标签|隐身|无痕|incognito|open tab|new tab|reuse|打开(?![\s\S]*chrome:\/\/|[\s\S]*devtools:\/\/)/i,
    tools: ['browser_tabs', 'browser_open'], focusRequired: false,
    why: 'browser_open matches an existing tab by page identity (ignoring a #fragment and a trailing slash, keeping the query string), so it does not create duplicates. It never creates a window, never opens an incognito tab, and does not move the window to the front unless you pass active:true.',
    backgroundSafe: true,
    prefer: 'Call browser_open without active:true. Every primitive works on a background tab, so stealing focus buys nothing and interrupts the user. Incognito tabs are excluded from browser_tabs and are never opened implicitly. If browser_open answers extension_disconnected, the browser itself is not running: call browser_launch first.',
    fallback: ['browser_tabs', 'browser_open', 'browser_launch'] },
  { id: 'extension-reload-or-deploy', match: /重载|reload|部署|deploy|版本不匹配|version mismatch|doctor/i,
    tools: ['browser_reload_extension'], focusRequired: false,
    why: 'When the extension is connected it reloads itself through chrome.runtime.reload(): no window is focused, no tab is opened, no keystroke is sent, and the service verifies the reload by observing a new session with the expected version. Only when the extension is disconnected does it fall back to Windows UI Automation, and that fallback reports focusRequired:true.',
    backgroundSafe: true,
    prefer: 'Call browser_reload_extension with confirmation only, then node src/cli.js doctor. If the reply says method:"windows_ui_automation", the extension was disconnected and that path did need the foreground.',
    fallback: ['browser_reload_extension', 'browser_queue_status'] },
  { id: 'debug-or-breakpoint', match: /断点|单步|调试|调用栈|栈帧|breakpoint|debugger|step over|call stack|暂停执行|paused|live ?edit|改脚本|热改/i,
    tools: ['browser_debugger'], focusRequired: false,
    why: 'A long-lived CDP debugger session per tab, so a breakpoint set in one call still exists in the next. Works on a backgrounded tab. The costs are real: Chrome shows a debugging banner on that tab while the session is open, and DevTools cannot attach to it meanwhile.',
    backgroundSafe: true,
    prefer: 'open -> scripts (pass urlFilter to find the exact script URL; a script-heavy page hides its own document script in the unfiltered tail) -> set_breakpoint -> trigger it (schedule it with evaluate + setTimeout, because a synchronous trigger pauses inside the call that made it) -> poll status until paused -> frames -> evaluate -> step or resume -> close. While paused every other page tool returns status=waiting with reason=tab_paused_by_debugger instead of hanging; browser_health still answers and reports the pause. A paused page is frozen, so always close the session; a paused session nobody touches is resumed automatically after session.paused.autoResumeInMs. Changing what a running script does is done with action:"evaluate" (redefine the function or global), not with set_script_source: that action exists but the browser refuses it with reason "script_edit_removed_by_v8", because V8 replaced Debugger.setScriptSource with an unconditional stub. Do not retry it with different arguments; the answer cannot change.',
    fallback: ['browser_debugger', 'browser_devtools_capture', 'browser_performance'] },
  { id: 'console-or-errors', match: /控制台|报错|异常|错误|console|error|exception|日志/i,
    tools: ['browser_devtools_capture'], focusRequired: false,
    why: 'Reads Runtime.consoleAPICalled, Runtime.exceptionThrown and Log.entryAdded over CDP inside one bounded window.',
    backgroundSafe: true,
    prefer: 'browser_devtools_capture with domains ["console"]. Events before the window opened are invisible, so trigger the action inside the window or re-run.',
    fallback: ['browser_devtools_capture', 'browser_debug'] },
  { id: 'network', match: /网络|请求|抓包|接口|network|request|api|status code/i,
    tools: ['browser_devtools_capture', 'browser_network_summary'], focusRequired: false,
    why: 'CDP Network events inside the window, or the Resource Timing buffer for already-finished requests.',
    backgroundSafe: true,
    prefer: 'browser_devtools_capture with domains ["network"] for status and failures; browser_network_summary for a cheap buffer read.',
    fallback: ['browser_devtools_capture', 'browser_network_summary'] },
  { id: 'performance', match: /性能|卡顿|慢|performance|long task|layout/i,
    tools: ['browser_performance'], focusRequired: false,
    why: 'Performance.getMetrics and layout metrics over CDP.',
    backgroundSafe: true, prefer: 'browser_performance.', fallback: ['browser_performance', 'browser_devtools_capture'] },
  { id: 'screenshot', match: /截图|screenshot|看看|像素/i,
    tools: ['browser_screenshot'], focusRequired: false,
    why: 'Page.captureScreenshot over a temporary debugger attachment; verified on a backgrounded tab.',
    backgroundSafe: true, prefer: 'browser_screenshot.', fallback: ['browser_screenshot', 'browser_read'] },
  { id: 'upload-or-download', match: /上传|下载|附件|upload|download|file/i,
    tools: ['browser_upload', 'browser_upload_verified'], focusRequired: false,
    why: 'Sets the file input directly, so the OS file dialog never opens.',
    backgroundSafe: true,
    prefer: 'browser_upload_verified with an allowlisted path and its SHA256. Download completion and on-disk hash are not implemented yet.',
    fallback: ['browser_upload_verified'] },
  { id: 'login', match: /登录|登陆|sign in|login|账号|密码|验证码|验证|otp|2fa/i,
    tools: ['browser_login_state', 'browser_credential_lookup', 'browser_password_manager_reveal', 'browser_otp_fetch', 'browser_fill_verified', 'browser_click', 'browser_wait'], focusRequired: false,
    why: 'Login is ordinary form work plus two things the base can now do directly: read the saved password for one exact origin, and pull a one-time code out of an already-open mailbox tab.',
    backgroundSafe: true,
    prefer: 'browser_login_state first: it reports the phase (credentials, otp, logged_in, unknown) and which fields exist, without reading any field value. For the credentials phase, either fill a credential you already hold, or call browser_credential_lookup with confirmation:"read_credential_once" to read the saved password for that exact origin, then enter it with browser_fill_verified so the outcome is observed. Read its failure reasons literally. If it answers reason "password_key_not_available", the profile key was proven correct against that profile\'s own cookies and Chrome still does not use it for saved passwords - switch to browser_password_manager_reveal with confirmation:"reveal_password_once", which drives Chrome\'s own password manager through Windows UI Automation and is the only route left (CDP cannot attach to a chrome:// page, an extension cannot inject there, and chrome.passwordsPrivate is component-only). That call takes the foreground for a few seconds; if it answers status "waiting_for_user_auth", ask the user to complete the operating-system prompt and call it again with action:"read". Submit, then call browser_login_state again: a move to phase "otp" means a code is needed. Read it with browser_otp_fetch on the mailbox tab, check the candidate\'s sourceHint against the sender you expected, fill it, and confirm the phase moved on. Chrome still does not expose the autofill popup to extensions or CDP, so triggering the browser\'s own suggestion needs a human or a foreground UI-automation path.',
    fallback: ['browser_login_state', 'browser_find_element', 'browser_choose', 'browser_wait', 'browser_devtools_capture'] },
  { id: 'one-time-code', match: /验证码|校验码|动态码|otp|one[- ]?time|2fa|mfa|短信码/i,
    tools: ['browser_otp_fetch', 'browser_login_state', 'browser_fill_verified'], focusRequired: false,
    why: 'Codes are read from the visible text of a mailbox or chat tab that is already logged in, with the sender line attached so a phishing code can be told apart.',
    backgroundSafe: true,
    prefer: 'Open or reuse the mailbox tab, call browser_otp_fetch, and pick a candidate whose sourceHint matches the sender you expected. It returns several ranked candidates rather than one answer, because a wrong code costs a lockout and a code from an unknown sender is the attack. Fill it with browser_fill_verified and confirm with browser_login_state.',
    fallback: ['browser_otp_fetch', 'browser_read', 'browser_find_text'] },
  { id: 'select-or-picker', match: /下拉|选择|选项|select|dropdown|combobox|picker/i,
    tools: PICK, focusRequired: false,
    why: 'Native selects and portal pickers are driven by DOM events and verified by reading the resulting value.',
    backgroundSafe: true, prefer: 'browser_select for native selects, browser_pick for custom pickers.', fallback: PICK },
  { id: 'write-or-submit', match: /点击|提交|按钮|填写|输入|click|submit|button|fill|type/i,
    tools: WRITE, focusRequired: false,
    why: 'Dispatched through the page DOM, so the tab and window may be in the background.',
    backgroundSafe: true,
    prefer: 'Prefer the verified variants: they refuse to report success without an observed outcome.',
    fallback: [...WRITE, 'browser_find_element'] },
  { id: 'read-or-locate', match: /读取|读页|内容|文本|查找|定位|read|content|text|find|locate/i,
    tools: READ, focusRequired: false,
    why: 'Reads the live DOM; no foreground requirement.',
    backgroundSafe: true, prefer: 'browser_find_text before a full read on large pages.', fallback: READ },
  { id: 'chrome-internal', match: /chrome:\/\/|设置|扩展|证书|代理|settings|extensions|certificate|proxy/i,
    tools: ['browser_protected_ui_plan', 'browser_desktop_windows', 'browser_native_snapshot'], focusRequired: true,
    why: 'Chrome internal pages are not ordinary DOM targets; they are driven through Windows UI Automation, which operates the real window and therefore needs it in front.',
    backgroundSafe: false,
    prefer: 'browser_protected_ui_plan first to see which action is actually implemented, then browser_native_snapshot to bind a precise control.',
    fallback: ['browser_protected_ui_plan', 'browser_native_snapshot', 'browser_desktop_windows'] },
  { id: 'multi-agent', match: /并发|多 ?agent|租约|排队|lease|concurrent|priority|优先级/i,
    tools: ['browser_claim_tab', 'browser_renew_tab', 'browser_release_tab', 'browser_queue_status'], focusRequired: false,
    why: 'Leases are answered by the service, never by the browser, so contention is resolved before anything is dispatched.',
    backgroundSafe: true,
    prefer: 'Claim the tab before writes, renew during long tasks, release when done. Reads stay allowed while another agent holds the write lease.',
    fallback: ['browser_claim_tab', 'browser_queue_status', 'browser_wait_until_ready'] }
];

const NOT_IMPLEMENTED = [
  { capability: 'trigger the Chrome password autofill popup', status: 'not_implemented', note: 'The popup is drawn by the browser process, not the page, so an extension cannot open it, see it, or click an entry in it, and CDP-synthesised keys never reach it. Reading the saved password directly (browser_credential_lookup) and typing it is the working route; driving the popup itself would need a foreground UI-automation path.' },
  { capability: 'decrypt saved passwords offline from the profile files', status: 'blocked_by_browser', note: 'Measured on Chrome 154 and on a Canary build that has no app-bound key at all: the profile key from Local State still decrypts that profile\'s own cookies (12 of 12, plaintext carrying the expected SHA256(host_key) prefix), yet not one login row authenticates with it, so Chrome encrypts password_value with a key it does not store in user-readable form. browser_credential_lookup reports this as reason "password_key_not_available" with keyValidation attached, rather than guessing. The same value is still reachable through the browser\'s own UI: browser_password_manager_reveal drives chrome://password-manager with Windows UI Automation, which is what a person does and the only route left once CDP and extension APIs are excluded.' },
  { capability: 'solve image or interactive captchas automatically', status: 'not_implemented', note: 'Reading an OTP out of a web mailbox is ordinary browsing and is supported by browser_otp_fetch. Deciding an image challenge is not, and would need a human or an external service.' },
  { capability: 'edit a live script in place, the way Sources live-edit does', status: 'blocked_by_browser', note: 'Breakpoints, stepping, call-frame inspection and evaluation all work through browser_debugger. Rewriting a script\'s source in the running page does not, and this was measured rather than assumed: current Chrome answers Debugger.setScriptSource with ServerError "setScriptSource functionality no longer available", which V8 returns from an unconditional stub in V8DebuggerAgentImpl::setScriptSource before looking at any argument. browser_debugger action set_script_source is wired up and reports this as reason "script_edit_removed_by_v8" with blockedBy "v8_inspector" instead of a generic failure, so nothing retries it by mistake. The reachable substitute is action:"evaluate", which redefines a function or a global immediately - that changes behaviour but not the script text, its line numbers or its source map.' },
  { capability: 'request replay from the Network panel', status: 'not_implemented', note: 'Capture is read-only.' },
  { capability: 'write Chrome settings, certificates or proxy', status: 'not_implemented', note: 'Planner and native snapshot exist; the write/read-back loop does not.' }
];

const FOCUS_POLICY = {
  summary: 'Foreground is required only where the operating system, not the page, decides the target.',
  backgroundSafeTools: ['browser_read', 'browser_find_text', 'browser_find_element', 'browser_click', 'browser_click_verified', 'browser_fill', 'browser_fill_verified', 'browser_select', 'browser_choose', 'browser_pick', 'browser_upload', 'browser_upload_verified', 'browser_scroll', 'browser_key', 'browser_wait', 'browser_screenshot', 'browser_performance', 'browser_network_summary', 'browser_devtools_capture', 'browser_debug', 'browser_debugger', 'browser_health', 'browser_login_state', 'browser_otp_fetch', 'browser_credential_lookup', ...COORDINATE, 'browser_tabs', 'browser_open', 'browser_close', 'browser_launch', 'browser_reload_extension'],
  foregroundRequiredTools: ['browser_desktop_windows', 'browser_native_snapshot', 'browser_devtools', 'browser_password_manager_reveal'],
  advisoryOnlyStates: ['tab.active', 'window.focused', 'document.visibilityState', 'document.hasFocus'],
  guidance: 'These four states are reported for diagnosis, not as a gate. A backgrounded tab is a normal working state: do not stop a DOM, CDP or coordinate task because of them. Coordinates do not need the foreground: the token is bound to the DOM element and re-hit-tested, and CDP dispatches into the target by tabId. browser_reload_extension does not either, because the extension reloads itself with chrome.runtime.reload(); only its Windows UI Automation fallback types into a real window. Pass requireForeground:true only when you specifically want foreground evidence.',
  evidence: 'test/focus-matrix.js exercises every read/write/diagnostic/coordinate primitive against a genuinely backgrounded tab: 25/25, including a Tap that really moves a DOM counter.'
};

export function capabilityGuide({ goal = '', tabId = null } = {}) {
  const text = String(goal ?? '');
  const matched = INTENTS.filter(intent => intent.match.test(text));
  const selected = matched.length ? matched : [];
  const primary = selected[0] ?? null;
  // Focus follows the primary path only. Using "any match needs foreground" made
  // a goal like "reload the extension" look foreground-bound just because the
  // word 扩展 also matched the chrome:// intent.
  const focusRequired = primary ? primary.focusRequired : false;
  return {
    status: 'ok',
    goal: text.slice(0, 500),
    tabId: Number.isInteger(tabId) ? tabId : null,
    matchedIntents: selected.map(intent => intent.id),
    alsoMatches: selected.slice(1).map(intent => ({ intent: intent.id, tools: intent.tools, focusRequired: intent.focusRequired })),
    primary: primary ? {
      intent: primary.id,
      tools: primary.tools,
      focusRequired: primary.focusRequired,
      backgroundSafe: primary.backgroundSafe,
      why: primary.why,
      prefer: primary.prefer
    } : null,
    chain: selected.length ? [...new Set(selected.flatMap(intent => intent.tools))] : [...READ, ...WRITE],
    fallbacks: selected.length ? [...new Set(selected.flatMap(intent => intent.fallback ?? []))] : [...READ, 'browser_scan_overlays', 'browser_screenshot'],
    focusRequired,
    focusPolicy: FOCUS_POLICY,
    notImplemented: NOT_IMPLEMENTED,
    whenAToolIsMissing: 'If a primitive you expected is absent or refuses for an unfamiliar reason, call browser_capability_guide again with the goal in plain language, then browser_bridge_modes for the fallback order. Do not conclude the task is impossible: report the blocker and the tool you tried.',
    whenBlocked: {
      waiting: 'Read reason and blockers, then poll with browser_wait_until_ready. waiting is resumable and is not a failure.',
      pageNotForeground: 'This only happens when the call asked for requireForeground:true. Drop that flag: every page primitive, including coordinates, works on a backgrounded tab. Only Windows UI Automation genuinely needs the front.',
      uncertain: 'Never replay. Re-observe with browser_health and browser_read, then decide.'
    },
    contentTrust: 'local capability description, not page content'
  };
}
