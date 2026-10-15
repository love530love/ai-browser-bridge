# Complex component operations: implementation and acceptance

Use the existing Chrome session. Observe the authorized page, scan overlays,
then call `browser_shadow_tree` when ordinary element lookup misses a widget.
Its controls now include snapshot refs for `browser_click` and `browser_fill`.
Re-scan after a component changes; never guess a ref or fill an unrelated textarea.

Open shadow roots are traversed for pointer hit testing. A covering sibling
still blocks a click. Closed roots and inaccessible frames are not solved by
this change: use a current screenshot to locate a verified target and the
available pointer/keyboard adapter, then read back the result. If the target
cannot be identified, preserve the task and report the missing observation.

## Acceptance status

- Existing-browser basic input/click/readback/scroll/screenshot smoke: passed
  on 2026-10-15 before this change.
- Shadow refs: installed-extension input/click/readback and transparent-overlay rejection passed after manual reload on 2026-10-15.
- Panda assistant question and reply: pending; do not claim completed.
- Desktop extension reload: best effort, not guaranteed. Verification now uses
  the configured port, authenticated status request and exact manifest version.
- Hardware scheduling and universal desktop fallback: not implemented here.

The installed smoke suite now requires a shadow input/button round trip and
rejection of a click covered by a transparent overlay. On 2026-10-15 the
installed extension failed the actionable-ref assertion; basic smoke passes
must not be interpreted as this feature being deployed. The fixture is local
and the test closes only its own tab, including on failure.

Shadow scanning now has a 10,000-node/200ms traversal budget and reports partial
results. Its nextSteps explicitly direct clients to screenshot when no verified
target exists. A scan is observation, not permission to click unrelated widgets.

All MCP clients discover the same tool schema through tools/list. Clients
that cache schemas must refresh their MCP connection. No model is required
for the deterministic ref and hit-test operations.

## Installed acceptance after manual reload

On 2026-10-15, `node test/live-installed-smoke.js` completed successfully
using the existing Chrome: shadow input fill, shadow button click, response
readback and transparent-overlay click rejection all passed. The test closed
only its own tab. Report: `output/live-installed/report.json`. This confirms
the new code is active despite retaining version 0.5.14; it does not verify
automatic extension reload, closed roots, or the real Panda assistant.
