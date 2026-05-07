# Subagent INTERRUPTED Timeout Triage

Date: 2026-05-07

## Context

The initial-response-then-hang issue was separated from the `INTERRUPTED` issue. The initial-response hang paths are considered fixed in the current codebase: active bridge key isolation, `tool_call_id` fallback resume, early bridge stdout buffering, and delayed multi-`mcpArgs` SSE close are all covered by smoke/build/basic proxy QA.

The remaining `INTERRUPTED` symptom was investigated separately because it can happen after a subagent has already started working.

## Change

- `src/h2-bridge.mjs` now reads `CURSOR_BRIDGE_INITIAL_TIMEOUT_MS` and `CURSOR_BRIDGE_INACTIVITY_TIMEOUT_MS` through a positive-number parser.
- The bridge initial guard remains 30 seconds by default.
- The bridge inactivity guard now defaults to 10 minutes instead of 2 minutes.
- `AGENTS.md` and `README.md` document `CURSOR_BRIDGE_INACTIVITY_TIMEOUT_MS`.

This protects Cursor-backed subagents, especially `cursor/auto` / `sisyphus-junior`, from losing a paused Cursor stream while OpenCode is still executing a long tool call.

## Scope Boundary

This change is Cursor-specific. It does not explain `INTERRUPTED` events from subagents using `minimax-coding-plan/MiniMax-M2.7`, because those agents bypass the local Cursor HTTP/2 bridge.

For non-Cursor subagents, likely shared candidates are OpenCode subagent lifecycle handling, provider/request stream interruption, or MCP tool timeout. The local global config currently has enabled `lazy-tool` MCP timeout at 120000 ms. That should only be changed if a failing trace shows an active `lazy-tool` MCP call timing out near that boundary.

## Verification

- `node --check src/h2-bridge.mjs` passed.
- `src/h2-bridge.mjs` LSP diagnostics are clean.
- A local HTTP/2 driver verified the bridge honors configured initial/inactivity timeout values.
- `bun test/smoke.ts` passed.
- `bun run build` passed.
- `dist/h2-bridge.mjs` SHA256 matches `src/h2-bridge.mjs` after build.
- Basic proxy surface QA passed:
  - `GET /v1/models` returned `200`.
  - Invalid empty-message `POST /v1/chat/completions` returned `400` with `No user message found`.

## Remaining Follow-Up

If `INTERRUPTED` still happens for MiniMax-backed subagents, capture one failing run with timestamps, active tool/MCP server name, elapsed time, and OpenCode/provider logs. Do not assume the Cursor bridge setting applies to that path.
