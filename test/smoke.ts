import http from "node:http";
import http2 from "node:http2";
import type { AddressInfo } from "node:net";
import type { ServerHttp2Stream } from "node:http2";
import { create, fromBinary, toBinary } from "@bufbuild/protobuf";
import {
  AgentClientMessageSchema,
  AgentRunRequestSchema,
  AgentServerMessageSchema,
  AskQuestionInteractionQuerySchema,
  ConversationStateStructureSchema,
  ExecServerMessageSchema,
  InteractionUpdateSchema,
  InteractionQuerySchema,
  GetUsableModelsResponseSchema,
  McpArgsSchema,
  ModelDetailsSchema,
  TextDeltaUpdateSchema,
  TurnEndedUpdateSchema,
} from "../src/proto/agent_pb";

type DiscoveryMode = "success" | "empty" | "auth-error";

interface TestModules {
  startProxy: typeof import("../src/proxy").startProxy;
  stopProxy: typeof import("../src/proxy").stopProxy;
  getProxyPort: typeof import("../src/proxy").getProxyPort;
  __testFindActiveBridgeKeyByToolCallId: typeof import("../src/proxy").__testFindActiveBridgeKeyByToolCallId;
  __testCreateActiveBridgeKey: typeof import("../src/proxy").__testCreateActiveBridgeKey;
  __testBuildPayloadFromOpenAiMessages: typeof import("../src/proxy").__testBuildPayloadFromOpenAiMessages;
  __testEmitToolCallsFromConnectFrames: typeof import("../src/proxy").__testEmitToolCallsFromConnectFrames;
  __testStreamToolCallsFromConnectFrames: typeof import("../src/proxy").__testStreamToolCallsFromConnectFrames;
  __testInteractionResponseFromQueryFrame: typeof import("../src/proxy").__testInteractionResponseFromQueryFrame;
  generateCursorAuthParams: typeof import("../src/auth").generateCursorAuthParams;
  getTokenExpiry: typeof import("../src/auth").getTokenExpiry;
  CursorAuthPlugin: typeof import("../src/index").CursorAuthPlugin;
  getCursorModels: typeof import("../src/models").getCursorModels;
  clearModelCache: typeof import("../src/models").clearModelCache;
}

interface ObservedRunRequest {
  conversationId: string | undefined;
  modelId: string | undefined;
  requestedModelId: string | undefined;
  hasModelDetails: boolean;
  displayName: string | undefined;
  actionUserText: string | undefined;
  historyTurnCount: number;
}

