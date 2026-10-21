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
