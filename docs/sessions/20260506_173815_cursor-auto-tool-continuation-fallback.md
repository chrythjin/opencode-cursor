# Cursor Auto Tool Continuation Fallback

## Context

`cursor/auto` itself correctly maps to Cursor's server-side default model id (`default`) in both `modelDetails` and `requestedModel`. The fragile part was live bridge continuation: a tool-result follow-up only looked up active bridges by a derived key based on `modelId` and the first user text prefix.

That key can miss when a harness or subagent changes the follow-up model id, rewrites the first user message, or shares long prompt prefixes across concurrent agents.

## Changes

- Added active bridge lookup fallback by incoming OpenAI `tool_call_id` against pending Cursor MCP exec `toolCallId` values.
- Ensured the matched bridge key, not the newly derived miss key, is used when deleting and resuming a bridge.
- Buffered early bridge stdout until `onData` is registered, preventing fast bridge output from being dropped before the Connect frame parser is attached.
- Added a smoke regression for `tool_call_id` bridge selection when the exact bridge key would differ.
- Updated the investigation note with the implemented fix and remaining verification boundary.

## Implementation Details

Production code changed in `src/proxy.ts`:

- `handleChatCompletion()` now calls `findActiveBridge(bridgeKey, toolResults)` instead of reading `activeBridges.get(bridgeKey)` directly.
- `findActiveBridge()` preserves the old exact lookup as the first path. This means normal same-key continuation behavior is unchanged.
- If exact lookup misses and the request contains tool results, `findActiveBridgeKeyByToolCallId()` scans active bridges and compares incoming OpenAI tool result ids with pending Cursor MCP exec ids.
- The matched active bridge key is carried forward as `activeBridgeKey` and is used for both `activeBridges.delete(activeBridgeKey)` and `handleToolResultResume(..., activeBridgeKey, ...)`.
- `spawnBridge()` now keeps a `bufferedData` queue. If the child bridge writes length-prefixed stdout payloads before a proxy stream registers `onData`, those chunks are retained and replayed when `onData` is attached.

Regression coverage changed in `test/smoke.ts`:

- Added `__testFindActiveBridgeKeyByToolCallId` import from `src/proxy.ts`.
- Added `testToolResultContinuationFallsBackToToolCallId()`.
- The regression sets up two synthetic active bridge entries and verifies that incoming `tool-call-1` selects `bridge:auto:first-user`, even though that bridge would not be found by a newly derived key.
- The full HTTP/2 streaming tool round-trip was intentionally not committed because the in-process harness repeatedly failed before entering the product continuation path, making it a poor regression signal.

## Why This Fix Addresses The Observed Risk

Before the fix, a follow-up request could only resume a live bridge if the newly derived key matched the original key:

```ts
SHA256("bridge:" + modelId + firstUserText.slice(0, 200))
```

That is fragile for subagents because the follow-up request can differ structurally from the initial request while still carrying the exact OpenAI `tool_call_id` generated from the original Cursor MCP exec. The `tool_call_id` is therefore a stronger continuation correlation point than the first user text prefix.

After the fix, continuation order is:

1. Try the exact bridge key.
2. If exact key misses and there are tool results, match incoming `tool_call_id` against pending exec `toolCallId` across active bridges.
3. Resume the matched bridge with `mcpResult`.
4. If no match exists, fall back to the existing new-request path.

This specifically covers cases where `cursor/auto` or harness rewriting changes `modelId` or first-user-text-derived key material between the initial request and the tool-result follow-up.

## Verification

- `bun test/smoke.ts` passed.
- `bun run build` passed.
- LSP diagnostics on changed files reported no TypeScript errors. Existing Biome warnings remain.

Exact final verification commands run:

```sh
bun test/smoke.ts
bun run build
```

Observed final smoke coverage included:

- proxy start/stop and `/v1/models`
- missing user message validation
- 404 handling
- auth parameter generation
- token expiry parsing
- plugin export shape
- array content parsing
- `model: "auto"` encoding to Cursor `default`
- tool-result continuation fallback by `tool_call_id`
- refresh-before-discovery
- discovery fallback/success

## Remaining Boundary

The smoke suite does not yet perform a full HTTP/2 streaming `mcpArgs -> tool_calls -> role: tool -> mcpResult` loop. Direct harness attempts were unreliable before reaching the product continuation path, so the committed regression covers deterministic bridge selection and the existing smoke suite continues to cover the proxy HTTP surface.

If the same symptom appears again in a live Sisyphus/subagent run, the next investigation should not start with Auto routing. Capture structural continuation metadata first:

- initial request `body.model`
- follow-up request `body.model`
- derived `bridgeKey` and `convKey`
- incoming message roles/order
- assistant `tool_calls[].id`
- tool-result `tool_call_id`
- active bridge keys
- pending exec `toolCallId` values
- whether the live bridge closed before the follow-up arrived

Most likely remaining causes after this fix would be:

- the live bridge dies before `role: "tool"` follow-up arrives;
- the follow-up payload does not include the matching `tool_call_id`;
- Cursor emits multiple `mcpArgs` in one turn and only one pending exec is exposed/handled;
- another agent collides on first-user-prefix key while also reusing or confusing tool-call ids.
