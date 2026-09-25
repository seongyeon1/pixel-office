# 전체 맵을 한 층짜리 회사로 — 설계

## 목적

전체 맵이 프로젝트 카드 격자라서 "각자 다른 방에 있는 동료들이 한 회사에서 일한다"는 느낌이 없다.
한 층 평면도 위에서 에이전트가 출근하고, 자기 방에서 일하고, 협업할 때 움직이고, 끝나면 퇴근한다.
사람이 봐야 할 동료는 머리 위 `?` / `!`로 바로 찾을 수 있어야 한다.

## 합의된 결정

| 항목 | 결정 |
|---|---|
| 렌더링 | DOM 평면도 + 경유점 이동 (canvas 전환 안 함). `PixelWorker`·aria 버튼 재사용 |
| 방 단위 | 레포 = 방. 워크트리 = 방 안 책상 줄(파티션) + 브랜치 이름표. 워크트리가 메인뿐이면 구분선 없음 |
| 협업 무빙 | 섞어서 — 실제 신호로 생기는 동선은 사실대로, 한가한 동료만 가끔 탕비실 연출 |
| 퇴근 | 프로세스 종료(`processAlive === false`) 즉시, 또는 마지막 활동 후 30분 |
| 머리 위 표시 | `?` = 사람 응답 없이는 진행이 멈춘 상태, `!` = 작업을 끝내고 보고가 있는 상태(누르면 사라짐) |

## 서버 — 관측 신호 추가 (`observer.ts`, `contracts.ts`)

`ObservedSession`에 필드 3개를 추가한다. 모두 선택 필드라 기존 소비자는 그대로 동작한다.

```ts
worktree?: { path: string; branch: string; main: boolean };
parentId?: string;          // subagent면 부모 세션의 observed id
attention?: { kind: 'question' | 'approval'; certain: boolean; since: string } | null;
```

**워크트리.** `projectRoot(cwd)`가 `git worktree list --porcelain -z`의 모든 레코드를 읽어
`cwd`를 포함하는 가장 긴 워크트리 경로와 그 `branch`(없으면 `detached`)를 함께 돌려준다.
첫 레코드가 메인 워크트리다.

**유령 방 방지.** 워크트리 폴더가 지워져 git이 실패하면:
1. 이미 알던 `cwd` 매핑이 있으면(만료됐어도) 그대로 유지한다.
2. 없으면 존재하는 가장 가까운 상위 폴더에서 git을 다시 시도한다. 예: `.claude/worktrees/x`가 지워져도 상위 폴더가 레포 안이면 원래 레포로 묶인다.
3. 그래도 실패하면 지금처럼 `cwd` 자체를 방으로 쓴다.

**부모 연결.**
- Claude subagent: 파일이 `…/<부모ID>/subagents/agent-*.jsonl`이고 기록의 `sessionId`가 부모 ID다.
- Codex subagent: `session_meta.payload.parent_thread_id`.
- `list()`에서 같은 provider의 subagent가 아닌 세션 중 `sessionId`가 일치하는 것을 부모로 보고 `parentId`를 채운다.

**`?` 감지.** `parseRecord`가 도구 시작·종료(`tool_use.id`/`tool_result.tool_use_id`, Codex는 `call_id`)를
보고하고, 커서가 결과를 아직 못 받은 도구 목록을 들고 있는다. 턴 완료나 새 요청이 오면 비운다.

| 대기 중인 도구 | 판정 |
|---|---|
| `AskUserQuestion`, `request_user_input`, `request_user_input_async` | `question`, 확실 |
| `ExitPlanMode` | `approval`, 확실 |
| 그 밖의 도구가 60초 넘게 결과 없음 (subagent·대기용 도구 제외) | `approval`, 추정 |

`attention`이 있는 세션은 턴이 열린 지 2분이 지나도 `stale`이 아니라 `active`로 둔다.
사람을 기다리는 세션이 "상태 확인 필요"로 보이는 문제를 이렇게 고친다.

## 클라이언트 — 층 평면도 (`src/client/floor/`)

