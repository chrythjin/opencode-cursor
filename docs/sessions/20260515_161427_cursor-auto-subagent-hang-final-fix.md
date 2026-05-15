# Session: cursor/auto Subagent Tool-Continuation Hang — Final Fix

**Date:** 2026-05-15
**Session:** ses_1d5840d37ffe8Mh9QjOLh8E7Xj

## Problem

`cursor/auto` subagent calls still appeared to hang after tool requests (e.g. file reads),
even after the earlier tool-result resume ordering fix (2026-05-06).

## Root Cause

The prior Sisyphus conclusion focused on the `mcpResult` write ordering race, but that did not
explain continued failures after the ordering fix was already present.

The actual remaining failure path: the proxy could receive Cursor `mcpArgs` frames and then a
Connect end-stream/error closure before any OpenAI `role: "tool"` follow-up arrives. In that
state the Cursor bridge is already dead, but `createBridgeStreamResponse` still finalized the
client response with `finish_reason: "tool_calls"` when an active bridge entry existed. That
advertised a resumable tool call to OpenCode even though there was no live bridge left to
accept the later `mcpResult`.

The user-visible symptom: a subagent shows a tool/file-read step and then stalls or fails
continuation, because the next request contains a valid `tool_call_id` for a bridge that cannot
be resumed.

## Key Finding (Second-Order)

Even after changing the final `finish_reason` from `"tool_calls"` to `"stop"`, the tool_calls
delta was already sent to SSE before the end-stream frame arrived. OpenAI-compatible clients
could still execute the tool from the accumulated delta even though the final `finish_reason`
was `"stop"`.

Fix: do not emit `tool_calls` delta to SSE synchronously on `mcpArgs`; instead buffer it and
flush it on the next macrotask, so a same-turn bridge close can reject the request before any
tool call is exposed to OpenCode.

## Changes

### `src/proxy.ts`

- Added `pendingToolCallChunks[]` buffer in `createBridgeStreamResponse`.
- `onMcpExec` pushes tool_calls chunks to the buffer instead of sending immediately.
- `flushPendingToolCalls()` runs on next macrotask (`setTimeout(..., 0)`) and:
  - Checks bridge is still alive and in activeBridges.
  - If alive: sends all buffered chunks, then `finishStream("tool_calls")`.
  - If dead/closed: deletes active bridge, sends error chunk, `finishStream("stop", true)`.
- `finishStream()` clears the flush timer to prevent double-flush.
- Two Connect end-stream/error branches updated to call the flush path instead of sending
  `finish_reason: "tool_calls"` directly.

### `test/smoke.ts`

- `testStreamingResponseEmitsAllMcpArgs`: removed spurious `frameConnectEndStream()` appended
  after the live tool-call frames.
- `testStreamingResponseRejectsClosedToolBridge`: new test that verifies a closed bridge:
  - Emits error content `"bridge closed before tool result continuation"`.
  - Does **not** emit any `"tool_calls"` delta.
  - Finishes with `finish_reason: "stop"` and `[DONE]`.
- Full smoke suite passes.

### `docs/sessions/20260515_160924_closed-tool-bridge-rejection.md`

- Updated with second-order finding, buffer flush design, and subagent QA confirmation.

## Verification

| Check | Result |
|---|---|
| `bun test/smoke.ts` | ✓ All tests passed |
| `bun run build` | ✓ Passed |
| LSP error diagnostics (`src/proxy.ts`) | ✓ Clean |
| LSP error diagnostics (`test/smoke.ts`) | ✓ Clean |
| `rtk git diff --check` | ✓ No whitespace errors |
| Subagent QA (live file read) | ✓ Sisyphus-Junior read `AGENTS.md` in 12s, returned without hanging |

## Limitations

- Live Cursor OAuth E2E path was not exercised; subagent QA used the local proxy model route.
- Full HTTP/2 bidirectional streaming loop (`mcpArgs → tool_calls → role:tool → mcpResult → final-response`)
  is not covered by smoke; existing Known Issue remains.

## Files Changed

```
M src/proxy.ts
M test/smoke.ts
A docs/sessions/20260515_160924_closed-tool-bridge-rejection.md
```

## Related Prior Fixes

- `docs/sessions/20260506_173815_cursor-auto-tool-continuation-fallback.md` — tool call ID
  matching fallback and early stdout buffering.
- `docs/sessions/20260515_082604_cursor-auto-tool-result-resume-order.md` — write ordering
  between `mcpResult` and `onData` handler attachment.