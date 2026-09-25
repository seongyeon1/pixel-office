# 레포별 하네스(플러그인·스킬) 설정 — 설계

## 목적

앱이 레포에서 에이전트를 실행할 때 쓸 플러그인과 스킬을 레포마다 화면에서 고른다.
지금은 두 공급자가 서로 다르게 동작한다. Claude 앱 작업은 완전히 격리돼 있고(`settingSources: []`),
Codex 앱 작업은 사용자 `config.toml`의 스킬 117개·플러그인·훅·AGENTS.md를 전부 불러온다.

## 결정

| 항목 | 결정 |
|---|---|
| 적용 대상 | 앱 작업(구현·리뷰)만. 기록 기반 답변 대화는 계속 전부 끄고, 세션 이어가기 터미널은 CLI 기본 동작 그대로 |
| 선택 단위 | 공급자별로 플러그인(통째로) + 사용자 스킬(개별) + 프로젝트 문서(CLAUDE.md / AGENTS.md) 토글 |
| 기본값 | 아무것도 선택하지 않은 격리 실행. **Codex 앱 작업은 이 변경으로 사용자 설정을 더 이상 자동으로 불러오지 않는다** |
| 훅 | 앱 작업에서는 항상 끈다. 개인 훅(예: 커밋 게이트)이 무인 실행을 막지 않게 한다 |
| 플러그인 MCP | Claude는 `skipMcpDiscovery`로 플러그인의 MCP 서버를 띄우지 않는다. Codex의 MCP·앱 설정은 이 변경에서 건드리지 않는다 |
| 기록 | 실행을 만들 때 그 레포의 하네스 설정을 실행 기록(`run.harness`)에 복사한다. 진행 중에 설정을 바꿔도 해당 실행에는 영향이 없다 |

## 검증한 사실 (spike)

- Claude SDK: `settingSources: []`에서 `plugins: [{ type: 'local', path }]`로 넘긴 플러그인의 스킬이 로드된다.
  사용자 스킬은 격리 상태에서 로드되지 않지만, 스킬 폴더를 `skills/` 아래에 둔 래퍼 플러그인으로 넘기면
  `<플러그인>:<스킬>`로 로드된다. 플러그인 **내부의** 개별 스킬을 거르는 `skills` 옵션은 검증하지 못해서 쓰지 않는다.
- Codex app-server: `thread/start`의 `config.skills.config = [{ name, enabled: false }]`로 스레드 단위로 스킬을 끌 수 있다
  (실제 턴에서 `bc-arxiv`가 목록에서 빠짐). `skills/config/write`는 사용자 `config.toml`을 고치므로 쓰지 않는다.

## 서버

- `contracts.ts`: `HarnessChoice { plugins: string[]; skills: string[]; projectDoc: boolean }`,
  `RepoHarness = Record<Provider, HarnessChoice>`, `HarnessCatalog`(공급자별 `plugins`·`skills` 항목과 오류).
  `PhaseInput.harness?`, `Run.harness?`.
- `store.ts`: `repo_harness(root, data)` 테이블. 읽기·쓰기.
- `harness.ts`:
  - 카탈로그: Claude는 `~/.claude/plugins/installed_plugins.json`과 `~/.claude/skills/*/SKILL.md`를 읽고,
    Codex는 app-server의 `config/read`(플러그인 키)와 `skills/list`(`pluginId`가 없는 사용자 스킬)를 쓴다.
  - Claude 적용: 선택한 플러그인을 **훅을 뺀 미러 폴더**로 넘긴다. `hooks/`·`.mcp.json`·`.lsp.json`은 링크하지 않고
    `plugin.json`에서 `hooks`·`mcpServers`·`lspServers`를 지우고, 나머지(skills, agents, commands 등)는 원본에 링크한다.
    이름은 그대로라 `superpowers:brainstorming` 같은 스킬 이름이 유지된다(spike로 확인). 선택한 사용자 스킬은
    `repo-skills` 래퍼 플러그인으로 넘긴다. 둘 다 `<dataDir>/harness/<레포 해시>/claude/`에 실행마다 다시 만든다.
    `settings.disableAllHooks`는 쓰지 않는다. 앱의 파일 경계 검사와 Bash 확인이 SDK 훅이라, 그 설정이 이것까지
    끄는지 모델 호출 없이 검증할 수 없기 때문이다. 훅을 아예 싣지 않는 쪽이 파일로 검증 가능하다.
    프로젝트 문서를 켜면 작업 폴더의 CLAUDE.md(최대 20KB)를 프롬프트 앞에 붙인다. `settingSources: ['project']`는
    권한 규칙까지 함께 불러오기 때문에 쓰지 않는다.
  - Codex 적용: 순수 함수 `codexHarnessConfig(choice, installedPlugins, skills)` →
    선택하지 않은 플러그인 `enabled: false`, 선택하지 않은 사용자 스킬 `skills.config` 비활성,
    `features.hooks: false`, 프로젝트 문서를 끄면 `project_doc_max_bytes: 0`.
- API: `GET /api/harness/catalog`, `GET /api/harness?root=`, `POST /api/harness { root, harness }` (zod 검증, 기존 인증·Origin 규칙).

## 화면

상단 바의 “코드 · 터미널” 옆에 **하네스** 버튼(레포 선택 시). 누르면 모달이 열린다.
Claude/Codex 탭, 플러그인·사용자 스킬 체크 목록(이름·설명·검색), 프로젝트 문서 토글,
“훅은 앱 작업에서 항상 꺼져요 · 기록 답변과 이어가기 터미널에는 적용되지 않아요” 안내, 저장.

## 테스트

- vitest: 설정 저장·기본값, Claude 래퍼 플러그인 구성(선택한 스킬만 연결, 다시 만들 때 남은 링크 제거),
  `codexHarnessConfig`의 비활성 목록·훅·프로젝트 문서, 오케스트레이터가 실행 기록에 설정을 복사하고 어댑터에 넘기는지,
  API 검증·인증.
- e2e: 하네스 모달에서 선택 → 저장 → 새로고침 뒤 유지, 다른 레포와 분리.
