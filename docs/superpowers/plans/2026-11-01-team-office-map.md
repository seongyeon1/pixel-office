# 팀 오피스 맵 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 전체 맵을 동료별 방(팻말: 맡은 일 + 지금 동작) + "지금 진행 중" 보드로 바꿔, 지금 돌아가는 모든 일이 한 화면에서 읽히게 한다.

**Architecture:** 서버는 세션마다 짧은 "지금 동작" 문장(`ObservedSession.action`)과 코디네이터 안내 데스크 상태, 전체 대기 승인 목록을 읽기 전용으로 내준다. 클라이언트는 기존 `projectRooms` 결과를 동료 기준으로 다시 묶는 순수 함수(`teamRooms`, `boardRows`)를 두고, `ProjectMap`이 맵(`FloorMap`) 옆에 새 `WorkBoard`를 그린다. 픽셀 캐릭터·움직임·부서·방 합치기는 그대로 쓴다.

**Tech Stack:** React 19 + TypeScript, Fastify, node:sqlite, vitest, Playwright. 새 의존성 없음.

**Spec:** `docs/superpowers/specs/2026-11-01-team-office-map-design.md`

## Global Constraints

- 작업 위치: `feat/terminal-workbench`(커밋 `27bf1d6`)에서 갈라진 새 worktree, 브랜치 `feat/team-office-map`. 설계 문서와 이 계획서(메인 체크아웃에 미추적)를 첫 커밋으로 옮긴다.
- 상주 서비스가 **메인 체크아웃의 `dist/`** 로 돈다. worktree에서도 메인 경로에 빌드 산출물을 쓰지 않는다. 검증용 클라이언트 빌드는 `npx vite build --outDir <scratchpad>/mirror/dist/client`, e2e는 미러 폴더 방식(메모리 `live-service-runs-from-repo-dist`). e2e 뒤 `git checkout -- docs/images`로 복원하고 스크린샷 변경은 커밋하지 않는다(새 스크린샷이 필요한 Task 6만 예외로 명시된 파일을 커밋).
- UI 문구는 한국어, 해요체, 번역투 금지. 코드·커밋은 영어, Conventional Commits.
- 새 npm 의존성 금지.
- Slack 토큰·세션 쿠키는 어떤 새 응답·로그에도 넣지 않는다. 새 엔드포인트는 기존 인증 훅 뒤에 둔다(`/api/` 아래 등록이면 자동).
- 서버의 규칙 강제·Slack 배정 동작(`coworkers.forFolder` 포함)은 바꾸지 않는다.
- 각 Task 끝에 `npm test && npm run typecheck` 통과.

## Review Focus

1. **동료가 0명인 사용자** — 지금 실제 상태. 맵이 오늘과 같은 저장소 방(흐린 임시 방)으로 가득 차야 하고, 보드는 터미널 세션만으로도 채워져야 한다. → Task 4 테스트 `no coworkers keeps every repository as a temporary room`.
2. **한 저장소에서 앱 run 여러 개 동시 진행**(Slack 동시 실행 상한 2~8) — `ProjectSummary.latestRun`은 하나뿐이라 나머지가 사라지기 쉽다. → Task 4 테스트 `every active run of a coworker gets its own row and sign`.
3. **같은 일이 두 줄로** — 앱 run과 그 관리 세션(`managed.runId`), 서브에이전트 세션. → Task 4 테스트 `a run and its managed session are one row; subagents fold into the parent`.
4. **긴 제목·긴 명령** — 팻말·보드가 넘치지 않아야 한다(제목 1줄 말줄임, `action` 80자 상한). → Task 2 테스트 `action text is short`, Task 5 CSS `text-overflow: ellipsis` + Task 6 e2e 긴 제목 픽스처.
5. **동료 폴더가 겹칠 때 / worktree 경로** — 가장 깊은 폴더가 이기고, worktree 세션은 메인 저장소 경로로 매칭. → Task 1 테스트.

