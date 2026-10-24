# Service recovery evidence

`node src/cli.js diagnose-upgrade` includes a `usage` section for the last 48
hours. It separates command errors from extension-error records (which can
mirror the same failure), counts watchdog starts and connected transitions,
and reports missing, oversized or malformed evidence. Three or more starts
trigger an advisory investigation recommendation, never an automatic restart.
The legacy top-level error counts remain raw, mixed event counts.

Only current audit/watchdog files are sampled, not rotated files. Therefore
these counts are observed records, not a complete uptime history or an
end-to-end success rate. Connected transitions are not matched recovery pairs;
exit causes remain unknown. The summary does not include raw page/error text.

The watchdog can restore an absent service, but recovery alone does not identify
why the previous process stopped. A disconnected notification can occur before
the next watchdog health check succeeds.

Before a new service is started, `start.ps1` now copies existing `server.log` and
`server-error.log` into `.local/service-history/<UTC timestamp>-<unique suffix>/`.
The originals remain available at their normal paths. Each archive includes
metadata with `exitCause: unknown`: an empty error log does not prove a clean exit.
If preservation fails, startup emits a warning and continues recovery.

These archives stay local and are not uploaded. They may contain diagnostic
details; inspect and redact them before sharing. Archives are currently retained
without automatic pruning, so their disk usage should be monitored.

For investigation, correlate these archives with `.local/watchdog.jsonl` and
Windows/security software events. Do not infer antivirus involvement solely
from a previous, unrelated detection.

Validation: `node --test test/service-log-history.test.js test/watchdog.test.js
test/launcher-policy.test.js` passed all four tests on Windows. Tests use temporary
fixtures and do not stop the live bridge. This change takes effect on the next
normal service start; no extension reload is needed.
