# Cursor Auto subagent patch summary

Date: 2026-05-14

## Current patch

This patch fixes a request-surface mismatch for Cursor Auto when subagents call the provider-qualified model id `cursor/auto`.

Before this patch, `src/proxy.ts` only treated the exact OpenAI-compatible model id `auto` as Cursor Auto. A subagent routed through the Cursor provider can send `model: "cursor/auto"`; that value then bypassed the Auto mapping and reached Cursor as a literal lower-level model id instead of the intended Cursor Auto/default routing.

The proxy now normalizes the local Cursor provider prefix before the chat-completion request is processed:

```ts
const CURSOR_PROVIDER_PREFIX = "cursor/";

function normalizeOpenAIModelId(modelId: string): string {
  return modelId === `${CURSOR_PROVIDER_PREFIX}${CURSOR_AUTO_PROXY_MODEL.id}`
    ? CURSOR_AUTO_PROXY_MODEL.id
    : modelId;
}
```

`handleChatCompletion()` uses the normalized model id for request building, bridge key derivation, active bridge lookup, and response model metadata. With this change, both `auto` and `cursor/auto` follow the same existing Cursor Auto route:

- `modelDetails.modelId = "default"`
- `requestedModel.modelId = "default"`
- display name remains `Auto`

Explicit non-Auto model ids are unchanged. The normalization is deliberately limited to the known subagent case `cursor/auto` so the patch does not change concrete model routing.

## Files changed in this patch

### `src/proxy.ts`

- Added `CURSOR_PROVIDER_PREFIX = "cursor/"`.
- Added `normalizeOpenAIModelId(modelId)`.
- Changed `handleChatCompletion()` to derive its internal `modelId` from `normalizeOpenAIModelId(body.model)` instead of using `body.model` directly.

### `test/smoke.ts`

- Extended `testAutoModelSendsCursorDefaultModel()` with a real proxy request using `model: "cursor/auto"`.
- Asserted the provider-qualified Auto request reaches the test Cursor backend as Cursor default routing:
  - `qualifiedAutoRequest.modelId === "default"`
  - `qualifiedAutoRequest.requestedModelId === "default"`
- Added an explicit-model guard that `model: "cursor/composer-2"` remains unchanged, so the patch cannot silently broaden into all-provider-prefix stripping.

### `docs/sessions/20260514_122359_cursor-auto-provider-qualified-subagent.md`

- Added the session-level implementation record for this patch.

## Verification performed for this patch

- `lsp_diagnostics` on `src/proxy.ts`: no TypeScript errors; existing Biome warnings remain.
- `lsp_diagnostics` on `test/smoke.ts`: no TypeScript errors; existing Biome warnings remain.
- `bun test/smoke.ts`: passed. The suite includes the updated Auto encoding regression.
- `bun run build`: passed with `tsc -p tsconfig.json && node scripts/copy-runtime.mjs`.

## Live symptom observed during this session

Two background explore tasks initially launched on `cursor/auto` failed before returning useful results with:

```text
Tool result continuation expired or was not found. Retry the original request instead of replaying tool output.
```

The harness retried both tasks on `minimax-coding-plan/MiniMax-M2.7`. This symptom matches the replay guard added on 2026-05-13: when a tool-result follow-up arrives after the paused Cursor bridge is missing or expired, the proxy now rejects replaying tool output as a fresh Cursor run.

This patch addresses one concrete cause that can contribute to those failures: inconsistent model id material (`cursor/auto` vs `auto`) entering the proxy path. It does not remove the replay guard, and it does not automatically retry original user requests after a lost bridge.

The completed fallback investigation for the stream-resume path independently pointed to the same minimal fix: normalize `body.model` before using it for `deriveBridgeKey()` and Cursor request encoding, because provider-qualified values such as `cursor/auto` otherwise produce different bridge keys and bypass the `auto -> default` mapping.

## Related docs reviewed

- `docs/20260427_sessions.md`
  - Records the original `cursor/auto` provider registration work.
  - Notes that OpenCode subagent routing expected `cursor/auto`, while the proxy exposed OpenAI-facing `auto`.
- `docs/20260502_sessions.md`
  - Records the evolution from concrete-model fallback to true Cursor Auto/default routing.
  - Current intended behavior is `auto -> Cursor default`, not first discovered model selection.
- `docs/cursor-auto-tool-continuation-investigation.md`
  - Summarizes the Auto tool-result continuation investigation.
  - Documents that `auto` maps to Cursor `default`, and continuation should prefer exact bridge lookup then `tool_call_id` fallback.
- `docs/sessions/20260506.md`
  - Records the `tool_call_id` fallback for active bridge continuation and early bridge stdout buffering.
- `docs/sessions/20260507.md`
  - Records parallel Auto bridge key isolation, multi-`mcpArgs` emission handling, and longer bridge inactivity timeout for Cursor-backed subagents.
- `docs/sessions/20260513_165040_tool-result-continuation-replay-guard.md`
  - Records the HTTP 409 replay guard for orphaned or expired `role: "tool"` continuations.
- `docs/sessions/20260514_122359_cursor-auto-provider-qualified-subagent.md`
  - Records this patch in session format.

## Current expected behavior after this patch

For OpenAI-compatible `/v1/chat/completions` requests:

| Incoming `body.model` | Internal model id | Cursor run model id |
| --- | --- | --- |
| `auto` | `auto` | `default` |
| `cursor/auto` | `auto` | `default` |
| `composer-2` | `composer-2` | `composer-2` |
| `cursor/composer-2` | `cursor/composer-2` | `cursor/composer-2` |

The most important subagent case is `cursor/auto -> auto -> default`.

## Remaining boundaries

- The smoke suite still does not perform a full live HTTP/2 streaming loop from Cursor `mcpArgs` to OpenAI `tool_calls`, then `role: "tool"`, then Cursor `mcpResult`.
- If a live subagent still fails after restarting/reloading the plugin code, collect structural continuation metadata before changing Auto routing again:
  - initial and follow-up `body.model`
  - derived bridge lookup key and active bridge key
  - incoming message role order
  - assistant `tool_calls[].id`
  - tool `tool_call_id`
  - active bridge pending Cursor `toolCallId` values
  - whether the bridge closed before the tool-result follow-up arrived
- Already-running OpenCode processes may keep old plugin/proxy code in memory. Restarting or retrying in a newly started runtime is required before this patch can affect live `cursor/auto` traffic.

## Worktree notes

Untracked `.sisyphus/run-continuation/*.json` files were present before this patch and were not modified.
