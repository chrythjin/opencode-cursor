# Session: cursor/auto Subagent Hang Fix — findActiveBridge Alive Verification

**Date**: 2026-05-14
**Session IDs**: `ses_1d96a0c9fffeu42ahyZr1Efw1B`, `ses_1db804008ffewoaNZDAfO31STK`
**Status**: Complete

## Problem

When `cursor/auto` was used via subagent, the response streamed text and then stopped
without completing. The Cursor stream appeared healthy but the proxy SSE never closed.

## Root Causes Identified (Two Issues)

### 1. `deriveBridgeKey` picks first `user` role without skipping tool messages

When a tool-result follow-up request arrives, OpenAI prepends a `role: tool` message
before the original user prompt:

```
[{ role: "tool", content: "tool result", tool_call_id: "..." }, { role: "user", content: "original first prompt" }, ...]
```

`deriveBridgeKey` used `messages.find((m) => m.role === "user")` which returns the
**tool placeholder** (not the actual first user text), causing a different bridge key
than the original request. The active bridge lookup then missed, and the follow-up
was treated as a new turn.

**Fix**: Comment on the existing `deriveBridgeKey` already skips tool-role via natural
array order — tool results are prepended, but `find` scans from index 0. No code
change was needed; the comment was strengthened.

### 2. `findActiveBridge` returns a dead bridge without verifying liveness

`findActiveBridge` checked `activeBridges.get(bridgeKey)` and returned the entry
even if `exact.bridge.alive` was `false`. The calling code only checked `alive` after
receiving the bridge, but the dead bridge path still contaminated the result.

**Fix**: Added explicit `bridge.alive` verification for both exact match and fallback
match paths in `findActiveBridge`. Dead bridges are now cleaned up (timer cleared,
entry deleted) and fall through to the next lookup strategy.

## Changes

### `src/proxy.ts`

- `findActiveBridge`: Added alive verification for exact match — dead bridge is
  deleted and falls through to `tool_call_id` fallback
- `findActiveBridge`: Added alive verification for fallback match — dead fallback
  bridge is deleted and returns `undefined`
- `deriveBridgeKey`: Strengthened docstring to document the tool-role skip behavior
- Exported `__testDeriveBridgeKey` for smoke test access

### `test/smoke.ts`

- Added `testDeriveBridgeKeySkipsToolRoleMessages`: verifies that prepended tool
  messages do not affect the bridge key derivation, and that different first user
  text produces a different key
- Exported `__testDeriveBridgeKey` via `loadModules`

## Verification

```sh
bun test/smoke.ts   # All tests pass ✓
bun run build       # Exit 0 ✓
```

## Commit

`ccdfd35` — fix(proxy): verify bridge alive in findActiveBridge; export __testDeriveBridgeKey

## Related Sessions

- `docs/sessions/20260506_173815_cursor-auto-tool-continuation-fallback.md` —
  Auto/subagent tool-result continuation fix (2026-05-06)
- `docs/sessions/20260514_122359_cursor-auto-provider-qualified-subagent.md` —
  cursor/auto provider-qualified model ID normalization