# Cursor auto modelDetails retest

## Context

Explore subagent calls through the Cursor provider failed with:

```text
Connect error invalid_argument: Model details are required
```

The failure meant the Cursor `AgentService/Run` request path was not receiving a usable `modelDetails` payload for automatic model routing.

## Change

- Updated `src/proxy.ts` so `auto` is resolved before building the Cursor run request.
- `auto` now maps to the first non-auto model known to the proxy, then `modelDetails` is always populated on `AgentRunRequest`.
- Kept `/v1/models` exposing `auto` for OpenCode model selection while avoiding sending `auto` as the lower-level Cursor run model.

## Evidence

- Public implementation research indicates Cursor's lower-level `AgentService/Run` requires concrete `ModelDetails`; the higher-level Cloud Agent REST API's omitted-model default behavior does not apply directly to this protobuf RPC.
- `bun run build && bun test/smoke.ts` passed after the change.
- Smoke coverage verifies that `model: "auto"` is encoded as `modelDetails.modelId === "composer-2"` when `composer-2` is the discovered model.
- Fresh `opencode run -m cursor/composer-2 ...` returned a model response, confirming a newly started OpenCode process can route through the local Cursor plugin.
- Fresh `opencode run -m cursor/auto ...` no longer returned `Model details are required`; it failed with `resource_exhausted`, which indicates the modelDetails validation blocker was passed and the remaining issue is account/quota/rate-limit related.

## Caveat

The already-running interactive OpenCode session may keep plugin/proxy code in memory, so in-session `task()` retests can continue showing the old error until OpenCode is restarted or the provider is reloaded.
