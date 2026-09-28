# 동료에게 말 걸기 — 설계

## 지금까지

캐릭터의 대화 탭은 **기록 기반 답변**이다. 도구 없는 새 요청이 로그를 읽고 답하며, 원래 세션에는 아무것도
들어가지 않는다(`directAvailable: false`). 실제 세션을 움직이는 길은 **이어서 작업** 터미널뿐인데, 입력을
터미널 화면에서 직접 쳐야 한다. 사용자는 `sy`(= `claude --dangerously-skip-permissions --plugin-dir …`)와
`syc`(= `codex --dangerously-bypass-approvals-and-sandbox …`)로 CLI를 띄우지만, 대화형 CLI에는 밖에서 메시지를
넣는 API가 없다. 입력 통로는 그 프로세스의 stdin 하나다.

## 목표

캐릭터에게 말을 걸면 **그 동료가 실제로 실행**한다. 통로는 둘이고, 앱이 자동으로 고른다.

1. **터미널 채널** — 앱이 연 이어가기 PTY가 있으면 거기에 텍스트를 쓴다. 없으면 이어가기 PTY를 먼저 열고
   CLI가 조용해진 뒤 쓴다. 다른 터미널에서 아직 실행 중인 세션은 복제(fork)한 뒤 쓴다. 이어가기 명령은
   설정한 명령(`sy`, `syc` 등)을 쓴다.
2. **직접 채널** — PTY가 없으면 Claude Agent SDK `resume`/Codex app-server `thread/resume`로 세션을 앱이
   이어받아 다음 turn을 돌린다. 답변은 스트림으로 바로 받고, 승인·질문은 앱 작업과 같은 방식으로 대화 탭에서
   사람이 답한다. 다른 곳에서 실행 중이면 `forkSession`/`thread/fork`로 복제한 뒤 돌리고, 이후 지시는 그 복제
   세션으로 간다.

기록 질문은 그대로 남긴다. 한 세션에는 한 번에 하나의 답변(기록 질문·터미널 지시·직접 지시 중 하나)만 진행한다.

## 화면

대화 탭 상단에 모드 전환: **질문(기록 기반)** / **지시(실제 실행)**. 지시 모드에서는 지금 쓰일 통로를 한 줄로
보여 준다 — "이어가기 터미널로 전달", "앱에서 이어받아 실행 · 승인 요청", "원래 터미널이 살아 있어 복제한 세션에서
실행". 지시 메시지는 `나 · 터미널 지시`/`나 · 직접 지시`, 답변은 `Claude · 답변`으로 구분한다. 직접 채널의
승인·질문은 기존 `InteractionPanel`을 작성창 위에 띄운다. 설정(접힘): 이어가기 터미널이 띄울 명령(Claude/Codex).
캐릭터 카드의 "이 동료에게 질문"은 "말 걸기"가 된다.

## 구조

- `contracts`: `ChatChannel = 'records' | 'terminal' | 'direct'`. `ChatMessage.channel`, 복제 세션이면
  `viaSessionId`. `SessionConversation`에 `channels`(터미널 열림, 다른 곳 실행 중, 권한)와 `interactions`.
  `DirectSettings { commands: Record<Provider, string> }`.
- `store`: `settings(key)` 테이블에 `direct` 설정. `direct_links`에 관측 id → 복제된 공급자 세션 id.
  승인·질문은 기존 `interactions` 테이블을 `runId = observed:<id>`로 재사용한다.
- `chat.ts`: `say(id, text, channel)`. 터미널 채널은 주입된 `terminal.send`로 쓰고, 이후 관측 로그에서 **같은
  본문의 요청 이벤트**를 찾아 그 뒤 메시지·완료 이벤트로 답변 메시지를 채운다(복제로 새 세션이 생겨도 본문으로
  찾는다). 직접 채널은 주입된 `direct` 응답기로 turn을 돌리고 `interact`를 `interactions`에 적재한다.
  `answer(id, interactionId, answer)`, `cancel(id)`.
- `adapters/direct.ts`: Claude는 `query({ resume, forkSession, plugins(레포 하네스), permissionMode: 'default',
  canUseTool → interact })`, Codex는 `thread/resume` 또는 `thread/fork`(`approvalPolicy: on-request`,
  `sandbox: workspace-write`) 뒤 `turn/start`. 앱 작업의 승인 규칙을 그대로 따른다.
- `terminals.ts`: `write(id, text)`와 `whenQuiet(id, quietMs, maxMs)`. 여러 줄은 bracketed paste로 감싸고
  마지막에 `\r`을 보낸다.
- `transport.ts`: `GET/PUT /api/settings/direct`, `POST /api/observed/:id/say`,
  `POST /api/observed/:id/chat/answer`. `GET /api/observed/:id/chat`가 채널 상태와 대기 중 승인을 함께 준다.
  이어가기(`/resume`)도 설정된 명령을 쓴다. 명령은 공백 없는 실행 파일 이름만 받는다.

## 경계

- 사용자가 자기 터미널에서 띄운 세션의 원래 프로세스에는 여전히 아무것도 보내지 않는다. 말이 닿는 것은 앱이
  소유한 PTY와 앱이 이어받은 SDK/app-server turn뿐이고, 살아 있는 세션은 복제본에 쓴다.
- 기록 질문 응답기는 그대로 도구 없음·별도 폴더다. 직접 채널만 실제 파일을 바꿀 수 있고, 화면에 그렇게 적는다.

## 테스트

- vitest: 터미널 지시가 PTY에 쓰이고 로그의 같은 본문 요청 뒤 메시지로 답변이 채워진다(복제 세션 포함). 직접
  지시가 응답기로 가고 승인 요청이 `interactions`에 쌓였다가 답으로 풀린다. 한 세션 동시 진행 거절. 설정 명령이
  이어가기 명령에 반영되고 공백 있는 명령은 거절된다.
- e2e: 지시 모드로 보낸 문장이 가짜 CLI 터미널에 `GOT:` 줄로 찍히고 대화에 터미널 지시로 남는다. 직접 채널
  데모 응답기가 승인을 요청하면 대화 탭에서 승인해 답변이 완료된다.
