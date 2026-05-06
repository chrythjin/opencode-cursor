# Cursor Auto Tool-Result Continuation Investigation

Status: **fixed in current worktree**. This note records the evidence, the chosen fix, and the remaining verification boundary.

## Context

`cursor/auto` was added so OpenCode can request `model: "auto"` while the Cursor RPC uses Cursor's server-side default routing:

- OpenAI-facing model id: `auto`
- Cursor `AgentService/Run` `modelDetails.modelId`: `default`
- Cursor `AgentService/Run` `requestedModel.modelId`: `default`
- Cursor display name: `Auto`

That routing is intentional. `GetDefaultModelForCli` returns a concrete CLI default model and is not true Auto routing.

## What Is Verified

- Local OMO config uses `cursor/auto` for Sisyphus-Junior and some subagents.
- The smoke test verifies that OpenAI `model: "auto"` is encoded for Cursor as `default` in both `modelDetails` and `requestedModel`.
- Tool-result continuation no longer depends only on the derived bridge key. If the exact bridge key misses, the proxy falls back to matching incoming `role: "tool"` `tool_call_id` values against pending Cursor MCP execs on active bridges.
- The bridge stdout reader now buffers early child output until the proxy registers its `onData` callback, preventing fast Cursor/test responses from being dropped before stream processing starts.
- `bun test/smoke.ts` includes a regression check for `tool_call_id` fallback bridge selection.
- `bun test/smoke.ts` passes.
- `bun run build` passes.

## What Is Not Verified

- We do not yet have an actual Sisyphus-Junior `/v1/chat/completions` request/follow-up payload capture.
- We have not proven that Sisyphus sends `model: "default"` instead of `model: "auto"` on tool-result follow-up.
- The smoke suite does not currently exercise the full streaming tool round-trip through an HTTP/2 backend:
  `Cursor mcpArgs -> OpenAI tool_calls SSE -> role: "tool" follow-up -> Cursor mcpResult`.
  A direct HTTP/2 harness reproduction was attempted but proved unreliable before reaching the product continuation path, so the committed regression test focuses on the deterministic bridge-selection logic.

## Likely Failure Area

The proxy's active bridge lookup key is weak for agent/subagent continuation:

```ts
bridge:${modelId}:${firstUserText.slice(0, 200)}
```

This can break or collide when:

- multiple Sisyphus/subagent prompts begin with the same long template text;
- the harness rewrites, summarizes, truncates, or reorders messages between the initial request and tool-result follow-up;
- many agents use the same `modelId` (`auto`) concurrently;
- the active bridge closes before the tool-result follow-up arrives;
- Cursor emits multiple tool requests in one turn but the proxy tracks only the pending state expected by the current bridge lifecycle.

`cursor/auto` may make this easier to trigger because many agents converge on the same `modelId`, but the underlying risk is the proxy/harness continuation key and state management, not necessarily the Auto routing itself.

## Implemented Fix

- Exact active bridge lookup still happens first.
- When exact lookup misses and the request contains tool results, the proxy scans active bridges for pending execs whose `toolCallId` matches an incoming `tool_call_id`.
- The matched bridge key is used for deletion and resume, so the follow-up can continue even when the model id or first user text used to derive the original key differs.
- Early bridge stdout is buffered until `onData` is registered, closing a race where a fast bridge response could be lost before `createConnectFrameParser` is attached.

## Code Locations

- `src/proxy.ts`: `handleChatCompletion()` uses `findActiveBridge()` and carries the matched `activeBridgeKey` into delete/resume.
- `src/proxy.ts`: `findActiveBridgeKeyByToolCallId()` implements the fallback scan from incoming tool results to active bridge pending execs.
- `src/proxy.ts`: `spawnBridge()` buffers early stdout chunks until `onData` is registered.
- `test/smoke.ts`: `testToolResultContinuationFallsBackToToolCallId()` locks the fallback bridge selection behavior.
- `docs/sessions/20260506_173815_cursor-auto-tool-continuation-fallback.md`: detailed implementation and verification record.

## Operational Status

The code is ready to use for normal work. The fix covers the confirmed fragile lookup path. If a future live subagent still fails, treat it as a new residual failure mode and collect continuation metadata before changing Auto routing.

## Useful Future Diagnostic

Add temporary proxy diagnostics around initial requests and tool-result follow-ups. Log only hashes and structural metadata, not full prompt/tool content:

- `body.model`
- derived `bridgeKey`
- derived `convKey`
- hash of `firstUserText.slice(0, 200)`
- `activeBridges.has(bridgeKey)`
- incoming message roles/order
- assistant `tool_calls[].id`
- tool `tool_call_id`
- pending exec ids on the active bridge
- bridge close timing relative to tool-call emission and tool-result follow-up

That capture should distinguish between:

- model id mismatch (`auto` vs `default` or concrete Cursor model id);
- first-user-text mismatch;
- key collision between concurrent agents;
- bridge lifecycle/early-close issue;
- malformed or unsupported harness tool-result message shape.

## Remaining Follow-Up

If failures continue in a real Sisyphus run, capture the structural diagnostics above. The most likely remaining causes would be bridge death before follow-up, malformed `role: "tool"` payloads, or multiple Cursor `mcpArgs` in one turn rather than the Auto model routing itself.
