# Complex component operations: implementation and acceptance

## Debugger contention (2026-10-17, source implementation)

An attachment conflict now returns `status: waiting`, `reason: debugger_busy`
and `dispatched: false`. Screenshots are retryable through the existing bounded
CLI/MCP waiting recovery. Input calls return `retryable: false` and
`requiresObservation: true`: retain the task, wait for the owner to finish,
then re-observe and issue a fresh action. Do not replay stale coordinates.
No competing debugger is detached. Failures after attachment remain errors
with potentially unknown effects. Unit tests cover attachment contention,
successful later acquisition and post-attachment failures. Live acceptance
requires reloading the updated extension and is not yet claimed.

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

## Element Plus forms (2026-11-18 field report)

Measured on a jeecg-boot + Element Plus registration form (Bridge 0.46.0,
Chrome 156). The write succeeded, but two controls had no audited route and one
display panel was mistaken for evidence.

| Control | Reliable action | Evidence |
|---|---|---|
| `el-radio` | Click the hidden native input: `browser_eval_verified` with `document.querySelectorAll('.el-radio__original')[n].click()`, an `expect` (`anyChange:true` or a branch naming the revealed field) and a `commandId`. Clicking the visible label does not change the model. | eval reply `{"after":true,"v":"1"}`; the form submitted with that value. |
| `el-checkbox` | Clicking the label works; `browser_click_verified` with `elementLabelAppears` or a DOM-change expectation is enough. | Rule checkbox stayed checked and the submit advanced. |
| `el-date-editor` | `browser_fill_verified` with `YYYY-MM-DD` plus `input` + `change`; the component accepts it and posts it. | Reply `persisted:true`; final submission succeeded. |
| Right-hand summary panel | **Not evidence.** It does not update live (name still showing the phone number, birth date still `--`) while the underlying inputs already hold the new values. | `browser_read` text disagreed with `includeFormValues`; the submit still carried the filled values. |

Rules that follow from the table:

- The component's rendered summary is a view cache, not the model. Verify with
  `browser_read includeFormValues:true`, the submit result, or the API response.
- A submit is a branching outcome. Use `expect` with `anyOf`
  (`urlContains` the landing route, `elementLabelAppears:"待审核"`,
  `textAppears` with `stableForMs`) rather than a bare phrase such as `"成功"`,
  which a leftover login toast already satisfies. If the reply is
  `not_dispatched`, read `matchedIn`: a `transient:true` match means the phrase
  was painted by an old notice, and the expectation must change - not retried.
- `javascript:void(0)` menu links are inert same-origin handlers; a
  `browser_click` on them is reported with `inlineNavigation:true` instead of an
  origin refusal. Real cross-origin links stay refused.
- Never inject a zoom overlay to read a captcha. Use
  `browser_capture_element(ref, scale:4)` (read-only, background-safe) and fill
  the answer within the server's validity window; a rejected captcha is more
  often expired than misread.
