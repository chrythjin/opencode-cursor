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

## Tool Call Flow

```
1. OpenAI tool defs → MCP tool defs in RequestContext
2. Cursor native tools rejected with typed errors (ReadRejected, ShellRejected, etc.)
3. Model falls back to MCP → mcpArgs exec message
4. Proxy emits OpenAI tool_calls SSE, pauses H2 stream
5. OpenCode executes tool, sends result in follow-up
6. Proxy resumes H2 stream with mcpResult
```

## Style / Conventions

- TypeScript `strict: true`, ESM, `bundler` module resolution
- No linter/formatter configured — match existing style manually
- `bun` types in `tsconfig.json` — not `node`
- Proxy uses `@bufbuild/protobuf` for all protobuf encode/decode

## Testing

`bun test/smoke.ts` spins up an in-process HTTP/2 test server — no real Cursor API needed. Tests cover:
- Proxy start/stop, `/v1/models`, 404 handling
- Auth param generation (PKCE verification)
- Token expiry parsing
- Plugin export shape
- Array content (`ContentPart[]`) message normalization
- Auto model → first discovered model resolution
- Token refresh before model discovery
- Discovery fallback to hardcoded models

Set `CURSOR_API_URL` and `CURSOR_REFRESH_URL` env vars to point at the test backend.
