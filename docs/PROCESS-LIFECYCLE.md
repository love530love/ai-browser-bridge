# Process ownership and cleanup

The shared HTTP bridge and its watchdog are resident services. A stdio MCP
adapter is different: each connected client may legitimately own one adapter.
Do not classify all Node processes as duplicates or kill them by process name.

The MCP adapter now exits when its input reaches EOF/closes or its output pipe
breaks. It closes the SDK transport and bounds shutdown to one second, even if
an HTTP request remains pending. Existing MCP clients must reconnect to load
this change. No Chrome extension reload is required.

This is local adapter cleanup, not browser command cancellation. A previously
dispatched write may still complete in the shared service. Reconnecting clients
must observe the page and verify its outcome before another write.

Regression: a real child MCP process calls a local fixture server that deliberately
holds its response; closing stdin previously left the process alive, and now
exits with code zero within the test's 2.5-second budget. The fixture neither
contacts Chrome nor stops the live bridge.

Remaining work: start-script concurrency exclusion, identity-aware process
inventory, resource-growth sampling, and cancellation of queued jobs with clear
ownership. This fix does not establish the cause of all machine-wide slowdown,
nor detect clients that remain alive and keep their pipes open indefinitely.

## Process attribution (2026-11-14)

A machine-wide cleanup session reported 166 duplicate third-party MCP/stdio
instances under Qoder / Qoder CN / WorkBuddy hosts (`windows-control/server.py`,
`windows_mcp serve`, `jianyingdraft/server.py`). Those names have **zero hits**
in this repository. Do not attribute them to this bridge, and never kill a
process by executable name: identify ownership by the **full command line** plus
the listening PID, using the native-API probe in
`scripts/probe-service-process.ps1` (`NtQueryInformationProcess`, no WMI).

Measured at 22:04–22:15 GMT+8 on 0.40.0: `NODE_TOTAL=58`,
`BRIDGE_MCP_ADAPTERS=0`, `BRIDGE_SERVER=1` (PID 37712, command line ending in
`src\server.js`, the sole `127.0.0.1:19387` listener), `FOREIGN_MCP_IN_NODE=0`.
Four node processes were older than 12h and were **not** claimed or killed:
their ownership was not established. Attribute by **exe full path plus command
line**, never by product name: `D:\Programs\WorkBuddy\WorkBuddy.exe` and
`D:\Programs\WorkBuddyAI\WorkBuddyAI.exe` are two separate installations. At
22:18 GMT+8 the stale daemon PID 57164 resolved to the former, while this
bridge's only extension host (`extensionOwner.pid 124960`) resolved to system
Chrome at `D:\Program Files\Google\Chrome\Application\chrome.exe`. See
[docs/PROCESS-OWNERSHIP-AND-RUNTIME-DECISION.md](PROCESS-OWNERSHIP-AND-RUNTIME-DECISION.md) §1.

The remaining gap above is real but **not a current symptom**: a client that
stays alive while never closing its pipes can keep an adapter indefinitely.
Do not "fix" it with a bare `process.ppid` liveness check — an adapter started
through a shell wrapper may have a parent that exits immediately, so that check
would kill healthy adapters. An idle timeout would kill long-lived but valid
sessions. Any change here needs an explicit decision and a real child-process
boundary test (`test/mcp-lifecycle.test.js`).

## Adapter registry (2026-11-15)

The inventory gap now has an observability fix, not a kill policy. Every stdio
adapter started from the current source writes `stateDir/mcp-adapters/<pid>.json`
on start and refreshes it every 15 seconds (`AIB_ADAPTER_HEARTBEAT_MS` overrides
the interval for tests). The record carries `pid`, `ppid`, `execPath`, `argv`,
`cwd`, `startedAt` and `heartbeatAt`; the same process removes it on graceful
shutdown, including the EOF/EPIPE path in `src/mcp.js`.

`node src/cli.js adapters` reads that directory and reports `fresh` versus
`stale` by heartbeat age; it sets `liveness: "not_checked"` on purpose. A stale
heartbeat means "nobody refreshed this file", not "this pid is dead", so the
inventory neither signals nor kills anything. `--prune` deletes only registry
files older than `--older-than-hours` (default 24) and never touches a process;
`--dry-run` reports what it would delete.

The original gap is therefore **observable, not closed**: a client that stays
alive with open pipes still keeps its adapter. Closing that needs a separate
decision and the parent-identity/launch-method evidence described above.
Regressions: `test/adapter-registry.test.js` (record, heartbeat refresh,
fresh/stale inventory, age-gated prune, real child process) and the extended
`test/mcp-lifecycle.test.js` (record exists while serving, gone after EOF).

## Parent guard and process inventory (0.42.2)

The "client stays alive with open pipes" gap is now closed for the case where
ownership can be proven, without the unsafe naive `process.ppid` check:

- `src/mcp-parent-guard.js` probes the recorded parent's **name** first and
  arms only when the name is readable and is not a shell/launcher
  (`bash`, `sh`, `cmd`, `conhost`, `pwsh`, `powershell`, `node`, `npx`, `npm`,
  terminals). While armed it checks parent liveness every 30s and exits the
  adapter when the parent is gone. An unreadable name never acts: it disarms
  after three consecutive probe failures, so one transiently slow lookup cannot
  disable the guard for the session.
- Measured while building this: `tasklist.exe /FI "PID eq N"` took **over 8s on
  this host** and timed out a 5s probe, which made every parent name `null`.
  The probe therefore tries `pwsh.exe`/`powershell.exe` `Get-Process` first
  (~0.75s) and keeps `tasklist.exe` only as the last-resort fallback. Process
  names are normalized to lowercase and to an `.exe` suffix so both
  `node` and `node.exe` match the same safety rule.
- `node src/cli.js processes` is the one inventory of what this project started:
  it lists the service pid file, the watchdog pid file and every registered
  adapter with `alive`, `parentAlive`, `parentName`, `parentIsShell` and
  `orphanedCandidate`. It is `action: "report-only"`: pid files are treated as
  claims, and nothing is signalled or killed. Probes run in parallel.
- Registry files for dead adapters are still removed only by age
  (`adapters --prune`), never on a liveness guess: a live adapter with a blocked
  event loop can have a stale heartbeat.

Regressions: `test/mcp-parent-guard.test.js` (shell disarm, unreadable-name
disarm after three attempts, orphan fires only after arming, `.exe`
normalization, PowerShell-first with tasklist fallback). `node src/cli.js
runtime` additionally reports which optional runtimes are present on a new
machine; only Node >=22 is required.

