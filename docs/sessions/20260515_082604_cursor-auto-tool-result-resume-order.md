# Session: cursor/auto Tool Result Resume Ordering

## Problem

Live `cursor/auto` subagent calls still intermittently failed after a few
responses with:

```text
Tool result continuation expired or was not found. Retry the original request instead of replaying tool output.
```

This means an OpenAI `role: "tool"` follow-up arrived after the proxy could no
longer resume the paused Cursor bridge.

## Finding

`handleToolResultResume()` wrote `mcpResult` messages to the existing bridge
before it created the new SSE response and attached the bridge `onData`/`onClose`
handlers for the resumed stream.

If Cursor responded immediately after receiving the `mcpResult`, the response
bytes could be delivered to the old closed stream callback instead of the new
continuation response. That ordering race can make the resumed turn appear to
stall and eventually leave later tool-result follow-ups orphaned.

## Change

- `src/proxy.ts`: create the resumed `createBridgeStreamResponse(...)` before
  writing any `mcpResult` messages.
- `test/smoke.ts`: added a regression helper/test that verifies every
  `mcpResult` write happens after the resumed bridge data handler is attached.
- `test/smoke.ts`: extended the in-process Cursor backend with a live Run stream
  mode and added an HTTP `/v1/chat/completions` regression test that exercises
  the real proxy surface: first request emits `tool_calls`, the follow-up
  `role: "tool"` request writes `mcpResult` on the same live stream, and the
  resumed response returns assistant text.

## Verification

- `bun test/smoke.ts` passed.
- `bun run build` passed.
- LSP error diagnostics on `src/proxy.ts` and `test/smoke.ts` were clean.
- `rtk git diff --check` passed.

## Remaining live boundary

Smoke now covers a live proxy/H2-bridge resume loop against the test backend.
Live OpenCode subagent traffic should still be watched because Cursor's real
HTTP/2 server timing can differ from the deterministic in-process backend.
