# Cursor auto explore subagent ULW follow-up

## Context

Explore subagent calls were launched to verify whether `cursor/auto` works for codebase exploration. All three background explore calls failed with:

```text
Connect error resource_exhausted: Error
Model quota exhausted. Try 'auto' model or wait for quota reset.
```

The user's correction was important: `auto` is not the same as a fixed Cursor model, and the account may still have Auto quota even when concrete model quota is exhausted.

## Confirmed local state

- Local OMO config routes explore through `cursor/auto`:
  - `C:\Users\U-N-00658\.config\opencode\oh-my-openagent.jsonc`
  - `agents.explore.model = "cursor/auto"`
- Current proxy code resolves OpenCode model `auto` to the first discovered non-auto Cursor model before building `ModelDetails`:
  - `src/proxy.ts`
  - `resolveCursorRunModelId("auto") -> first available proxy model`
- Current smoke coverage expects that behavior:
  - `test/smoke.ts`
  - `model: "auto"` is expected to send `modelDetails.modelId === "composer-2"`

## External research result

A librarian research task checked public Cursor private-API references and reconstructed protobufs. Findings:

- Private `api2.cursor.sh/agent.v1.AgentService/Run` still has legacy `model_details` field 3.
- The proto also has optional `requested_model` field 9, with comments indicating `model_details` may be deprecated in favor of `requested_model`.
- Public examples found generally populate concrete `ModelDetails`.
- No public example confirmed Auto/default routing by:
  - omitting `modelDetails`,
  - setting `modelDetails.modelId = "auto"`,
  - setting `modelDetails.modelId = "default"`, or
  - using a confirmed `requested_model` Auto sentinel.
- Previous local evidence says omitting `modelDetails` caused `invalid_argument: Model details are required`, so reverting to omission would likely regress.

## Decision

Do not change `src/proxy.ts` yet. The failure is consistent with `cursor/auto` being collapsed to a concrete model quota path, but the correct private RPC encoding for true Cursor Auto is not proven from public sources.

## Next safest experiments

1. Add a targeted test harness for private `GetDefaultModelForCli` to see whether Cursor returns a concrete default `ModelDetails` that differs from first discovered model.
2. Experiment against the real private API with `requestedModel` field 9 while preserving valid `modelDetails`, because `requested_model` is the only proto-supported alternate model-selection field found.
3. If available, inspect live Cursor IDE traffic for Auto/default model selection instead of guessing sentinel values.

## Verification performed in this session

- Confirmed local OMO explore model is `cursor/auto`.
- Confirmed current proxy transforms `auto` into a concrete discovered model.
- Confirmed current smoke test expectation matches that transformation.
- Collected external research result for private Cursor RPC model selection.

## Outcome

No code was changed. This document preserves the confirmed diagnosis and prevents repeating the unsafe `omit modelDetails` change without new evidence.
