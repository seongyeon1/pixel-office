# Session activity and chat implementation plan

> **For agentic workers:** Use superpowers:executing-plans to implement task-by-task. Existing user authorization covers implementation and publishing.

**Goal:** Per-session characters, readable work history, persistent record-based Q&A and speech bubbles.

**Architecture:** An authenticated chat service snapshots one observed session and its own conversation. Native Claude/Codex responders run separately with restricted tools. The client polls persisted replies and displays a compact office, task list and tabbed inspector.

**Tech Stack:** Node >=24, React, Fastify, SQLite, installed Claude SDK / Codex app-server. No new dependencies.

**Spec:** `docs/superpowers/specs/2026-09-25-session-chat.md`

## Global Constraints

- Node >=24. No new dependencies.
- Existing session processes and working trees remain unchanged.
- All answers carry the record-based label; live control is unavailable in current adapters.
- Chat context and history are scoped to one observed ID.

## Review Focus

- Session switching while a reply arrives must never show another session's answer.
- Concurrent submissions must not start duplicate generations.
- Cancellation, timeout and restart must settle pending messages.
- CLI failure must appear as an error, never a fabricated answer.
- Long content and mobile widths must preserve readable controls.

### Task 1: Persistent chat and native responders

Files: `src/shared/contracts.ts`, `src/server/store.ts`, `src/server/chat.ts`, `src/server/adapters/chat.ts`, `src/server/transport.ts`, `src/server/index.ts`, `tests/chat.test.ts`.

Interface: `createChatService({store,getSession,respond,timeoutMs?})` exposes `ask(id,question)`, `list(id)`, `cancel(id)`, `close()`. Responder receives bounded prompt, provider and AbortSignal and emits replacement response text. Messages persist by session ID with pending/completed/failed/cancelled status.

- [x] Write and run failing tests for session isolation, duplicate submission, persisted restart recovery, cancellation, failure and timeout. Example: `expect(() => service.ask('one','again')).toThrow()` while first request is pending; `expect(service.list('two')).toEqual([])`.
- [x] Implement SQLite chat storage, context limits, lifecycle and restricted native responders. POST `/api/observed/:id/chat` returns accepted messages; GET returns history and capability; POST `/cancel` cancels only Q&A.
- [x] Run `npx vitest run tests/chat.test.ts` and `npm run typecheck`; verify native responders with synthetic facts for each provider.

### Task 2: Readable session office and chat

Files: `src/client/components/ObservedOffice.tsx`, `src/client/components/SessionChat.tsx`, `src/client/office/SessionOffice.tsx`, `src/client/styles.css`, `e2e/server.ts`, `e2e/office.spec.ts`.

Interface: chat panel accepts one `ObservedSession` and reports its latest assistant reply to the matching avatar. Key panel state by session ID; ignore late responses after unmount. Scene displays at most eight selectable avatars at once with paging; list remains searchable.

- [x] Add failing E2E expectations for per-session avatars, tabs, question / answer bubble, persistent reload and isolation when switching agents.
- [x] Implement compact pixel desk grid, selected task summary, searchable list, readable timeline with raw tool details collapsed, chat status and composer.
- [x] Run `npm run build && npm run test:e2e`; inspect desktop / mobile browser output.

### Task 3: Ship

Files: `README.md`, `docs/external-sessions.md`, `docs/verification.md`.

- [x] Record exact capabilities and native smoke evidence; run `npm test`, `npm run typecheck`, `npm run build`, `npm run test:e2e`.
- [x] Review changes, resolve important findings, commit and push `HEAD:main` to the user-authorized repository.
- [x] Restart only the owned Pixel server after confirming no managed run is active; open and finalize browser deliverable.
