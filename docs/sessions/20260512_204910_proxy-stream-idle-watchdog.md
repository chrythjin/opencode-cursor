## Summary

Fixed a remaining `model: "auto"` first-response-then-hang path where Cursor can stream assistant text and then stop sending frames without a Connect end-stream, `turnEnded`, bridge close, or bridge error.

## Root cause

The proxy only closed the OpenAI SSE stream on explicit terminal signals. The H2 bridge also sends client heartbeats while the stream is alive; those writes keep the bridge inactivity guard fresh, so a live Cursor stream that goes quiet after text can leave OpenCode waiting indefinitely.

## Changes

- Added `CURSOR_PROXY_STREAM_IDLE_TIMEOUT_MS` with a 60 second default.
- Added a proxy-side SSE idle watchdog after assistant text is emitted.
- The watchdog is cleared when an MCP tool call is pending, preserving long tool-call round trips.
- Added smoke coverage for text-without-terminal-frame closing with `finish_reason: "stop"` and `[DONE]`.
- Documented the new environment variable in `README.md` and `AGENTS.md`.

## Verification

- `bun run build`
- `bun test/smoke.ts`
- Manual Bun SSE driver that feeds a text delta without a terminal frame and observes text, `finish_reason: "stop"`, and `data: [DONE]` in 62ms with a 25ms test timeout.

## Notes

This does not change tool-call continuation behavior. The idle guard does not apply once `mcpArgs` has been received.
