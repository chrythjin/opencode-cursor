# opencode-cursor-oauth

OpenCode plugin that connects Cursor's API to OpenCode via OAuth, model discovery, and a local OpenAI-compatible proxy.

## Dev Commands

```sh
bun install          # Install dependencies
bun run build       # TypeScript compile + copy h2-bridge.mjs to dist/
bun test/smoke.ts   # Run smoke tests (in-process HTTP2 test server, no external deps)
```

**Build artifact**: `dist/` is the publishable npm package. Only `dist/h2-bridge.mjs` is a runtime file alongside the compiled JS — the `scripts/copy-runtime.mjs` post-build step copies it.

## Architecture

```
OpenCode  -->  /v1/chat/completions  -->  Bun.serve (proxy, src/proxy.ts)
                                              |
                                    Node child process (src/h2-bridge.mjs)
                                              |
                                     HTTP/2 Connect stream
                                              |
                                     api2.cursor.sh gRPC
                                       /agent.v1.AgentService/Run
```

### Key files

| File | Purpose |
|------|---------|
| `src/index.ts` | Plugin entry — registers auth provider + model loader |
| `src/proxy.ts` | Bun-side OpenAI→Cursor proxy; handles streaming, tool calls, conversation state |
| `src/h2-bridge.mjs` | Node.js HTTP/2 bridge (stdin/stdout pipe); **Bun's node:http2 is broken** — never rewrite this in Bun |
| `src/auth.ts` | OAuth PKCE flow, token refresh, JWT expiry parsing |
| `src/models.ts` | Model discovery via `GetUsableModels` RPC; falls back to hardcoded list |
| `src/proto/agent_pb.ts` | Generated protobuf/Connect schemas — **do not edit by hand** |
| `src/pkce.ts` | PKCE verifier/challenge generation |

## Critical Constraints

- **Bun's `node:http2` is unreliable against Cursor's API.** All HTTP/2 transport goes through `h2-bridge.mjs` (Node.js). If you need to debug H2, check that file first.
- **Proto schemas are generated** (`@bufbuild/protobuf`). If you modify `.proto` files, regenerate with `prot-gen-es`.
- **`idleTimeout: 255`** (max) on the Bun proxy server — Cursor responses can take 30s+.
- **Conversation state TTL: 30 min** (`CONVERSATION_TTL_MS`). Active bridges survive tool-call round-trips via `activeBridges` map keyed by `SHA256(modelId + firstUserText.slice(0,200))`.
- **Token expiry**: 5-minute safety margin subtracted from JWT `exp`. Auth refresh happens automatically before expiry.
- **`CURSOR_API_URL`** env var overrides `https://api2.cursor.sh` for testing.
- **`CURSOR_REFRESH_URL`** env var overrides the token refresh endpoint.
- **`CURSOR_BRIDGE_INACTIVITY_TIMEOUT_MS`** env var controls the H2 bridge inactivity guard; default is 10 minutes so long subagent tool runs do not kill the bridge at 2 minutes.

## Auto Model Routing

`model: "auto"` from OpenAI is **not** resolved to the first discovered model. It is encoded for `AgentService/Run` as:
- `modelDetails.modelId = "default"`
- `requestedModel.modelId = "default"`
- `modelDetails.displayName = "Auto"`

This routes to Cursor's own server-side default model, not a client-side first-discovered pick. `GetDefaultModelForCli` returns a concrete CLI default and is not true Auto routing.

## Tool Call Flow

```
1. OpenAI tool defs → MCP tool defs in RequestContext
2. Cursor native tools rejected with typed errors (ReadRejected, ShellRejected, etc.)
3. Model falls back to MCP → mcpArgs exec message
4. Proxy emits OpenAI tool_calls SSE, pauses H2 stream
5. OpenCode executes tool, sends result in follow-up
6. Proxy resumes H2 stream with mcpResult
```

## Recent Fix: Auto/Subagent Tool Continuation

Saved local reference for future sessions: `docs/sessions/20260506_173815_cursor-auto-tool-continuation-fallback.md` and `docs/cursor-auto-tool-continuation-investigation.md`.

`cursor/auto` tool-result continuation was fixed in `src/proxy.ts` on 2026-05-06. The important point is that Auto routing itself remains intentional: OpenAI `model: "auto"` is still encoded to Cursor `default` in both `modelDetails` and `requestedModel`. The bug risk was active bridge continuation lookup.

Continuation now works like this:

1. Try the exact active bridge key first.
2. If the exact key misses and the request contains `role: "tool"` results, match incoming OpenAI `tool_call_id` values against active bridge pending Cursor MCP exec `toolCallId` values.
3. Use the matched `activeBridgeKey` for both `activeBridges.delete(...)` and `handleToolResultResume(...)`.

This covers subagent/harness follow-ups where `modelId` or first-user-text-derived key material changes between the initial `mcpArgs` request and the `mcpResult` follow-up. `spawnBridge()` also buffers early child stdout until `onData` is registered so fast bridge output is not lost before Connect frame parsing attaches.

Verification recorded at the time of the fix:

- `bun test/smoke.ts` passed.
- `bun run build` passed.
- Changed files had no TypeScript errors; existing Biome warnings remained.

Remaining boundary: the smoke suite does not yet exercise the full HTTP/2 streaming loop `mcpArgs -> OpenAI tool_calls -> role: tool -> mcpResult`. If a live Sisyphus/subagent still fails, diagnose bridge death before follow-up, malformed/missing `tool_call_id`, or multiple `mcpArgs` in one turn before changing Auto routing.

## Style / Conventions

- TypeScript `strict: true`, ESM, `bundler` module resolution
- **No linter/formatter configured** — match existing style manually
- `bun` types in `tsconfig.json` — not `node`
- Proxy uses `@bufbuild/protobuf` for all protobuf encode/decode

## Testing

`bun test/smoke.ts` spins up an in-process HTTP/2 test server — no real Cursor API needed. Tests cover:
- Proxy start/stop, `/v1/models`, 404 handling
- Auth param generation (PKCE verification)
- Token expiry parsing
- Plugin export shape
- Array content (`ContentPart[]`) message normalization
- **Auto model → `default` encoding in `modelDetails` and `requestedModel`**
- Token refresh before model discovery
- Discovery fallback to hardcoded models

Set `CURSOR_API_URL` and `CURSOR_REFRESH_URL` env vars to point at the test backend.

## Subagent Resilience

When explore subagents fail with `resource_exhausted` (model quota exhausted), fall back to direct `grep`/`rg`/`ast_grep` tools for codebase search.

## Key Implementation Notes

- The synthetic `"auto"` model is **appended after** discovery, replacing any auto returned by Cursor (`mergeAutoModel` in `index.ts`, `mergeAutoProxyModel` in `proxy.ts`).
- `FALLBACK_MODELS` in `src/models.ts` is the hardcoded list used when model discovery fails.
- Thinking tags (`<think>`, `</think>`, etc.) are stripped from streamed text and routed to `reasoning_content`.
- Heartbeat sent every 5 seconds to keep the bridge alive across tool-call pauses.
- The proxy only handles `/v1/models` (GET) and `/v1/chat/completions` (POST) — all else returns 404.
- `activeBridges` is keyed by `SHA256("bridge:" + modelId + firstUserText.slice(0,200))` — bridges survive within the same conversation turn.
- `conversationStates` is keyed by `SHA256("conv:" + firstUserText.slice(0,200))` — model-independent, survives model switches.
