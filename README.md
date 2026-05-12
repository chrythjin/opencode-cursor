# opencode-cursor-oauth

OpenCode plugin that connects to Cursor's API, giving you access to Cursor
models inside OpenCode with full tool-calling support.

## Install in OpenCode

Add this to `~/.config/opencode/opencode.json`:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": [
    "opencode-cursor-oauth"
  ],
  "provider": {
    "cursor": {
      "name": "Cursor"
    }
  }
}
```

The `cursor` provider stub is required because OpenCode drops providers that do
not already exist in its bundled provider catalog.

OpenCode installs npm plugins automatically at startup, so users do not need to
clone this repository.

## Authenticate

```sh
opencode auth login --provider cursor
```

This opens Cursor OAuth in the browser. Tokens are stored in
`~/.local/share/opencode/auth.json` and refreshed automatically.

## Use

Start OpenCode and select any Cursor model. The plugin starts a local
OpenAI-compatible proxy on demand and routes requests through Cursor's gRPC API.

## How it works

1. OAuth — browser-based login to Cursor via PKCE.
2. Model discovery — queries Cursor's gRPC API for all available models.
3. Local proxy — translates `POST /v1/chat/completions` into Cursor's
   protobuf/HTTP/2 Connect protocol.
4. Native tool routing — rejects Cursor's built-in filesystem/shell tools and
   exposes OpenCode's tool surface via Cursor MCP instead.

HTTP/2 transport runs through a Node child process (`h2-bridge.mjs`) because
Bun's `node:http2` support is not reliable against Cursor's API.

`CURSOR_BRIDGE_INACTIVITY_TIMEOUT_MS` can override the bridge inactivity guard.
The default is 10 minutes so long OpenCode tool calls can return before the
paused Cursor stream is killed.

`CURSOR_PROXY_STREAM_IDLE_TIMEOUT_MS` can override the proxy-side SSE idle guard.
The default is 60 seconds. It only applies after assistant text has streamed and
no tool call is pending, so a Cursor stream that never sends a terminal frame
does not leave OpenCode waiting forever.

## Architecture

```
OpenCode  -->  /v1/chat/completions  -->  Bun.serve (proxy)
                                              |
                                    Node child process (h2-bridge.mjs)
                                              |
                                     HTTP/2 Connect stream
                                              |
                                    api2.cursor.sh gRPC
                                      /agent.v1.AgentService/Run
```

### Tool call flow

```
1. Cursor model receives OpenAI tools via RequestContext (as MCP tool defs)
2. Model tries native tools (readArgs, shellArgs, etc.)
3. Proxy rejects each with typed error (ReadRejected, ShellRejected, etc.)
4. Model falls back to MCP tool -> mcpArgs exec message
5. Proxy emits OpenAI tool_calls SSE chunk, pauses H2 stream
6. OpenCode executes tool, sends result in follow-up request
7. Proxy resumes H2 stream with mcpResult, streams continuation
```

## Develop locally

```sh
bun install
bun run build

```
OpenCode  -->  /v1/chat/completions  -->  Bun.serve (proxy)
                                              |
                                    Node child process (h2-bridge.mjs)
                                              |
                                     HTTP/2 Connect stream
                                              |
                                    api2.cursor.sh gRPC
                                      /agent.v1.AgentService/Run
```

### Tool call flow

```
1. Cursor model receives OpenAI tools via RequestContext (as MCP tool defs)
2. Model tries native tools (readArgs, shellArgs, etc.)
3. Proxy rejects each with typed error (ReadRejected, ShellRejected, etc.)
4. Model falls back to MCP tool -> mcpArgs exec message
5. Proxy emits OpenAI tool_calls SSE chunk, pauses H2 stream
6. OpenCode executes tool, sends result in follow-up request
7. Proxy resumes H2 stream with mcpResult, streams continuation
```

## Develop locally

```sh
bun install
bun run build
bun test/smoke.ts
```

## Requirements

- [OpenCode](https://opencode.ai)
- [Bun](https://bun.sh)
- [Node.js](https://nodejs.org) >= 18 for the HTTP/2 bridge process
- Active [Cursor](https://cursor.com) subscription

## Enabling Model Variants for Custom Providers (like openai-oauth)

If you are using a custom OpenAI-compatible provider (e.g., `openai-oauth`) and notice that the model variants (like `high` or `low` reasoning effort) do not appear next to the model name in the OpenCode TUI, you can enable them by explicitly setting `"reasoning": true` in your `opencode.json` file.

OpenCode's internal logic will automatically generate and display the standard/high/low reasoning variants if the model's capabilities include reasoning.

### Example configuration (`~/.config/opencode/opencode.json`)

```jsonc
{
  "provider": {
    "openai-oauth": {
      "name": "openai-oauth",
      "npm": "@ai-sdk/openai-compatible",
      "options": {
        "baseURL": "http://127.0.0.1:10531/v1",
        "apiKey": "oauth"
      },
      "models": {
        "gpt-5.5": {
          "name": "gpt-5.5",
          "reasoning": true, // <--- Add this flag to enable reasoning capabilities
          "variants": {      // <--- (Optional) Define your own custom variant names
            "standard": {},
            "high": { "body": { "reasoning_effort": "high" } },
            "low": { "body": { "reasoning_effort": "low" } }
          }
        }
      }
    }
  }
}
```

After modifying the configuration, you **must completely restart OpenCode** for the new configuration to be applied and the variants to appear in the TUI state bar.
