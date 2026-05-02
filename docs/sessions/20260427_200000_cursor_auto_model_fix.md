# Session: Fix Cursor auto model - AgentRunRequest Model Details Required

Date: 2026-04-27
Session: `ses_231750a28ffeGcf0DEW4HdIfDg`
Agent: Sisyphus (self)

## Context

**Problem:** `explore` subagents using `cursor/auto` model failed with:
```
[Error: Connect error invalid_argument: Model details are required]
```

User explicitly rejected changing `explore.model` from `cursor/auto` to a fixed explicit model as a workaround.

## Root Cause Analysis

- Three initial `explore` background tasks failed immediately before performing any search.
- Failure was from Cursor ConnectRPC, not from search logic, auth, or local tool execution.
- Active OMO config uses `explore.model = "cursor/auto"`.
- Previous change made `modelId === "auto"` omit `AgentRunRequest.modelDetails`.
- Cursor private `agent.v1.AgentService/Run` requires `modelDetails`.
- Public Cursor Cloud Agents REST API supports `model: "default"`/omitted model, but that does not apply to the private ConnectRPC protobuf path.

## Implemented Fix

**File:** `src/proxy.ts`

Added `resolveCursorRunModelId(modelId)` function:
```typescript
function resolveCursorRunModelId(modelId: string): string {
  if (modelId !== CURSOR_AUTO_PROXY_MODEL.id) return modelId;
  const discoveredDefaultModel = proxyModels.find((model) => model.id !== CURSOR_AUTO_PROXY_MODEL.id);
  if (!discoveredDefaultModel) {
    throw new Error("Cursor auto model requires at least one discovered Cursor model");
  }
  return discoveredDefaultModel.id;
}
```

Used in `buildCursorRequest()`:
```typescript
const cursorModelId = resolveCursorRunModelId(modelId);
const modelDetails = create(ModelDetailsSchema, {
  modelId: cursorModelId,
  displayModelId: cursorModelId,
  displayName: cursorModelId,
});
```

**Key behavior:**
- `cursor/auto` remains exposed in `/v1/models` (user-facing)
- Before building Cursor `ModelDetails`, `auto` resolves to first discovered non-auto Cursor model from `proxyModels`
- Explicit model requests still pass through unchanged

## Files Changed (Original PR #24)

| File | Changes |
|------|---------|
| `src/proxy.ts` | Added `resolveCursorRunModelId()`, integrated in `buildCursorRequest()` |
| `src/index.ts` | Added `CURSOR_AUTO_MODEL` constant, `mergeAutoModel()` function |
| `src/models.ts` | Model list updates |
| `test/smoke.ts` | Added `testAutoModelSendsDiscoveredCursorModelDetails()` |

## Final PR

**PR #25** (clean): https://github.com/ephraimduncan/opencode-cursor/pull/25
- Only `src/proxy.ts` (1 file)
- User rejected including test file in final PR

## Verification

| Test | Result |
|------|--------|
| `lsp_diagnostics` on `src/proxy.ts` | No diagnostics |
| `bun run build` | Passed |
| Live explore subagent with `cursor/auto` | **Success (12s)** |

## Notes

- PR was closed by user in favor of not submitting to upstream
- Local docs folder restored to `d294144` state
- Original local changes were messy (included `.serena/`, `docs/sessions/`, etc.)
- Final clean branch `auto-pr` was reset to `origin/main` to start fresh
