# Pixel Agent Office Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 로컬 Git 프로젝트에서 모델과 직급 페르소나를 설정한 Claude·Codex에게 직접 작업을 맡기고 순차 협업 과정을 픽셀 사무실에서 관찰하는 앱을 완성한다.

**Architecture:** React 화면이 로컬 Node 서버에 작업을 요청한다. 서버는 실행별 Git worktree, SQLite 실행 기록, Codex App Server·Claude Agent SDK 어댑터를 관리한다. 정규화된 이벤트를 WebSocket으로 보내 화면과 협업 상태를 일치시킨다.

**Tech Stack:** TypeScript, React, Vite, Canvas 2D, Node.js 24, node:sqlite, Fastify, ws, Zod, @anthropic-ai/claude-agent-sdk, Vitest, Playwright. 설치 시 공식 npm 패키지의 호환 버전을 확인하고 package-lock.json으로 고정한다.

**Spec:** [승인된 설계](../specs/2026-09-25-pixel-agent-office-design.md)

## Global Constraints

- 첫 버전은 한 번에 한 작업만 실행한다.
- 두 에이전트는 같은 작업 worktree를 **순서대로** 사용한다.
- 최초 검토 이후 수정은 최대 2회로 제한한다.
- 원본 브랜치 병합이나 원격 푸시는 자동으로 수행하지 않는다.
- 모델 이름을 코드에 고정하지 않고 미지정 시 공급자 기본 설정을 따른다.
- 공급자·모델·직급·업무는 독립적으로 설정하며 직급으로 실행 권한을 확대하지 않는다.
- 브라우저에 자격 증명을 보내거나 셸 명령 문자열을 조립해 실행하지 않는다.
- 개발용 이벤트 재생 기능에는 항상 '데모'를 표시한다.
- UI 문구는 한국어로 제공한다.
- 프로젝트의 기존 커밋되지 않은 변경은 자동으로 옮기거나 덮어쓰지 않는다.
- 로컬 서버는 루프백 주소에만 바인딩한다.
- CLI 설치 확인과 인증·실제 실행 성공을 구분해 표시한다.

## Review Focus

1. 공백·한글이 포함된 경로, 심볼릭 링크, HEAD 없는 저장소: 경로를 안전하게 정규화하고 실행 가능한 저장소만 허용한다. Task 2.
2. 작업 시작 연타와 취소 직후 완료 도착: 실행은 하나만 생성되고 취소 뒤 검토가 시작되지 않는다. Task 5.
3. 새로고침 중 승인 요청 및 이벤트 수신: 요청을 잃지 않고 이미 응답한 요청을 중복 실행하지 않는다. Tasks 1, 6.
4. 검토 출력 불량, 도구 출력이 큰 경우, 파일명이 특수문자를 포함한 diff: 성공으로 오인하지 않고 페이지가 멈추지 않는다. Tasks 2, 5, 7.
5. 공급자 종료·서버 재시작·WebSocket 단절: 실행 중으로 영구 방치하지 않고 기록과 worktree를 보존한다. Tasks 3, 4, 6.

## 파일 구조와 공통 계약

```text
src/shared/contracts.ts           실행·이벤트·승인·검토 타입과 Zod 검증
src/server/index.ts               루프백 서버 시작과 종료
src/server/store.ts               SQLite 실행·이벤트·대기 요청 저장
src/server/projects.ts            Git 경로 검증, worktree 생성, diff 수집
src/server/adapters/types.ts      공급자 공통 인터페이스
src/server/adapters/codex.ts      Codex 세션 수명주기
src/server/adapters/codex-rpc.ts  stdio RPC 전송·요청 상관관계
src/server/adapters/claude.ts     Claude SDK 수명주기
src/server/adapters/normalize.ts  공급자 메시지 → 앱 이벤트
src/server/orchestrator.ts        단독 실행·구현·검토·수정 제어
src/server/prompts.ts             역할 지시 및 인계 내용
src/server/personas.ts            시니어·주니어·신입 지침과 버전
src/server/transport.ts           HTTP·WebSocket·연결 인증
src/client/App.tsx                페이지 배치와 선택 상태
src/client/api.ts                 HTTP 호출·WS 재연결
src/client/state.ts               이벤트 반영·중복 제거
src/client/components/            프로젝트·작업·로그·승인·결과 패널
src/client/office/Office.tsx       Canvas 수명주기와 입력
src/client/office/draw.ts          타일·가구·캐릭터 렌더링
src/client/office/motion.ts        상태별 위치·이동·감소 모션
src/client/styles.css             레이아웃·색·반응형·접근성
tests/                           단위·서버 통합 테스트
tests/fixtures/                  공급자 이벤트와 데모 시나리오
e2e/                             브라우저 사용자 흐름
scripts/smoke.ts                  실제 공급자 통합 검증
README.md                        설치·실행·인증·문제 해결
```

