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
  { id: 'open-or-reuse-tab', match: /新标签|新窗口|复用|重复标签|隐身|无痕|incognito|open tab|new tab|reuse|打开(?![\s\S]*chrome:\/\/|[\s\S]*devtools:\/\/)/i,
    tools: ['browser_tabs', 'browser_open'], focusRequired: false,
    why: 'browser_open matches an existing tab by page identity (ignoring a #fragment and a trailing slash, keeping the query string), so it does not create duplicates. It never creates a window, never opens an incognito tab, and does not move the window to the front unless you pass active:true.',
    backgroundSafe: true,
    prefer: 'Call browser_open without active:true. Every primitive works on a background tab, so stealing focus buys nothing and interrupts the user. Incognito tabs are excluded from browser_tabs and are never opened implicitly.',
    fallback: ['browser_tabs', 'browser_open'] },
  { id: 'extension-reload-or-deploy', match: /重载|reload|部署|deploy|版本不匹配|version mismatch|doctor/i,
    tools: ['browser_reload_extension'], focusRequired: false,
    why: 'Target binding is resolved inside the call: one visible Chrome window is used, several return candidates instead of guessing.',
    backgroundSafe: true,
    prefer: 'Call browser_reload_extension with confirmation only, then node src/cli.js doctor.',
    fallback: ['browser_reload_extension', 'browser_queue_status'] },
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
    tools: ['browser_find_element', 'browser_fill', 'browser_click', 'browser_wait'], focusRequired: false,
    why: 'Login is ordinary form work: find the field, fill it, click submit, wait for the expected text.',
    backgroundSafe: true,
    prefer: 'Fill the username, then let Chrome autofill the password by focusing the field and accepting the suggestion, or fill it yourself if you already hold the value. Chrome does not expose stored password values to extensions or CDP, so a base cannot read them; it can only trigger the browser autofill the same way a human does.',
    fallback: ['browser_find_element', 'browser_choose', 'browser_wait', 'browser_devtools_capture'] },
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
  { capability: 'launch a browser when none is running', status: 'not_implemented', note: 'The bridge drives an already-running Chrome. Launching must reuse the existing profile so cookies and logins survive; it is not implemented yet.' },
  { capability: 'read values stored in the Chrome password manager', status: 'impossible_by_design', note: 'Chrome does not expose saved password values to extensions, CDP or UI Automation. Only triggering the browser autofill is possible.' },
  { capability: 'solve image or interactive captchas automatically', status: 'not_implemented', note: 'Reading an OTP out of a web mailbox is ordinary browsing and is supported. Deciding an image challenge is not, and would need a human or an external service.' },
  { capability: 'type into and run code in the DevTools Console', status: 'not_implemented', note: 'Console output can be captured; executing arbitrary script from the Console is not exposed.' },
  { capability: 'breakpoints, stepping and script editing in Sources', status: 'not_implemented', note: 'Not exposed yet; a paused page has no safe resume contract in a single-slot queue.' },
  { capability: 'request replay from the Network panel', status: 'not_implemented', note: 'Capture is read-only.' },
  { capability: 'write Chrome settings, certificates or proxy', status: 'not_implemented', note: 'Planner and native snapshot exist; the write/read-back loop does not.' }
];

const FOCUS_POLICY = {
  summary: 'Foreground is required only where the operating system, not the page, decides the target.',
  backgroundSafeTools: ['browser_read', 'browser_find_text', 'browser_find_element', 'browser_click', 'browser_click_verified', 'browser_fill', 'browser_fill_verified', 'browser_select', 'browser_choose', 'browser_pick', 'browser_upload', 'browser_upload_verified', 'browser_scroll', 'browser_key', 'browser_wait', 'browser_screenshot', 'browser_performance', 'browser_network_summary', 'browser_devtools_capture', 'browser_debug', 'browser_health', ...COORDINATE, 'browser_tabs', 'browser_open', 'browser_close'],
  foregroundRequiredTools: ['browser_desktop_windows', 'browser_native_snapshot', 'browser_devtools', 'browser_reload_extension'],
  advisoryOnlyStates: ['tab.active', 'window.focused', 'document.visibilityState', 'document.hasFocus'],
  guidance: 'These four states are reported for diagnosis, not as a gate. A backgrounded tab is a normal working state: do not stop a DOM, CDP or coordinate task because of them. Only Windows UI Automation still needs the foreground, because it types into the real screen. Coordinates do not: the token is bound to the DOM element and re-hit-tested, and CDP dispatches into the target by tabId. Pass requireForeground:true only when you specifically want foreground evidence.',
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
