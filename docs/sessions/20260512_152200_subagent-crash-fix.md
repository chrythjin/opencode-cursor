# Cursor Auto 서브에이전트 크래시 수정

**날짜**: 2026-05-12  
**파일**: `src/proxy.ts`  
**변경량**: +27 / -12 (1 file)

## 문제 현상

Cursor Auto 모델(Agent)이 서브에이전트를 호출한 뒤 프로세스가 "뻗는" 현상이 반복적으로 발생.  
OpenCode 클라이언트 측에서 응답을 영원히 기다리며 먹통이 됨.

## 근본 원인 분석

### 1. 스트림 조기 종료 (핵심 버그)

`createBridgeStreamResponse` 내 `onMcpExec` 콜백에서 첫 번째 도구 호출 수신 즉시 `queueMicrotask`로 SSE 스트림을 종료 예약:

```typescript
// 기존 (문제 코드)
if (!toolCallFinishScheduled) {
  toolCallFinishScheduled = true;
  queueMicrotask(() => {
    sendSSE(makeChunk({}, "tool_calls"));
    sendDone();
    closeController();
  });
}
```

**문제점**:
- Cursor가 한 턴에 여러 도구 호출을 순차적으로 보내면, 첫 번째 호출 후 스트림이 닫혀 나머지가 유실됨
- `queueMicrotask`는 동일 이벤트 루프의 마이크로태스크에서 실행되므로, 동기적으로 여러 `mcpArgs`를 수신하는 경우에만 안전함
- H2 bridge의 비동기 데이터 수신 타이밍에 따라 비결정적으로 실패

### 2. bridge 정상 종료 시 스트림 미종료

`bridge.onClose` 핸들러에서 `code !== 0`만 처리:

```typescript
// 기존
} else if (code !== 0) {
  // Bridge died ...
}
// code === 0 && mcpExecReceived → 아무것도 안 함 → 클라이언트 무한 대기
```

bridge가 정상적으로 종료(`code === 0`)되면서 도구 호출이 있는 경우, SSE 스트림을 아예 닫지 않아 클라이언트가 영원히 대기.

### 3. InteractionQuery 미처리

Cursor 서버가 `interactionQuery` (웹 검색, 질문하기 등 네이티브 UI 기능)를 보낼 때, `processServerMessage`에서 이 케이스를 무시하고 있었음. 이로 인해 서버가 응답을 기다리며 bridge가 타임아웃으로 죽을 가능성 존재.

## 적용된 수정

### 변경 1: Import 추가 (L67)

```diff
+  type InteractionQuery,
   type KvServerMessage,
```

### 변경 2: findActiveBridge 디버그 로깅 (L535, L542)

```diff
 ): ActiveBridgeMatch | undefined {
+  if (process.env.DEBUG_PROXY) console.log(`[proxy] findActiveBridge: ...`);
   const exact = activeBridges.get(bridgeKey);
```

bridge 조회 시 exact match / fallback 경로를 `DEBUG_PROXY=1`로 추적 가능.

### 변경 3: processServerMessage 로깅 + interactionQuery 핸들링 (L948-964)

```diff
   const msgCase = msg.message.case;
+  if (process.env.DEBUG_PROXY) {
+    console.log(`[proxy] server message: ${msgCase}`);
+  }
   ...
+  } else if (msgCase === "interactionQuery") {
+    const query = msg.message.value as InteractionQuery;
+    const queryCase = query.query.case;
+    console.warn(`[proxy] unhandled interactionQuery: ${queryCase}`);
   } else if (msgCase === "conversationCheckpointUpdate") {
```

- 모든 서버 메시지 타입을 `DEBUG_PROXY`로 추적 가능
- `interactionQuery` 수신 시 경고 로그 출력 (향후 적절한 응답 구현 필요)

### 변경 4: 스트림 종료 로직 3-way 분기 (L1374-1445)

**onMcpExec**: `queueMicrotask` 삭제, 도구 호출 기록만 수행

```diff
 if (!toolCallFinishScheduled) {
   toolCallFinishScheduled = true;
-  queueMicrotask(() => {
-    sendSSE(makeChunk({}, "tool_calls"));
-    sendDone();
-    closeController();
-  });
+  // Don't close here — wait for bridge onClose to finalize.
+  // This ensures all tool calls in this turn are captured.
 }
```

**onClose**: 3가지 경우 모두 처리

```typescript
if (!mcpExecReceived) {
  // 1. 도구 호출 없음 → finish_reason: "stop"
} else if (activeBridges.has(bridgeKey)) {
  // 2. 도구 호출 있고 bridge가 activeBridges에 등록됨
  //    → finish_reason: "tool_calls" + 스트림 종료
  //    → 클라이언트가 도구 실행 후 follow-up 요청
} else {
  // 3. bridge 비정상 종료
  //    → 에러 메시지 + finish_reason: "stop"
}
```