실행 중 구현자가 아래 계약을 먼저 정의하고 이후 모듈에서 재사용한다. 공급자별 상세 필드는 설치한 SDK 타입과 Codex 생성 스키마로 검증한다.

```ts
export type Provider = 'codex' | 'claude';
export type Seniority = 'senior' | 'junior' | 'intern';
export interface AgentProfile {
  seniority: Seniority; model?: string; personaVersion: '1';
}
export type TeamConfig = Record<Provider, AgentProfile>;
export type RunStatus = 'queued' | 'running' | 'waiting_approval'
  | 'waiting_input' | 'completed' | 'failed' | 'cancelled'
  | 'interrupted' | 'needs_attention';
export type Activity = 'idle' | 'responding' | 'reading' | 'editing'
  | 'executing' | 'reviewing';
export type Mode = 'collaborate' | 'codex' | 'claude';
export interface Run {
  id: string; projectPath: string; worktreePath: string; branch: string;
  baseCommit: string; prompt: string; mode: Mode; implementer: Provider;
  status: RunStatus; phase: 'implement' | 'review' | 'revise' | 'done';
  revision: number; createdAt: string; team: TeamConfig;
}
export interface OfficeEvent {
  eventId: string; sequence: number; runId: string; agentId: Provider | null;
  timestamp: string; type: string; payload: Record<string, unknown>;
}
export type EventInput = Omit<OfficeEvent, 'eventId' | 'sequence' | 'timestamp'>;
export interface Review {
  verdict: 'pass' | 'changes_requested' | 'inconclusive';
  summary: string;
  findings: Array<{ path: string; message: string; severity: 'error' | 'warning' }>;
}
export interface Interaction {
  id: string; runId: string; agentId: Provider;
  kind: 'approval' | 'question'; title: string;
  details: Record<string, unknown>; resolved: boolean;
}
export type Answer = { decision: 'approve' | 'deny' }
  | { answers: Record<string, string[]> };
export interface PhaseInput {
  runId: string; cwd: string; prompt: string;
  role: 'implementer' | 'reviewer'; profile: AgentProfile; signal: AbortSignal;
}
export interface PhaseResult {
  outcome: 'completed' | 'failed' | 'cancelled';
  text: string; review?: Review; error?: string;
}
export interface Adapter {
  probe(): Promise<{ installed: boolean; authenticated: boolean | null; detail: string }>;
  execute(input: PhaseInput, emit: (event: EventInput) => void,
    interact: (request: Omit<Interaction, 'id' | 'resolved'>) => Promise<Answer>
  ): Promise<PhaseResult>;
  close(): Promise<void>;
}
```

## Task 1: 실행 기록과 이벤트 계약

**Files:** package.json, package-lock.json, tsconfig.json, vite.config.ts, vitest.config.ts, .gitignore, src/shared/contracts.ts, src/server/store.ts, tests/store.test.ts.

**Interfaces:** `createStore(path: string)`은 `createRun(run: Run): void`, `getRun(id: string): Run | undefined`, `append(input: EventInput): OfficeEvent`, `events(runId: string, after: number): OfficeEvent[]`, `setStatus(runId: string, status: RunStatus): void`, `saveInteraction(request: Interaction): void`, `pending(runId: string): Interaction[]`, `resolveInteraction(id: string): boolean`, `interruptActive(): number`, `close(): void`를 반환한다.