interface TestCursorBackend {
  apiUrl: string;
  refreshUrl: string;
  queueRunFrames: (frames: Uint8Array[]) => void;
  setDiscoveryMode: (mode: DiscoveryMode) => void;
  setDiscoveredModels: (models: Array<{ id: string; name: string; reasoning?: boolean }>) => void;
  resetObservations: () => void;
  getDiscoveryAuthHeaders: () => string[];
  getDiscoveryRequestBodies: () => Uint8Array[];
  getRefreshAuthHeaders: () => string[];
  getRunRequests: () => ObservedRunRequest[];
  close: () => Promise<void>;
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function assertEqual<T>(actual: T, expected: T, message: string): void {
  if (actual !== expected) {
    throw new Error(`${message}: expected ${String(expected)}, got ${String(actual)}`);
  }
}

function assertArrayEqual(
  actual: readonly string[],
  expected: readonly string[],
  message: string,
): void {
  const actualJson = JSON.stringify(actual);
  const expectedJson = JSON.stringify(expected);
  if (actualJson !== expectedJson) {
    throw new Error(`${message}: expected ${expectedJson}, got ${actualJson}`);
  }
}

function makeJwt(expiresAtSeconds: number): string {
  const header = btoa(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const payload = btoa(JSON.stringify({ exp: expiresAtSeconds }));
  return `${header}.${payload}.fakesig`;
}

function frameConnectUnaryMessage(payload: Uint8Array): Buffer {
  const frame = Buffer.alloc(5 + payload.length);
  frame[0] = 0;
  frame.writeUInt32BE(payload.length, 1);
  frame.set(payload, 5);
  return frame;
}

function frameConnectEndStream(): Buffer {
  const payload = new TextEncoder().encode("{}");
  const frame = Buffer.alloc(5 + payload.length);
  frame[0] = 0b0000_0010;
  frame.writeUInt32BE(payload.length, 1);
  frame.set(payload, 5);
  return frame;
}

function frameConnectEndStreamError(code: string, message: string): Buffer {
  const payload = new TextEncoder().encode(JSON.stringify({ error: { code, message } }));
  const frame = Buffer.alloc(5 + payload.length);
  frame[0] = 0b0000_0010;
  frame.writeUInt32BE(payload.length, 1);
  frame.set(payload, 5);
  return frame;
}

function makeAskQuestionInteractionQueryFrame(id: number): Buffer {
  const query = create(InteractionQuerySchema, {
    id,
    query: {
      case: "askQuestionInteractionQuery",
      value: create(AskQuestionInteractionQuerySchema, {
        toolCallId: `interaction-tool-${id}`,
      }),
    },
  });
  const serverMessage = create(AgentServerMessageSchema, {
    message: { case: "interactionQuery", value: query },
  });
  return frameConnectUnaryMessage(toBinary(AgentServerMessageSchema, serverMessage));
}

function makeMcpExecFrame(id: number, toolCallId: string, toolName: string): Buffer {
  const mcpArgs = create(McpArgsSchema, {
    name: toolName,
    toolName,
    toolCallId,
    providerIdentifier: "opencode",
    args: {},
  });
  const execMessage = create(ExecServerMessageSchema, {
    id,
    execId: `exec-${id}`,
    message: { case: "mcpArgs", value: mcpArgs },
  });
  const serverMessage = create(AgentServerMessageSchema, {
    message: { case: "execServerMessage", value: execMessage },
  });
  return frameConnectUnaryMessage(toBinary(AgentServerMessageSchema, serverMessage));
}

function makeTextDeltaFrame(text: string): Buffer {
  const update = create(InteractionUpdateSchema, {
    message: {
      case: "textDelta",
      value: create(TextDeltaUpdateSchema, { text }),
    },
  });
  const serverMessage = create(AgentServerMessageSchema, {
    message: { case: "interactionUpdate", value: update },
  });
  return frameConnectUnaryMessage(toBinary(AgentServerMessageSchema, serverMessage));
}

function makeTurnEndedFrame(): Buffer {
  const update = create(InteractionUpdateSchema, {
    message: {
      case: "turnEnded",
      value: create(TurnEndedUpdateSchema, {}),
    },
  });
  const serverMessage = create(AgentServerMessageSchema, {
    message: { case: "interactionUpdate", value: update },
  });
  return frameConnectUnaryMessage(toBinary(AgentServerMessageSchema, serverMessage));
}

function makeCheckpointFrame(): Buffer {
  const checkpoint = create(ConversationStateStructureSchema, {
    rootPromptMessagesJson: [],
    turns: [],
    todos: [],
    pendingToolCalls: [],
    previousWorkspaceUris: [],
    fileStates: {},
    fileStatesV2: {},
    summaryArchives: [],
    turnTimings: [],
    subagentStates: {},
    selfSummaryCount: 0,
    readPaths: [],
  });
  const serverMessage = create(AgentServerMessageSchema, {
    message: { case: "conversationCheckpointUpdate", value: checkpoint },
  });
  return frameConnectUnaryMessage(toBinary(AgentServerMessageSchema, serverMessage));
}

function getAuthLoader(
  hooks: Awaited<ReturnType<TestModules["CursorAuthPlugin"]>>,
): NonNullable<NonNullable<typeof hooks.auth>["loader"]> {
  assert(hooks.auth, "Expected Cursor auth hooks to be registered");
  assert(hooks.auth.loader, "Expected Cursor auth loader to be registered");
  return hooks.auth.loader;
}

function decodeConnectStreamingMessages(payload: Uint8Array): Uint8Array[] {
  const messages: Uint8Array[] = [];
  let offset = 0;
  while (offset + 5 <= payload.length) {
    const flags = payload[offset]!;
    const messageLength = new DataView(
      payload.buffer,
      payload.byteOffset + offset,
      payload.byteLength - offset,
    ).getUint32(1, false);
    const frameEnd = offset + 5 + messageLength;
    if (frameEnd > payload.length) break;
    if ((flags & 0b0000_0010) === 0) {
      messages.push(payload.subarray(offset + 5, frameEnd));
    }
    offset = frameEnd;
  }
  return messages;
}

function observeRunRequest(body: Uint8Array): ObservedRunRequest | null {
  const [messageBytes] = decodeConnectStreamingMessages(body);
  if (!messageBytes) return null;
  const clientMessage = fromBinary(AgentClientMessageSchema, messageBytes);
  if (clientMessage.message.case !== "runRequest") return null;
  const runRequest = clientMessage.message.value;
  const decodedRunRequest = fromBinary(
    AgentRunRequestSchema,
    toBinary(AgentRunRequestSchema, runRequest),
  );
  const action = decodedRunRequest.action?.action;
  return {
    conversationId: runRequest.conversationId,
    modelId: runRequest.modelDetails?.modelId,
    requestedModelId: runRequest.requestedModel?.modelId,
    hasModelDetails: runRequest.modelDetails !== undefined,
    displayName: runRequest.modelDetails?.displayName,
    actionUserText: action?.case === "userMessageAction"
      ? action.value.userMessage?.text
      : undefined,
    historyTurnCount: decodedRunRequest.conversationState?.turns.length ?? 0,
  };
}

async function createTestCursorBackend(): Promise<TestCursorBackend> {
  let discoveryMode: DiscoveryMode = "success";
  let discoveredModels: Array<{ id: string; name: string; reasoning?: boolean }> = [
    { id: "composer-2", name: "Composer 2", reasoning: true },
  ];
  const discoveryAuthHeaders: string[] = [];
  const discoveryRequestBodies: Uint8Array[] = [];
  const refreshAuthHeaders: string[] = [];
  const runRequests: ObservedRunRequest[] = [];
  const queuedRunFrames: Uint8Array[][] = [];
  const refreshServer = http.createServer((req, res) => {
    if (req.method !== "POST" || req.url !== "/auth/exchange_user_api_key") {
      res.writeHead(404);
      res.end("not found");
      return;
    }

    const authHeader = req.headers.authorization ?? "";
    refreshAuthHeaders.push(authHeader);

    if (authHeader !== "Bearer valid-refresh") {
      res.writeHead(401, { "Content-Type": "text/plain" });
      res.end("bad refresh token");
      return;
    }

    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        accessToken: makeJwt(Math.floor(Date.now() / 1000) + 3600),
        refreshToken: "valid-refresh",
      }),
    );
  });
  await new Promise<void>((resolve) => refreshServer.listen(0, "127.0.0.1", resolve));
  const refreshPort = (refreshServer.address() as AddressInfo).port;

  const apiServer = http2.createServer();
  apiServer.on("stream", (stream, headers) => {
    const serverStream = stream as ServerHttp2Stream;
    const path = String(headers[":path"] ?? "");
    const authHeader = String(headers.authorization ?? "");
    const chunks: Buffer[] = [];

    stream.on("data", (chunk) => {
      chunks.push(Buffer.from(chunk));
    });

    stream.on("end", () => {
      if (path === "/agent.v1.AgentService/Run") {
        const observed = observeRunRequest(new Uint8Array(Buffer.concat(chunks)));
        if (observed) runRequests.push(observed);
        if (!stream.destroyed) {
          try {
            serverStream.respond({
              ":status": 200,
              "content-type": "application/connect+proto",
            });
            const frames = queuedRunFrames.shift();
            if (frames) {
              for (const frame of frames) stream.write(frame);
            }
            stream.end();
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ERR_HTTP2_INVALID_STREAM") {
              throw error;
            }
          }
        }
        return;
      }

      if (path === "/agent.v1.AgentService/GetUsableModels") {
        discoveryAuthHeaders.push(authHeader);
        discoveryRequestBodies.push(new Uint8Array(Buffer.concat(chunks)));

        if (discoveryMode === "auth-error") {
          serverStream.respond({
            ":status": 401,
            "content-type": "application/json",
          });
          stream.end(
            JSON.stringify({ code: "unauthenticated", message: "expired token" }),
          );
          return;
        }

        const responseBody = discoveryMode === "empty"
          ? frameConnectUnaryMessage(new Uint8Array())
          : frameConnectUnaryMessage(
              toBinary(
                GetUsableModelsResponseSchema,
                create(GetUsableModelsResponseSchema, {
                  models: discoveredModels.map((model) =>
                    create(ModelDetailsSchema, {
                      modelId: model.id,
                      displayModelId: model.id,
                      displayName: model.name,
                      displayNameShort: model.name,
                      aliases: [],
                    }),
                  ),
                }),
              ),
            );
        serverStream.respond({
          ":status": 200,
          "content-type": "application/connect+proto",
        });
        stream.end(responseBody);
        return;
      }

      serverStream.respond({ ":status": 404 });
      stream.end();
    });
  });
  await new Promise<void>((resolve) => apiServer.listen(0, "127.0.0.1", resolve));
  const apiPort = (apiServer.address() as AddressInfo).port;

  return {
    apiUrl: `http://127.0.0.1:${apiPort}`,
    refreshUrl: `http://127.0.0.1:${refreshPort}/auth/exchange_user_api_key`,
    queueRunFrames(frames) {
      queuedRunFrames.push(frames);
    },
    setDiscoveryMode(mode) {
      discoveryMode = mode;
    },
    setDiscoveredModels(models) {
      discoveredModels = models;
    },
    resetObservations() {
      discoveryAuthHeaders.length = 0;
      discoveryRequestBodies.length = 0;
      refreshAuthHeaders.length = 0;
      runRequests.length = 0;
    },
    getDiscoveryAuthHeaders() {
      return [...discoveryAuthHeaders];
    },
    getDiscoveryRequestBodies() {
      return discoveryRequestBodies.map((body) => new Uint8Array(body));
    },
    getRefreshAuthHeaders() {
      return [...refreshAuthHeaders];
    },
    getRunRequests() {
      return [...runRequests];
    },
    async close() {
      await Promise.all([
        new Promise<void>((resolve, reject) =>
          apiServer.close((error) => (error ? reject(error) : resolve())),
        ),
        new Promise<void>((resolve, reject) =>
          refreshServer.close((error) => (error ? reject(error) : resolve())),
        ),
      ]);
    },
  };
}

