# Slack 입구 + 코디네이터 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Slack DM/바인딩 채널에 쓴 한 줄을 코디네이터가 동료(폴더 + 하네스 + 역할)에게 배정하고, 진행·질문·승인·결과를 그 스레드로 돌려준다.

**Architecture:** 오피스 서버 안에 세 모듈을 더한다. `coworkers`(동료 명단·승인 규칙), `slack/`(Socket Mode 게이트웨이 — 일·스레드 매핑, 상태 메시지, 버튼), `coordinator`(Agent SDK `query()` + in-process MCP 도구). 배정 하나는 기존 오케스트레이터 Run 하나이고, 오케스트레이터는 전역 단일 실행에서 "폴더별 직렬, 폴더 간 병렬(상한)"로 바뀐다.

**Tech Stack:** Node 24, TypeScript, Fastify 5, zod 4, `node:sqlite`, `@anthropic-ai/claude-agent-sdk`(이미 의존), 신규 `@slack/bolt`(Socket Mode), vitest, Playwright.

**Spec:** `docs/superpowers/specs/2026-10-31-slack-coordinator-design.md`

## Global Constraints

- 패키지 관리자는 이 레포의 **npm** (`package-lock.json`). `npm install @slack/bolt`.
- 봇은 설정에 등록한 **Slack user id 한 명**의 메시지·버튼만 처리한다. 다른 사람, 봇(`bot_id` 있음), 메시지 subtype(`message_changed` 등)은 무시한다.
- Slack 토큰은 `dataDir/slack.json`(권한 `0600`)에만 둔다. API 응답, 이벤트 payload, 로그, 에러 문구에 토큰이 나오면 안 된다.
- 응답 속도: 메시지 수신 후 **3초 안에 👀 리액션**, **10초 안에 배정 계획 답글**.
- 스레드 도배 금지: 일마다 상태 메시지 하나를 `chat.update`로 고친다. 새 답글은 배정 계획, 질문/승인, 최종 보고, 실패일 때만.
- 외부 MCP 쓰기 도구의 기본 규칙은 `ask`. 동료 규칙이 전역 `approvals` 설정보다 우선한다.
- 동시 실행 상한 기본값 **3**, 설정 키 `concurrency`.
- UI 문구는 한국어, 기존 화면 문체(~해요)를 따른다. 코드와 커밋은 영어, Conventional Commits.
- **작업 위치:** 메인 체크아웃에는 커밋 안 된 작업이 많고, 상주 서비스가 이 레포의 `dist`에서 돈다. 구현은 별도 worktree(`superpowers:using-git-worktrees`)에서 하고, 그 안에서 `npm run build`를 하지 않는다. e2e는 worktree에서 dev 서버를 `PORT=4330 PIXEL_DATA_DIR=<임시>`로 띄워 돌린다.

## Review Focus

1. **Slack 이벤트 중복 전달** — Socket Mode 재연결·재시도로 같은 메시지가 두 번 오면 일이 두 개 생기면 안 된다. `event_id`/`client_msg_id`로 중복을 거른다 (Task 6 테스트).
2. **작업 중 서버 재시작** — `interruptActive()`가 Run을 `interrupted`로 바꿀 때, 그 일의 Slack 스레드에도 "서버가 재시작되어 중단됐어요"가 가야 한다 (Task 8 테스트).
3. **이미 처리된 버튼** — 오피스 화면에서 먼저 답했거나 재시작으로 사라진 요청의 버튼을 누르면 에러 없이 버튼을 "처리됨"으로 바꾼다 (Task 6 테스트).
4. **코디네이터 동시 기상** — 배정 계획 중에 스레드 답글이 오거나 배정 두 개가 동시에 끝나도, 한 일에 대한 코디네이터 실행은 하나씩 순서대로만 돈다 (Task 7 테스트).
5. **긴 결과** — 요약이 Slack 한도(섹션 블록 3000자, 메시지 40000자)를 넘으면 잘라서 보내고 전문은 파일로 첨부한다 (Task 8 테스트).

---

## File Structure

| 파일 | 책임 |
|---|---|
| `src/shared/coworkers.ts` (신규) | 동료·승인 규칙·Slack 설정 zod 스키마와 타입, `matchToolRule()` |
| `src/server/coworkers.ts` (신규) | 동료 CRUD(store 위), 폴더 → 동료 조회, 코디네이터 고정 항목, 첫 실행 후보 |
| `src/server/store.ts` (수정) | `coworkers`, `jobs`, `slack_seen` 테이블과 접근자 |
| `src/server/projects.ts` (수정) | `inspectProject(path, { allowPlain })` — git 아닌 폴더 |
| `src/server/orchestrator.ts` (수정) | 폴더별 레인 + 상한, 대기 후속 지시, 동료 실행 옵션, 도구 규칙 전달 |
| `src/server/approvals.ts` (수정) | 규칙 `ask`가 전역 auto 자동 승인에 먹히지 않게 |
| `src/server/adapters/claude.ts`, `codex.ts` (수정) | 실행 명령 교체, 도구 규칙 강제 / Codex MCP 끄기 |
| `src/server/slack/secrets.ts` (신규) | `slack.json` 읽기·쓰기(0600), 마스킹 |
| `src/server/slack/port.ts` (신규) | `SlackPort` 인터페이스 + Bolt 구현 (`createBoltPort`) |
| `src/server/slack/gateway.ts` (신규) | 수신 필터, 일 생성·라우팅, 상태 메시지, 버튼 ↔ Interaction, 최종 보고 |
| `src/server/slack/blocks.ts` (신규) | Block Kit 조립과 길이 자르기 (순수 함수) |
| `src/server/coordinator.ts` (신규) | 코디네이터 실행기, MCP 도구, 일별 직렬 큐, `AGENTS.md` 초기화 |
| `src/server/transport.ts` (수정) | `/api/coworkers*`, `/api/settings/slack*`, `/api/settings/concurrency`, health의 `activeIds` |
| `src/server/index.ts` (수정) | 조립 |
| `src/client/components/CoworkerSettings.tsx`, `SlackSettings.tsx` (신규) | 설정 화면 |
| `src/client/components/TeamPanel.tsx` (수정) | 두 설정 마운트 |
| `src/client/App.tsx` (수정) | `activeIds`, Slack 출처 배지 |
| `tests/*.test.ts` | 아래 각 Task |