---

### Task 1: 폴더 → 동료 매칭 (shared)

**Files:**
- Modify: `src/shared/coworkers.ts`
- Test: `tests/coworkers.test.ts`

**Interfaces:**
- Produces: `coworkerForPath(coworkers: Coworker[], path: string): Coworker | undefined` — `path === c.folder` 또는 `path`가 `c.folder + '/'`로 시작하면 후보, 후보 중 `folder.length`가 가장 긴 것. 코디네이터(`id === COORDINATOR_ID`)는 제외. 경로 끝 `/`는 무시.

- [ ] **Step 1: 실패 테스트** `coworkerForPath picks the deepest coworker folder and ignores the coordinator`
  - 동료 `a`(`/r/app`), `b`(`/r/app/web`), 코디네이터(`/r`)
  - `/r/app` → a, `/r/app/web/src` → b, `/r/app-other` → undefined, `/r` → undefined, `/r/app/` → a
- [ ] **Step 2: `npx vitest run tests/coworkers.test.ts`로 실패 확인**
- [ ] **Step 3: 구현** (기존 `inside` 패턴은 `src/client/floor/departments.ts:3` 참고)
- [ ] **Step 4: 통과 확인**
- [ ] **Step 5: Commit** `feat(coworkers): match a path to the deepest coworker folder`

### Task 2: 세션의 "지금 동작" 문장

**Files:**
- Create: `src/shared/actions.ts`
- Modify: `src/shared/contracts.ts` (`ObservedSession`에 `action?: string`), `src/server/observation/observer.ts` (마지막 이벤트를 반영하는 자리, 현재 `cursor.info.activity = item.activity` 옆)
- Test: `tests/actions.test.ts`(신규), `tests/observation.test.ts`

**Interfaces:**
- Produces: `describeAction(event: Pick<ObservedEvent, 'kind' | 'title' | 'detail' | 'activity'>): string` — 80자 이하.
  - `tool`: 도구 이름으로 동사를 고르고 `detail`(파일 경로면 basename, 명령이면 첫 줄)을 붙인다. Read/Grep/Glob 계열 → `"<대상> 읽는 중"`, Edit/Write/apply_patch 계열 → `"<대상> 수정 중"`, Bash/exec 계열 → `"명령 실행 중 · <명령>"`, `mcp__<server>__<tool>` → `"<server> <tool> 호출 중"`, 그 밖 → `"<도구> 사용 중"`.
  - `message` → `"답변 쓰는 중"`, `request` → `"요청 확인 중"`, `result`/`complete` → `"응답 완료"`.
- 세션 `attention`이 있으면 클라이언트가 `action`보다 대기 문구를 우선한다(Task 4). 서버는 `action`만 채운다.

- [ ] **Step 1: 실패 테스트** `tests/actions.test.ts`
  - `describes reads, edits, commands and MCP calls in Korean`
    - `{kind:'tool', title:'Read', detail:'/r/app/README.md'}` → `'README.md 읽는 중'`
    - `{title:'Bash', detail:'npm test\nmore'}` → `'명령 실행 중 · npm test'`
    - `{title:'mcp__atlassian__createJiraIssue'}` → `'atlassian createJiraIssue 호출 중'`
  - `action text is short`: 500자 명령 → 길이 ≤ 80, `…`로 끝남
- [ ] **Step 2: 실패 테스트** `tests/observation.test.ts` — 기존 픽스처 방식으로 Read 도구 이벤트가 마지막인 로그 → 세션 `action === '<파일> 읽는 중'`
- [ ] **Step 3: 실패 확인, 구현, 통과 확인** (`npx vitest run tests/actions.test.ts tests/observation.test.ts`)
- [ ] **Step 4: Commit** `feat(observer): describe what each session is doing right now`

### Task 3: 안내 데스크와 대기 승인 API