async function loadModules(): Promise<TestModules> {
  const proxy = await import("../src/proxy");
  const auth = await import("../src/auth");
  const index = await import("../src/index");
  const models = await import("../src/models");
  return {
    startProxy: proxy.startProxy,
    stopProxy: proxy.stopProxy,
    getProxyPort: proxy.getProxyPort,
    __testFindActiveBridgeKeyByToolCallId: proxy.__testFindActiveBridgeKeyByToolCallId,
    __testCreateActiveBridgeKey: proxy.__testCreateActiveBridgeKey,
    __testBuildPayloadFromOpenAiMessages: proxy.__testBuildPayloadFromOpenAiMessages,
    __testEmitToolCallsFromConnectFrames: proxy.__testEmitToolCallsFromConnectFrames,
    __testStreamToolCallsFromConnectFrames: proxy.__testStreamToolCallsFromConnectFrames,
    __testInteractionResponseFromQueryFrame: proxy.__testInteractionResponseFromQueryFrame,
    generateCursorAuthParams: auth.generateCursorAuthParams,
    getTokenExpiry: auth.getTokenExpiry,
    CursorAuthPlugin: index.CursorAuthPlugin,
    getCursorModels: models.getCursorModels,
    clearModelCache: models.clearModelCache,
  };
}