- [ ] 패키지와 TypeScript·Vitest 설정을 추가한다. `dev`, `build`, `start`, `typecheck`, `test`, `test:e2e`, `smoke` 명령을 정의한다. `.pixel/`, `node_modules/`, `dist/`, 테스트 결과와 인증 파일은 Git에서 제외한다. 아직 Git 저장소가 아니므로 구현 이력 관리를 위해 로컬 저장소를 초기화한다.
- [ ] 다음 핵심 테스트를 작성하고 `npx vitest run tests/store.test.ts`로 구현 전 실패를 확인한다.

```ts
import { expect, test } from 'vitest';
import { createStore } from '../src/server/store';
test('replay returns only events after acknowledged sequence', () => {
  const store = createStore(':memory:');
  store.createRun({ id: 'r1', projectPath: '/p', worktreePath: '/w',
    branch: 'pixel/r1', baseCommit: 'abc', prompt: 'task', mode: 'codex',
    implementer: 'codex', status: 'running', phase: 'implement',
    revision: 0, createdAt: new Date().toISOString(),
    team: { codex: { seniority: 'junior', personaVersion: '1' },
      claude: { seniority: 'senior', personaVersion: '1' } } });
  const a = store.append({ runId: 'r1', agentId: 'codex', type: 'message', payload: { text: 'a' } });
  const b = store.append({ runId: 'r1', agentId: 'codex', type: 'message', payload: { text: 'b' } });
  expect(store.events('r1', a.sequence).map(e => e.eventId)).toEqual([b.eventId]);
  store.saveInteraction({ id: 'q1', runId: 'r1', agentId: 'codex',
    kind: 'approval', title: 'command', details: {}, resolved: false });
  expect(store.resolveInteraction('q1')).toBe(true);
  expect(store.resolveInteraction('q1')).toBe(false);
  expect(store.pending('r1')).toEqual([]);
  expect(store.interruptActive()).toBe(1);
  expect(store.getRun('r1')?.status).toBe('interrupted');
  store.close();
});
```

- [ ] SQLite에 runs, events, interactions 테이블을 생성한다. sequence는 DB가 할당하고 이벤트 저장·상태 변경은 트랜잭션으로 처리한다. 요청 해결은 `UPDATE ... WHERE resolved = 0`의 변경 행 수로 중복을 차단한다. 런타임 입력은 Zod로 검증한다.
- [ ] 테스트를 통과시키고 파일 DB를 닫았다가 다시 열어 기록과 미응답 요청이 남는 테스트를 추가한다. `npm run typecheck`를 통과시키고 이 단위를 커밋한다.

## Task 2: 프로젝트 선택과 격리된 작업 공간

**Files:** src/server/projects.ts, tests/projects.test.ts.

**Interfaces:** `inspectProject(path: string): Promise<{root: string; head: string; dirty: boolean}>`, `createWorkspace(projectPath: string, runId: string, dataDir: string): Promise<{path: string; branch: string; baseCommit: string}>`, `collectChanges(worktreePath: string, baseCommit: string): Promise<Array<{path: string; status: string; diff: string; truncated: boolean}>>`.

- [ ] 테스트에서 임시 Git 저장소를 만들고 다음 조건을 고정한다. Git 테스트 설정은 `git -c user.name=Pixel -c user.email=pixel@example.test commit`의 프로세스 인자로만 지정한다.

```ts
// 테스트의 fixture 생성 이후 사용하는 인수 조건
const before = await readFile(join(projectPath, 'draft.txt'), 'utf8');
const workspace = await createWorkspace(projectPath, 'r1', dataDir);
await writeFile(join(workspace.path, 'new 한글.txt'), 'hello\n');
expect(await readFile(join(projectPath, 'draft.txt'), 'utf8')).toBe(before);
expect((await collectChanges(workspace.path, workspace.baseCommit))
  .map(change => change.path)).toContain('new 한글.txt');
```

