# Cursor auto default Run routing

## Goal

Make OpenAI-compatible requests with `model: "auto"` use Cursor provider Auto routing instead of resolving to the first discovered concrete Cursor model such as `composer-2`.

## Evidence used

- OSS Cursor API/proxy implementations indicate true Cursor Auto is represented as Cursor model id `default` on `AgentService/Run`.
- `GetDefaultModelForCli` returns a concrete/default CLI model and is not the same as true Auto routing.
- Generated proto supports both legacy `modelDetails` and newer `requestedModel`; comments indicate Cursor is moving from `modelDetails` to `requestedModel`.

## Changes

- `src/proxy.ts`
  - Removed local `auto -> first discovered model` resolution.
  - Translates OpenAI `model: "auto"` to Cursor Run model id `default`.
  - Sends both:
    - `modelDetails.modelId = "default"`, `displayModelId = "default"`, `displayName = "Auto"`, `displayNameShort = "Auto"`
    - `requestedModel.modelId = "default"`
  - Explicit models still pass through unchanged in both fields.
- `test/smoke.ts`
  - Updated auto model smoke test to assert `auto` encodes as Cursor `default` instead of `composer-2`.
  - Added `requestedModelId` and `displayName` observation for Run requests.

## Verification

- `bun run build` passed.
- `bun test/smoke.ts` passed, including `Testing auto model request encoding... Auto model request encoding OK`.
- LSP diagnostics on `src/` reported 0 errors. File-level diagnostics had stale/cached output during editing, so final error status was verified at directory scope.

## Notes

This deliberately does not implement model quota rotation or concrete-model retry fallback. The requested goal was to use Cursor provider Auto routing, not to work around it with another concrete model.
