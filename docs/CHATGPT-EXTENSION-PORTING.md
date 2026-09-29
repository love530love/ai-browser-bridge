# ChatGPT Extension Porting Notes

AI-Browser-Bridge is intentionally model-neutral. It should expose browser capabilities to any local agent through MCP, HTTP, or CLI without embedding a model inside the extension.

## What Can Be Ported

- Tool naming and schemas can be mirrored into ChatGPT-style tool adapters.
- `browser_read`, `browser_debug`, `browser_ai_status`, `browser_local_judge`, `browser_choose`, and `browser_upload` can become a reusable browser-control capability set.
- The extension pairing model can be reused: local-only service, explicit token, user-loaded Chrome extension, and origin policy.
- Native upload safety can be reused: allowlisted root, realpath confinement, exact SHA256, and no path leakage to the page.
- Event-driven wakeup can be layered above the same HTTP/CLI bridge.

## What Should Not Be Ported Blindly

- Do not embed API keys or model routing in the extension.
- Do not let a cloud-only conversation claim it controls the browser without a local bridge/tool session.
- Do not make coordinate or keyboard fallback the default path for structured controls.
- Do not submit forms, publish, buy, or upload without explicit task authorization and a fresh observation.

## Adapter Shape

A ChatGPT-side adapter should:

1. Discover tools from `/tools`.
2. Check `/status` and require matching service and extension versions.
3. Use `browser_read` for normal state.
4. Use `browser_debug` for ambiguous page state.
5. Use `browser_ai_status` and `browser_local_judge` only as optional local advisory signals.
6. Use `browser_choose` for custom dropdowns.
7. Use `browser_upload` for file inputs.
8. Treat write timeouts as unknown outcome and stop.

## Open Work

- Build a thin adapter package that maps these schemas into the target ChatGPT extension format.
- Add a disposable acceptance page that verifies read, debug, choose, upload, and submit-disabled behavior.
- Add a signed manifest or checksum bundle so agents can verify which extension build is actually loaded.
