/** Centralized env var config: CLI flag > env var > default (lazy — reads process.env on access) */
export const env = {
  get tasksDir()     { return process.env.ORCH_TASKS ?? './tasks'; },
  get repoDir()      { return process.env.ORCH_REPO ?? ''; },
  get model()        { return process.env.ORCH_MODEL ?? 'openrouter/owl-alpha'; },
  get converge()     { return parseInt(process.env.ORCH_CONVERGE ?? '3', 10); },
  get maxFailures()  { return parseInt(process.env.ORCH_MAX_FAILURES ?? '5', 10); },
  get worktreesDir() { return process.env.ORCH_WORKTREES ?? ''; },
  get heartbeatMs()  { return parseInt(process.env.ORCH_HEARTBEAT_MS ?? '300000', 10); },
} as const;
