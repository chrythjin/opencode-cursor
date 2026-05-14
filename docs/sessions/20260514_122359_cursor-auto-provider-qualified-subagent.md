# Cursor auto provider-qualified subagent fix

## Summary

Fixed Cursor auto model handling when OpenAI-compatible requests arrive with a provider-qualified model id such as `cursor/auto`. The proxy now normalizes the incoming OpenAI model id before request building, bridge key derivation, and response model reporting, so `cursor/auto` follows the same intentional Cursor server-side default route as `auto`.

## Root cause

The proxy only treated the exact model id `auto` as Cursor Auto. Subagent/provider routing can send `cursor/auto`, which previously reached Cursor as a literal model id instead of being encoded as Cursor `default` in `requestedModel.modelId` and `modelDetails.modelId`.

## Changes

- Added OpenAI model id normalization in `src/proxy.ts` for the local `cursor/auto` provider-qualified Auto id.
- Extended the auto model smoke coverage in `test/smoke.ts` to assert that `cursor/auto` is encoded to Cursor `default`.

## Verification

- `lsp_diagnostics` on `src/proxy.ts` and `test/smoke.ts`: no TypeScript errors; existing Biome warnings remain.
- `bun test/smoke.ts`: passed, including auto model request encoding.
- `bun run build`: passed (`tsc -p tsconfig.json && node scripts/copy-runtime.mjs`).

## Notes

Untracked `.sisyphus/run-continuation/*.json` files were already present and were not modified.