- [ ] `npx vitest run tests/projects.test.ts`의 실패를 확인하고 `realpath`, `git rev-parse`, `git worktree add -b`를 구현한다. 프로세스 실행은 `execFile`과 인자 배열을 사용한다. 경로는 절대 경로만 받고 저장소 루트로 정규화한다. 초기 커밋이 없는 저장소는 설명 가능한 오류로 거절한다.
- [ ] 변경 수집은 기준 커밋부터의 tracked 변경과 untracked 파일을 모두 포함한다. 파일명은 `-z` 출력으로 파싱한다. 바이너리는 텍스트 diff 대신 바이너리 표시, 파일당 diff는 256 KiB까지 반환하고 생략 사실을 표시한다. 심볼릭 링크 대상 파일은 따라 읽지 않는다.
- [ ] 공백·한글 경로, 저장소 심볼릭 링크, HEAD 없는 저장소, 외부를 가리키는 untracked symlink, 바이너리·큰 파일을 검증한다. 원본의 dirty 파일 내용과 Git 상태가 유지되는지 확인하고 커밋한다.

## Task 3: Codex 실행·승인·중단 연결

**Files:** src/server/adapters/types.ts, codex.ts, codex-rpc.ts, normalize.ts, tests/codex.test.ts, tests/fixtures/codex.jsonl. 파일명은 위 구조의 동일 디렉터리를 사용한다.

**Interfaces:** `createCodexAdapter(): Adapter`; `RpcClient`는 `request(method: string, params: unknown): Promise<unknown>`, `respond(id: string | number, result: unknown): void`, `close(): Promise<void>`를 제공한다. 정상화 함수는 `normalizeCodex(runId: string, message: unknown): EventInput[]`다.

- [ ] 로컬 `codex app-server generate-ts`로 임시 디렉터리에 현재 프로토콜 타입을 생성해 초기화·thread/start·turn/start·turn/interrupt·서버 요청의 필드를 확인한다. 생성물 전체를 제품에 복사하지 않고 실제 사용하는 타입과 런타임 검증 범위를 고정한다.
- [ ] 공급자 프로세스 대신 테스트용 stdio 서버를 사용해 분할 JSON 라인, 동시 request ID, approval 요청, 질문, 종료 중 미완료 RPC를 검증한다. 다음 중단 인수를 포함한다.

```ts
const controller = new AbortController();
const events: EventInput[] = [];
const result = adapter.execute({ runId: 'r1', cwd: workspace.path,
  prompt: 'change a file', role: 'implementer',
  profile: { seniority: 'junior', personaVersion: '1' }, signal: controller.signal },
  event => events.push(event), async () => ({ decision: 'deny' }));
controller.abort();
expect((await result).outcome).toBe('cancelled');
expect(events.some(e => e.type === 'run.completed')).toBe(false);
```

- [ ] `npx vitest run tests/codex.test.ts`로 실패를 확인한다. `spawn('codex', ['app-server', '--stdio'])`로 연결하고 초기화, 작업 폴더를 지정한 thread/start, turn/start, 종료 이벤트 수신을 구현한다. 계정 조회로 인증 상태를 확인하되 자격 증명은 반환하지 않는다.
- [ ] 파일 변경·명령 실행·메시지·승인·질문 이벤트를 정규화한다. 서버 요청은 원래 RPC id로 응답하며 취소된 요청은 다시 응답하지 않는다. 구현 세션은 workspace-write, 검토 세션은 read-only 정책을 사용한다. 권한 우회 옵션은 사용하지 않는다.
- [ ] profile.model이 지정되면 thread/turn 설정에 전달한다. 모델 목록 API가 제공되면 선택 목록에 사용한다. 공급자 기본 모델 사용과 명시 모델 선택을 구분하고 잘못된 모델 요청을 다른 모델로 대체하지 않는 테스트를 추가한다.
- [ ] turn/interrupt 이후 종료를 기다리고 제한 시간 후 소유한 자식 프로세스를 정리한다. 비정상 종료는 실패로 반환하고 미해결 요청을 정리한다. 30초 RPC 연결 제한 시간과 stderr 진단을 둔다. fixture 기반 테스트를 통과시키고 커밋한다.

## Task 4: Claude 실행·승인·질문 연결

**Files:** src/server/adapters/claude.ts, normalize.ts, tests/claude.test.ts, tests/fixtures/claude.jsonl.

**Interfaces:** `createClaudeAdapter(): Adapter`; `normalizeClaude(runId: string, message: unknown): EventInput[]`.

