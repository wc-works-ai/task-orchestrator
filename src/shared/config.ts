export interface ConfigItem {
  readonly group: string;
  readonly env: string;
  readonly flag?: string;
  readonly kind: 'string' | 'boolean' | 'number';
  readonly def: string;
  readonly desc: string;
}

export const CONFIG_SPEC: readonly ConfigItem[] = [
  { group: 'Paths', env: 'ORCH_REPO', flag: 'repo', kind: 'string', def: 'current directory', desc: 'Target repo/folder' },
  { group: 'Paths', env: 'ORCH_STATE_ROOT', flag: 'state-root', kind: 'string', def: '<home>/task-orchestrator', desc: 'Orchestrator state root' },
  { group: 'Paths', env: 'ORCH_TASKS', flag: 'tasks', kind: 'string', def: '<state-root>/<repo-slug>/tasks', desc: 'Task directory' },
  { group: 'Paths', env: 'ORCH_WORKTREES', flag: 'worktrees', kind: 'string', def: '<state-root>/<repo-slug>/worktrees', desc: 'Worktree directory' },
  { group: 'Run mode', env: 'ORCH_NO_WORKTREE', flag: 'no-worktree', kind: 'boolean', def: 'off', desc: 'Skip worktree/git — agent works directly in main repo' },
  { group: 'Coding agent', env: 'ORCH_AGENT', flag: 'agent', kind: 'string', def: 'pi', desc: 'Coding agent: pi or copilot' },
  { group: 'Coding agent', env: 'ORCH_MODEL', flag: 'model', kind: 'string', def: 'agent default', desc: 'Model override passed to the agent' },
  { group: 'Coding agent', env: 'ORCH_REASONING', flag: 'reasoning', kind: 'string', def: 'unset', desc: 'Reasoning effort for supported agents' },
  { group: 'Agent', env: 'ORCH_AGENT_CMD', kind: 'string', def: 'unset', desc: 'Command run as the agent when ORCH_AGENT=exec' },
  { group: 'Run mode', env: 'ORCH_KEEP_ALIVE', flag: 'keep-alive', kind: 'boolean', def: 'off', desc: 'Wait through transient idle/cooldown periods' },
  { group: 'Run mode', env: 'ORCH_INFINITE', flag: 'infinite', kind: 'boolean', def: 'off', desc: 'Daemon mode; wait for new/addressed tasks (alias: --loop)' },
  { group: 'Run mode', env: 'ORCH_IDLE_SLEEP_MS', kind: 'number', def: '5000', desc: 'Idle poll interval for keep-alive/infinite (ms)' },
  { group: 'Run mode', env: 'ORCH_PARALLEL', flag: 'parallel', kind: 'number', def: '1', desc: 'Max concurrent tasks (0=unlimited, 1-100 clamps to 100, default: serial)' },
  { group: 'Run mode', env: 'ORCH_KEEP_CONVERGED', flag: 'keep-converged', kind: 'number', def: '100', desc: 'Max converged task dirs to keep (0 = unlimited); older ones are archived to converged/.archive.jsonl' },
  { group: 'Convergence & merge', env: 'ORCH_CONVERGE', kind: 'number', def: '3', desc: 'Zero-metric runs required to converge' },
  { group: 'Convergence & merge', env: 'ORCH_MAX_FAILURES', kind: 'number', def: '5', desc: 'Failed attempts before BLOCKED (int>=1 or infinite)' },
  { group: 'Convergence & merge', env: 'ORCH_AUTO_STASH', flag: 'auto-stash', kind: 'boolean', def: 'on', desc: 'Stash parent repo changes before merging (disable with ORCH_AUTO_STASH=false)' },
  { group: 'Convergence & merge', env: 'ORCH_MERGE_LOCK_MS', kind: 'number', def: '600000', desc: 'Break a merge lock held longer than this (crashed merger, ms)' },
  { group: 'Convergence & merge', env: 'ORCH_VERIFY_CMD', kind: 'string', def: 'unset', desc: 'Shell command to run in worktree before merge (e.g. npm run tc)' },
  { group: 'Concurrency & timeouts', env: 'ORCH_HEARTBEAT_MS', kind: 'number', def: '300000', desc: 'Reclaim a claim whose heartbeat is older than this (crashed worker, ms)' },
  { group: 'Concurrency & timeouts', env: 'ORCH_PROGRESS_TIMEOUT', kind: 'number', def: '120000', desc: 'Kill agent after no output for this long (ms)' },
  { group: 'Concurrency & timeouts', env: 'ORCH_BENCHMARK_TIMEOUT', kind: 'number', def: '120000', desc: 'Kill a task benchmark.js run after this long (ms); raise it for benchmarks that run the full test suite' },
  { group: 'Logging', env: 'ORCH_LOG_LEVEL', kind: 'string', def: 'normal', desc: 'Console verbosity: quiet | normal | verbose' },
  { group: 'Logging', env: 'ORCH_AGENT_LOG_RAW', kind: 'boolean', def: 'off', desc: 'Write raw spawned-agent output to agent.log' },
  { group: 'Logging', env: 'ORCH_AGENT_LOG_MAX_BYTES', kind: 'number', def: '10485760', desc: 'Max agent.log size before truncation (bytes)' },
] as const;

function flagText(item: ConfigItem): string {
  if (!item.flag) return '';
  if (item.kind === 'boolean') return `--${item.flag}`;
  return `--${item.flag} ${placeholder(item.flag)}`;
}

function placeholder(flag: string): string {
  if (flag === 'repo' || flag === 'state-root' || flag === 'tasks' || flag === 'worktrees') return '<dir>';
  if (flag === 'agent') return '<name>';
  if (flag === 'model') return '<model>';
  if (flag === 'reasoning') return '<level>';
  if (flag === 'parallel') return '<count>';
  /* v8 ignore next */
  return '<value>';
}

export function formatSettingsHelp(): string {
  const lines: string[] = ['Settings:'];
  let group = '';

  for (const item of CONFIG_SPEC) {
    if (item.group !== group) {
      group = item.group;
      lines.push('', `${group}:`);
    }

    const setting = (flagText(item) || '(env only)').padEnd(24);
    const env = item.env.padEnd(28);
    lines.push(`  ${setting}${env}${item.desc} (default: ${item.def})`);
  }

  return lines.join('\n');
}

function hasFlagValue(value: unknown): boolean {
  return value === true || (typeof value === 'string' && value !== '');
}

export function formatEffectiveConfig(values: Record<string, unknown>, environ: NodeJS.ProcessEnv): string {
  const lines: string[] = ['Configuration (CLI flag > env var > default)'];
  let group = '';

  for (const item of CONFIG_SPEC) {
    if (item.group !== group) {
      group = item.group;
      lines.push('', `${group}:`);
    }

    const flagValue = item.flag ? values[item.flag] : undefined;
    const envValue = environ[item.env];
    let value = item.def;
    let source = 'default';

    if (hasFlagValue(flagValue)) {
      value = flagValue === true ? 'on' : String(flagValue);
      source = 'flag';
    } else if (envValue !== undefined && envValue !== '') {
      value = envValue;
      source = 'env';
    }

    const name = item.flag ? `${item.env} (--${item.flag})` : item.env;
    lines.push(`${name} = ${value}   [${source}]`);
  }

  return lines.join('\n');
}