---

### Task 1: git 아닌 폴더에서 Run 실행

문서·컨텐츠 동료의 폴더(예: 커밋 없는 `meeting-minutes`)에서도 Run이 돌아야 한다. 기존 화면 경로의 검증은 그대로 둔다.

**Files:**
- Modify: `src/server/projects.ts:42-58`, `src/shared/contracts.ts` (`Run`, `startSchema`), `src/server/orchestrator.ts` (`start`, `followUp`, `complete`), `src/server/delivery.ts` (`workingState` 호출부)
- Test: `tests/orchestrator.test.ts`, `tests/projects.test.ts`

**Interfaces:**
- Produces: `inspectProject(path: string, opts?: { allowPlain?: boolean }): Promise<Project & { plain?: true }>`. `allowPlain`이고 git 저장소가 아니거나 커밋이 없는 저장소면 `{ root: realpath, head: '', dirty: false, plain: true }`. 경로가 없으면 지금처럼 throw.
- Produces: `Run.plain?: true`, `startSchema`에 `allowPlain: z.boolean().optional()`.

- [ ] **Step 1: 실패 테스트** — `tests/projects.test.ts`에 `inspectProject(plainDir, { allowPlain: true })`가 `plain: true`를 돌려주고, 옵션 없이는 기존 `'Git 저장소를 선택해 주세요.'`로 throw하는 테스트. `git init`만 하고 커밋 없는 폴더도 `plain: true`.
- [ ] **Step 2: 실패 테스트** — `tests/orchestrator.test.ts` `plain folder runs without git and follow-ups reuse the folder`: git 아닌 임시 폴더로 `start({ ..., allowPlain: true })` → 완료 상태, `run.plain === true`, `run.worktreePath === folder`, `pullRequests`가 없음. 같은 run에 `followUp` → 완료.
- [ ] **Step 3: 두 테스트가 실패하는지 확인** — `npx vitest run tests/projects.test.ts tests/orchestrator.test.ts`
- [ ] **Step 4: 구현** — plain이면 `personalWorkspace`/`createWorkspace`를 건너뛰고 `worktreePath = root`, `branch = ''`, `baseCommit = ''`, `initialChanges = {}`. `complete()`에서 plain이면 `verifyDelivery`를 부르지 않는다. `followUp`의 `git rev-parse` 확인은 plain이면 `stat`으로 폴더가 있는지만 본다. `isolated` + plain은 `'git 저장소가 아닌 폴더는 개인 실행만 지원해요.'`로 거절.
- [ ] **Step 5: 통과 확인** — 같은 명령, 전체 `npm test`도 통과.
- [ ] **Step 6: Commit** — `feat(runs): run coworkers in folders that are not git repositories`

### Task 2: 폴더별 직렬, 폴더 간 병렬 실행

**Files:**
- Modify: `src/server/orchestrator.ts` (`busy`, `current` 제거), `src/server/transport.ts:388` (health), `src/client/App.tsx:84,323`
- Test: `tests/orchestrator.test.ts`, `tests/transport.test.ts`

**Interfaces:**
- Produces (orchestrator):
  - `start(input)`와 `followUp(id, prompt, opts?: { whenDone?: boolean })`는 즉시 `Run`(status `queued`)을 돌려주고, 실행은 레인에서 한다. 레인 키는 `run.projectPath`.
  - 같은 레인에 실행 중인 Run이 있으면 대기. 전체 실행 수가 `concurrency`(store 설정, 기본 3)에 차면 대기.
  - `followUp`: 원본이 끝나지 않았을 때 `whenDone !== true`면 지금처럼 throw. `whenDone: true`면 대기 Run을 만들고, **실행 직전에** 원본의 최신 `sessions`·`summary`를 다시 읽어 맥락을 채운다.
  - `queuePosition(id): number` — 앞에 기다리는 Run 수(실행 중이면 0).
  - `activeIds: string[]` (기존 `activeId` getter 대체). `cancel(id)`는 대기 중인 Run도 취소한다(status `cancelled`, 레인에서 제거).
  - `shutdown()`은 모든 실행을 중단한다.
- Produces (transport): `/api/health`가 `activeIds: string[]`를 돌려준다. `activeId`는 `activeIds[0] ?? null`로 한 버전 동안 남긴다.
- Produces: `GET/POST /api/settings/concurrency` `{ limit: 1..8 }`.

- [ ] **Step 1: 실패 테스트** — `runs in different folders overlap, runs in one folder are serial`: 첫 실행이 Promise로 멈춰 있는 fake adapter 두 폴더 A, B. A1, A2, B1을 start → A1과 B1이 동시에 `running`, A2는 `queued`이고 `queuePosition(A2) === 1`. A1을 풀면 A2 실행.
- [ ] **Step 2: 실패 테스트** — `global limit queues the fourth run`: 폴더 4개, 상한 3 → 네 번째는 `queued`.
- [ ] **Step 3: 실패 테스트** — `whenDone follow-up waits and resumes the latest session`: 원본 실행 중 `followUp(id, '추가', { whenDone: true })` → `queued`. 원본이 `sessionId: 's2'`를 내보내고 끝나면 후속 Run의 `PhaseInput.resumeSessionId === 's2'`.
- [ ] **Step 4: 실패 테스트** — `cancel removes a queued run` 그리고 기존 "진행 중인 작업을 먼저 완료" 에러를 기대하던 테스트를 새 동작(대기)으로 바꾼다.
- [ ] **Step 5: 실패 확인** — `npx vitest run tests/orchestrator.test.ts`
- [ ] **Step 6: 구현** — `Map<string, { controller; task }>`로 실행 목록, 레인별 FIFO, 끝날 때마다 `drain()`. 기존 `sessionGuard`, 사용량 소진 전환, `clearPending`은 Run 단위로 유지.
- [ ] **Step 7: 클라이언트** — `App.tsx`가 `activeIds.includes(...)`를 쓰게 바꾼다. 기존 e2e `e2e/overview.spec.ts`가 통과하는지 확인.
- [ ] **Step 8: 통과 확인** — `npm test && npm run typecheck`
- [ ] **Step 9: Commit** — `feat(orchestrator): run folders in parallel with a concurrency limit`

### Task 3: 동료 명단과 승인 규칙 저장