async function testProxyStartStop(modules: TestModules) {
  console.log("[test] Starting proxy...");
  const port = await modules.startProxy(async () => "test-token");
  console.log(`[test] Proxy started on port ${port}`);

  if (port < 1) {
    throw new Error(`Expected a valid port number, got ${port}`);
  }
  if (modules.getProxyPort() !== port) {
    throw new Error("getProxyPort() mismatch");
  }

  const modelsRes = await fetch(`http://localhost:${port}/v1/models`);
  if (!modelsRes.ok) {
    throw new Error(`/v1/models returned ${modelsRes.status}`);
  }
  const modelsBody = await modelsRes.json();
  if (modelsBody.object !== "list") {
    throw new Error(`Expected object=list, got ${modelsBody.object}`);
  }
  if (!Array.isArray(modelsBody.data) || modelsBody.data.length !== 1) {
    throw new Error(`Expected model list with 1 entry (auto), got ${JSON.stringify(modelsBody.data)}`);
  }
  if (modelsBody.data[0]?.id !== "auto") {
    throw new Error(`Expected model id=auto, got ${JSON.stringify(modelsBody.data[0])}`);
  }
  console.log("[test] /v1/models OK");

  const badRes = await fetch(`http://localhost:${port}/v1/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: "test", messages: [] }),
  });
  if (badRes.status !== 400) {
    throw new Error(`Expected 400 for missing user message, got ${badRes.status}`);
  }
  const badBody = await badRes.json();
  if (!badBody.error?.message?.includes("No user message")) {
    throw new Error(`Expected 'No user message' error, got: ${badBody.error?.message}`);
  }
  console.log("[test] Missing user message validation OK");

  const notFoundRes = await fetch(`http://localhost:${port}/unknown`);
  if (notFoundRes.status !== 404) {
    throw new Error(`Expected 404, got ${notFoundRes.status}`);
  }
  console.log("[test] 404 handling OK");

  modules.stopProxy();
  if (modules.getProxyPort() !== undefined) {
    throw new Error("Proxy port should be undefined after stop");
  }
  console.log("[test] Proxy stop OK");
}

async function testAuthParams(modules: TestModules) {
  console.log("[test] Generating auth params...");
  const params = await modules.generateCursorAuthParams();

  if (!params.verifier || !params.challenge || !params.uuid || !params.loginUrl) {
    throw new Error("Missing auth params");
  }
  if (!params.loginUrl.includes("cursor.com/loginDeepControl")) {
    throw new Error(`Unexpected login URL: ${params.loginUrl}`);
  }
  if (!params.loginUrl.includes(params.uuid)) {
    throw new Error("Login URL missing UUID");
  }

  const data = new TextEncoder().encode(params.verifier);
  const hashBuffer = await crypto.subtle.digest("SHA-256", data);
  const expectedChallenge = Buffer.from(hashBuffer).toString("base64url");
  if (params.challenge !== expectedChallenge) {
    throw new Error(
      `PKCE challenge mismatch: expected ${expectedChallenge}, got ${params.challenge}`,
    );
  }

  console.log("[test] Auth params OK");
}

async function testTokenExpiry(modules: TestModules) {
  console.log("[test] Testing token expiry parsing...");

  const futureExp = Math.floor(Date.now() / 1000) + 7200;
  const fakeJwt = makeJwt(futureExp);

  const expiry = modules.getTokenExpiry(fakeJwt);
  const expectedMin = futureExp * 1000 - 5 * 60 * 1000 - 1000;
  const expectedMax = futureExp * 1000 - 5 * 60 * 1000 + 1000;

  if (expiry < expectedMin || expiry > expectedMax) {
    throw new Error(`Token expiry ${expiry} out of expected range [${expectedMin}, ${expectedMax}]`);
  }

  const fallbackExpiry = modules.getTokenExpiry("not-a-jwt");
  const now = Date.now();
  const expectedFallback = now + 3600 * 1000;
  if (Math.abs(fallbackExpiry - expectedFallback) > 5000) {
    throw new Error(
      `Fallback expiry off by ${Math.abs(fallbackExpiry - expectedFallback)}ms, expected ~1h from now`,
    );
  }

  console.log("[test] Token expiry OK");
}

async function testPluginShape(modules: TestModules) {
  console.log("[test] Checking plugin export shape...");

  const fakeInput = {
    client: { auth: { set: async () => {} } },
  } as any;
  const hooks = await modules.CursorAuthPlugin(fakeInput);

  if (!hooks.auth) {
    throw new Error("Plugin hooks missing 'auth'");
  }
  if (hooks.auth.provider !== "cursor") {
    throw new Error(`Expected provider 'cursor', got '${hooks.auth.provider}'`);
  }
  if (typeof hooks.auth.loader !== "function") {
    throw new Error("Plugin hooks.auth.loader is not a function");
  }
  if (!Array.isArray(hooks.auth.methods) || hooks.auth.methods.length === 0) {
    throw new Error("Plugin hooks.auth.methods missing or empty");
  }
  if (hooks.auth.methods[0].type !== "oauth") {
    throw new Error(`Expected method type 'oauth', got '${hooks.auth.methods[0].type}'`);
  }
  if (typeof hooks.auth.methods[0].authorize !== "function") {
    throw new Error("Plugin auth method missing authorize function");
  }

  console.log("[test] Plugin shape OK");
}

async function testArrayContentParsing(modules: TestModules) {
  console.log("[test] Testing array content (plan-mode) parsing...");
  const port = await modules.startProxy(async () => "test-token");

  const res = await fetch(`http://localhost:${port}/v1/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "test",
      stream: false,
      messages: [
        {
          role: "system",
          content: [
            { type: "text", text: "You are a helpful assistant." },
            { type: "text", text: "Plan mode is active." },
          ],
        },
        {
          role: "user",
          content: [
            { type: "text", text: "lazy-load recharts" },
            { type: "text", text: "work on a plan" },
          ],
        },
      ],
    }),
  });

  if (res.status === 400) {
    const body = await res.json();
    if (body.error?.message?.includes("No user message")) {
      throw new Error(
        "Array content not normalized — plan mode messages lost",
      );
    }
  }

  modules.stopProxy();
  console.log("[test] Array content parsing OK");
}

async function testAutoModelSendsCursorDefaultModel(
  modules: TestModules,
  backend: TestCursorBackend,
) {
  console.log("[test] Testing auto model request encoding...");
  backend.resetObservations();
  let port = await modules.startProxy(async () => "test-token", [
    { id: "composer-2", name: "Composer 2" },
  ]);

  await fetch(`http://localhost:${port}/v1/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "auto",
      stream: false,
      messages: [{ role: "user", content: "use automatic model selection" }],
    }),
  });

  await fetch(`http://localhost:${port}/v1/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "composer-2",
      stream: false,
      messages: [{ role: "user", content: "use explicit model selection" }],
    }),
  });

  await fetch(`http://localhost:${port}/v1/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "cursor/auto",
      stream: false,
      messages: [{ role: "user", content: "use provider qualified auto model selection" }],
    }),
  });

  await fetch(`http://localhost:${port}/v1/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "cursor/composer-2",
      stream: false,
      messages: [{ role: "user", content: "use provider qualified explicit model selection" }],
    }),
  });

  modules.stopProxy();
  port = await modules.startProxy(async () => "test-token", [
    { id: "composer-2", name: "Composer 2" },
  ]);

  await fetch(`http://localhost:${port}/v1/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "auto",
      stream: false,
      messages: [{ role: "user", content: "use automatic model selection" }],
    }),
  });

  const [autoRequest, explicitRequest, qualifiedAutoRequest, qualifiedExplicitRequest, restartedAutoRequest] = backend.getRunRequests();
  assert(autoRequest, "Expected auto model request to reach Cursor backend");
  assert(
    autoRequest.hasModelDetails,
    `Expected auto model to include modelDetails, got ${JSON.stringify(autoRequest)}`,
  );
  assertEqual(
    autoRequest.modelId,
    "default",
    "Expected auto model to use Cursor default modelDetails id",
  );
  assertEqual(
    autoRequest.requestedModelId,
    "default",
    "Expected auto model to use Cursor default requestedModel id",
  );
  assertEqual(
    autoRequest.displayName,
    "Auto",
    "Expected auto model to display as Auto",
  );
  assert(qualifiedAutoRequest, "Expected provider-qualified auto model request to reach Cursor backend");
  assertEqual(
    qualifiedAutoRequest.modelId,
    "default",
    "Expected provider-qualified auto model to use Cursor default modelDetails id",
  );
  assertEqual(
    qualifiedAutoRequest.requestedModelId,
    "default",
    "Expected provider-qualified auto model to use Cursor default requestedModel id",
  );
  assert(qualifiedExplicitRequest, "Expected provider-qualified explicit model request to reach Cursor backend");
  assertEqual(
    qualifiedExplicitRequest.modelId,
    "cursor/composer-2",
    "Expected provider-qualified explicit model id to remain unchanged",
  );
  assertEqual(
    qualifiedExplicitRequest.requestedModelId,
    "cursor/composer-2",
    "Expected provider-qualified explicit requestedModel id to remain unchanged",
  );
  assert(restartedAutoRequest, "Expected restarted auto model request to reach Cursor backend");
  assertEqual(
    restartedAutoRequest.conversationId,
    autoRequest.conversationId,
    "Expected auto model conversationId to stay stable for the same first user prompt after proxy restart",
  );
  assert(explicitRequest, "Expected explicit model request to reach Cursor backend");
  assertEqual(
    explicitRequest.modelId,
    "composer-2",
    "Expected explicit model id to be forwarded in modelDetails",
  );
  assertEqual(
    explicitRequest.requestedModelId,
    "composer-2",
    "Expected explicit model id to be forwarded in requestedModel",
  );

  modules.stopProxy();
  console.log("[test] Auto model request encoding OK");
}

