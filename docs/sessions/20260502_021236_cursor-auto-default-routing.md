# Cursor Auto Model Default Routing

## Summary

Changed Cursor auto model handling so OpenCode still exposes `cursor/auto`, but Cursor `AgentRunRequest` no longer resolves it to the first discovered concrete model.

## Why

The previous behavior converted `auto` to a discovered model such as `composer-2`, which defeats Cursor's separate Auto/default routing and can surface concrete-model `resource_exhausted` errors. External Cursor API docs indicate default model behavior is represented by omitting the model field rather than sending an explicit model id.

## Changes

- `src/proxy.ts`: replaced `resolveCursorRunModelId` with `buildCursorModelDetails`; `auto` now omits `modelDetails`, explicit models still include `modelDetails`.
- `test/smoke.ts`: updated the auto model encoding test to assert `auto` omits `modelDetails` and explicit `composer-2` still forwards normally.
- Closed upstream PR #26 (`feat: resolve cursor/auto to discovered model in AgentRunRequest`) because it implemented the incorrect concrete-model resolution behavior.

## Next Steps

- OpenCode를 재시작해야 플러그인 새 코드가 로드됩니다. 재시작 전에는 `resource_exhausted` 에러가 계속 발생할 수 있습니다.

## Verification

- LSP diagnostics on `src/proxy.ts`: no errors.
- LSP diagnostics on `test/smoke.ts`: no errors.
- `bun run build`: passed.
- `bun test/smoke.ts`: passed, including true auto model request encoding.