## 검증

| 항목 | 결과 |
|------|------|
| `bun run build` (tsc) | ✅ 성공, 타입 에러 없음 |
| `git diff --stat` | `1 file changed, 27 insertions(+), 12 deletions(-)` |
| Smoke test "array content" 멈춤 | ⚠️ 원본에서도 동일 — bridge 30초 초기 타임아웃 기존 문제 |

## 디버깅 방법

서브에이전트 호출 시 문제가 재발하면:

```bash
DEBUG_PROXY=1 bun run ...
```

로그에서 확인할 항목:
1. `[proxy] server message: interactionQuery` — 미처리 쿼리가 스톨 원인인지
2. `[proxy] findActiveBridge: bridgeKey=... toolResults=N` — bridge 조회 실패 여부
3. `[proxy] findActiveBridge: fallback match via toolCallId` — fallback 경로 사용 빈도

## 잔존 위험 및 해결 방향

### 1. InteractionQuery 응답 미구현

**위험**: `interactionQuery`(웹 검색, 질문하기, 모드 전환 등)에 대해 현재 경고 로그만 출력하고 응답을 보내지 않음. Cursor 서버가 이 응답을 동기적으로 기다린다면 bridge가 타임아웃으로 죽을 수 있음.

**우선순위**: 🔴 높음 — 서브에이전트 크래시의 또 다른 원인일 가능성

**해결 방향**:

`processServerMessage`에서 `interactionQuery`를 수신하면 `InteractionResponse`를 즉시 전송하여 서버를 unblock. 각 쿼리 타입별로 적절한 빈 응답/거부 응답을 구성:

```typescript
// processServerMessage 내 interactionQuery 분기
} else if (msgCase === "interactionQuery") {
  const query = msg.message.value as InteractionQuery;
  const queryCase = query.query.case;
  console.warn(`[proxy] interactionQuery: ${queryCase}`);

  // 각 쿼리 타입에 맞는 빈/거부 응답 전송
  const responseMap: Record<string, { case: string; value: unknown }> = {
    webSearchRequestQuery: {
      case: "webSearchRequestResponse",
      value: create(WebSearchRequestResponseSchema, { results: [] }),
    },
    askQuestionInteractionQuery: {
      case: "askQuestionInteractionResponse",
      value: create(AskQuestionInteractionResponseSchema, {
        result: { case: "rejected", value: "Not supported in this environment" },
      }),
    },
    // switchModeRequestQuery, exaSearchRequestQuery 등도 동일 패턴
  };

  const responseEntry = responseMap[queryCase as string];
  if (responseEntry) {
    const interactionResponse = create(InteractionResponseSchema, {
      id: query.id,
      result: responseEntry as any,
    });
    const clientMsg = create(AgentClientMessageSchema, {
      message: { case: "interactionResponse", value: interactionResponse },
    });
    sendFrame(frameConnectMessage(toBinary(AgentClientMessageSchema, clientMsg)));
  }
}
```

**구현 단계**:
1. `DEBUG_PROXY=1`로 실제 사용 중 어떤 `interactionQuery` 타입이 오는지 수집
2. 프로토 스키마에서 각 `*Response` 타입의 필수 필드 확인
3. 빈/거부 응답 구현 및 테스트
4. `processServerMessage` 시그니처에 `sendFrame` 파라미터 추가 (현재는 `handleExecMessage`에만 전달됨)

---

### 2. Smoke Test 회귀 (`testArrayContentParsing` 타임아웃)

**위험**: `testArrayContentParsing`이 원본에서도 30초 초기 타임아웃으로 멈춤. 테스트 서버가 `/agent.v1.AgentService/Run` 요청에 대해 빈 응답으로 `stream.end()`만 호출하고 Connect 프로토콜의 end-stream 프레임을 보내지 않아, bridge 프로세스가 H2 스트림 종료를 인식하지 못함.

**우선순위**: 🟡 중간 — 기능에는 영향 없으나 CI/CD 파이프라인 차단

**해결 방향**:

테스트 서버의 `Run` RPC 핸들러에서 적절한 Connect end-stream 프레임을 전송:

```typescript
// test/smoke.ts — apiServer "Run" 핸들러 수정
if (path === "/agent.v1.AgentService/Run") {
  const observed = observeRunRequest(new Uint8Array(Buffer.concat(chunks)));
  if (observed) runRequests.push(observed);
  if (!stream.destroyed) {
    try {
      serverStream.respond({
        ":status": 200,
        "content-type": "application/connect+proto",
      });
      // Connect end-stream 프레임 전송 (flags=0x02, 빈 JSON 페이로드)
      const endStreamPayload = new TextEncoder().encode("{}");
      const endFrame = Buffer.alloc(5 + endStreamPayload.length);
      endFrame[0] = 0b0000_0010; // end-stream flag
      endFrame.writeUInt32BE(endStreamPayload.length, 1);
      endFrame.set(endStreamPayload, 5);
      stream.end(endFrame);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ERR_HTTP2_INVALID_STREAM") {
        throw error;
      }
    }
  }
  return;
}
```

**구현 단계**:
1. `frameConnectEndStream()` 헬퍼가 이미 테스트 파일에 존재 (line 87) — 이것을 `Run` 핸들러에서 사용
2. bridge가 end-stream 프레임 수신 시 정상 종료되는지 확인
3. `CURSOR_BRIDGE_INITIAL_TIMEOUT_MS=5000`으로 테스트 타임아웃을 단축하여 실패 시 빠르게 감지

---

### 3. 다중 Bridge 키 충돌

**위험**: `deriveBridgeKey`가 `SHA256("bridge:" + modelId + firstUserText[:200])`로 생성되므로, 동일 프롬프트로 여러 서브에이전트가 병렬 실행되면 lookup key가 충돌. 현재 `createActiveBridgeKey`가 UUID 접미사를 붙여 실제 `activeBridges` 맵 키는 유니크하지만, 새 요청이 올 때 `findActiveBridge`의 exact match가 실패하여 fallback 경로를 타게 됨.

**우선순위**: 🟢 낮음 — `tool_call_id` 기반 fallback이 이미 동작하므로 실질적 충돌 빈도 낮음

**해결 방향**:

**단기 (모니터링)**:
```bash
# DEBUG_PROXY 로그에서 fallback 빈도 확인
DEBUG_PROXY=1 bun run ... 2>&1 | grep "fallback match"
```

fallback이 빈번하면 bridge key 전략을 개선.

**장기 (키 전략 개선)**:

bridge key에 요청 시퀀스 또는 conversation turn 번호를 포함시켜 유니크성 강화:

```typescript
// 현재
function deriveBridgeKey(modelId: string, messages: OpenAIMessage[]): string {
  const firstUserText = ...;
  return createHash("sha256")
    .update(`bridge:${modelId}:${firstUserText.slice(0, 200)}`)
    .digest("hex").slice(0, 16);
}

// 개선안: 메시지 수 + 마지막 assistant tool_calls ID를 키에 포함
function deriveBridgeKey(modelId: string, messages: OpenAIMessage[]): string {
  const firstUserText = ...;
  const msgCount = messages.length;
  const lastToolCallId = messages
    .filter(m => m.role === "assistant" && m.tool_calls?.length)
    .at(-1)?.tool_calls?.[0]?.id ?? "";
  return createHash("sha256")
    .update(`bridge:${modelId}:${firstUserText.slice(0, 200)}:${msgCount}:${lastToolCallId}`)
    .digest("hex").slice(0, 16);
}
```

**구현 단계**:
1. `DEBUG_PROXY` 로그로 실제 충돌 빈도 측정 (1주간)
2. 충돌이 빈번하면 키 전략 개선 적용
3. `__testFindActiveBridgeKeyByToolCallId` 테스트에 병렬 시나리오 추가

---

### 4. `processServerMessage`에서 `sendFrame` 부재 (InteractionQuery 응답 시 필요)

**위험**: 현재 `processServerMessage`는 `sendFrame`을 `handleExecMessage`와 `handleKvMessage`에만 전달. `interactionQuery` 응답을 보내려면 `sendFrame`이 필요하지만, 현재 함수 시그니처에서 직접 접근 가능(이미 파라미터로 받고 있음). 다만, `InteractionResponse`는 `ExecClientMessage`가 아닌 `AgentClientMessage.interactionResponse`로 전송해야 하므로 별도의 헬퍼 함수가 필요.

**우선순위**: 🔴 높음 — 위험 1번 해결의 선행 조건

**해결 방향**:

```typescript
function sendInteractionResponse(
  queryId: number,
  responseCase: string,
  value: unknown,
  sendFrame: (data: Uint8Array) => void,
): void {
  const interactionResponse = create(InteractionResponseSchema, {
    id: queryId,
    result: { case: responseCase as any, value: value as any },
  });
  const clientMsg = create(AgentClientMessageSchema, {
    message: { case: "interactionResponse", value: interactionResponse },
  });
  sendFrame(frameConnectMessage(toBinary(AgentClientMessageSchema, clientMsg)));
}
```

`processServerMessage`는 이미 `sendFrame`을 파라미터로 받고 있으므로 시그니처 변경 없이 바로 사용 가능.
