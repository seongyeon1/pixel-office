# Terminal workbench

Continue the user's authorized usability work. Default to native interactive Claude/Codex terminals; retain the existing office and managed team flow as an explicit mode. Use the existing React, xterm, PTY, launcher and resume APIs.

- [x] Allow an empty first prompt: launch the CLI without manufacturing an instruction. Preserve literal argument quoting and request idempotency.
- [x] Add a compact native launch variant to AgentLauncher. One click opens Claude or Codex in the selected project; harness/model/initial task are optional settings.
- [x] Add persistent project session tabs, actual two-terminal split, session list, focus and keyboard navigation. Closing tabs hides sessions; stopping terminals is explicit. Restore existing PTYs across reloads without POSTing another launch.
- [x] Expose terminal/team modes, make terminal the default, and shrink navigation in terminal mode. Keep existing managed flows and file tools available.
- [x] Verify empty launch arguments, real PTY input isolation, split/tab/reload/hide behavior, responsive geometry, error recovery and legacy team journeys. Use disposable E2E fixtures rather than real provider calls. Capture desktop/mobile screens, then run typecheck/build/unit and E2E suites.

Review focus: original externally running sessions must not be resumed automatically; launch retries must not create duplicates; hidden terminals must not steal focus; project switching must not mix sessions; CLI Ctrl+C, Escape, slash commands and Enter remain native.