**Files:**
- Create: `src/shared/coworkers.ts`, `src/server/coworkers.ts`
- Modify: `src/server/store.ts` (테이블 `coworkers(id TEXT PRIMARY KEY, data TEXT NOT NULL)`), `src/server/transport.ts`
- Test: `tests/coworkers.test.ts` (신규), `tests/transport.test.ts`

**Interfaces:**
- Produces (`src/shared/coworkers.ts`):
  ```ts
  toolRuleSchema = z.object({ pattern: z.string().min(1).max(200), action: z.enum(['auto', 'ask']) })
  coworkerSchema = z.object({
    id: z.string().regex(/^[a-z0-9][a-z0-9-]{0,39}$/),
    name: z.string().trim().min(1).max(40),
    folder: z.string().min(1),
    engine: z.enum(['claude', 'codex']),
    command: commandSchema.optional(),     // 없으면 sy / syc
    model: z.string().trim().max(150).optional(),
    role: z.string().trim().max(2000),
    mode: z.enum(['solo', 'collaborate']),
    bindings: z.array(z.string().regex(/^[CG][A-Z0-9]+$/)).max(20),
    rules: z.array(toolRuleSchema).max(50),
    createdBy: z.enum(['user', 'coordinator']),
  })
  type Coworker, type ToolRule
  matchToolRule(rules: ToolRule[], tool: string): 'auto' | 'ask' | undefined   // 위에서부터 첫 일치, `*` 글롭, 대소문자 무시
  DEFAULT_RULES: ToolRule[]   // 아래 Step 3의 값
  COORDINATOR_ID = 'coordinator'
  ```
- Produces (`src/server/coworkers.ts`): `createCoworkers(store, { dataDir })` →
  `list(): Coworker[]`(코디네이터가 맨 앞), `get(id)`, `save(input): Coworker`(폴더 존재 확인, `realpath` 정규화, 같은 폴더 중복 거절 `'이미 이 폴더를 맡은 동료가 있어요.'`), `remove(id)`(코디네이터는 `'코디네이터는 삭제할 수 없어요.'`), `forFolder(root): Coworker | undefined`, `forChannel(channelId)`, `suggestions(): { name; folder }[]`(`store.listProjects()`의 최근 5개 중 아직 동료가 없는 폴더).
- 코디네이터 항목: `folder = dataDir/coordinator`, `engine: 'claude'`, `mode: 'solo'`, `rules: []`. 저장소에 없으면 `list()`가 만들어 넣는다.
- Produces (transport): `GET /api/coworkers`, `POST /api/coworkers`, `DELETE /api/coworkers/:id`, `GET /api/coworkers/suggestions`.

- [ ] **Step 1: 실패 테스트** — `matchToolRule`: `[{pattern:'mcp__atlassian__*create*',action:'ask'},{pattern:'mcp__*',action:'auto'}]`에서 `mcp__atlassian__createConfluencePage` → `'ask'`, `mcp__notion__search` → `'auto'`, `Read` → `undefined`.
- [ ] **Step 2: 실패 테스트** — 저장 왕복, 폴더 중복 거절, 코디네이터 삭제 거절, `forChannel`, `suggestions`가 이미 동료 있는 폴더를 뺌, 잘못된 id(`'SKT Dev'`) 거절.
- [ ] **Step 3: 구현** — `DEFAULT_RULES` 값:
  ```
  mcp__*__*create*  ask    mcp__*__*update*  ask    mcp__*__*delete*  ask
  mcp__*__*publish* ask    mcp__*__*send*    ask    mcp__*__*post*    ask
  mcp__*__*comment* ask    mcp__*__*transition* ask
  ```
  새 동료의 `rules` 기본값은 `DEFAULT_RULES` 복사본. (스펙: 쓰기 성격 판정은 모르면 `ask` 쪽.)
- [ ] **Step 4: transport 테스트와 라우트** — 토큰 인증 아래에 둔다(기존 `/api/` 인증 훅이 처리).
- [ ] **Step 5: 통과 확인** — `npx vitest run tests/coworkers.test.ts tests/transport.test.ts`
- [ ] **Step 6: Commit** — `feat(coworkers): store coworkers with folders, harness, role and tool rules`

### Task 4: 동료로 실행 — 실행 명령 교체와 승인 규칙 강제

**Files:**
- Modify: `src/shared/contracts.ts` (`PhaseInput`, `Run`, `startSchema`), `src/server/orchestrator.ts`, `src/server/approvals.ts`, `src/server/adapters/claude.ts:74-130`, `src/server/adapters/codex.ts:36-50,160-180`
- Test: `tests/run-harness-adapters.test.ts`, `tests/approvals.test.ts`, `tests/orchestrator.test.ts`

**Interfaces:**
- Consumes: `Coworker`, `matchToolRule`, `createCoworkers().forFolder`.
- Produces:
  - `PhaseInput.executable?: string`, `PhaseInput.toolRules?: ToolRule[]`.
  - `Run.coworkerId?: string`, `Run.origin?: { kind: 'slack'; jobId: string }`.
  - orchestrator 옵션 `coworkerFor?: (root: string) => Coworker | undefined`. `execute()`가 Run마다 `coworkerFor(run.projectPath)`로 `toolRules`를 정한다. 그 폴더의 동료가 있으면 **어느 입구에서 시작했든** 적용한다.
  - orchestrator `startFor(coworker: Coworker, prompt: string, origin?: Run['origin']): Promise<Run>` — `projectPath = coworker.folder`, `mode = coworker.mode === 'solo' ? coworker.engine : 'collaborate'`, `implementer = coworker.engine`, `team = defaultTeam`에 `model` 덮어쓰기, `allowPlain: true`, `executable = coworker.command`. 프롬프트 앞에 `역할:\n${role}\n\n`을 붙인다.
  - `Interaction.details.policy?: 'ask'`. `automaticApproval()`과 `approvePending()`은 `details.policy === 'ask'`면 자동 승인하지 않는다.