**Files:**
- Create: `src/server/slack/desk.ts`
- Modify: `src/server/store.ts` (`listOpenJobs(): Job[]`, `pendingAll(): Interaction[]`), `src/server/transport.ts`, `src/shared/contracts.ts` (`DeskState`)
- Test: `tests/slack-desk.test.ts`(신규), `tests/transport.test.ts`

**Interfaces:**
- `DeskState = { slack: 'connected' | 'off' | 'error'; requests: { jobId: string; phase: 'planning' | 'working'; tasks: number }[] }` (`src/shared/contracts.ts`)
- `deskRequests(jobs: Job[], runOf: (id: string) => Run | undefined, now: number): DeskState['requests']` (`desk.ts`)
  - 코디네이터 경로(`route.kind === 'coordinator'`) Job만.
  - `assignments`가 비었고 `createdAt`이 30분 안 → `planning`, `tasks: 0`.
  - 배정 중 하나라도 `runId` 없음(후속 대기) 또는 그 run이 끝나지 않음(`terminal(status)`이 false) → `working`, `tasks` = 배정 수.
  - 나머지(모두 끝남, 또는 30분 넘게 배정 없음)는 빼서 데스크 숫자가 계속 쌓이지 않게 한다.
  - Ruling: 설계의 "보고 중" 단계는 서버가 알 근거가 없어 뺀다. 끝나면 데스크에서 사라진다.
- `GET /api/office/desk` → `DeskState`. `slack`: 설정 없음 → `off`, `slack.error()` 있음 → `error`, 아니면 `connected`. 토큰·채널 id는 넣지 않는다.
- `GET /api/interactions` → 끝나지 않은 run들의 미해결 `Interaction[]` (`pendingAll`). 답은 기존 `POST /api/interactions/:id/answer` 그대로.

- [ ] **Step 1: 실패 테스트** `tests/slack-desk.test.ts` — `desk counts planning and working coordinator requests and drops finished ones`: 배정 없음(5분 전) → planning, 배정 2개 중 1개 running → working tasks 2, 모두 completed → 없음, 배정 없음 40분 전 → 없음, `route.kind:'coworker'` Job → 없음.
- [ ] **Step 2: 실패 테스트** `tests/transport.test.ts` — `office desk and pending interactions are read-only and carry no secrets`: Slack 미설정이면 `{slack:'off', requests:[]}`; 대기 승인 1개인 run → `/api/interactions` 길이 1; 응답 JSON에 `xox` 문자열 없음.
- [ ] **Step 3: 실패 확인, 구현, 통과 확인**
- [ ] **Step 4: Commit** `feat(office): expose the coordinator desk and pending approvals`

### Task 4: 팀 방과 보드 줄 (클라이언트 모델)

**Files:**
- Create: `src/client/overview/team.ts`
- Modify: `src/client/overview/projects.ts` (`ProjectRoom`에 `coworker?: Coworker`, `temporary?: boolean`; `ProjectWorker`에 `task?: string`(맡은 일 제목), `action?: string`, `source?: 'slack' | 'office' | 'terminal'`)
- Test: `tests/team.test.ts`(신규)

