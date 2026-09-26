// Variables Claude Code sets for the processes it starts. A server launched from inside a Claude
// Code session inherits them, and every CLI it spawns then believes it is that session's child: it
// writes no transcript of its own, so resumed and forked sessions vanish from observation.
// User settings that share the prefix (CLAUDE_CODE_USE_BEDROCK, CLAUDE_CONFIG_DIR, …) are kept.
const SESSION_SCOPED = [
  'CLAUDECODE',
  'CLAUDE_PID',
  'CLAUDE_CODE_SESSION_ID',
  'CLAUDE_CODE_CHILD_SESSION',
  'CLAUDE_CODE_ENTRYPOINT',
  'CLAUDE_CODE_SESSION_ATTENDED',
  'CLAUDE_CODE_MESSAGING_SOCKET',
  'CLAUDE_CODE_MESSAGING_TOKEN',
  'CLAUDE_CODE_EXECPATH',
  'CLAUDE_AGENT_SDK_VERSION',
];
export function withoutParentSession(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const clean = { ...env };
  for (const key of SESSION_SCOPED) delete clean[key];
  return clean;
}
// Applied once at start-up so the SDK, Codex and terminals all start from a clean environment.
export function dropParentSession(env: NodeJS.ProcessEnv = process.env) {
  for (const key of SESSION_SCOPED) delete env[key];
}