- [ ] **Step 1: 실패 테스트 (claude)** — `run-harness-adapters.test.ts`: 기존 방식대로 SDK `query`를 가로채서, `executable: 'pstack-claude'`이면 `pathToClaudeCodeExecutable === 'pstack-claude'`, 없으면 `'sy'`.
- [ ] **Step 2: 실패 테스트 (claude 규칙)** — PreToolUse 훅에 `mcp__atlassian__createConfluencePage`를 넣으면 `toolRules`가 `ask`일 때 `interact`가 `{ kind: 'approval', details: { policy: 'ask', tool } }`로 불리고, deny 답이면 훅이 `permissionDecision: 'deny'`를 돌려준다. `approvalMode: 'auto'`(bypassPermissions)에서도 같다.
- [ ] **Step 3: 실패 테스트 (approvals)** — 전역 `auto`에서 `details.policy: 'ask'` 요청은 `automaticApproval()`이 `undefined`.
- [ ] **Step 4: 실패 테스트 (orchestrator)** — 동료 폴더에서 화면 경로 `start()`로 시작한 Run도 adapter가 받은 `toolRules`가 그 동료 규칙이다. `startFor`가 `coworkerId`, `origin`을 Run에 남긴다.
- [ ] **Step 5: Codex 실측 (수동, 결과를 이 파일 아래 "실측 기록"에 적는다)** — `syc app-server --stdio`에 MCP 쓰기 도구를 부르는 지시를 보내고, MCP 호출 전에 `*requestApproval` 또는 elicitation 요청이 오는지 확인한다.
  - 온다 → 그 메서드에서 `matchToolRule`을 적용한다(Step 6a).
  - 안 온다 → Step 6b.
- [ ] **Step 6a 또는 6b: Codex 구현**
  - 공통: 실행 명령은 `executable ?? (personal ? 'syc' : 'codex')`.
  - 6b: `toolRules`에 `ask` 규칙이 하나라도 있으면 `~/.codex/config.toml`의 `[mcp_servers.<name>]` 이름마다 `-c mcp_servers.<name>.enabled=false`를 붙여 실행한다. 동료 저장 응답에 `warnings: ['Codex는 외부 도구 승인을 강제할 수 없어 외부 MCP를 끄고 실행해요.']`를 넣는다. 테스트는 spawn 인자에 그 플래그가 들어가는지 확인한다.
- [ ] **Step 7: 통과 확인** — `npm test && npm run typecheck`
- [ ] **Step 8: Commit** — `feat(coworkers): run assignments with the coworker's command and enforce tool rules`

### Task 5: Slack 비밀 저장과 연결 설정 API

**Files:**
- Create: `src/server/slack/secrets.ts`, `src/server/slack/port.ts`
- Modify: `package.json` (`@slack/bolt`), `src/server/transport.ts`
- Test: `tests/slack-secrets.test.ts` (신규), `tests/transport.test.ts`

**Interfaces:**
- Produces (`secrets.ts`): `SlackConfig = { botToken: string; appToken: string; ownerId: string }`. `readSlackConfig(dataDir): Promise<SlackConfig | undefined>`, `writeSlackConfig(dataDir, c)` (파일 모드 `0o600`, 쓰고 나서 `chmod`도 한다), `clearSlackConfig(dataDir)`, `maskSlack(c) → { configured: true; ownerId; botToken: 'xoxb-…' + 끝 4자 }`.
- Produces (`port.ts`):
  ```ts
  interface SlackPort {
    start(onMessage: (m: InboundMessage) => void, onAction: (a: InboundAction) => void): Promise<void>
    stop(): Promise<void>
    react(channel: string, ts: string, name: string): Promise<void>
    post(channel: string, threadTs: string | undefined, blocks: Block[], text: string): Promise<string>  // ts
    update(channel: string, ts: string, blocks: Block[], text: string): Promise<void>
    upload(channel: string, threadTs: string, filename: string, content: string): Promise<void>
    openDm(userId: string): Promise<string>  // channel id
    authTest(): Promise<{ teamId: string; botUserId: string }>
  }
  InboundMessage = { eventId: string; teamId: string; channel: string; channelType: 'im' | 'channel' | 'group'; user?: string; botId?: string; subtype?: string; text: string; ts: string; threadTs?: string; mentionsBot: boolean }
  InboundAction = { userId: string; channel: string; messageTs: string; actionId: string; value: string; respond(blocks: Block[], text: string): Promise<void> }
  createBoltPort(config: SlackConfig): SlackPort   // @slack/bolt App, socketMode: true, logLevel: ERROR
  ```
- Produces (transport): `GET /api/settings/slack` → `maskSlack` 또는 `{ configured: false }`. `POST /api/settings/slack` `{ botToken: /^xoxb-/, appToken: /^xapp-/, ownerId: /^U[A-Z0-9]+$/ }` → `authTest()` 성공 후 저장하고, 소유자 DM으로 "Pixel Office와 연결됐어요."를 보낸 뒤 게이트웨이를 다시 시작한다. 실패하면 `'Slack 연결을 확인하지 못했어요: <Slack 에러 코드>'`(토큰 없이). `DELETE /api/settings/slack`.

- [ ] **Step 1: 실패 테스트** — 쓰기 후 `stat().mode & 0o777 === 0o600`. `maskSlack` 결과 JSON에 원래 토큰 문자열이 없음.
- [ ] **Step 2: 실패 테스트 (transport)** — fake `SlackPort` 주입. `POST` 후 `GET` 응답, 그리고 실패 응답 본문 어디에도 토큰이 없음. 잘못된 형식은 400.
- [ ] **Step 3: 구현** — `createServer`에 `slack?: { connect(config): Promise<void>; disconnect(): Promise<void> }` 의존성을 추가한다(테스트는 fake).
- [ ] **Step 4: 통과 확인** — `npx vitest run tests/slack-secrets.test.ts tests/transport.test.ts`
- [ ] **Step 5: Commit** — `feat(slack): store Slack credentials privately and test the connection`

### Task 6: Slack 게이트웨이 — 수신, 일, 상태 메시지, 버튼

**Files:**
- Create: `src/server/slack/gateway.ts`, `src/server/slack/blocks.ts`
- Modify: `src/server/store.ts` (테이블 `jobs(id TEXT PRIMARY KEY, thread_key TEXT UNIQUE NOT NULL, data TEXT NOT NULL)`, `slack_seen(event_id TEXT PRIMARY KEY, at INTEGER NOT NULL)`)
- Test: `tests/slack-gateway.test.ts` (신규), `tests/slack-blocks.test.ts` (신규)

