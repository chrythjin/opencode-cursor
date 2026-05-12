# Auto 첫 응답 멈춤 수정

## 증상

`model: "auto"` 사용 시 같은 내용을 한 번 입력하면 응답이 일부 나오다가 멈추고, 같은 내용을 다시 입력해야 답변이 완료되는 현상이 보고됨.

## 원인 후보와 수정

### 1. 정상 Connect end-stream에서 SSE 미종료

`createBridgeStreamResponse()`가 Cursor/Connect end-stream을 받았을 때 에러만 처리하고, 정상 종료 `{}`는 bridge child process 종료까지 기다렸다. 이 경로에서는 OpenAI SSE 클라이언트가 `finish_reason`/`[DONE]`을 받지 못해 “응답하다 멈춤”으로 보일 수 있다.

수정:

- 정상 end-stream + 도구 호출 없음: 즉시 `finish_reason: "stop"`, usage, `[DONE]` 전송 후 controller close.
- 정상 end-stream + pending tool calls: 즉시 `finish_reason: "tool_calls"`, usage, `[DONE]` 전송.
- 일반 응답 정상 종료 시 heartbeat 정리와 bridge stdin 종료도 같이 수행.
- 기존 bridge `onClose` fallback은 유지.

### 2. `conversationId`가 proxy 재시작 후 불안정

`deterministicConversationId(convKey)` helper가 이미 존재했지만 새 `StoredConversation` 생성 시 `crypto.randomUUID()`를 사용하고 있었다. 같은 첫 user prompt의 `convKey`가 같아도 proxy 재시작/상태 초기화 뒤 Cursor 서버에 다른 `conversationId`가 전달될 수 있었다.

수정:

- 새 conversation 생성 시 `conversationId: deterministicConversationId(convKey)` 사용.
- `testAutoModelSendsCursorDefaultModel()`에 proxy 재시작 뒤 같은 auto 첫 prompt가 같은 `conversationId`를 보내는 회귀 검증 추가.

## 검증

- `bun run build` 통과.
- `lsp_diagnostics`:
  - `src/proxy.ts`: error 없음.
  - `test/smoke.ts`: error 없음.
- Surface driver:
  - 로컬 HTTP/2 test backend를 세움.
  - proxy `/v1/chat/completions`에 `model: "auto"`, streaming 요청 전송.
  - Connect 정상 end-stream `{}` 수신 후 OpenAI SSE가 `data: [DONE]`까지 닫히는 것 확인.
  - proxy stop/start 후 같은 auto prompt를 다시 보내도 Cursor `runRequest.conversationId`가 동일한 것 확인.

검증 출력 요약:

```text
stable conversationId c698e6e5-7b5e-445b-9a63-a41c7a9c297c
```

## 미해결/기존 이슈

`bun test/smoke.ts` 전체 실행은 기존과 동일하게 `testArrayContentParsing` 지점에서 120초 timeout으로 멈춤. 이번 변경 경로는 별도 targeted surface driver와 build/LSP로 검증했다.
