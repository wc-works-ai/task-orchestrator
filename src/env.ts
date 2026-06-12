/** Centralized env var config: CLI flag > env var > default (lazy — reads process.env on access) */
function bool(value: string | undefined): boolean {
  return /^(1|true|yes|on)$/i.test(value ?? '');
}

function maxFailures(value: string | undefined): number {
  const raw = (value ?? '5').trim();
  if (/^(infinite|unlimited|inf)$/i.test(raw)) return Infinity;
  if (!/^\d+$/.test(raw)) return 5;
  const n = Number(raw);
  return n >= 1 ? n : 5;
}

function logLevel(value: string | undefined): 'quiet' | 'normal' | 'verbose' {
  return value === 'quiet' || value === 'verbose' ? value : 'normal';
}

function ms(value: string | undefined, fallback: number): number {
  const n = parseInt(value ?? '', 10);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

export const env = {
  get tasksDir()     { return process.env.ORCH_TASKS || undefined; },
  get repoDir()      { return process.env.ORCH_REPO || undefined; },
  get stateRoot()    { return process.env.ORCH_STATE_ROOT || undefined; },
  get agent()        { return process.env.ORCH_AGENT || 'pi'; },
  get model()        { return process.env.ORCH_MODEL || undefined; },
  get reasoning()    { return process.env.ORCH_REASONING || undefined; },
  get autoStash()    { return bool(process.env.ORCH_AUTO_STASH); },
  get converge()     { return parseInt(process.env.ORCH_CONVERGE ?? '3', 10); },
  get maxFailures()  { return maxFailures(process.env.ORCH_MAX_FAILURES); },
  get worktreesDir() { return process.env.ORCH_WORKTREES || undefined; },
  get heartbeatMs()       { return parseInt(process.env.ORCH_HEARTBEAT_MS ?? '300000', 10); },
  get progressTimeoutMs()  { return parseInt(process.env.ORCH_PROGRESS_TIMEOUT ?? '120000', 10); },
  get agentLogMaxBytes()   { return parseInt(process.env.ORCH_AGENT_LOG_MAX_BYTES ?? '10485760', 10); },
  get agentLogRaw()        { return bool(process.env.ORCH_AGENT_LOG_RAW); },
  get logLevel()           { return logLevel(process.env.ORCH_LOG_LEVEL); },
  get keepAlive()          { return bool(process.env.ORCH_KEEP_ALIVE); },
  get infinite()           { return bool(process.env.ORCH_INFINITE); },
  get idleSleepMs()        { return ms(process.env.ORCH_IDLE_SLEEP_MS, 5000); },
  get claimMaxMs()         { return parseInt(process.env.ORCH_CLAIM_MAX_MS ?? '1800000', 10); },
  get mergeLockMs()        { return parseInt(process.env.ORCH_MERGE_LOCK_MS ?? '600000', 10); },
} as const;
