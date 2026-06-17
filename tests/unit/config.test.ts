import { describe, expect, it } from 'vitest';
import { CONFIG_SPEC, COMMAND_SPEC, OPERATION_SPEC, EXAMPLES, formatEffectiveConfig, formatSettingsHelp, formatHelp } from '../../src/shared/config.js';

describe('config', () => {
  const expectedEnvNames = [
    'ORCH_REPO',
    'ORCH_STATE_ROOT',
    'ORCH_TASKS',
    'ORCH_WORKTREES',
    'ORCH_NO_WORKTREE',
    'ORCH_AGENT',
    'ORCH_MODEL',
    'ORCH_REASONING',
    'ORCH_AGENT_CMD',
    'ORCH_KEEP_ALIVE',
    'ORCH_INFINITE',
    'ORCH_IDLE_SLEEP_MS',
    'ORCH_PARALLEL',
    'ORCH_KEEP_CONVERGED',
    'ORCH_CONVERGE',
    'ORCH_MAX_FAILURES',
    'ORCH_AUTO_STASH',
    'ORCH_MERGE_LOCK_MS',
    'ORCH_VERIFY_CMD',
    'ORCH_HEARTBEAT_MS',
    'ORCH_PROGRESS_TIMEOUT',
    'ORCH_BENCHMARK_TIMEOUT',
    'ORCH_LOG_LEVEL',
    'ORCH_AGENT_LOG_RAW',
    'ORCH_AGENT_LOG_MAX_BYTES',
  ];

  it('lists all expected environment variables with complete metadata', () => {
    expect(CONFIG_SPEC.map(item => item.env)).toEqual(expectedEnvNames);

    const flags = CONFIG_SPEC.flatMap(item => item.flag ? [item.flag] : []);
    expect(new Set(flags).size).toBe(flags.length);

    for (const item of CONFIG_SPEC) {
      expect(item.group).not.toBe('');
      expect(item.env).not.toBe('');
      expect(item.def).not.toBe('');
      expect(item.desc).not.toBe('');
    }
  });

  it('renders every environment variable and group heading in help', () => {
    const help = formatSettingsHelp();

    for (const envName of expectedEnvNames) {
      expect(help).toContain(envName);
    }
    for (const group of [
      'Paths',
      'Coding agent',
      'Agent',
      'Run mode',
      'Convergence & merge',
      'Concurrency & timeouts',
      'Logging',
    ]) {
      expect(help).toContain(group);
    }
    expect(help).toContain('ORCH_MERGE_LOCK_MS');
    expect(help).toContain('ORCH_AGENT_CMD');
    expect(help).toContain('--reasoning <level>');
  });

  it('uses the generic placeholder for unknown string flags', () => {
    const extra = {
      group: 'Test',
      env: 'ORCH_TEST_UNKNOWN',
      flag: 'unknown',
      kind: 'string',
      def: 'unset',
      desc: 'test only',
    } as const;

    (CONFIG_SPEC as typeof CONFIG_SPEC & { push: (item: typeof extra) => number }).push(extra);
    try {
      expect(formatSettingsHelp()).toContain('--unknown <value>');
    } finally {
      (CONFIG_SPEC as typeof CONFIG_SPEC & { pop: () => unknown }).pop();
    }
  });

  it('renders default source when neither flag nor env is set', () => {
    expect(formatEffectiveConfig({}, {})).toContain('ORCH_AGENT (--agent) = pi   [default]');
  });

  it('renders env source when env is set', () => {
    expect(formatEffectiveConfig({}, { ORCH_AGENT: 'copilot' })).toContain('ORCH_AGENT (--agent) = copilot   [env]');
  });

  it('renders flag source when flag and env are set', () => {
    expect(formatEffectiveConfig({ agent: 'copilot' }, { ORCH_AGENT: 'pi' })).toContain(
      'ORCH_AGENT (--agent) = copilot   [flag]',
    );
  });

  it('renders boolean flags and env-only numbers', () => {
    const output = formatEffectiveConfig(
      { 'auto-stash': true },
      { ORCH_MERGE_LOCK_MS: '12345' },
    );

    expect(output).toContain('ORCH_AUTO_STASH (--auto-stash) = on   [flag]');
    expect(output).toContain('ORCH_MERGE_LOCK_MS = 12345   [env]');
  });
});

describe('formatHelp', () => {
  const defaults = {
    agent: 'pi', model: '', reasoning: '', parallel: 1, converge: 3,
    maxFailures: '5', autoStash: true, noWorktree: false, logLevel: 'normal',
  };

  it('embeds the passed version and the core sections', () => {
    const help = formatHelp('1.2.3', defaults);
    expect(help).toContain('Task Orchestrator v1.2.3');
    expect(help).toContain('USAGE');
    expect(help).toContain('COMMANDS');
    expect(help).toContain('OPERATIONS');
    expect(help).toContain('EXAMPLES');
    expect(help).toContain('Priority: --flag > ORCH_* env var > default.');
  });

  it('renders every command, operation, and example from the specs', () => {
    const help = formatHelp('0.0.0', defaults);
    for (const c of COMMAND_SPEC) expect(help).toContain(c.name);
    for (const o of OPERATION_SPEC) expect(help).toContain(o.name);
    for (const e of EXAMPLES) expect(help).toContain(e.cmd);
  });

  it('reuses formatSettingsHelp for the settings block', () => {
    expect(formatHelp('0.0.0', defaults)).toContain(formatSettingsHelp());
  });

  it('shows default placeholders for empty model/reasoning and on/off toggles', () => {
    const help = formatHelp('0.0.0', defaults);
    expect(help).toContain('model=(agent default)');
    expect(help).toContain('reasoning=(off)');
    expect(help).toContain('auto-stash=on');
    expect(help).toContain('no-worktree=off');
  });

  it('shows explicit values and flipped toggles when set', () => {
    const help = formatHelp('0.0.0', {
      ...defaults, model: 'gpt-5', reasoning: 'high', autoStash: false, noWorktree: true,
    });
    expect(help).toContain('model=gpt-5');
    expect(help).toContain('reasoning=high');
    expect(help).toContain('auto-stash=off');
    expect(help).toContain('no-worktree=on');
  });
});
