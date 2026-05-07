# Multi MCP Args Tool-Call Emission

Date: 2026-05-07

## Context

After the earlier `cursor/auto` active bridge key isolation fix, the remaining live failure risk was a Cursor stream that emits more than one `mcpArgs` execution before the proxy closes the OpenAI SSE response for tool execution.

The previous stream handling closed the SSE response immediately inside the first `mcpArgs` callback. If additional `mcpArgs` frames were already buffered in the same bridge output chunk, they could be skipped, leaving the caller with only the first OpenAI `tool_call` while Cursor had more pending MCP executions.

## Change

- `src/proxy.ts` now schedules the `finish_reason: "tool_calls"` chunk and stream close with `queueMicrotask()` the first time an MCP exec is seen.
- This lets all already-buffered `mcpArgs` frames in the current parser turn emit their OpenAI `tool_calls` before the response closes.
- The active bridge still keeps the full shared `pendingExecs` array so the follow-up `role: "tool"` request can resume with all matching tool results.
- Added `__testEmitToolCallsFromConnectFrames()` as a focused test hook for Connect-frame parser behavior.
- Added a smoke regression that feeds two `mcpArgs` frames plus an end-stream frame and asserts both tool call IDs are collected.

## Verification

- `bun test/smoke.ts` passed.
- `bun run build` passed.
- Manual proxy surface QA passed:
  - `GET /v1/models` returned `200` with `composer-2` and appended `auto`.
  - Invalid `POST /v1/chat/completions` with no messages returned `400` and `No user message found`.

## Notes

- Existing Biome diagnostics remain in `src/proxy.ts` and `test/smoke.ts` for import ordering, non-null assertions, explicit `any`, and an unused `deterministicConversationId`; they predate this change.
- A full live Cursor HTTP/2 multi-tool round-trip is still not covered by the smoke backend. The new regression covers the product parser path that previously closed too early.
