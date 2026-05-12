# Cursor Auto tool-call and non-streaming hang fix

## Summary

Fixed two proxy hang paths that affected Cursor Auto and the smoke harness:

1. Streaming Cursor `mcpArgs` frames now close the OpenAI SSE response with `finish_reason: "tool_calls"` on the next microtask while keeping the active bridge alive for the follow-up `role: "tool"` resume.
2. Non-streaming `AgentService/Run` collection now ends the bridge stdin after the initial request and resolves on Connect end-stream, avoiding the HTTP/2 request-body deadlock observed in `testArrayContentParsing`.

## Changes

- `src/proxy.ts`
  - Restored microtask-delayed `tool_calls` finish in `createBridgeStreamResponse()` so OpenCode receives tool calls promptly instead of waiting for bridge close.
  - Narrowed the bridge parameter type for `createBridgeStreamResponse()` and `ActiveBridge` to the methods the stream path uses, enabling a lightweight test bridge.
  - Added `__testStreamToolCallsFromConnectFrames()` to exercise the real SSE close behavior for mcpArgs frames.
  - Updated `collectFullResponse()` to resolve on Connect end-stream and close the write side after sending the initial non-streaming request.
- `test/smoke.ts`
  - Added coverage that multi-tool mcpArgs frames produce `finish_reason: "tool_calls"` and `[DONE]`, not just pending tool-call IDs.

## Verification

- `bun run build` passed.
- `bun test/smoke.ts` passed.
- Targeted Bun driver importing `__testStreamToolCallsFromConnectFrames()` confirmed SSE output includes `finish_reason: "tool_calls"` and `data: [DONE]`.
- LSP diagnostics show only pre-existing Biome warnings (`noExplicitAny`, non-null assertions, import sorting, unused callback parameter); no TypeScript errors.

## Notes

The untracked `.sisyphus/run-continuation/...json` file was already present and was not touched.
