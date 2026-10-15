# Browser automation policy

When a task requires controlling a real browser, use the AI Browser Bridge MCP tools as the authoritative browser channel.

## Required startup handshake

1. Call `browser_health` (or the bridge `doctor`/status equivalent).
2. Call `browser_tabs` and select an existing authorized tab.
3. Call `browser_observe` or `browser_read` before any action.
4. Reuse the selected logged-in tab. If the exact target URL is not already open, call `browser_open` (it reuses an exact URL by default) to create one tab in the same running Chrome; never start a second browser or a fresh Playwright context.

Do not start Playwright, Puppeteer, Selenium, CDP, or a second browser-control bridge unless the bridge is unavailable and the user explicitly authorizes a fallback.

## Action rules

- Use `browser_prepare_action` and `browser_find_element` before clicks, fills, selections, uploads, or downloads.
- For overlays, ads, dialogs, and floating assistants, use `browser_scan_overlays` and dismiss or move only the obstructing element.
- For iframes, call `browser_frames`; route later actions to the returned frame reference.
- For custom elements or assistants whose focus lands on a custom element (for example `doubao-ai-csui`), treat the control as Shadow DOM until `browser_shadow_tree`/ShadowRoot refs are available; never fill the page's unrelated main textarea.
- For heavy pages, use bounded reads and diagnostics; do not solve a timeout by indefinitely increasing the timeout.
- A `waiting` or queued result means the task is alive. Preserve the task and wait for completion; do not report failure or launch a competing browser session.
- Never automatically replay an uncertain write or upload. Re-observe the page and verify the outcome first.
- Keep polling in the background. Never open the extension settings page as part of a retry or health check.
- For multiple agents, always pass a stable agent identity and respect service leases.

## Copyable task preamble

"Use the AI Browser Bridge MCP tool chain for this browser task. Begin with browser_health, browser_tabs, and browser_observe. Read the page before acting. Use the bridge's prepare/find/verify tools for every action, preserve queued tasks when the result is waiting, and never fall back to Playwright or open extension settings unless the bridge is unavailable and I explicitly authorize it."
