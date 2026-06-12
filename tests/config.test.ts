import { describe, expect, it } from 'vitest';
import { CONFIG_SPEC, formatEffectiveConfig, formatSettingsHelp } from '../src/config.js';

describe('config', () => {
  const expectedEnvNames = [
    'ORCH_REPO',
    'ORCH_STATE_ROOT',
    'ORCH_TASKS',
    'ORCH_WORKTREES',
    'ORCH_AGENT',
    'ORCH_MODEL',
    'ORCH_REASONING',
    'ORCH_KEEP_ALIVE',
    'ORCH_INFINITE',
    'ORCH_IDLE_SLEEP_MS',
    'ORCH_CONVERGE',
    'ORCH_MAX_FAILURES',
    'ORCH_AUTO_STASH',
    'ORCH_MERGE_LOCK_MS',
    'ORCH_VERIFY_CMD',
    'ORCH_HEARTBEAT_MS',
    'ORCH_CLAIM_MAX_MS',
    'ORCH_PROGRESS_TIMEOUT',
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
      'Run mode',
      'Convergence & merge',
      'Concurrency & timeouts',
      'Logging',
    ]) {
      expect(help).toContain(group);
    }
    expect(help).toContain('ORCH_CLAIM_MAX_MS');
    expect(help).toContain('ORCH_MERGE_LOCK_MS');
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
