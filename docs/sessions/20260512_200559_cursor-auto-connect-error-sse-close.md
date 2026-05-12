# Cursor Auto Connect Error SSE Close Fix

## Problem

`cursor/auto` could emit initial response content and then leave the OpenAI-compatible client waiting indefinitely.

The earlier fixes covered normal Connect end-stream completion, tool-call completion, interactionQuery rejection, and deterministic conversation IDs. The remaining reproducible gap was the Connect end-stream error path: when Cursor returned a Connect end-stream payload with `error`, the proxy emitted an error text chunk but never emitted `finish_reason`, usage, `[DONE]`, or closed the SSE controller.

## Root cause

In `src/proxy.ts`, `createBridgeStreamResponse()` handled `parseConnectEndStream(endStreamBytes)` errors by only calling:

```ts
sendSSE(makeChunk({ content: `\n[Error: ${endError.message}]` }));
```

That left the SSE stream open. From OpenCode's surface this looks like “first response arrives, then it waits forever.”

Subagent review independently identified the same high-probability path. A secondary remaining live-only candidate is Cursor keeping the HTTP/2 stream open without sending a Connect end-stream or closing the bridge; that path is not covered by this fix.

## Change

- `src/proxy.ts`
  - Connect end-stream errors now delete the active bridge entry and call `finishStream("stop", true)` after emitting the error text.
  - `finishStream()` is idempotent, so a later bridge close cannot double-send terminal SSE chunks.
- `test/smoke.ts`
  - Added `frameConnectEndStreamError()`.
  - Added `testStreamingResponseClosesOnConnectError()` to assert error text, `finish_reason: "stop"`, and `data: [DONE]` are emitted.

## Verification

- `bun run build` passed.
- `bun test/smoke.ts` passed.
- Manual SSE driver imported `__testStreamToolCallsFromConnectFrames()`, injected a Connect end-stream error frame, and verified:
  - error text was emitted,
  - `finish_reason: "stop"` was emitted,
  - `data: [DONE]` was emitted.

## Remaining diagnostic note

If `cursor/auto` still hangs after this change, the next likely class is not an error end-stream but a live Cursor HTTP/2 stream that emits content and then remains open without a Connect end-stream or bridge close. That requires live bridge logging around `h2Stream.on("data")`, `h2Stream.on("end")`, and proxy `createBridgeStreamResponse()` terminal paths.
