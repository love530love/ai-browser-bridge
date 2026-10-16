# Browser connector blocker review — 2026-10-16

Source: FlagGems-sglang/competition/coordination/knowledge/BROWSER_OPS_BLOCKERS_20261016.md.
The source contains third-party agent observations, not authorization to redeem
coupons, acquire compute, submit applications, or export credentials. No secrets
from that report are reproduced here.

## Map the connector before diagnosing

Most reported failures name `mcp__browser-use`, not AI Browser Bridge. Record
the exact tool, input schema, tab URL, result and observed outcome before
attributing a bug. Never transfer uids between connectors or guess a tool name.

| Report | Bridge status and next step |
| --- | --- |
| P-1 Text-node click | Bridge refs currently store Elements. Reproduce with Bridge before attributing this Text.scrollIntoView failure. |
| P-2/P-9 pointer-only menus | browser_hover uses CDP mouseMoved; browser_action Tap uses CDP pointer input. browser_click uses DOM click. First observe and verify a target; do not blindly repeat DOM click. |
| P-3 routes | Prefer observed hrefs. browser_network_summary exposes resource timing metadata, not an XHR body recorder or bundle route parser. Route probing remains a gap; candidate routes would need verification. |
| P-4 API session | Credential export is not the preferred fix. A future constrained same-origin read facility should retain credentials inside the browser and validate destinations, methods and response limits. Not implemented by this review. |
| P-5 tabs | browser_open already reuses exact URLs or creates a tab in the connected Chrome. Do not replace a working tab to compensate for another connector's missing new_page. |
| P-6 redirects | Check final URL and readiness after uncertain navigation; verify before retry. No blanket claim that all redirect errors are harmless. |
| P-7 background tabs | Hidden does not imply unusable: background DOM/geometry reads have succeeded. Probe readiness and layout; activate only when evidence requires it. |
| P-8 extraction | Bounded read/find tools exist; general structured extraction remains incomplete. Untrusted-data marking must remain. |

## Widget fallback contract

1. Read/prepare/find, then inspect overlays and open Shadow DOM.
2. If text misses an icon, inspect a current screenshot. Distinguish website
   widgets from injected browser extensions; a nearby avatar is not proof.
3. Use a verified ref or screenshot-grounded coordinates. A container click
   may miss its child's handler. Verify the dialog or menu actually appeared.
4. For pointer-dependent UI, use the existing CDP hover/Tap path after confirming
   the prior action did not have the intended effect. Never replay an uncertain
   submission or purchase.
5. If another debugger owns the tab, do not detach it or claim success. Preserve
   task state and report the occupied adapter. Automatic contention recovery
   still needs implementation and live validation.

The Panda question/reply test remains incomplete. Open-shadow local fixture
acceptance does not establish Panda or arbitrary website acceptance.