**Interfaces:**
- Consumes: `SlackPort`, `createCoworkers`, orchestrator(`startFor`, `followUp`, `answer`, `queuePosition`), `store.bus`의 `'event'`.
- Produces (store):
  ```ts
  Job = { id: string; threadKey: string; channel: string; threadTs: string; statusTs?: string;
          route: { kind: 'coordinator' } | { kind: 'coworker'; coworkerId: string };
          assignments: { id: string; coworkerId: string; runId: string; task: string; after?: string }[];
          state: 'open' | 'done'; createdAt: string }
  store.createJob, getJob, getJobByThread(threadKey), updateJob(id, patch), jobForRun(runId)
  store.markSlackSeen(eventId): boolean   // 처음이면 true. 24시간 지난 행은 이때 지운다
  ```
  `threadKey = `${teamId}:${channel}:${threadTs ?? ts}``
- Produces (gateway): `createSlackGateway({ store, port, coworkers, orchestrator, coordinator, ownerId })` → `{ start(); stop() }`. coordinator는 Task 7의 `{ wake(jobId, reason: WakeReason): void }`(이 Task에서는 fake).
- Produces (blocks): `planBlocks`, `statusBlocks(job, runs, positions)`, `approvalBlocks(interaction)`, `questionBlocks(interaction)`, `resolvedBlocks(text)`, `reportBlocks(summary, links)`, `clip(text, max): { text; clipped: boolean }`. 버튼 `action_id`는 `pixel:approve`, `pixel:deny`, `pixel:answer`이고 `value`는 `JSON.stringify({ interactionId, option? })`.

수신 규칙(위에서부터):
1. `markSlackSeen(eventId)`가 false → 무시.
2. `user !== ownerId`, `botId` 있음, `subtype` 있음 → 무시.
3. 채널(`channelType !== 'im'`)은 `mentionsBot`이거나 `coworkers.forChannel(channel)`일 때만.
4. `threadKey`에 일이 있으면 → 후속: `coordinator.wake(job.id, { kind: 'reply', text })`. 단, `route.kind === 'coworker'`면 그 동료의 마지막 배정에 `followUp(runId, text, { whenDone: true })`.
5. 새 일: 👀 리액션(`eyes`)을 **가장 먼저** 보내고 Job을 만든다. 바인딩 채널이면 `startFor(coworker, text, { kind: 'slack', jobId })`. 아니면 `coordinator.wake(job.id, { kind: 'new', text })`.

이벤트 처리: `store.bus`에서 Run이 `origin.kind === 'slack'`인 이벤트만 본다.
- `run.updated` → 상태 메시지 `update`(없으면 `post`해서 `statusTs` 저장). 같은 일에 대한 업데이트는 1초에 한 번으로 묶는다.
- `interaction.requested` → 승인이면 `approvalBlocks`, 질문이면 `questionBlocks`를 새 답글로 단다. 자유 입력 질문은 다음 스레드 답글을 답으로 쓴다.
- `interaction.resolved` → 해당 답글을 `resolvedBlocks('오피스에서 처리됨' | '자동 승인됨' | '승인됨' | '거절됨')`으로 바꾼다. 답글이 없는 자동 승인(`payload.automatic`)은 상태 메시지에 `payload.text` 한 줄을 더한다(최근 5줄까지).
- 버튼 → `userId !== ownerId`면 `respond`로 "이 작업은 소유자만 처리할 수 있어요."만 보낸다. 아니면 `orchestrator.answer()`. 이미 처리된 요청이면 throw를 잡아 `resolvedBlocks('이미 처리됨')`.

- [ ] **Step 1: 실패 테스트 (blocks)** — `clip('가'.repeat(5000), 3000)`은 3000자 이하이고 `clipped: true`. `approvalBlocks` 버튼 value를 파싱하면 `interactionId`가 나온다.
- [ ] **Step 2: 실패 테스트 (수신)** — 같은 `eventId` 두 번 → Job 1개. 다른 user → 아무 호출 없음. `botId`/`subtype` → 없음. 바인딩 안 된 채널에서 멘션 없음 → 없음. DM → `react` 호출이 `coordinator.wake`보다 먼저.
- [ ] **Step 3: 실패 테스트 (바인딩)** — 바인딩 채널 메시지 → `startFor`에 그 동료와 `origin.jobId`. 같은 스레드 답글 → `followUp(..., { whenDone: true })`.
- [ ] **Step 4: 실패 테스트 (이벤트 → Slack)** — fake 오케스트레이터 이벤트로 `run.updated` 3번을 0.5초 안에 보내면 `update` 1번. `interaction.requested`(approval) → 버튼 답글. 버튼(소유자) → `answer(id, { decision: 'approve' })`. 버튼(다른 사람) → `answer` 안 불림. 이미 처리된 요청 버튼 → 예외 없이 "이미 처리됨".
- [ ] **Step 5: 실패 확인 후 구현** — `npx vitest run tests/slack-gateway.test.ts tests/slack-blocks.test.ts`
- [ ] **Step 6: 통과 확인**
- [ ] **Step 7: Commit** — `feat(slack): turn owner messages into jobs and mirror progress into the thread`

### Task 7: 코디네이터

**Files:**
- Create: `src/server/coordinator.ts`, `src/server/coordinator-agents.md` (초기 `AGENTS.md` 템플릿, 빌드 시 복사되도록 `tsconfig.server.json`/스크립트 확인)
- Test: `tests/coordinator.test.ts` (신규)

