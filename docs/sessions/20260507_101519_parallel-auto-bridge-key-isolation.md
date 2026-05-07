# Parallel AUTO Bridge Key Isolation

## Problem

Parallel `model: "auto"` subagent/tool-call runs could share the same legacy active bridge key derived from `modelId + firstUserText.slice(0, 200)`. When two calls used similar prompt templates, the later paused bridge could overwrite the earlier one in `activeBridges`, leaving one tool continuation stuck even though the child `h2-bridge.mjs` process and TCP connection remained alive.

## Fix

- `src/proxy.ts` now stores active bridges under a per-request UUID-suffixed key created from the legacy lookup prefix.
- Tool-result continuation still resumes by matching incoming OpenAI `role: "tool"` `tool_call_id` values against pending Cursor MCP exec `toolCallId` values.
- The tool-call fallback now returns a bridge only when one bridge contains all incoming tool result IDs, avoiding ambiguous mixed results across parallel bridges.
- Existing Cursor Auto routing remains unchanged: OpenAI `model: "auto"` is still encoded as Cursor `default` with display name `Auto`.

## Verification

- `lsp_diagnostics` on `src/proxy.ts` and `test/smoke.ts`: no errors.
- `bun test/smoke.ts`: passed.
- `bun run build`: passed.
- Manual proxy surface QA via `startProxy`: `/v1/models` returned `200`; two parallel malformed `/v1/chat/completions` requests returned `400`; `stopProxy()` cleared the active port.

## Operational Note

Already-hung OpenCode runtimes keep their in-memory bridge state and old loaded proxy code. Restart or retry in a newly started runtime after build to use this fix.
