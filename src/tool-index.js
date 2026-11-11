// The intent index: a few hundred bytes that answer "which tool do I want",
// where the full schema dump answers it in 68.6 KB.
//
// Measured on the previous release: listing 111 tools with descriptions cost
// 68.6 KB, and a real session used 11 of them. The two extremes were both
// unusable - names alone are not enough to choose, and descriptions are too
// expensive to read before every task. This sits in between and is ordered by
// what a task actually starts with.
//
// It is data, not prose: every name here is checked against the real tool list
// by test/tool-index.test.js, so the index cannot advertise a tool that was
// renamed or removed.

export const TOOL_GROUPS = [
  { id: 'read', purpose: '读页面、读元素、拿 ref；扫不到就 eval', tools: [
    'browser_at', 'browser_read', 'browser_eval', 'browser_observe', 'browser_ax_snapshot', 'browser_find_text',
    'browser_find_element', 'browser_shadow_tree', 'browser_frames', 'browser_performance',
    'browser_wait_for_selector'
  ] },
  { id: 'act', purpose: '点、填、选、按键、滚动', tools: [
    'browser_prepare_action', 'browser_click', 'browser_click_verified', 'browser_fill',
    'browser_fill_verified', 'browser_select', 'browser_select_verified', 'browser_choose',
    'browser_choose_verified', 'browser_pick', 'browser_key', 'browser_hover', 'browser_scroll',
    'browser_scroll_element', 'browser_action', 'browser_action_verified',
    'browser_prepare_coordinate', 'browser_drag', 'browser_upload', 'browser_upload_verified',
    'browser_dialog', 'browser_wait'
  ] },
  { id: 'overlay', purpose: '遮挡层、浮层、toast、tooltip', tools: [
    'browser_scan_overlays', 'browser_dismiss_overlay', 'browser_transient', 'browser_popup'
  ] },
  { id: 'network', purpose: '同源请求：先判风险、再发、再回读', tools: [
    'browser_prepare_request', 'browser_fetch', 'browser_replay_request',
    'browser_network_summary', 'browser_network_rules', 'browser_devtools_capture'
  ] },
  { id: 'tab', purpose: '标签、导航、窗口', tools: [
    'browser_tabs', 'browser_open', 'browser_close', 'browser_navigate', 'browser_navigate_verified',
    'browser_navigation', 'browser_claim_tab', 'browser_renew_tab', 'browser_release_tab',
    'browser_tab_lease', 'browser_windows', 'browser_tab_groups', 'browser_session_restore', 'browser_launch'
  ] },
  { id: 'auth', purpose: '登录态、凭据、cookie、站点存储', tools: [
    'browser_login_state', 'browser_credential_lookup', 'browser_password_manager_reveal',
    'browser_otp_fetch', 'browser_identity', 'browser_cookies', 'browser_cookies_write',
    'browser_storage_read', 'browser_storage_write'
  ] },
  { id: 'capture', purpose: '截图、PDF打印保存、整页MHTML保存、剪贴板、模拟与注入', tools: [
    'browser_screenshot', 'browser_pdf_save', 'browser_save_page', 'browser_clipboard',
    'browser_clipboard_write', 'browser_emulation', 'browser_init_script'
  ] },
  { id: 'download', purpose: '查下载列表、等待一个精确下载ID完成、管理下载项', tools: [
    'browser_downloads', 'browser_download_wait', 'browser_downloads_control'
  ] },

  { id: 'fleet', purpose: '宿主', tools: [
    'browser_hosts', 'browser_scheduler_status', 'browser_route_task'
  ] },
  { id: 'debug', purpose: '诊断/队列', tools: [
    'browser_health', 'browser_debug', 'browser_failure_help', 'browser_queue_status',
    'browser_wait_until_ready', 'browser_capability_guide', 'browser_bridge_modes',
    'browser_execution_profile', 'browser_debugger', 'browser_ai_status',
    'browser_local_judge', 'browser_agent_guide', 'browser_capabilities', 'browser_tool_index'
  ] },
  { id: 'desktop', purpose: '原生窗口与 UI Automation（chrome:// 等）', tools: [
    'browser_desktop_windows', 'browser_native_snapshot', 'browser_native_action',
    'browser_devtools', 'browser_protected_ui_plan', 'browser_reload_extension',
    'browser_extension_errors'
  ] },
  { id: 'recipe', purpose: '把一段流程存成可复用的 recipe', tools: [
    'browser_recipe_save', 'browser_recipe_run', 'browser_recipe_list', 'browser_recipe_delete'
  ] },
  { id: 'maintenance', purpose: '浏览器自身设置（低频）', tools: [
    'browser_bookmarks', 'browser_bookmarks_write', 'browser_history', 'browser_history_search',
    'browser_history_delete', 'browser_extensions', 'browser_extension_state', 'browser_clear_browsing_data',
    'browser_site_settings', 'browser_site_settings_write', 'browser_privacy_settings',
    'browser_privacy_settings_write', 'browser_windows_control', 'browser_proxy',
    'browser_proxy_write', 'browser_native_messaging', 'browser_native_ports',
    'browser_native_host', 'browser_native_host_install', 'browser_certificates',
    'browser_certificates_write'
  ] }
];