**Interfaces:**
- Consumes: `createCoworkers`, orchestrator(`startFor`, `followUp`, `cancel`, `queuePosition`), store의 Job, Task 6의 `SlackPort.post` (gateway를 통해 `reply(jobId, text)`로 주입).
- Produces:
  ```ts
  type WakeReason = { kind: 'new' | 'reply'; text: string } | { kind: 'assignment_done'; assignmentId: string }
  createCoordinator({ store, coworkers, orchestrator, dataDir, reply, propose, run? }) → { wake(jobId, reason): void }
  // run: 테스트용 주입점. 기본은 Agent SDK query()
  ```
  - 한 Job에 대한 `wake`는 **직렬**(Job별 Promise 체인). 다른 Job은 병렬.
  - `query()` 옵션: `cwd = dataDir/coordinator`, `settingSources: []`, `systemPrompt`는 깨어날 때마다 읽은 `dataDir/coordinator/AGENTS.md` 본문(Claude Code는 `AGENTS.md`를 자동으로 읽지 않으므로 직접 넣는다), `tools: []`, `mcpServers: { office: createSdkMcpServer(...) }`, `allowedTools: ['mcp__office__*']`, `permissionMode: 'default'`, `maxTurns: 12`, `model`은 설정 `coordinatorModel`(기본 `claude-sonnet-5-5`), `resume`은 Job에 저장한 코디네이터 세션 id.
  - 프롬프트: 깨어난 이유 + 일의 배정 목록과 각 상태·요약(요약은 배정당 4000자까지).
  - MCP 도구(이름은 스펙 그대로): `list_coworkers`, `delegate({ coworkerId, task, after? })`, `follow_up({ assignmentId, prompt })`(내부적으로 `whenDone: true`), `cancel({ assignmentId })`, `job_status`, `propose_coworker({ name, folder, role, engine })`, `reply({ text })`.
  - `delegate`의 `after`: 앞 배정이 안 끝났으면 배정을 Job에 `pending`으로만 적고, `assignment_done` 때 코디네이터 대신 **서버가** 시작한다. 이때 앞 배정 요약을 `이전 단계 결과:\n…`로 task 앞에 붙인다.
  - `propose_coworker`는 `propose(jobId, draft)`를 부른다. gateway가 [만들기][취소] 버튼을 달고, 승인하면 `coworkers.save({ ...draft, createdBy: 'coordinator', mode: 'solo', bindings: [], rules: DEFAULT_RULES })` 후 `wake(jobId, { kind: 'reply', text: '동료 <name>를 만들었어요.' })`.
  - 배정 Run이 끝나면(gateway가 `run.updated` terminal을 보고) `wake(jobId, { kind: 'assignment_done', assignmentId })`.
  - `AGENTS.md` 초기 규칙(템플릿에 그대로 쓴다): 애매해도 가장 그럴듯한 동료로 바로 배정하고 가정을 첫 `reply`에 적는다 / 질문은 맞는 동료가 없을 때만 / 첫 `reply`는 배정 계획 한두 줄 / 최종 보고는 모든 배정이 끝났을 때 한 번, 산출물 링크 포함 / 외부 게시는 직접 하지 않는다.
  - `dataDir/coordinator/AGENTS.md`가 없을 때만 템플릿을 쓴다(사용자 수정 보존).

- [ ] **Step 1: 실패 테스트** — fake `run`이 도구 호출 시나리오를 재생한다. `new` → `delegate('meeting', ...)`, `delegate('planner', ..., after)` → `startFor`는 meeting만 호출, planner는 pending. meeting Run 완료 → `assignment_done` → planner `startFor`의 prompt에 `이전 단계 결과:`와 meeting 요약.
- [ ] **Step 2: 실패 테스트 (직렬)** — 같은 Job에 `wake` 두 번을 동시에 → 두 번째 `run`은 첫 번째가 끝난 뒤 시작. 다른 Job은 겹친다.
- [ ] **Step 3: 실패 테스트 (제안)** — `propose_coworker` → `propose` 호출, `coworkers.save`는 아직 안 불림.
- [ ] **Step 4: 실패 테스트 (AGENTS.md)** — 파일이 있으면 덮어쓰지 않는다. 사용자가 고친 본문이 다음 `wake`의 `systemPrompt`로 들어간다.
- [ ] **Step 5: 구현 후 통과 확인** — `npx vitest run tests/coordinator.test.ts`
- [ ] **Step 6: 속도 실측 (수동)** — 실제 `query()`로 "skt 회의록 정리해줘"를 넣고 첫 `reply`까지 걸린 시간을 5회 잰다. 중앙값이 10초를 넘으면 `coordinatorModel` 기본값을 `claude-haiku-5-5`로 바꾸고 다시 잰다. 결과를 아래 "실측 기록"에 적는다.
- [ ] **Step 7: Commit** — `feat(coordinator): assign Slack jobs to coworkers through office tools`

### Task 8: 최종 보고, 산출물 첨부, 재시작 알림

**Files:**
- Modify: `src/server/slack/gateway.ts`, `src/server/store.ts` (`interruptActive`가 중단한 runId 목록을 돌려주도록)
- Test: `tests/slack-gateway.test.ts`

**Interfaces:**
- Consumes: `runDocuments(run, events, changes)` (`src/shared/task-documents.ts`), Run의 `pullRequests`, `summary`.
- Produces: `interruptActive(): string[]`(기존 숫자 반환 호출부 수정). gateway `start()`가 `notifyInterrupted(runIds)`를 받아 해당 Job 스레드에 "서버가 재시작되어 작업이 중단됐어요. 스레드에 답글을 달면 이어서 진행해요."를 단다.
- 코디네이터 경로: 최종 보고는 코디네이터의 `reply`가 한다. 서버는 마지막 배정이 끝나면 산출물 문서(마크다운, 각 200KB 이하, 최대 3개)를 `upload`한다.
- 바인딩 경로(코디네이터 없음): 서버가 `reportBlocks(summary, [...pullRequests])`로 최종 보고를 단다. 요약이 3000자를 넘으면 잘라서 보내고 전문을 `summary.md`로 첨부한다.

- [ ] **Step 1: 실패 테스트** — 바인딩 Job의 Run이 `completed`(summary 5000자, PR 1개) → 보고 답글 1개(잘린 요약 + PR 링크)와 `summary.md` 업로드.
- [ ] **Step 2: 실패 테스트** — Run 문서 4개 중 3개만 업로드, 200KB 넘는 파일 제외.
- [ ] **Step 3: 실패 테스트** — `notifyInterrupted([runId])` → 그 Job 스레드에 재시작 안내.
- [ ] **Step 4: 구현 후 통과 확인** — `npm test`
- [ ] **Step 5: Commit** — `feat(slack): report results with documents and announce interrupted jobs`

### Task 9: 설정 화면과 Slack 출처 표시

**Files:**
- Create: `src/client/components/CoworkerSettings.tsx`, `src/client/components/SlackSettings.tsx`
- Modify: `src/client/components/TeamPanel.tsx:39` (`<ApprovalSettings />` 아래에 두 설정), `src/client/App.tsx` (작업 목록 행에 `run.origin?.kind === 'slack'`이면 "Slack" 배지)
- Test: `e2e/coworkers.spec.ts` (신규, 기존 `e2e/workbench-helpers.ts` 사용)