전부 순수 함수로 만들어서 vitest로 검증한다.

- `roster.ts`: `onDuty(session, now)`로 퇴근 여부를 판정하고, `hasReport(session, seen)`로 `!` 여부를 판정한다.
  - 퇴근 규칙: 프로세스 종료 → 퇴근. `attention`이 있거나 `active`면 → 근무. subagent는 `active`가 아니면 → 퇴근.
    마지막 활동 후 30분 → 퇴근.
  - `!` 규칙: subagent가 아니고 `idle`이며, `updatedAt`이 마지막으로 확인한 시각보다 새것이면 표시한다.
    확인 시각은 `localStorage`(`pixel.seenReports`)에 저장한다.
- `layout.ts`: `floorLayout(rooms, width)`로 방 사각형, 워크트리 줄, 좌석, 복도, 왼쪽 세로 통로(spine),
  입구, 회의실·탕비실 자리를 px 좌표로 계산한다. 방은 두 줄씩 짝을 지어 가운데 복도를 공유한다(band).
  열 개수는 컨테이너 너비로 정한다.
- `route.ts`: `route(from, to, layout)`는 경유점 목록을 돌려준다.
  좌석 → 방 문 → 복도 → (다른 band면 spine) → 대상 복도 → 대상 문 → 좌석 순서다.
- `choreography.ts`: `placements(workers, layout, clock)`로 동료마다 목적지를 정한다.
  같은 입력과 시각이면 같은 결과가 나오도록 결정적으로 만든다.
  1. `?` 또는 `!` → 자기 책상
  2. 앱 협업 작업의 리뷰 단계 → 구현자가 리뷰어 옆에 섬
  3. 같은 레포에서 `active`인 비-subagent가 2명 이상 → 90초 주기 중 일부 구간에 두 명이 회의실로 감
  4. 근무 중이고 한가한 동료 → 60초 주기 중 일부 구간에 탕비실로 감
  5. 나머지 → 자기 책상 (subagent는 부모 옆자리)
- `FloorMap.tsx` + `FloorWorker.tsx`: 동료는 버튼이고, 목적지가 바뀌면 경로를 따라 구간별 CSS transition으로 걷는다.
  첫 렌더에는 자리에 바로 앉힌다. 이후 새로 온 동료는 입구에서 출근하고, 퇴근한 동료는 입구까지 걸어간 뒤 사라진다.
  `prefers-reduced-motion`이면 바로 순간 이동한다.

`ProjectMap`은 머리말, 요약, 검색·필터를 그대로 두고, 카드 격자 자리에 `FloorMap`을 넣는다.
그 아래에 "오늘 퇴근한 동료" 목록(누르면 해당 세션 열기)과 기존 `RetiredSessions`를 둔다.
방 하나에 보이는 인원은 워크트리 줄 3개 × 4석으로 제한하고, 넘치면 `+N명`으로 표시한다.

레포 오피스의 `WalkingWorker`도 같은 `?`/`!` 표시를 쓴다.

## 테스트

- vitest: 워크트리·브랜치 해석과 삭제된 워크트리 처리, 부모 연결(Claude·Codex), `attention` 3종,
  `onDuty`/`hasReport`, 레이아웃에서 겹침 없음, 경로가 복도와 spine만 지나가는지, choreography의 결정성과 규칙 우선순위.
- e2e(`overview.spec.ts`): 기존 시나리오를 층 평면도에 맞게 바꾼다. 방·동료 aria 이름, 인원 상한과 `+N`, 페이지 가로 스크롤 없음,
  클릭하면 해당 세션 열기. 여기에 `?` 표시 픽스처, 퇴근(오래된 세션은 평면도에서 빠짐) 시나리오를 추가한다.

## 범위 밖

- canvas 렌더링, 동료 간 실제 메시지 표시
- Codex 프로세스 생존 감지(기록에 정보가 없음)
- 퇴근 기록의 서버 저장(관측 7일 창 안의 세션에서 매번 다시 계산한다)
