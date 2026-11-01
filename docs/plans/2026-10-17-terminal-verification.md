# Terminal workbench verification

Candidate: `7e0e126` plus the current uncommitted workbench changes, 2026-10-17. Quick local verification; non-authoritative for merge/release. Existing office changes from the preceding iteration are retained.

Environment: macOS, installed project dependencies, Vite production client, disposable Fastify/SQLite E2E server. Desktop Chromium 1440×1000/DPR1 and mobile Chromium iPhone 13 390×664/DPR3. CLI commands are fixture shells using real PTYs and WebSockets; no paid provider invocation. The normal port 4317 service is separate from the port 4318 fixture.

## Scenarios

- New native-mode entry connects a project and starts an interactive CLI without requiring or fabricating a first instruction.
- Native Enter reaches the selected PTY; two split terminals receive independent input. Tabs retain terminal content, and reload reconnects to existing processes without another launch POST.
- Tab hiding keeps the process available in the session list; explicit terminal termination closes it. Native mode contains no second chat composer.
- Lost launch responses can be retried with the same request ID; delayed list responses do not discard the accepted new session.
- Three open sessions preserve the visible split pair when either pane receives focus.
- Delayed accepted launches preserve a newly selected file workspace both within native mode and after leaving native mode.
- Managed team work remains available via the mode switch. Opening managed work history returns to the team output and follow-up flow.
- Legacy approval/question, launch harness/model/folder, external session resume, document/file, worktree, project map, quota and team journeys remain in the full E2E suite. The legacy suite explicitly selects the saved team-mode preference; native scenarios use the default empty browser profile.

## Evidence and limits

Screenshots: `docs/images/terminal-start-desktop.png`, `terminal-start-mobile.png`, `terminal-workbench-desktop.png`, `terminal-workbench-mobile.png`. These cover native entry and two-terminal split states; the remaining transitions are checked by E2E assertions rather than a complete screenshot sequence. No full accessibility audit or real-provider interactive smoke is claimed. Local tabs and harness/model preferences survive browser reload; PTYs do not survive a server restart. Promptless Codex launches use no tracking prompt; the terminal is directly accessible while log-to-launch correlation depends on the available provider session metadata.

## Results

- `npm run build`: passed (client/server/desktop).
- `npm run typecheck`: passed.
- `npm test`: 192 passed across 33 files.
- `npx playwright test --reporter=line --max-failures=3`: 86 passed in 8.5 minutes (43 desktop, 43 mobile), including all 10 native terminal cases.
- Prettier and `git diff --check`: passed.
- Independent read-only review found split-focus, delayed-list, run-history routing and delayed-launch navigation defects. They were reproduced where applicable, fixed and covered by the final suite.
- Generated legacy tracked screenshots were restored; the four new native screenshots remain as evidence. No user-owned untracked files were removed.

The full run's final build and source were frozen throughout verification. Earlier red regression runs and an interrupted pre-final suite are not completion evidence.

## Local application

After the complete suite passed, the installed service was authenticated and confirmed to have no active managed run and no child terminal/provider process. It was restarted using the existing service configuration. Readiness returned with a new process ID, and the HTTP client document matched the verified `dist/client/index.html` exactly. No real provider was launched.