async function testFollowUpUserMessageBecomesCursorAction(
  modules: TestModules,
  backend: TestCursorBackend,
) {
  console.log("[test] Testing follow-up user message action parsing...");
  backend.resetObservations();
  const port = await modules.startProxy(async () => "test-token", [
    { id: "composer-2", name: "Composer 2" },
  ]);

  await fetch(`http://localhost:${port}/v1/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "auto",
      stream: false,
      messages: [
        { role: "user", content: "first question" },
        { role: "assistant", content: "first answer" },
        { role: "user", content: "second question" },
      ],
    }),
  });

  const [request] = backend.getRunRequests();
  assert(request, "Expected follow-up auto request to reach Cursor backend");
  assertEqual(
    request.actionUserText,
    "second question",
    "Expected the latest user message to be sent as the Cursor action",
  );
  assertEqual(
    request.historyTurnCount,
    1,
    "Expected earlier user/assistant exchange to be preserved as history",
  );

  modules.stopProxy();
  console.log("[test] follow-up user message action parsing OK");
}

async function testCompletedTranscriptDoesNotReplayLastUser(
  modules: TestModules,
  backend: TestCursorBackend,
) {
  console.log("[test] Testing completed transcript is not replayed...");
  backend.resetObservations();
  const port = await modules.startProxy(async () => "test-token", [
    { id: "composer-2", name: "Composer 2" },
  ]);

  const response = await fetch(`http://localhost:${port}/v1/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "auto",
      stream: false,
      messages: [
        { role: "user", content: "do not run this again" },
        { role: "assistant", content: "already answered" },
      ],
    }),
  });

  assertEqual(
    response.status,
    400,
    "Expected a completed transcript without a new user message to be rejected",
  );
  assertEqual(
    backend.getRunRequests().length,
    0,
    "Expected completed transcript rejection to avoid replaying the last user message",
  );

  modules.stopProxy();
  console.log("[test] completed transcript replay guard OK");
}

