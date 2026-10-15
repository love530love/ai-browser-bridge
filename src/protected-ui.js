const PROTECTED_ORIGINS = ['chrome://extensions', 'chrome://settings', 'chrome://inspect', 'chrome-extension://'];
const HIGH_RISK = new Set(['install_extension', 'remove_extension', 'toggle_developer_mode', 'change_security_setting', 'reload_extension']);

export function protectedUiPlan({ url = '', action = 'observe', target = '' } = {}) {
  const protectedPage = PROTECTED_ORIGINS.some(prefix => String(url).startsWith(prefix));
  const highRisk = HIGH_RISK.has(action);
  if (!protectedPage) return {
    status: 'ordinary_page', protectedPage: false, action, target,
    next: 'Use browser_observe/browser_find_element and the deterministic page tools.'
  };
  return {
    status: highRisk ? 'requires_user' : 'desktop_adapter_required', protectedPage: true,
    origin: String(url).split('/').slice(0, 3).join('/'), action, target,
    adapterOrder: ['windows_uia', 'computer_use_screenshot', 'manual_user_action'],
    confirmation: highRisk ? { required: true, singleUse: true, reason: 'Chrome protected UI or security-sensitive action' } : null,
    guarantees: ['No ordinary DOM success is claimed for protected UI.', 'No action is replayed after an uncertain result.', 'Chrome-enforced boundaries are not bypassed.']
  };
}

export const PROTECTED_UI_ACTIONS = [...HIGH_RISK];
