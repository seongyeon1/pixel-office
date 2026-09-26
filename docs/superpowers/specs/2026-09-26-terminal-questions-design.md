# 터미널 Claude의 질문에 화면에서 답하기 — 설계

## 문제

사용자 터미널에서 도는 Claude가 `AskUserQuestion`을 부르면 맵에 `?`는 뜨지만 답할 수 없다. 다른 프로세스의
터미널이라 앱이 입력을 넣을 통로가 없다(macOS는 다른 TTY에 키 입력 주입도 막는다).

## 검증한 사실 (spike)

프로젝트 설정의 `PreToolUse` 훅(matcher `AskUserQuestion`, command)이
`{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"allow","updatedInput":{...tool_input,"answers":{질문:답}}}}`
을 출력하자 모델은 훅이 넣은 답을 받았고 `canUseTool`은 한 번도 불리지 않았다(SDK, Haiku).
훅 입력에는 `session_id`, `cwd`, `transcript_path`, `tool_input.questions`가 있다.
**대화형 터미널에서의 동작은 구현 후 실제 세션으로 확인한다.**

## 설계

- `scripts/ask-hook.mjs`(의존성 없음): 질문을 서버에 등록하고 답을 long-poll로 기다린다. 답이 오면 위 JSON을 출력.
  서버가 없거나, 사용자가 “터미널에서 답할게요”를 누르거나, 9분 30초가 지나면 **아무것도 출력하지 않고 종료**해서
  터미널의 원래 선택 화면이 뜬다. 훅 `timeout`은 600초.
- 서버 `questions.ts`: 대기 중 질문(메모리) — 등록·대기·답변·돌려주기·15분 만료.
- 인증: 훅 전용 토큰을 `<dataDir>/hook.json`(권한 600, `{url, token}`)에 한 번 만들어 두고 훅은 헤더로 보낸다.
  `/api/hook/*`만 토큰으로 받고, 화면용 `/api/questions/*`는 기존 쿠키·Origin 검사를 거친다.
- 설치: 화면 버튼으로만. `~/.claude/settings.json`(또는 `CLAUDE_CONFIG_DIR`)에 PreToolUse 항목 하나를 넣고,
  넣기 전 백업을 만든다. 이미 있으면 그대로, 제거는 우리 항목만 지운다.
- 화면: 질문이 걸린 외부 세션을 고르면 오른쪽 패널 맨 위에 선택지 폼(`InteractionPanel` 재사용)과
  “터미널에서 답할게요”. 훅이 설치되지 않았으면 안내와 설치 버튼. **우리 팀** 화면에 설치 상태·설치·제거.

## 테스트

- vitest: 질문 대기·답변·돌려주기·만료, 훅 토큰 없는 요청 거절, 화면 API 인증, 설치·제거(백업, 멱등, 다른 훅 보존),
  훅 스크립트를 실제로 실행해 서버 답을 출력하는지·서버가 없으면 조용히 끝나는지.
- e2e: 훅이 질문을 등록하면 해당 세션 패널에 폼이 뜨고, 답하면 훅 쪽 대기가 그 답으로 끝난다.