async function testOrphanToolResultDoesNotStartFreshRun(
  modules: TestModules,
  backend: TestCursorBackend,
) {
  console.log("[test] Testing orphan tool result is rejected...");
  backend.resetObservations();
  const port = await modules.startProxy(async () => "test-token", [
    { id: "composer-2", name: "Composer 2" },
  ]);

  const response = await fetch(`http://localhost:${port}/v1/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "auto",
      messages: [
        { role: "user", content: "find a file" },
        {
          role: "assistant",
          content: null,
          tool_calls: [{
            id: "missing-tool-call",
            type: "function",
            function: { name: "glob", arguments: "{}" },
          }],
        },
        {
          role: "tool",
          tool_call_id: "missing-tool-call",
          content: "No files found",
        },
      ],
    }),
  });

  assertEqual(
    response.status,
    409,
    "Expected orphan tool results to be rejected instead of starting a fresh Cursor run",
  );
  assertEqual(
    backend.getRunRequests().length,
    0,
    "Expected orphan tool-result rejection to avoid replaying tool output as a new request",
  );

  modules.stopProxy();
  console.log("[test] orphan tool result replay guard OK");
}

async function testFollowUpIgnoresStoredCheckpoint(
  modules: TestModules,
) {
  console.log("[test] Testing follow-up ignores stored checkpoint...");
  const requestBytes = modules.__testBuildPayloadFromOpenAiMessages(
    "auto",
    [
      { role: "user", content: "checkpoint follow-up first" },
      { role: "assistant", content: "first answer" },
      { role: "user", content: "checkpoint follow-up second" },
    ],
    "00000000-0000-4000-8000-000000000000",
  );
  const clientMessage = fromBinary(AgentClientMessageSchema, requestBytes);
  const runRequest = clientMessage.message.case === "runRequest"
    ? clientMessage.message.value
    : undefined;
  assert(runRequest, "Expected helper to build a runRequest");
  const decodedRunRequest = fromBinary(
    AgentRunRequestSchema,
    toBinary(AgentRunRequestSchema, runRequest),
  );
  const action = decodedRunRequest.action?.action;
  assertEqual(
    action?.case === "userMessageAction" ? action.value.userMessage?.text : undefined,
    "checkpoint follow-up second",
    "Expected the latest user message to remain the Cursor action after a stored checkpoint",
  );
  assertEqual(
    decodedRunRequest.conversationState?.turns.length ?? 0,
    1,
    "Expected OpenAI history to be rebuilt instead of replaced by the stored checkpoint",
  );

  console.log("[test] follow-up checkpoint rebuild OK");
}

async function testToolResultContinuationFallsBackToToolCallId(
  modules: TestModules,
) {
  console.log("[test] Testing tool-result continuation fallback...");
  assertEqual(
    modules.__testFindActiveBridgeKeyByToolCallId(
      [
        { key: "bridge:auto:first-user", pendingToolCallIds: ["tool-call-1"] },
        { key: "bridge:auto:other-user", pendingToolCallIds: ["tool-call-2"] },
      ],
      ["tool-call-1"],
    ),
    "bridge:auto:first-user",
    "Expected tool result to find the original bridge by matching tool_call_id",
  );
  console.log("[test] Tool-result continuation fallback OK");
}

async function testParallelAutoBridgeKeysDoNotCollide(
  modules: TestModules,
) {
  console.log("[test] Testing parallel AUTO bridge keys...");
  const lookupKey = "bridge:auto:first-user";
  const firstKey = modules.__testCreateActiveBridgeKey(lookupKey);
  const secondKey = modules.__testCreateActiveBridgeKey(lookupKey);

  assert(
    firstKey.startsWith(`${lookupKey}:`),
    "Expected active bridge key to retain the legacy lookup prefix for diagnostics",
  );
  assert(
    secondKey.startsWith(`${lookupKey}:`),
    "Expected active bridge key to retain the legacy lookup prefix for diagnostics",
  );
  assert(
    firstKey !== secondKey,
    "Expected parallel AUTO bridge keys with the same lookup input to be unique",
  );
  assertEqual(
    modules.__testFindActiveBridgeKeyByToolCallId(
      [
        { key: firstKey, pendingToolCallIds: ["tool-call-a"] },
        { key: secondKey, pendingToolCallIds: ["tool-call-b"] },
      ],
      ["tool-call-a"],
    ),
    firstKey,
    "Expected tool_call_id fallback to find the matching UUID-keyed bridge",
  );
  assertEqual(
    modules.__testFindActiveBridgeKeyByToolCallId(
      [
        { key: firstKey, pendingToolCallIds: ["tool-call-a"] },
        { key: secondKey, pendingToolCallIds: ["tool-call-b"] },
      ],
      ["tool-call-a", "tool-call-b"],
    ),
    undefined,
    "Expected mixed tool results from parallel bridges not to match one bridge",
  );
  console.log("[test] Parallel AUTO bridge keys OK");
}

async function testInteractionQueryIsRejected(
  modules: TestModules,
) {
  console.log("[test] Testing interactionQuery rejection response...");
  const [responseFrame] = modules.__testInteractionResponseFromQueryFrame(
    makeAskQuestionInteractionQueryFrame(7),
  );
  assert(responseFrame, "Expected interactionQuery to produce a client response frame");
  const [responseBytes] = decodeConnectStreamingMessages(responseFrame);
  assert(responseBytes, "Expected interaction response frame to contain one protobuf message");
  const responseMessage = fromBinary(AgentClientMessageSchema, responseBytes);
  if (responseMessage.message.case !== "interactionResponse") {
    throw new Error(
      `Expected interactionQuery to be answered with interactionResponse, got ${responseMessage.message.case}`,
    );
  }
  const response = responseMessage.message.value;
  assertEqual(response.id, 7, "Expected interactionResponse to preserve query id");
  if (response.result.case !== "askQuestionInteractionResponse") {
    throw new Error(
      `Expected askQuestion interaction response type, got ${response.result.case}`,
    );
  }
  assertEqual(
    response.result.value.result?.result.case,
    "rejected",
    "Expected askQuestion interaction query to be rejected instead of hanging",
  );
  console.log("[test] interactionQuery rejection response OK");
}

async function testStreamingResponseEmitsAllMcpArgs(
  modules: TestModules,
) {
  console.log("[test] Testing multi-tool stream frame handling...");
  const frames = [
    makeMcpExecFrame(1, "tool-call-a", "first_tool"),
    makeMcpExecFrame(2, "tool-call-b", "second_tool"),
    frameConnectEndStream(),
  ];
  const toolCallIds = modules.__testEmitToolCallsFromConnectFrames(frames);
  assertArrayEqual(
    toolCallIds,
    ["tool-call-a", "tool-call-b"],
    "Expected all mcpArgs frames to become pending tool calls before finishing",
  );

  const sseText = await modules.__testStreamToolCallsFromConnectFrames(frames);
  assert(
    sseText.includes('"finish_reason":"tool_calls"'),
    "Expected streaming tool-call response to finish with tool_calls",
  );
  assert(
    sseText.includes("data: [DONE]"),
    "Expected streaming tool-call response to close with [DONE]",
  );
  console.log("[test] Multi-tool stream frame handling OK");
}

async function testStreamingResponseClosesOnConnectError(
  modules: TestModules,
) {
  console.log("[test] Testing Connect error stream closure...");
  const sseText = await modules.__testStreamToolCallsFromConnectFrames([
    frameConnectEndStreamError("internal", "model stream failed"),
  ]);
  assert(
    sseText.includes("Connect error internal: model stream failed"),
    "Expected Connect end-stream error to be emitted to the client",
  );
  assert(
    sseText.includes('"finish_reason":"stop"'),
    "Expected Connect end-stream error to finish the SSE stream",
  );
  assert(
    sseText.includes("data: [DONE]"),
    "Expected Connect end-stream error response to close with [DONE]",
  );
  console.log("[test] Connect error stream closure OK");
}

async function testStreamingResponseClosesOnTurnEnded(
  modules: TestModules,
) {
  console.log("[test] Testing turnEnded stream closure...");
  const sseText = await modules.__testStreamToolCallsFromConnectFrames([
    makeTextDeltaFrame("hello from cursor"),
    makeTurnEndedFrame(),
  ]);
  assert(
    sseText.includes("hello from cursor"),
    "Expected text delta to be emitted before turnEnded closure",
  );
  assert(
    sseText.includes('"finish_reason":"stop"'),
    "Expected turnEnded update to finish the SSE stream",
  );
  assert(
    sseText.includes("data: [DONE]"),
    "Expected turnEnded response to close with [DONE]",
  );
  console.log("[test] turnEnded stream closure OK");
}

async function testStreamingResponseClosesOnIdleText(
  modules: TestModules,
) {
  console.log("[test] Testing idle text stream closure...");
  const sseText = await modules.__testStreamToolCallsFromConnectFrames(
    [makeTextDeltaFrame("hello without terminal frame")],
    10,
  );
  assert(
    sseText.includes("hello without terminal frame"),
    "Expected text delta to be emitted before idle closure",
  );
  assert(
    sseText.includes('"finish_reason":"stop"'),
    "Expected idle text stream to finish instead of hanging",
  );
  assert(
    sseText.includes("data: [DONE]"),
    "Expected idle text stream to close with [DONE]",
  );
  console.log("[test] idle text stream closure OK");
}

async function testExpiredTokenRefreshBeforeDiscovery(
  modules: TestModules,
  backend: TestCursorBackend,
) {
  console.log("[test] Testing refresh-before-discovery...");
  modules.clearModelCache();
  backend.resetObservations();
  backend.setDiscoveryMode("success");
  backend.setDiscoveredModels([
    { id: "fresh-model", name: "Fresh Model", reasoning: true },
  ]);

  let authState = {
    type: "oauth" as const,
    access: "expired-access",
    refresh: "valid-refresh",
    expires: Date.now() - 10_000,
  };
  const writes: Array<{ access: string; refresh: string; expires: number }> = [];
  const hooks = await modules.CursorAuthPlugin({
    client: {
      auth: {
        set: async ({ body }: any) => {
          writes.push(body);
          authState = body;
        },
      },
    },
  } as any);
  const provider = { models: {} as Record<string, unknown> } as any;

  await getAuthLoader(hooks)(async () => authState, provider);

  assertEqual(writes.length, 1, "Expected refreshed auth to be persisted once");
  assert(
    writes[0]?.access && writes[0].access !== "expired-access",
    "Expected refreshed access token to replace the expired token",
  );
  assertArrayEqual(
    backend.getRefreshAuthHeaders(),
    ["Bearer valid-refresh"],
    "Expected refresh endpoint to be called with the stored refresh token",
  );
  assert(
    backend.getDiscoveryAuthHeaders().every((header) => header === `Bearer ${writes[0]?.access}`),
    `Expected discovery to use the refreshed token, got ${JSON.stringify(backend.getDiscoveryAuthHeaders())}`,
  );
  assert(
    "auto" in provider.models,
    "Expected provider models to include auto after refresh-before-discovery",
  );

  modules.stopProxy();
  console.log("[test] Refresh-before-discovery OK");
}

async function testDiscoveryFallbackAndSuccess(
  modules: TestModules,
  backend: TestCursorBackend,
) {
  console.log("[test] Testing discovery fallback and success...");

  const authState = {
    type: "oauth" as const,
    access: makeJwt(Math.floor(Date.now() / 1000) + 3600),
    refresh: "valid-refresh",
    expires: Date.now() + 3_600_000,
  };
  const hooks = await modules.CursorAuthPlugin({
    client: {
      auth: {
        set: async () => {},
      },
    },
  } as any);
  const provider = { models: { stale: { id: "stale" } } } as any;

  // Failed discovery should fall back to hardcoded models
  modules.clearModelCache();
  backend.setDiscoveryMode("empty");
  const degradedConfig = await getAuthLoader(hooks)(async () => authState, provider);
  assert(
    Object.keys(provider.models).length > 0,
    "Expected fallback models to be registered when discovery fails",
  );
  assert(
    "auto" in provider.models,
    "Expected provider models to include auto when discovery falls back",
  );
  assert(
    !("stale" in provider.models),
    "Expected stale models to be replaced",
  );
  const degradedModelsRes = await fetch(`${degradedConfig.baseURL}/models`);
  assertEqual(degradedModelsRes.status, 200, "Expected degraded /v1/models to succeed");
  const degradedModelsBody = await degradedModelsRes.json();
  assert(
    degradedModelsBody.data.length > 0,
    "Expected proxy /v1/models to expose fallback models",
  );

  // Successful discovery should replace with real models
  modules.clearModelCache();
  backend.setDiscoveryMode("success");
  backend.setDiscoveredModels([
    { id: "real-model-a", name: "Real Model A" },
    { id: "auto", name: "Auto From Discovery", reasoning: true },
    { id: "real-model-b", name: "Real Model B", reasoning: true },
  ]);
  const discoveredConfig = await getAuthLoader(hooks)(async () => authState, provider);
  assert(
    "auto" in provider.models,
    "Expected successful discovery provider models to include auto",
  );
  assertEqual(
    Object.keys(provider.models).filter((modelId) => modelId === "auto").length,
    1,
    "Expected provider models to include auto exactly once",
  );
  const discoveredModelsRes = await fetch(`${discoveredConfig.baseURL}/models`);
  assertEqual(discoveredModelsRes.status, 200, "Expected discovered /v1/models to succeed");
  const discoveredModelsBody = await discoveredModelsRes.json();
  const discoveredModelIds = discoveredModelsBody.data.map((model: { id: string }) => model.id);
  assert(
    discoveredModelIds.includes("auto"),
    "Expected proxy /v1/models to expose auto",
  );
  assertEqual(
    discoveredModelIds.filter((modelId: string) => modelId === "auto").length,
    1,
    "Expected proxy /v1/models to expose auto exactly once",
  );

  modules.stopProxy();
  console.log("[test] Discovery fallback and success OK");
}

async function main() {
  const backend = await createTestCursorBackend();
  process.env.CURSOR_API_URL = backend.apiUrl;
  process.env.CURSOR_REFRESH_URL = backend.refreshUrl;

  const modules = await loadModules();

  try {
    await testProxyStartStop(modules);
    await testAuthParams(modules);
    await testTokenExpiry(modules);
    await testPluginShape(modules);
    await testArrayContentParsing(modules);
    await testAutoModelSendsCursorDefaultModel(modules, backend);
    await testFollowUpUserMessageBecomesCursorAction(modules, backend);
    await testCompletedTranscriptDoesNotReplayLastUser(modules, backend);
    await testOrphanToolResultDoesNotStartFreshRun(modules, backend);
    await testFollowUpIgnoresStoredCheckpoint(modules);
    await testToolResultContinuationFallsBackToToolCallId(modules);
    await testParallelAutoBridgeKeysDoNotCollide(modules);
    await testStreamingResponseEmitsAllMcpArgs(modules);
    await testStreamingResponseClosesOnConnectError(modules);
    await testStreamingResponseClosesOnTurnEnded(modules);
    await testStreamingResponseClosesOnIdleText(modules);
    await testInteractionQueryIsRejected(modules);
    await testExpiredTokenRefreshBeforeDiscovery(modules, backend);
    await testDiscoveryFallbackAndSuccess(modules, backend);
    console.log("\n✓ All smoke tests passed");
    process.exitCode = 0;
  } catch (err) {
    console.error("\n✗ Smoke test failed:", err);
    process.exitCode = 1;
  } finally {
    modules.stopProxy();
    await backend.close();
  }
}

main();