**Interfaces:**
- Consumes: Task 1 `coworkerForPath`, Task 2 `ObservedSession.action`, 기존 `projectRooms(projects, sessions, {now, seen})`.
- Produces:
  - `teamRooms(input: { projects: ProjectSummary[]; sessions: ObservedSession[]; runs: Run[]; coworkers: Coworker[]; now: number; seen: Seen }): ProjectRoom[]`
    1. `projectRooms` 결과를 받는다.
    2. 각 방의 root를 `coworkerForPath`로 동료에 매칭. 매칭되면 그 동료 방(root = 동료 `folder`, `coworker` 설정)으로 workers/lanes/offDuty/automations/카운트를 합친다. 아니면 `temporary: true`.
    3. 일하지 않는 동료도 방을 갖는다(빈 방, 쉬는 중).
    4. `runs` 중 끝나지 않은 run이 아직 어떤 worker로도 표현되지 않았으면(`worker.run?.id`, `session.managed.runId` 비교) `run.coworkerId` 동료 방(없으면 폴더 매칭, 그것도 없으면 그 projectPath의 임시 방)에 run worker를 더한다. 형식은 `projects.ts`의 기존 run worker와 같게.
    5. 모든 worker에 `task`/`source`/`action`을 채운다: run이 있으면 `task` = run 프롬프트 첫 줄, `source` = `run.origin?.kind === 'slack' ? 'slack' : 'office'`; 아니면 `task` = 세션 `prompt` 첫 줄(없으면 `label`), `source` = `'terminal'`. `action` = 대기면 대기 문구(기존 `caption`), 아니면 세션 `action` ?? 기존 `caption`.
    6. 정렬: 동료 방 먼저(명단 순서), 그다음 임시 방(기존 순서). 코디네이터 방은 만들지 않는다(안내 데스크가 맡는다).
  - `boardRows(rooms: ProjectRoom[], interactions: Interaction[]): BoardRow[]`
    - `BoardRow = { id: string; workerId: string; root: string; task: string; source: 'slack'|'office'|'terminal'; owner: string; action: string; waiting: boolean; interaction?: Interaction }`
    - 근무 중 worker 하나당 한 줄. `parentId`가 있는 worker(서브에이전트)와 `visiting` worker(리뷰 받는 구현자)는 줄을 만들지 않는다.
    - `owner` = 동료 이름, 임시 방이면 방 이름(저장소 이름).
    - `interaction` = 그 run의 미해결 interaction(있을 때).
    - 정렬: `waiting` 먼저, 그다음 `updatedAt` 최신순.

- [ ] **Step 1: 실패 테스트** `tests/team.test.ts`
  - `no coworkers keeps every repository as a temporary room` — 동료 0명, 저장소 3개 세션 → 방 3개 모두 `temporary`, 보드 줄 = 근무 중 세션 수.
  - `a terminal session in a coworker subfolder sits in that coworker room` — 동료 `/r/app`, 세션 `projectPath:'/r/app'`, worktree 세션도 같은 방.
  - `every active run of a coworker gets its own row and sign` — 같은 동료의 running run 2개(Slack 1, 오피스 1), latestRun은 하나만 → 줄 2개, 출처 `slack`/`office`.
  - `a run and its managed session are one row; subagents fold into the parent` — run + `managed.runId` 세션 + `parentId` 세션 → 줄 1개, 그 줄 `action`은 세션 `action`.
  - `waiting rows come first and carry the app interaction` — 승인 대기 run + 진행 중 세션 → 첫 줄 `waiting`, `interaction.id` 일치.
  - `an idle coworker still has a room` — 일 없는 동료 → 방 있음, workers 0.
- [ ] **Step 2: 실패 확인 → 구현 → 통과 확인** (`npx vitest run tests/team.test.ts tests/floor.test.ts tests/projects.test.ts`)
- [ ] **Step 3: Commit** `feat(map): group the floor by coworker and list work as board rows`

### Task 5: 맵 화면 — 팻말, 안내 데스크, 임시 방, 보드

**Files:**
- Create: `src/client/overview/WorkBoard.tsx`
- Modify: `src/client/overview/ProjectMap.tsx`, `src/client/floor/FloorMap.tsx`, `src/client/floor/layout.ts`(팻말 높이만큼 방 상단 여백, 안내 데스크 자리), `src/client/overview/project-map.css`, `src/client/floor/floor.css`, `src/client/App.tsx`(ProjectMap에 `runs={allRuns}`, `onRegister`), `src/client/components/CoworkerSettings.tsx` + `TeamPanel.tsx`(처음 열 때 폴더가 채워진 새 동료 폼)

