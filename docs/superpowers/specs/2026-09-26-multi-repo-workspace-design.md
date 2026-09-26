# 여러 저장소를 넘나드는 작업 — 묶음 작업(multi-root workspace) 제안

상태: **1차 구현됨 (2026-09-26).** 제안의 1~5번을 그대로 넣었다. 열린 질문 중 1·2번은 아래처럼 일단 정했고, 3~6번은 그대로 열려 있다.

## 1차 구현에서 정한 것

- **어느 클론에서 딸 것인가(질문 1)**: 사용자가 고른다. 목록은 `origin` 이름 + 브랜치를 보이고, worktree는 기본으로 접어 둔다("worktree N개도 보기").
  각 저장소는 **현재 HEAD**에서 딴다(origin 기본 브랜치로 강제하지 않음). 같은 저장소의 GitHub·GitLab 원격은 폴더가 다르므로 그냥 둘 다 뜬다.
- **하네스 단위(질문 2)**: 고른 폴더(상위 폴더) 기준으로 저장한다. 저장소별 하네스는 묶음 작업에 적용되지 않는다.
- 탐색 깊이 2, `node_modules`·`.venv`·`dist`·`build`·숨김 폴더는 건너뛴다. `/api/projects`에서는 30초 캐시.
- 선택한 묶음은 브라우저 `localStorage`(`pixel.bundle.<폴더>`)에 폴더별로 기억한다. 부서 기본 묶음(서버 저장)은 아직 없다.
- 구현 파일: `projects.ts`(`listRepositories`, `createBundleWorkspace`, `collectRunChanges`), `orchestrator.ts`, `prompts.ts`, `transport.ts`, `App.tsx`(bundle-picker).

## 요청

`skt`처럼 git 저장소가 아니라 **저장소 여러 개를 담은 상위 폴더**에서 작업을 시작하고 싶다.
c-agent를 고치면서 zez-server의 API와 skt-brain-parser의 출력 형식을 같이 봐야 하는 일이 흔하다.
지금은 상위 폴더를 고르면 "Git 저장소를 선택해 주세요"로 막히고, 저장소 하나씩 따로 작업을 돌려야 한다.

## 관찰 (2026-09-26 로컬 기준)

`~/Desktop/teddynote-lab/project/skt` 안에는 저장소가 30여 개 있다. 같은 저장소의 clone과 worktree가 섞여 있고,
폴더 이름이 실체와 다른 경우도 있다.

| 폴더 | 실체 | 브랜치 |
|---|---|---|
| `c-agent/c-agent` + `c-agent/wt-*` 35개 | doc-console clone + worktree | 기능 브랜치 다수 |
| `skt-agent-template`, `skt-agent-template-wt-prune`, `zez-wt-*` | **zez-server** (GitLab) clone + worktree | fix/…, feat/… |
| `skt-brain-parser` + `skt-brain-parser-*` 5개 | skt-brain-parser (GitHub) | fix/ocr-repetition-tax 등 |
| `gitlab-skt-brain-parser`, `…-wt-single` | skt-brain-parser (GitLab, 별개 원격) | fix/… |
| `scz-sys`, `pii`, `sso`, `icms-console`, `medical_agent`, … | GitLab clone 각각 | main 또는 기능 브랜치 |

같은 구조가 `langconnect`(clone 1 + worktree 16)에도 있다. 즉 "부서 폴더 = 저장소 묶음"이 이 팀의 기본 배치다.

## 지금 구조에서 막히는 지점

- 앱 작업(run)은 **저장소 하나**에 묶인다. `createWorkspace`가 고른 저장소의 HEAD에서 worktree 하나를 따고,
  동료들의 cwd·변경 목록(`collectChanges`)·하네스(`store.getHarness(root)`)가 모두 그 하나를 기준으로 돈다.
- 부서(`departments`)와 방 합치기(`room_aliases`)는 **보이는 묶음**만 바꾼다. 작업 단위는 건드리지 않는다.
- 2026-09-26에 상위 폴더를 고르면 목록·칩·시작 버튼이 "Git 저장소 아님"을 보이도록 고쳤다. 막힘을 설명할 뿐 풀지는 않는다.

## 제안: 부서 단위 묶음 작업

VS Code의 multi-root workspace와 같은 모델. 부서·방 개념은 그대로 두고 **작업 단위만 저장소 집합으로 넓힌다.**