- [ ] 설치 SDK의 `query`, `Options`, `canUseTool`, `AbortController`, 구조화된 결과 타입을 확인한다. 테스트에서 SDK 실행을 주입 가능한 함수로 감싸 실제 요청 없이 이벤트를 재생한다.
- [ ] 정규화 테스트는 메시지 delta, tool_use, tool_result, result의 오류·성공, 알 수 없는 도구, parent_tool_use_id 유무를 다룬다. 승인 거절과 사용자 질문은 별도 interaction으로 유지한다.

```ts
expect(normalizeClaude('r1', { type: 'result', subtype: 'error_during_execution',
  is_error: true, errors: ['authentication failed'] })
  .some(event => event.type === 'agent.failed')).toBe(true);
```

- [ ] 실패를 확인한 뒤 `query`에 cwd, prompt, AbortController, canUseTool를 연결한다. 읽기·수정·명령 이벤트는 SDK 스트림과 훅에서 관측한다. 알 수 없는 이벤트는 진단 기록을 남기고 상태를 임의로 완료 처리하지 않는다.
- [ ] profile.model이 있으면 SDK model 옵션에 전달한다. 실제 선택 가능한 모델 목록 조회가 없으면 UI에 기본 모델과 식별자 입력을 제공한다. 직급은 모델 옵션이나 권한 모드로 변환하지 않는다.
- [ ] canUseTool의 승인 요청을 interaction으로 전달하고 질문은 AskUserQuestion의 스키마대로 응답한다. 모든 도구 호출에 적용할 경로·역할 제한은 PreToolUse 훅에서 검사한다. 검토자에게 파일 쓰기 도구를 노출하지 않고 검증 명령은 명시적 승인 대상으로 처리한다. 모델과 권한 우회를 하드코딩하지 않는다.
- [ ] 인증 수단이 확인되지 않으면 probe의 authenticated를 null로 반환하고 첫 실제 실행 전 연결 확인이 필요하다고 표시한다. 종료·취소·permission denial이 완료로 바뀌지 않는 테스트를 통과시키고 커밋한다.

## Task 5: 단독 실행과 두 에이전트 협업

**Files:** src/server/orchestrator.ts, prompts.ts, personas.ts, tests/orchestrator.test.ts, tests/personas.test.ts, src/shared/contracts.ts.

**Interfaces:** `createOrchestrator({store, adapters, dataDir})`는 `start({projectPath, prompt, mode, implementer, team}): Promise<Run>`, `cancel(runId: string): Promise<void>`, `answer(interactionId: string, answer: Answer): Promise<void>`, `shutdown(): Promise<void>`를 제공한다. `team`은 TeamConfig다. `reviewSchema`는 위 Review 타입을 검증한다. `nextAfterReview(review: Review, revision: number)`는 `'completed' | 'revise' | 'needs_attention'`을 반환한다. `personaInstructions(profile: AgentProfile): string`은 직급별 지침을 반환한다.

- [ ] 다음 분기 테스트와 fake Adapter를 이용한 실행 순서 테스트를 작성한다.

```ts
test('revision budget never becomes a false success', () => {
  const review: Review = { verdict: 'changes_requested', summary: 'fix it', findings: [] };
  expect(nextAfterReview(review, 0)).toBe('revise');
  expect(nextAfterReview(review, 2)).toBe('needs_attention');
  expect(reviewSchema.safeParse({ verdict: 'pass' }).success).toBe(false);
});
```