// Words a caller might use that do not appear in a group id or tool name.
const ALIASES = {
  network: ['api', '接口', 'post', 'get', 'http', '请求', '回读', 'verify', '写操作', 'fetch'],
  act: ['点击', '输入', '填写', '上传', '附件', 'click', 'fill', 'type', 'upload', 'attach file', '提交', 'submit'],
  read: ['读', '文本', '元素', 'text', 'dom', '内容', 'js', 'eval', 'evaluate', '脚本', 'script', 'expression', '执行'],
  overlay: ['遮挡', '弹窗', '蒙层', 'covered', 'popup', 'toast'],
  tab: ['标签页', '窗口', 'tab', 'navigate', '打开'],
  auth: ['登录', '密码', 'login', 'password', 'cookie', 'token'],
  capture: ['截图', 'screenshot', 'pdf', '打印成pdf', '保存网页为pdf', '剪贴板'],
  download: ['下载', '下载列表', '下载记录', '下载状态', '下载项', 'download', 'download list', 'download history', 'download status', 'download item'],
  debug: ['报错', '卡住', '失败', 'error', 'stuck', '诊断'],
  desktop: ['原生', 'chrome://', 'uia', '窗口句柄'],
  recipe: ['流程', '复用', 'flow'],
  maintenance: ['书签', '历史', '扩展', '代理', '证书', '设置']
};

const englishAliasMatches = (needle, alias) => {
  const escaped = alias.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`\\b${escaped}\\b`, 'i').test(needle);
};

function matches(goal) {
  const needle = goal.toLowerCase().replace(/\s+/g, ' ').trim();
  return TOOL_GROUPS.filter(group => {
    if (group.id === needle || group.id.includes(needle)) return true;
    if (needle && group.purpose.toLowerCase().includes(needle)) return true;
    if ((ALIASES[group.id] ?? []).some(raw => {
      const alias = raw.toLowerCase();
      return needle.includes(alias) || (/^[a-z0-9 ]+$/i.test(alias) && englishAliasMatches(needle, alias));
    })) return true;
    return group.tools.some(name => needle === name || (needle.length >= 8 && needle.includes(name)));
  });
}

// Ordered by first use: read and act come first because almost every task
// starts there, and the low-frequency browser-settings group is last on purpose.
export function toolIndex({ goal = '', group: only = '', format = 'text' } = {}) {
  const wanted = typeof only === 'string' ? only.trim().toLowerCase() : '';
  let groups = wanted ? TOOL_GROUPS.filter(item => item.id === wanted) : TOOL_GROUPS;
  if (wanted && !groups.length) {
    return { status: 'denied', retryable: false, reason: 'unknown_group',
      known: TOOL_GROUPS.map(item => item.id),
      message: `No group called "${only}". Pick one of the listed ids, or omit group to get all of them.` };
  }
  const term = typeof goal === 'string' ? goal.trim() : '';
  if (term) {
    const narrowed = matches(term);
    if (narrowed.length) groups = groups.filter(item => narrowed.includes(item));
  }
  if (format === 'json') {
    return { status: 'success', retryable: false, groups: groups.map(item => ({ id: item.id, purpose: item.purpose, tools: item.tools })),
      matchedGoal: term || null,
      nextStep: 'Call browser_capability_guide with the same goal for the detailed path, foreground requirements and fallbacks.' };
  }
  const lines = groups.map(item => `${item.id.padEnd(12)} ${item.purpose}\n${' '.repeat(13)}${item.tools.join(', ')}`);
  return {
    status: 'success', retryable: false, matchedGoal: term || null,
    groups: groups.map(item => item.id),
    index: lines.join('\n'),
    nextStep: 'Pick a tool from the group that matches the task, then read that one tool schema. Call browser_capability_guide with the goal for foreground requirements and fallback order; call browser_agent_guide for the operating rules.'
  };
}
