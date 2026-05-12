# Cursor auto turnEnded SSE close

## Problem

`cursor/auto` could still appear to hang after the first streamed response text. The proxy already closed OpenAI SSE on Connect end-stream and bridge close, but live Cursor streams can emit assistant text and a `turnEnded` interaction update while keeping the HTTP/2 stream open.

In that case the client received initial `content` chunks, but the proxy never emitted the terminal OpenAI SSE chunks (`finish_reason`, usage, and `[DONE]`) because it was waiting for lower-level stream closure.

## Change

- `src/proxy.ts` now passes an optional `onTurnEnded` callback through `processServerMessage()` into `handleInteractionUpdate()`.
- `handleInteractionUpdate()` recognizes `interactionUpdate.message.case === "turnEnded"`.
- Streaming responses now call `finishStream("stop", true)` on `turnEnded` when no MCP tool execution is pending.
- Tool-call streams keep the existing `mcpArgs -> tool_calls` continuation behavior unchanged.

## Regression coverage

- Added text-delta and turn-ended Connect frame helpers in `test/smoke.ts`.
- Added `testStreamingResponseClosesOnTurnEnded`, which verifies a stream containing `textDelta` followed by `turnEnded` emits content, `finish_reason: "stop"`, and `data: [DONE]` without needing Connect end-stream.

## Verification

- `bun run build` passed.
- `bun test/smoke.ts` passed.
- Manual Bun driver imported `__testStreamToolCallsFromConnectFrames()` and verified the SSE surface emits `manual hello`, `finish_reason: "stop"`, usage, and `[DONE]` for `textDelta -> turnEnded` frames.

## Notes

This explains the observed “first response arrives, then hangs” pattern: the model had already produced text, but OpenAI-compatible clients wait for `[DONE]`. If Cursor leaves the HTTP/2 stream open after `turnEnded`, the previous proxy logic had no completion signal at the OpenAI SSE layer.