- [ ] 테스트 실패를 확인하고 실행 락을 첫 await 전에 획득한다. 프로젝트·연결 점검 후 작업 공간을 만들고 Run을 저장한다. 실패 시 락을 해제하고 후속 에이전트를 시작하지 않는다.
- [ ] personas.ts에 senior는 구조적 영향·예외·판단 근거 확인, junior는 합의된 구현·테스트와 범위 변경 전 질문, intern은 작은 작업·불확실성 보고·검토 요청 지침을 정의한다. 구현·검토 업무 프롬프트에 선택한 personaInstructions를 합성한다. 입력 team을 깊은 복사해 Run에 저장하고 실행 중 편집은 허용하지 않는다.
- [ ] personas.test.ts에서 세 직급 지침이 구분되는지 확인하고, fake Adapter가 받은 PhaseInput.profile 및 prompt에 실제 선택값·지침이 포함되는지 검증한다. 모델·직급을 바꿔도 검토자 쓰기 제한과 수정 횟수가 유지되는 통합 테스트를 추가한다.
- [ ] 단독 실행은 선택 공급자만 호출한다. 협업은 구현 결과·변경 파일·기준 커밋·검증 결과를 검토자에게 인계한다. Review는 구조화된 결과를 우선 사용하고 엄격한 스키마 검증 실패 시 needs_attention으로 종료한다. 최초 검토 이후 최대 2회의 수정·재검토만 수행한다.
- [ ] 각 공급자 결과가 돌아온 직후 AbortSignal과 실행 상태를 확인한다. 취소 중 도착한 성공은 다음 단계로 진행시키지 않는다. 승인 대기 요청은 저장하고 응답 후 원래 실행 상태로 돌아간다. 존재하지 않거나 해결된 요청은 409 또는 404로 거절한다.
- [ ] 중복 start, 구현 실패, 취소-완료 경합, 역할 반전, 두 번의 수정, inconclusive 검토, 불량 JSON, 사용자 질문 복원을 테스트하고 커밋한다.

## Task 6: 로컬 HTTP·WebSocket 서버와 복구

**Files:** src/server/index.ts, transport.ts, tests/transport.test.ts, src/client/api.ts.

**Interfaces:** 아래 API를 제공한다. 모든 변경 요청은 연결 세션 인증을 요구한다.

```text
GET  /api/health                   프로세스·공급자 연결 상태
POST /api/projects/inspect         {path} → 프로젝트 상태
POST /api/runs                     {projectPath,prompt,mode,implementer,team} → Run
GET  /api/runs                     최근 실행 목록
GET  /api/runs/:id                 실행 스냅샷·에이전트·미응답 요청
GET  /api/runs/:id/changes          변경 파일·제한된 diff
POST /api/runs/:id/cancel          실행 취소
POST /api/interactions/:id/answer  Answer → 해결 여부
WS   /api/events?runId=...&after=... 저장 이벤트 재생 후 실시간 이벤트
```

- [ ] Fastify 주입 테스트와 실제 loopback WebSocket으로 인증 누락, 잘못된 Origin, 중복 interaction 응답, reconnect cursor, 존재하지 않는 실행을 검증한다.

```ts
const res = await server.inject({ method: 'POST', url: '/api/runs',
  headers: { origin: 'https://untrusted.example' }, payload: {} });
expect(res.statusCode).toBe(403);
```

- [ ] 테스트 실패 후 서버를 127.0.0.1에만 바인딩한다. 시작 시 임시 bootstrap 토큰을 출력하고 프런트엔드는 URL fragment에서 이를 읽어 동일 출처 POST로 HttpOnly·SameSite=Strict 세션 쿠키와 교환한 뒤 URL에서 제거한다. 토큰은 공급자 인증 정보와 무관한 앱 연결용이며 서버 재시작 시 교체한다.
- [ ] HTTP와 WS 모두 Host·Origin·세션을 확인한다. Origin이 없는 비브라우저 요청도 명시적 세션 인증을 요구한다. WS는 저장 이벤트와 실시간 구독 사이의 누락을 sequence 재조회로 방지한다. 전송 큐 크기를 제한하고 느린 클라이언트는 닫은 뒤 cursor로 복구하게 한다.
- [ ] SIGINT·SIGTERM에서 실행 취소, 자식 프로세스 종료, DB 닫기를 수행한다. 기동 시 이전 활성 실행은 interrupted로 기록한다. process metadata는 진단 목적으로 남기고 PID만으로 무관한 프로세스를 종료하지 않는다.
- [ ] Vite 개발 프록시와 production 정적 파일 서빙을 연결한다. 재연결·미응답 승인 복원·서버 재시작 테스트를 통과시키고 커밋한다.

## Task 7: 픽셀 사무실과 작업 패널

**Files:** index.html, src/client/main.tsx, App.tsx, state.ts, styles.css, components/ProjectPanel.tsx, TeamPanel.tsx, TaskComposer.tsx, AgentPanel.tsx, InteractionPanel.tsx, RunResult.tsx, office/Office.tsx, draw.ts, motion.ts, tests/client-state.test.ts, e2e/office.spec.ts. client 하위 경로는 파일 구조를 따른다.

