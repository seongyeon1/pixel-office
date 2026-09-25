# 부서(구역)로 층 나누기 — 설계

## 요청

harness, langconnect(Deepconnector), skt를 따로 관리하고 싶다. 방은 저장소별로 그대로 두고 층을 부서 구역으로 나눈다.

## 관찰

세 묶음 모두 git 저장소가 아니라 저장소들을 담은 **상위 폴더**다.

| 부서 | 폴더 | 안의 저장소(예) |
|---|---|---|
| harness | `~/Desktop/teddynote-lab/harness` | braincrew(my-harness), braincrew-skills, braincrew-wiki, public-portfolio |
| langconnect (Deepconnector) | `~/Desktop/teddynote-lab/project/langconnect` | langconnect-enterprise (워크트리 여러 개) |
| skt | `~/Desktop/teddynote-lab/project/skt` | doc-console(c-agent), zez-server, skt-brain-parser |

## 결정

- 부서 = 이름 + 폴더. 방의 루트가 폴더 안에 있으면 그 부서, 여러 부서에 걸리면 가장 깊은 폴더. 어디에도 없으면 **기타**.
- `departments(id, name, root)` 테이블과 `GET/POST/DELETE /api/departments`. 폴더는 절대 경로, 이름 1–40자.
- 층: 회의실·탕비실·기록실 밴드 다음에 부서 순서(이름순) → 기타. 부서가 바뀌면 새 밴드에서 시작한다.
  밴드 왼쪽 위에 부서 이름판, 밴드마다 옅은 바닥색. 방이 하나도 보이지 않는 부서는 층에 그리지 않는다.
- 전체 맵 검색 줄에 부서 선택. 맵 위 **부서 관리**에서 추가·삭제.
- 레포 오피스·자동 기록·하네스는 바뀌지 않는다.

## 테스트

- vitest: 가장 깊은 폴더 우선 배정·기타, 레이아웃에서 부서 경계마다 새 밴드·방 겹침 없음, 저장소·API 검증.
- e2e: 부서를 만들면 방이 그 구역으로 옮겨가고 부서 선택으로 거를 수 있다.
