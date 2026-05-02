# Session: Cursor Model resource_exhausted Fix

**Date:** 2026-05-02
**Task:** Fix `resource_exhausted` error when using Cursor models, enable auto model fallback

## Problem

When using specific Cursor models (claude-4-sonnet, etc.), `resource_exhausted` error occurred because:
- User's specified models had monthly quota exhausted
- Only `auto` model had remaining usage
- Even when using `auto`, the first discovered model was often an exhausted one
- No retry/fallback mechanism existed

**Root Cause:**
1. `resolveCursorRunModelId()` picked the first model from `proxyModels` deterministically (alphabetically sorted), not based on availability
2. No handling of `resource_exhausted` Connect error code
3. No model rotation on quota exhaustion

## Solution

### 1. Enhanced `parseConnectEndStream` (proxy.ts:744-761)

Changed return type from `Error | null` to `{ isResourceExhausted: boolean; error: Error } | null` to detect quota exhaustion:

```typescript
function parseConnectEndStream(data: Uint8Array): { isResourceExhausted: boolean; error: Error } | null {
  try {
    const payload = JSON.parse(new TextDecoder().decode(data));
    const error = payload?.error;
    if (error) {
      const code = error.code ?? "unknown";
      const message = error.message ?? "Unknown error";
      return {
        isResourceExhausted: code === "resource_exhausted",
        error: new Error(`Connect error ${code}: ${message}`),
      };
    }
    return null;
  } catch {
    return { isResourceExhausted: false, error: new Error("Failed to parse Connect end stream") };
  }
}
```

### 2. Model Rotation with `exhaustedModelIds` Set (proxy.ts:339-341, 371-393)

Added tracking set and updated `resolveCursorRunModelId()` to skip exhausted models:

```typescript
const exhaustedModelIds = new Set<string>();

function resolveCursorRunModelId(modelId: string): string {
  if (modelId !== CURSOR_AUTO_PROXY_MODEL.id) return modelId;

  // Find the first non-exhausted model, skipping auto
  const availableModels = proxyModels.filter(
    (model) => model.id !== CURSOR_AUTO_PROXY_MODEL.id && !exhaustedModelIds.has(model.id),
  );

  if (availableModels.length === 0) {
    // All models exhausted — clear tracking and try again from the top
    exhaustedModelIds.clear();
    const firstModel = proxyModels.find((model) => model.id !== CURSOR_AUTO_PROXY_MODEL.id);
    if (!firstModel) {
      throw new Error("Cursor auto model requires at least one discovered Cursor model");
    }
    return firstModel.id;
  }

  return availableModels[0].id;
}
```

### 3. Error Handling in `createBridgeStreamResponse` (proxy.ts:1345-1354)

When `resource_exhausted` detected, mark model as exhausted and show user-friendly message:

```typescript
(endStreamBytes) => {
  const endResult = parseConnectEndStream(endStreamBytes);
  if (endResult) {
    sendSSE(makeChunk({ content: `\n[Error: ${endResult.error.message}]` }));
    if (endResult.isResourceExhausted) {
      const exhaustedModel = resolveCursorRunModelId(modelId);
      exhaustedModelIds.add(exhaustedModel);
      sendSSE(makeChunk({ content: "\n[Error: Model quota exhausted. Try 'auto' model or wait for quota reset.]" }));
    }
  }
},
```

## Files Changed

- `src/proxy.ts`: Added model rotation fallback for exhausted models

## Testing

- `bun run build` ✓
- `bun test/smoke.ts` - All 14 tests passed ✓

## Usage Recommendation

- Use `auto` model instead of specifying individual models
- When `resource_exhausted` occurs, auto model automatically rotates to next available model
- User can wait for monthly quota reset or upgrade Cursor plan