**Interfaces:** `applyEvent(state: OfficeState, event: OfficeEvent): OfficeState`; OfficeState는 Run, 에이전트별 activity·메시지, interactions, 마지막 sequence를 포함한다. `Office`는 agents, selectedAgent, onSelect를 props로 받고 서버나 프로세스를 직접 호출하지 않는다.

- [ ] 이벤트 reducer에 중복 eventId 무시, 이전 sequence 무시, 승인 해결 반영, 실패 후 늦은 message로 완료 상태가 바뀌지 않는 테스트를 작성한다. 실제 에이전트 호출 없이 실행 가능한 데모 서버는 명시적 테스트 플래그로만 켠다.
- [ ] 승인된 화면을 React DOM과 Canvas로 구현한다. 사무실은 따뜻한 바닥·책상·자료 공간·검토 테이블, Claude는 주황색·Codex는 청록색으로 구분한다. 상태 배지는 색과 한국어 텍스트를 함께 사용한다. 화면에 두 공급자 로고 자산이 없어도 자체 제작 캐릭터로 식별되게 한다.
- [ ] requestAnimationFrame에서 elapsed time으로 이동하고 imageSmoothingEnabled=false를 사용한다. Canvas devicePixelRatio와 클릭 좌표를 맞추고 resize 때 갱신한다. prefers-reduced-motion을 준수하며 offscreen·숨김 탭에서 불필요한 렌더링을 줄인다.
- [ ] 프로젝트 연결, 역할 변경, 작업 입력, 실행·중단, 에이전트 선택, 승인·거절·질문 답변, 실행 기록, 변경 파일·diff를 연결한다. 사용자·에이전트 출력은 텍스트로 렌더링하고 HTML로 삽입하지 않는다. 로그는 최근 표시 범위를 제한하고 이전 기록은 페이지 단위로 불러온다.
- [ ] TeamPanel에서 각 에이전트의 모델·직급을 설정한다. 초기 제안은 시니어 검토자와 주니어 구현자이며 사용자가 자유롭게 바꾼다. 캐릭터 이름표와 상세 패널에 직급·현재 업무를 표시하고 실행 기록에는 당시 선택 모델·직급을 표시한다. 신입 선택 시 작은 범위의 작업과 검토를 권하는 안내를 제공한다. 직급을 실제 경력·벤치마크 점수로 표현하지 않는다.
- [ ] E2E에서 직급 변경, 공급자 역할 반전, 신입 배치, 모델 기본값 복원, 실행 중 설정 잠금, 새로고침 후 당시 페르소나 표시를 검증한다.
- [ ] 브라우저 테스트의 기본 인수 흐름을 아래와 같이 작성한다. 테스트 서버는 고정 fixture로 승인 이벤트를 내보내고 항상 데모 배지를 표시한다.

```ts
await page.goto('/');
await expect(page.getByText('데모', { exact: true })).toBeVisible();
await page.getByLabel('프로젝트 경로').fill(sampleProjectPath);
await page.getByRole('button', { name: '프로젝트 연결' }).click();
await page.getByLabel('작업 내용').fill('간단한 함수를 추가하고 검토해 주세요');
await page.getByRole('button', { name: '작업 시작' }).click();
await page.getByRole('button', { name: 'Codex 선택' }).click();
await expect(page.getByText('승인 필요', { exact: true })).toBeVisible();
await page.reload();
await page.getByRole('button', { name: '승인', exact: true }).click();
await expect(page.getByText('검토 완료', { exact: true })).toBeVisible();
```

- [ ] 1440px·390px 뷰포트에서 레이아웃, 키보드 선택, reduced-motion, 큰 로그, diff 표시, 에러·중단 상태를 확인한다. 브라우저 스크린샷과 실제 클릭으로 시각적 상태 일치를 점검한다. 상태 테스트와 E2E를 통과시키고 커밋한다.

## Task 8: 실제 협업 실행과 사용자 실행 안내

**Files:** scripts/smoke.ts, README.md, docs/verification.md, package.json.

**Interfaces:** `npm run smoke -- --provider codex`, `--provider claude`, `--collaborate`는 자체 생성한 샘플 저장소에만 작업한다. `--collaborate`는 앱과 동일한 Orchestrator를 호출하고 결과를 검증한다.

