# Completed transcript replay guard

## Context

After the stream hang fixes, the proxy could receive an OpenAI `messages` array that ended with an assistant response and no new user message. The parser previously treated the last completed user/assistant pair as if the user message were a fresh Cursor action.

That can replay stale user text from conversation history, causing the model to continue repeating irrelevant prior work instead of waiting for an actual new user request.

## Change

- `src/proxy.ts` no longer promotes the last completed `user -> assistant` history pair into a new Cursor `userMessageAction`.
- A request with only completed transcript history and no tool result now follows the existing missing-user-message validation path instead of starting a new Cursor run.
- Added smoke regression `testCompletedTranscriptDoesNotReplayLastUser`.

## Verification

- `bun test/smoke.ts` passed.
- `bun run build` passed.
- LSP diagnostics on changed files showed no new TypeScript errors; existing Biome warnings remain.
