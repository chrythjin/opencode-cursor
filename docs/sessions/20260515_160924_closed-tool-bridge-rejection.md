# Session: Closed Tool Bridge Rejection

## Problem

`cursor/auto` subagent calls still appeared to hang after a tool request such as
file reads, even after the earlier tool-result resume ordering fix.

The prior Sisyphus conclusion focused on the `mcpResult` write ordering race,
but that did not explain continued failures after the ordering fix was already
present.

## Finding

The remaining failure path is different: the proxy could receive Cursor
`mcpArgs` frames and then a Connect end-stream/error closure before any OpenAI
`role: "tool"` follow-up can arrive.

In that state the Cursor bridge is already dead, but `createBridgeStreamResponse`
still finalized the client response with `finish_reason: "tool_calls"` when an
active bridge entry existed. That advertised a resumable tool call to OpenCode
even though there was no live bridge left to accept the later `mcpResult`.

The user-visible symptom is a subagent showing a tool/file-read step and then
stalling or failing continuation, because the next request contains a valid
`tool_call_id` for a bridge that cannot be resumed.

## Change

- `src/proxy.ts`: when the Connect stream ends while tool calls are pending,
  delete the active bridge entry, emit a clear bridge-closed error chunk, and
  finish with `finish_reason: "stop"` instead of `"tool_calls"`.
- `src/proxy.ts`: buffer pending `tool_calls` SSE deltas until the next macrotask,
  so a same-turn bridge close can reject the request before any tool call is
  exposed to OpenCode.
- `test/smoke.ts`: adjusted the multi-tool frame helper so it only asserts live
  pending tool calls without appending an end-stream frame.
- `test/smoke.ts`: added `testStreamingResponseRejectsClosedToolBridge` to lock
  the intended behavior: closed bridge + pending `mcpArgs` must not emit any
  OpenAI `tool_calls` delta and must not advertise resumable tool calls.

## Verification

- `bun test/smoke.ts` passed twice.
- `bun run build` passed.
- LSP error diagnostics on `src/proxy.ts` and `test/smoke.ts` were clean.
- A synchronous Sisyphus-Junior subagent read `AGENTS.md` and returned in 12s
  without hanging after the file-read operation.

## Notes

This does not weaken the live bridge continuation path: the existing HTTP live
bridge resume smoke test still passes, so a live bridge can still emit
`tool_calls` and later resume from `role: "tool"`.

The subagent QA confirms this session's subagent/tool-read path completed. It is
not a live Cursor OAuth production call because the active category model in the
test run reported `openai-oauth/gpt-5.5-medium`.