**Interfaces:**
- Consumes: Task 2·3·5의 API.
- `ApprovalSettings.tsx`와 같은 패턴(`api()` + 저장 중/저장됨/에러 상태)을 따른다.
- CoworkerSettings: 명단(코디네이터 고정, 삭제 버튼 없음), 추가/수정 폼 — 이름, id, 폴더(기존 폴더 선택 UI 재사용), 엔진, 실행 명령(등록된 `launch-harnesses` 중 선택, 기본값), 모델, 역할, 모드(문서·컨텐츠 / 코드 리뷰 포함), 바인딩 채널 id, 승인 규칙. 승인 규칙 위에 토글 5개(Confluence 게시, Jira 발급, Notion 페이지, Slack 다른 채널 발송, 그 외 외부 쓰기)를 두고, 토글이 위 패턴 규칙을 켜고 끈다. 저장 응답의 `warnings`를 폼 아래에 보여 준다. **플러그인·스킬 묶음(pstack 등)** 은 기존 `HarnessPanel`을 동료 폴더 기준(`/api/harness?root=<folder>`)으로 폼 안에 그대로 넣는다. 저장소별 `RepoHarness`가 곧 동료의 묶음이고 새로 저장하지 않는다. 묶음은 기존 어댑터 동작대로 isolated 실행에 적용되고, personal 실행은 사용자 설정을 그대로 쓴다는 안내 한 줄을 붙인다. 명단이 코디네이터뿐이면 `suggestions`를 "최근 작업한 폴더로 동료 만들기" 카드로 보여 준다. 코디네이터 행에 `AGENTS.md` 경로 표시.
- SlackSettings: 토큰 2개(password input), 내 Slack member ID, [연결 테스트 후 저장], 상태(연결됨 · 소유자 ID / 안 됨), [연결 해제]. 동시 실행 상한(1–8) 숫자 입력도 여기 둔다.

- [ ] **Step 1: e2e 작성** — 동료 추가 → 목록에 나타남 → Confluence 토글 끄면 저장된 규칙에서 해당 패턴이 `auto`. 코디네이터 행에 삭제 버튼 없음. Slack 설정에 잘못된 토큰 형식 → 에러 문구.
- [ ] **Step 2: 실패 확인** — `PORT=4330 npx playwright test e2e/coworkers.spec.ts` (Global Constraints의 데이터 디렉터리 규칙)
- [ ] **Step 3: 구현 후 통과 확인** — 같은 명령 + `npm run typecheck`
- [ ] **Step 4: Commit** — `feat(ui): coworker and Slack settings`

### Task 10: 조립, 실제 Slack 검증, 문서

**Files:**
- Modify: `src/server/index.ts`, `README.md` ("Slack으로 일 맡기기" 절)
- Test: 수동 검증 체크리스트(아래)

**Interfaces:**
- `index.ts`: `coworkers = createCoworkers(store, { dataDir })` → `createOrchestrator({ ..., coworkerFor: coworkers.forFolder })` → `const interrupted = store.interruptActive()` → `readSlackConfig(dataDir)`가 있으면 `createBoltPort` + `createCoordinator` + `createSlackGateway`를 만들고 `start()` 후 `notifyInterrupted(interrupted)`. Slack 연결 실패는 서버 시작을 막지 않고 로그(토큰 없이)와 `/api/settings/slack`의 `error`로만 남긴다. 종료 시 gateway `stop()`을 orchestrator `shutdown()`보다 먼저 한다.
- README: Slack 앱 만들기(Socket Mode, 필요한 스코프 `chat:write`, `reactions:write`, `files:write`, `im:history`, `im:write`, `app_mentions:read`, `channels:history`, `groups:history`, 이벤트 `message.im`, `app_mention`, `message.channels`, `message.groups`, Interactivity 켜기), 토큰 입력, 내 member ID 찾는 법, 동료 만들기, Atlassian·Notion MCP는 각 CLI에 따로 연결해야 한다는 안내.

- [ ] **Step 1: 조립 후 `npm test && npm run typecheck`**
- [ ] **Step 2: 실제 Slack 검증 (worktree dev 서버, 테스트용 Slack 워크스페이스나 개인 DM)** — 각 항목 결과를 아래 "실측 기록"에 적는다.
  - DM "pixel 레포 README 첫 문단 요약해줘" → 3초 안에 👀, 10초 안에 배정 계획, 완료 후 보고.
  - 진행 중 스레드 답글 → "후속 지시 대기" 표시 후 이어서 실행.
  - 외부 쓰기 도구를 부르는 지시 → 승인 버튼 → 승인/거절 둘 다.
  - 오피스 화면에서 먼저 승인 → Slack 버튼이 "오피스에서 처리됨".
  - 다른 사람 계정(가능하면)이나 봇 메시지 → 반응 없음.
  - 작업 중 서버 재시작 → 스레드에 중단 안내.
  - 맞는 동료가 없는 요청 → 동료 제안 버튼 → 만들기 → 배정.
- [ ] **Step 3: Commit** — `feat(slack): wire the Slack gateway and coordinator into the server` / `docs: explain assigning work from Slack`

---

## 실측 기록

(Task 4 Step 5, Task 7 Step 6, Task 10 Step 2 결과를 여기 적는다.)

### Task 4 Step 5 — Codex MCP 승인 (2026-10-31, codex-cli 0.166.0)

외부 서비스에 실제로 쓰는 호출은 하지 않고(동의 없는 외부 게시 방지), app-server 프로토콜 자체로 확인했다.

