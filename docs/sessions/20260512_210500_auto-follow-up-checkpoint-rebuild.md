# Auto follow-up checkpoint rebuild fix

## Problem

`model: "auto"` could answer the first request and then hang on the next normal follow-up request. Earlier fixes covered stream termination cases, but this remaining path was caused by request state reconstruction.

OpenAI chat-completions requests are stateless and include the authoritative `messages` transcript each time. The proxy still stored Cursor `conversationCheckpointUpdate` data and reused that checkpoint when building the next request. When a checkpoint existed, `buildCursorRequest()` bypassed the parsed OpenAI history, so the follow-up could reach Cursor with stale or incomplete turn state.

## Fix

- Added `buildPayloadFromOpenAiMessages()` in `src/proxy.ts` so normal chat-completion requests always build Cursor request state from the incoming OpenAI `messages`.
- Stopped passing stored Cursor checkpoint/blobStore into `buildCursorRequest()` for fresh OpenAI requests.
- Kept the deterministic Cursor `conversationId`, so follow-ups still use the same Cursor conversation identity while rebuilding the transcript from OpenAI messages.

## Regression coverage

- Added `testFollowUpIgnoresStoredCheckpoint` in `test/smoke.ts`.
- The test verifies that an auto follow-up request is encoded with:
  - `requestedModel.modelId = "default"`
  - the latest user message as the Cursor action
  - earlier user/assistant messages rebuilt as history turns

## Verification

- `bun run build` passed.
- `bun test/smoke.ts` passed.
- Manual Bun driver imported `__testBuildPayloadFromOpenAiMessages()` and confirmed the surface output:
  - same supplied `conversationId`
  - `modelId = "default"`
  - `requestedModelId = "default"`
  - action text `second`
  - `historyTurns = 1`

## Runtime note

This changes the package files on disk. Any already-running OpenCode process using the previous plugin code must be restarted before this fix can affect live `cursor/auto` traffic.
