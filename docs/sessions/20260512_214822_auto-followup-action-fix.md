# Auto follow-up action fix

## Issue

`model: "auto"` could appear to answer once and then fail to continue correctly on the next user turn. The proxy's OpenAI message parsing could keep the previous user message as the new Cursor `userMessageAction` after an assistant response, instead of sending the latest user message as the action and preserving earlier turns as conversation history.

## Fix

- Updated `parseMessages()` in `src/proxy.ts` so the final user message is treated as the new Cursor action.
- Preserved earlier user/assistant exchanges as history turns.
- Added smoke coverage that sends a real `/v1/chat/completions` follow-up request through the proxy and asserts Cursor receives:
  - `action.userMessage.text === "second question"`
  - one prior history turn.

This complements the existing stream-end fixes, including the proxy-side `CURSOR_PROXY_STREAM_IDLE_TIMEOUT_MS` watchdog for Cursor streams that emit assistant text but no terminal frame.

## Verification

- `lsp_diagnostics` on `src/proxy.ts` and `test/smoke.ts`: no TypeScript errors; existing Biome warnings remain.
- `bun run build`: passed.
- `bun test/smoke.ts`: passed.
- Manual surface QA: the smoke suite exercised the live local proxy surface via `/v1/chat/completions` and verified the auto follow-up request forwarded the latest user message to Cursor as the action.