- `codex app-server generate-ts --out <dir>`로 프로토콜 타입을 뽑아 `ServerRequest.ts`(서버 → 클라이언트 요청 전체)를 봤다. 승인/입력 요청은 `item/commandExecution/requestApproval`, `item/fileChange/requestApproval`, `item/permissions/requestApproval`, `item/tool/requestUserInput`, `mcpServer/elicitation/request`, (구버전) `applyPatchApproval`, `execCommandApproval`뿐이다. **MCP 도구 호출 전용 승인 요청은 없다.**
- `mcpServer/elicitation/request`의 params(`McpServerElicitationRequestParams`)는 `threadId`, `turnId`, `serverName`, `message`, `requestedSchema`/`url`만 있고 **도구 이름이 없다.** MCP 서버가 스스로 elicitation을 보낼 때만 오는 요청이라, 도구 이름 기준 `matchToolRule`을 적용할 수 없다.
- MCP 호출은 `ThreadItem`의 `mcpToolCall` 항목(`server`, `tool`, `arguments`)으로 알림(`item/started`)만 온다. 응답을 기다리지 않는 알림이라 실행 전에 막을 수 없다.
- 도구별 승인은 `apps.*.tools.*.approval_mode`(`AppToolApproval`: auto/prompt/writes/approve) 설정에만 있고, 개인 실행 auto 모드(`approvalPolicy: 'never'`)에서 승인 요청이 온다고 확신할 근거가 없다.
- 결론: 확실히 확인되지 않음 → **Step 6b** 구현. `ask` 규칙이 하나라도 있으면 `~/.codex/config.toml`(`CODEX_HOME` 우선)의 `[mcp_servers.<name>]`마다 `-c mcp_servers.<name>.enabled=false`를 붙인다.
- 끄기 플래그 확인: `codex -c mcp_servers.voicekit.enabled=false mcp list` → voicekit만 `disabled`로 바뀜. `-c 'mcp_servers."voicekit".enabled=false'`는 `invalid transport in mcp_servers."voicekit"`로 **시작 자체가 실패**한다(`-c`는 점으로 나누고 따옴표 구간을 지원하지 않음). 그래서 따옴표 이름은 따옴표를 벗겨 쓰고, 영문·숫자·`-`·`_`가 아닌 이름(예: `"my.docs"`)이 있으면 실행을 거부한다.
- 남는 구멍: config.toml 밖에서 들어오는 MCP(플러그인 번들 서버, 예: `codex mcp list`의 `codex_app`/`cua_repl`)와 ChatGPT 앱 커넥터(`apps.*`)는 이 방식으로 꺼지지 않는다. → 아래 수정 1차에서 막음.

### Task 4 수정 1차 — Codex 외부 도구 전부 끄기 (Ruling R12, 2026-10-31)

모델 호출 없이 `mcp list --json` / `features list` / `app-server --print-startup-config`만 돌려 확인했다.

- `codex mcp list --json`은 `[{ name, enabled, ... }]` 배열을 준다. config.toml에 없는 플러그인 번들 서버(`codex_app`, `cua_repl`)도 나온다.
- 플러그인 서버에 `-c mcp_servers.cua_repl.enabled=false`를 붙이면 `invalid transport in mcp_servers.cua_repl`로 **시작이 실패**한다. `-c`로는 config에 없는 서버를 못 끈다.
- `codex --disable plugins mcp list --json` → `codex_app`, `cua_repl`이 목록에서 사라진다. `codex features list`에서 `apps stable true`였고, `--disable apps`(= `-c features.apps=false`)를 붙이면 `apps stable false`가 된다.
- 그래서 `ask` 규칙이 있는 Codex 실행은 이렇게 간다: 실행할 명령·앞 플래그·폴더 그대로 `<cmd> <pre> --disable plugins --disable apps mcp list --json`로 남은 서버를 읽는다 → 이름마다 `-c mcp_servers.<name>.enabled=false`를 붙인다 → 같은 플래그로 다시 목록을 읽어 하나라도 `enabled: true`면 거부한다. 목록 실패, `-c`로 못 쓰는 이름(점 포함 등)도 실행을 거부한다(한국어 오류).
- 실제 함수(`mcpLockdown`)를 이 기기에서 `codex`, `syc --safe`, `syc`로 돌린 결과: 끄기 전 `codex_app=false, computer-use=false, cua_repl=true, node_repl=true, openaiDeveloperDocs=true, voicekit=true` → 끈 뒤 `computer-use=false, node_repl=false, openaiDeveloperDocs=false, voicekit=false`(플러그인 서버는 목록에서 빠짐), `features list`는 `apps false | plugins false`.
- `codex --sandbox workspace-write --ask-for-approval on-request --disable plugins --disable apps -c mcp_servers.voicekit.enabled=false app-server --print-startup-config` → exit 0. app-server가 이 플래그 조합을 받는다.
- `--safe`는 `syc` 전용 플래그다(`syc` 스크립트가 `codex --sandbox workspace-write --ask-for-approval on-request`로 펼친다). 그래서 다른 명령에는 이 두 플래그를 직접 넘긴다. `codex --help`에서 `-s, --sandbox`, `-a, --ask-for-approval`이 있는 것을 확인했다.
- 대가: 승인 규칙이 있는 동안 Codex 실행에서는 플러그인(그 안의 스킬 포함)과 앱 연결도 꺼진다. 동료 저장 응답의 경고 문구에 이 내용을 적었다.

### Task 7 Step 6 — 코디네이터 첫 답글까지 걸린 시간 (2026-10-31, claude-agent-sdk 0.3.282)

실제 `createCoordinator`(기본 `runQuery` = 실제 `query()`)에 임시 데이터 폴더, 실제 store·동료 명단(회의록 동료·기획 동료·SKT 개발), 가짜 오케스트레이터(`startFor`는 Run 기록만 만들고 실행하지 않음)를 붙였다. 외부로 나가는 동작은 없다. `wake(job, { kind: 'new', text: 'skt 회의록 정리해줘' })`부터 첫 `reply` 도구 호출까지를 쟀다. 매 회 새 Job(새 세션)이다.

| 모델 | 1 | 2 | 3 | 4 | 5 | 중앙값 |
|---|---|---|---|---|---|---|
| `claude-sonnet-5-5`(기본값) | 6.1s | 7.0s | 5.8s | 6.1s | 5.5s | **6.1s** |

- 중앙값이 10초 안이라 기본 모델은 `claude-sonnet-5-5` 그대로 둔다(haiku 재측정 안 함). 첫 회 시험 실행은 8.9s였다(콜드 스타트).
- 5회 모두 `list_coworkers` → `delegate('meeting-minutes', …)` → `reply` 순서였고, 첫 답글에 배정과 가정을 한두 줄로 적었다. `allowedTools: ['mcp__office__*']` + `permissionMode: 'default'`로 office 도구가 막히지 않는 것도 확인했다.
- 턴 전체(`reply` 뒤 마무리까지)는 7.8~9.6s.
- 측정 환경 탓에 앞 회차의 가짜 Run이 `queued`로 남아 `busy: true`가 보였고, 그래서 답글에 "다른 일을 하는 중"이 섞였다. 실제 실행에서는 Run 상태가 바뀌므로 해당 없음.