- [ ] 샘플 저장소에 package.json, add.js, node:test 테스트를 작성한다. 작업은 `add(a,b)` 구현과 검토이며 사용자 프로젝트는 사용하지 않는다.

```js
import assert from 'node:assert/strict';
import test from 'node:test';
import { add } from './add.js';
test('add combines numbers', () => {
  assert.equal(add(2, 3), 5);
  assert.equal(add(-2, 1), -1);
});
```

- [ ] 단위·통합 테스트, typecheck, production build를 실행한다. 이어 두 공급자의 인증을 확인하고 각 실제 실행 후 협업 실행을 수행한다. 정상 worktree에서 위 테스트가 통과하고 원본에는 변경이 없는지 확인한다. smoke 검증 중 필요한 승인도 기록하며 전체 권한 우회는 사용하지 않는다.
- [ ] 실제 실행 화면에서 캐릭터 선택, 활동 로그, 검토 인계, 결과 diff를 확인한다. 데모 E2E 성공과 실제 공급자 성공을 각각 기록한다. 인증이나 계정 제한으로 실행할 수 없으면 해당 공급자의 검증 미완료를 그대로 기록하고 구성 가능한 부분의 검증을 끝낸다.
- [ ] README에 `npm install`, `npm run dev`, 연결 URL, 프로젝트 최초 커밋 요구, 공급자 인증 안내, 작업 폴더 위치, 중단·복구, 원본으로 결과를 가져오는 방법을 작성한다. macOS 현재 환경과 실제 사용한 CLI·SDK 버전을 기록한다.
- [ ] 전체 변경을 검토하고 실패·누락을 수정한다. 최종 응답에는 로컬 URL, 실행 방법, 구현 범위, 실제 검증 결과와 남은 제한만 보고한다.

## 자체 검토

- 설계 1~3: Tasks 2, 5, 6, 7이 프로젝트 선택부터 결과 확인까지 담당한다.
- 설계 4: Task 7이 시각 동작·텍스트 접근성·반응형 화면을 담당한다.
- 직급 페르소나 추가 요구: Tasks 1, 3, 4, 5, 7이 모델·직급 기록, 공급자 전달, 역할 프롬프트, 배치 UI와 검증을 담당한다.
- 설계 5~6: Tasks 1, 3, 4, 5, 6이 저장·연결·인계·수정 제한을 담당한다.
- 설계 7: Tasks 1, 3, 4, 5, 6이 승인·취소·재연결·재시작을 담당한다.
- 설계 8: Task 8이 실제 공급자 실행을 포함한 최종 인수를 담당한다.
- 공통 타입과 공급자 역할, API 입력 이름을 일치시켰다.
- 위 Review Focus의 다섯 조건마다 소유 Task와 테스트를 지정했다.

## 실행 방식 제안

**Native 권장:** 이 세션의 주 에이전트가 위 순서로 직접 구현하고 마지막에 별도 검토를 받는다. 실행·승인·협업·UI가 같은 이벤트 계약을 공유하므로 한 구현자가 연결 흐름을 이어서 검증하는 편이 적합하다.

대안은 Task마다 구현 에이전트와 검토 에이전트를 분리하는 Subagent-driven 방식이다. 작업별 독립 검토가 늘어나는 대신 컨텍스트와 검토 비용도 증가한다.

## 공식 연동 자료

- Codex App Server: https://learn.chatgpt.com/docs/app-server
- Claude SDK 권한 처리: https://code.claude.com/docs/en/agent-sdk/permissions
- Claude SDK 승인·질문: https://code.claude.com/docs/en/agent-sdk/user-input
- Claude SDK TypeScript: https://code.claude.com/docs/en/agent-sdk/typescript

## 실행 결과 — 2026-09-25

구현을 완료하고 단위·통합 테스트 17개, 데스크톱·모바일 E2E 10개, 타입 검사와 프로덕션 빌드를 통과했습니다. 실제 Codex 구현→Claude 검토 협업과 Claude 단독 실행도 샘플 저장소에서 확인했습니다. 최종 변경·검증 범위는 [검증 기록](../../verification.md)을 참고하세요.
