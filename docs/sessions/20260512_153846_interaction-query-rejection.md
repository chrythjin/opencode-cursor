# InteractionQuery rejection follow-up

**Date**: 2026-05-12
**Files**: `src/proxy.ts`, `test/smoke.ts`

## Change

Implemented the remaining high-priority item from `docs/sessions/20260512_152200_subagent-crash-fix.md`: Cursor `interactionQuery` frames are no longer only logged. The proxy now sends an `AgentClientMessage.interactionResponse` back through the bridge for supported query families so Cursor is not left waiting for a native UI/client response.

Implemented typed rejection responses for:

- `webSearchRequestQuery`
- `askQuestionInteractionQuery`
- `switchModeRequestQuery`
- `exaSearchRequestQuery`
- `exaFetchRequestQuery`
- `createPlanRequestQuery`

`setupVmEnvironmentArgs` and empty query cases currently return an empty oneof result because the generated schema exposes no rejection variant for setup VM environment.

## Tests and verification

- `bun run build` passed.
- Direct surface driver passed: constructed an `interactionQuery` Connect frame, fed it through `__testInteractionResponseFromQueryFrame`, decoded the emitted client frame, and verified an `interactionResponse` with matching id and rejected `askQuestionInteractionResponse`.
- Added smoke coverage in `test/smoke.ts` for the same ask-question interaction rejection path.

## Known verification caveat

`bun test/smoke.ts` still hangs at `testArrayContentParsing`, matching the pre-existing issue documented in `20260512_152200_subagent-crash-fix.md`. The new interaction-query path was verified independently because the full smoke suite cannot currently progress past that existing bridge timeout.

## Notes

LSP/Biome diagnostics for `src/proxy.ts` continued to report stale parse errors at lines beyond the actual file end after `tsc` succeeded and the file read showed 1805 total lines. `test/smoke.ts` had no error diagnostics.
