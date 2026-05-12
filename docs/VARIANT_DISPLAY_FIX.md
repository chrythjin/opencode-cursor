# Opencode 모델 Variant 표시 문제 해결 내용 (2026-05-12)

## 개요
Opencode에서 `openai-oauth` 프로바이더 사용 시, 다른 프로바이더(Anthropic 등)와 달리 TUI 상태바 및 모델 선택 창에서 `variant`가 표시되지 않는 현상을 분석하고 조치했습니다.

## 원인 파악
1. **openai-oauth-provider 패키지 내부**: openai-oauth 패키지 소스 코드(`packages/openai-oauth-provider`)를 분석한 결과, 이는 순수 백엔드 HTTP 어댑터/프록시 역할만 수행하며, 화면 렌더링에 관여하는 UI 로직은 존재하지 않습니다.
2. **Opencode TUI 컴포넌트**: Opencode 소스 코드 (`dev` 브랜치의 TUI 컴포넌트: `app.tsx`, `footer.tsx`, `dialog-model.tsx`, `dialog-variant.tsx`)를 확인한 결과, Variant 기능은 내장된 모델 카탈로그에 `variants` 배열이 명시되어 있어야만 다이얼로그와 상태바에 출력됩니다. 
3. **opencode.json 설정 누락**: 사용자의 `~/.config/opencode/opencode.json` 설정에 커스텀으로 등록된 `openai-oauth` 모델들에는 `variants` 필드가 정의되어 있지 않았기 때문에 Opencode가 Variant를 표시할 수 없었습니다.

## 해결 방법
이 문제는 코드를 직접 포크하여 수정할 필요 없이, 로컬의 `opencode.json` 파일에 `variants` 배열만 추가해주면 해결됩니다. 설정 파일 크기가 늘어나더라도 LLM의 컨텍스트(토큰)와 무관한 로컬 앱 설정이므로 추가적인 토큰 소모가 발생하지 않습니다.

### 적용된 수정 사항
`C:\Users\U-N-00658\.config\opencode\opencode.json` 파일의 `gpt-5.4`와 `gpt-5.5` 모델에 아래와 같이 `variants` 속성을 추가했습니다.

```json
"gpt-5.4": {
  "name": "gpt-5.4",
  "reasoning": true
}
```

이후 `opencode`를 재시작하면, 해당 모델 선택 시 Variant를 선택할 수 있는 창이 나타나고 상태바에도 함께 표시됩니다.
