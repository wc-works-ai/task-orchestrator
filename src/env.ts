/** Centralized env var config: CLI flag > env var > default (lazy — reads process.env on access) */
function bool(value: string | undefined): boolean {
  return /^(1|true|yes|on)$/i.test(value ?? '');
}

export const env = {
  get tasksDir()     { return process.env.ORCH_TASKS || undefined; },
  get repoDir()      { return process.env.ORCH_REPO || undefined; },
  get stateRoot()    { return process.env.ORCH_STATE_ROOT || undefined; },
  get model()        { return process.env.ORCH_MODEL || undefined; },
  get autoStash()    { return bool(process.env.ORCH_AUTO_STASH); },
  get converge()     { return parseInt(process.env.ORCH_CONVERGE ?? '3', 10); },
  get maxFailures()  { return parseInt(process.env.ORCH_MAX_FAILURES ?? '5', 10); },
  get worktreesDir() { return process.env.ORCH_WORKTREES || undefined; },
  get heartbeatMs()       { return parseInt(process.env.ORCH_HEARTBEAT_MS ?? '300000', 10); },
  get progressTimeoutMs()  { return parseInt(process.env.ORCH_PROGRESS_TIMEOUT ?? '120000', 10); },
} as const;
