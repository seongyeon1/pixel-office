# 모델 계열별 동료 구분 — 설계

## 목적

같은 Claude·Codex라도 Fable·Opus·Sonnet·Haiku, Astra·Sol·Terra·Luna처럼 모델 계열에 따라 맡기는 일이
다르다. 지금은 공급자(Claude/Codex)만 보여서 어떤 동료가 어떤 모델인지 알 수 없다.

## 결정

| 항목 | 결정 |
|---|---|
| 표시 위치 | 맵·오피스 캐릭터의 계열 배지, 사이드바·오피스 동료 목록의 계열 그룹, 전체 맵의 모델 필터 |
| 계열 판별 | 모델 ID에서 계열 이름을 뽑는다 (`claude-opus-5-5` → Opus 5.5, `gpt-6-astra` → Astra) |
| 정렬 | 사용자가 지정한 표시 순서: Claude Fable → Opus → Sonnet → Haiku, Codex Astra → Sol → Terra → Luna, 모르는 계열은 뒤 |
| 설명 | 공급자 카탈로그(`/api/models/:provider`)의 설명을 툴팁에 쓴다. 카탈로그를 못 받아도 판별은 동작한다 |

첫 spec의 "모델 이름만으로 성능 순위를 단정하거나 자동 배치하지 않는다"는 그대로다. 이 순서는 목록을
보기 좋게 묶는 표시 순서일 뿐이고, 직급·권한·작업 배치를 바꾸지 않는다. 공급자 카탈로그 순서는
추천 모델을 맨 앞에 두는 순서라서(Claude는 Opus가 Fable보다 앞) 표시 순서로 쓰지 않는다.

## 구성

- `src/client/models/family.ts`: `modelFamily(provider, modelId)` → `{ key, label, version, provider, order }`.
  ID가 비어 있으면 `unknown`(“모델 정보 없음”), 앱 작업의 기본 모델은 `default`(“기본 모델”).
- `ProjectWorker.family`: 외부 세션은 `session.model`, 앱 작업은 `run.team[provider].model`로 채운다.
- `FloorWorker`: 이름표 아래 계열 배지(Claude 주황, Codex 청록). 툴팁에 전체 모델 이름과 카탈로그 설명.
- 사이드바 “함께 일하는 동료”: 공급자 버튼 아래에 계열별 인원 칩.
- 오피스 동료 목록: 계열별 소제목으로 묶고, 검색에 계열 이름을 포함한다.
- 전체 맵: 검색 줄에 모델 선택. 고르면 그 계열 동료만 방에 남고, 해당 계열이 없는 방은 숨긴다.

## 테스트

- vitest: 실제 관측된 ID(`claude-opus-5-5`, `claude-haiku-4-5-20251001`, `claude-fable-5-1`, `gpt-6-astra`,
  `gpt-5.6-sol`, `gpt-5.5`, 빈 값)의 계열·버전·정렬, 앱 작업 기본 모델, 맵 필터가 방·인원 수를 줄이는지.
- e2e: 계열 배지 텍스트, 모델 필터로 방이 줄어드는지, 오피스 목록의 계열 소제목.