1. **고르기.** 부서 폴더(비 git)를 고르면 그 안의 저장소 목록이 뜨고, 이번 작업에 쓸 저장소를 체크한다.
   목록은 폴더 이름이 아니라 `origin` 저장소 이름 + 현재 브랜치를 보인다(`skt-agent-template · zez-server · fix/icms-unverified-ta`).
2. **따기.** `.pixel/workspaces/<runId>/<저장소이름>/`에 저장소마다 worktree를 하나씩 만든다(`pixel/<runId>` 브랜치, 각자의 HEAD 기준).
   동료들의 cwd는 `<runId>/` 상위 폴더. 세 저장소가 형제 폴더로 보인다.
3. **기록.** `Run`이 `repos: { root, worktreePath, branch, baseCommit }[]`를 갖는다. 변경 목록·검토·PR은 저장소별로 나눈다.
   단일 저장소 작업은 `repos` 길이 1인 특수 경우로 흡수한다.
4. **기억.** 자주 쓰는 조합은 부서에 **기본 묶음**으로 저장한다("skt 기본: c-agent + zez-server + skt-brain-parser").
   다음부터는 부서만 고르면 바로 시작.
5. **문구.** 부서 폴더에서는 "Git 저장소 아님" 대신 "안의 저장소를 골라 묶음으로 시작"을 보인다.

## 열린 질문 — 결정 전에 답할 것

1. **어느 클론에서 딸 것인가.** 한 저장소에 clone 1개와 worktree 여러 개가 있고, 대부분 기능 브랜치다.
   worktree HEAD에서 따면 옛 코드 위에서 작업하게 된다. 후보: (a) main 계열 브랜치를 가진 clone을 기본 추천,
   (b) 항상 `origin/<기본 브랜치>`에서 새로 딴다(로컬 HEAD 무시), (c) 사용자가 매번 고른다.
   같은 저장소가 GitHub·GitLab 두 원격에 따로 있는 경우(skt-brain-parser)는 원격까지 골라야 한다.
2. **하네스·스킬의 단위.** 지금은 저장소별(`repo_harness`). 묶음 작업에서 (a) 저장소마다 각자 적용, (b) 부서 공통 하네스 추가,
   (c) 묶음별 하네스. 동료 cwd가 상위 폴더라 저장소별 `.claude/`·`AGENTS.md`가 자동으로 안 읽히는 문제도 같이 봐야 한다.
3. **저장소 간 실행 검증.** c-agent가 zez-server API를 부르는 식의 의존이 있으면 코드만 나란히 있어서는 검증이 안 된다.
   첫 버전은 "코드는 같이 보고 고치되 실행 검증은 저장소별"로 한정할지, docker-compose 같은 부서 실행 설정을 둘지.
4. **PR과 완료 조건.** 저장소 두 개에 걸친 변경은 PR이 둘이다. 하나만 머지되면 어떻게 표시할지, 작업 "완료"는 언제인지.
5. **관측 세션과의 관계.** 터미널에서 직접 연 Claude 세션은 저장소 하나의 cwd를 갖는다. 묶음 작업의 동료를 오피스 층에서
   어느 방에 앉힐지(저장소마다 분신? 부서 구역에 별도 자리?).
6. **범위.** 묶음 최대 개수, worktree 디스크 사용(langconnect worktree 하나가 1.6GB), 작업 끝난 뒤 정리 시점.

## 지금 당장의 우회

- 한 저장소 안에서 끝나는 일은 그 저장소 폴더를 고른다. `c-agent/c-agent`, `skt-agent-template`(zez-server), `skt-brain-parser`는 이미 목록에 있다.
- 두 저장소를 같이 고쳐야 하면 작업을 저장소별로 두 번 돌린다.
- 새 작업의 기준 커밋을 최신 main으로 하려면 먼저 clone에서 worktree를 딴다:
  `git worktree add ../<이름> -b feat/<이름> origin/main` 후 프로젝트 연결.

## 테스트 (구현 시)

- vitest: 여러 저장소 worktree 생성·정리, 저장소별 `collectChanges`, `Run.repos` 길이 1 하위 호환, 부서 기본 묶음 저장·조회,
  같은 원격 저장소의 clone/worktree 중 기본 후보 선정.
- e2e: 부서 폴더를 고르면 저장소 체크 목록이 뜨고, 두 개를 골라 시작하면 변경 목록이 저장소별로 나뉜다.
