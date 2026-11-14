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