**Interfaces:**
- `ProjectMap` 새 props: `runs: Run[]`, `onRegister: (folder: string) => void`. 내부에서 `/api/coworkers`, `/api/office/desk`, `/api/interactions`를 App의 기존 poll 주기에 맞춰(또는 `observation.scannedAt`이 바뀔 때) 다시 읽는다.
- `WorkBoard({ rows, selectedId, onHover(workerId?), onOpen(row), onAnswer(interactionId, Answer) })` — 묶음 제목 "승인 필요"/"진행 중", 줄마다 굵은 `task`(한 줄 말줄임), 출처 배지(`Slack`/`오피스`/`터미널`), `owner · action`. `interaction`이 있으면 [승인] [거절]. `waiting`인데 `interaction`이 없으면(터미널 세션) [터미널에서 확인] → `onOpen`. 비었으면 "지금 진행 중인 일이 없어요".
- `FloorMap`: 방마다 팻말 목록(worker당 한 장: `task` + `action`, 대기는 주황), 동료 방 이름 = 동료 이름, `temporary` 방은 흐리게 + [동료로 등록] 버튼(`onRegister(room.root)`), 일 없는 동료 방은 어둡게 "쉬는 중". 입구 쪽에 안내 데스크(코디네이터 캐릭터 + `DeskState` 요약: `off` → "Slack 연결 안 됨", requests 있음 → "요청 N건 · 배정 계획 중/동료 작업 중", 없음 → "대기 중").
- 강조 동기화: 보드 줄 hover/선택 → 그 worker의 방에 `.highlight`; 팻말 클릭 → 기존 `onOpen(root, worker)`; 팻말 hover → 보드 줄 강조. 기존 `selectedId` prop 재사용.
- 좁은 화면(≤ 760px): 보드를 맵 위로 쌓는다.
- 기존 검색·모델 필터·부서 패널·방 합치기·퇴근 목록은 그대로 둔다.

- [ ] **Step 1: 구현**
- [ ] **Step 2: `npm run typecheck && npm test`**
- [ ] **Step 3: 미러 폴더에서 `npx vite build`로 눈으로 확인할 화면 캡처 1장(데스크톱) — 커밋하지 않음**
- [ ] **Step 4: Commit** `feat(map): show signs, the coordinator desk and the work board on the floor`

### Task 6: e2e와 문서

**Files:**
- Modify: `e2e/overview.spec.ts`, `e2e/server.ts`(데모 데이터에 동료 1명·Slack run·긴 제목 세션 추가가 필요하면), `README.md`(전체 맵 설명 단락)
- Test: `e2e/overview.spec.ts`

- [ ] **Step 1: e2e** `whole map groups work by coworker and lists it on the board`
  - 동료 1명 등록(API) + 그 폴더 세션 + 다른 저장소 세션 → 동료 방 이름 표시, 다른 저장소는 [동료로 등록] 버튼이 있는 임시 방.
  - 보드 첫 줄이 승인 대기(기존 `app approvals` 픽스처 재사용), 출처 배지 보임.
  - 보드 줄 hover → 해당 방 `.highlight`.
  - 200자 제목 세션 → 팻말·보드 줄 높이가 한 줄(박스 높이 비교).
  - [동료로 등록] → 동료 폼의 폴더 칸에 그 경로.
- [ ] **Step 2: 기존 `e2e/overview.spec.ts` 두 테스트가 새 화면에서도 통과하게 선택자 갱신**
- [ ] **Step 3: 미러 방식으로 `npx playwright test e2e/overview.spec.ts e2e/coworkers.spec.ts --project=desktop` 통과, `git checkout -- docs/images`**
- [ ] **Step 4: README 전체 맵 단락 갱신**(방 = 동료, 임시 방, 보드, 안내 데스크)
- [ ] **Step 5: Commit** `test(map): cover the team floor and work board` / `docs: describe the team office map`

---

## 실측 기록

(실행 중 결과를 여기 적는다.)
