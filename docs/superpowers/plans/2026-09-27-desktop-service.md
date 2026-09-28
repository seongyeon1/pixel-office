# Desktop Service Implementation Plan

**Goal:** macOS에서 터미널 없이 Pixel Office를 실행하고 메뉴바 앱으로 접근한다.
**Architecture:** launchd가 기존 Node 서버를 관리하고 Electron이 연결 파일로 인증하여 기존 UI를 표시한다.
**Tech Stack:** TypeScript, Node 24+, launchd, Electron, Electron Packager, Vitest, Playwright.
**Spec:** `docs/superpowers/specs/2026-09-27-desktop-service-design.md`

## Global Constraints

- 기존 미커밋 변경·`.pixel` 데이터 보존. 현재 사용 중인 작업 폴더에서 별도 모듈을 추가한다.
- Node 서버와 Electron 런타임을 분리하여 node-pty ABI 변경을 피한다.
- 루프백 URL만 사용하고 연결 토큰은 로그·배포 파일에 넣지 않는다.
- 사용자의 진행 승인에 따라 구현 및 로컬 설치까지 수행한다. Git 커밋·푸시하지 않는다.

## Review Focus

- 공백 및 XML 특수 문자가 포함된 경로: plist와 프로세스 인수를 안전하게 전달.
- 오래된 연결 파일 및 서버 재시작: 인증 성공 후 연결, 새 토큰으로 UI 복구.
- 포트 충돌: 다른 프로세스를 종료하거나 재시작하지 않고 오류 표시.
- 창/앱 종료: 서버 및 진행 중 작업 유지.
- GUI의 최소 PATH: 설치 시 CLI 경로 및 사용자 지정 로그인 디렉터리 보존.

## Tasks

- [x] 1. `tests/desktop-service.test.ts`에서 plist, URL, readiness, 포트 충돌의 실패 테스트를 실행하고 `src/desktop/service.ts`, `service-cli.ts` 구현. `tsconfig.desktop.json`과 npm 명령을 연결.
- [x] 2. `src/desktop/main.ts`에 단일 인스턴스, 메뉴바, 숨김/재개, 연결 복구 구현. `scripts/package-desktop.mjs`에서 최소 앱 패키지 생성 및 로컬 설치. 데스크톱 수명주기 E2E 작성.
- [x] 3. 테스트·타입 검사·빌드·실제 launchd/Electron 검증 후 로컬 서비스와 앱 설치. README에 사용/중지/제거/제약 설명. 최종 변경 검토.

## Execution record

- 설계와 진행은 대화에서 승인됨. 현재 checkout의 다른 변경을 보존하기 위해 별도 worktree로 이동하지 않음.
- 구현은 이 세션에서 수행. 서비스 API가 데스크톱 앱과 CLI의 공통 인터페이스.
- 전체 단위 테스트 29 파일 / 140 테스트 통과. 타입 검사 및 프로덕션 빌드 통과.
- Electron E2E에서 창 닫기·재열기, 토큰 회전 재연결, 앱 종료 후 서버 유지 확인. 설치된 앱 바이너리로도 같은 시나리오 통과.
- 실제 서버의 활성 작업이 없는 상태에서 종료 후 launchd 복구 및 PID/토큰 변경 확인. 사용자 데이터는 보존.
- 실제 설치 앱의 오피스 화면, sandbox, 로그인 등록 상태(`enabled`, `openAtLogin: true`) 확인. 재부팅 자체와 OS 알림 배너 표시는 검증하지 않음.
- 독립 리뷰로 npm PATH 비교 및 로그인 시 명시적 서버 중지 존중 문제를 수정. 회귀 테스트 실패→통과 확인.
- 실제 앱 설치 검증으로 프레임워크 상대 링크 보존 문제를 찾아 수정. 설치 복사는 `verbatimSymlinks: true`; 재설치 시 앱 종료 완료를 기다린 뒤 교체.
- 검증 증거: `test-results/desktop/installed-office.png` (실제 로컬 세션 화면이므로 Git에 포함하지 않음).
