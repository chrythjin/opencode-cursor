# Tool-result continuation replay guard

**Date**: 2026-05-13
**Files**: `src/proxy.ts`, `test/smoke.ts`

## Problem

When a follow-up OpenAI request contained `role: "tool"` results but the matching paused Cursor bridge was missing or already dead, `handleChatCompletion()` could fall through and start a fresh Cursor run. In practice that allowed failed tool output such as `No files found` to be replayed as a new Cursor action, which could make the model repeat the same `Glob` / `Read` attempt indefinitely.

## Change

- `src/proxy.ts` now rejects orphaned or expired tool-result continuations with HTTP `409` and `type: "tool_result_continuation_not_found"`.
- Dead active bridges are still cleaned up, but the proxy no longer starts a fresh Cursor turn from tool output.
- `test/smoke.ts` adds a regression test that sends an orphan `role: "tool"` chat completion request through the real proxy HTTP surface and asserts:
  - response status is `409`
  - the test Cursor backend receives no `Run` request

## Verification

- `bun test/smoke.ts` passed.
- `bun run build` passed.
- LSP diagnostics on changed TypeScript files reported no errors. Existing Biome warnings remain in `src/proxy.ts` and `test/smoke.ts`.

## Notes

This does not retry the original request automatically. The client must retry the original user request if it wants to recover after a lost bridge; replaying tool output is explicitly rejected to avoid repeated tool-call loops.
