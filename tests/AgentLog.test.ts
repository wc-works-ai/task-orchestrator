import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { appendAgentLog, openAgentLog, runLogName } from '../src/AgentLog.js';

function setup(): string {
  const root = resolve('test-artifacts');
  mkdirSync(root, { recursive: true });
  return mkdtempSync(resolve(root, 'agent-log-'));
}

describe('AgentLog', () => {
  let dir = '';

  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it('appends text while under the byte limit', () => {
    dir = setup();
    const log = openAgentLog(join(dir, 'agent.log'), 64);

    appendAgentLog(log, 'hello');

    expect(readFileSync(log.path, 'utf-8')).toBe('hello');
    expect(log.bytes).toBe(5);
  });

  it('replaces the log with only the truncation marker when maxBytes is shorter than the marker', () => {
    dir = setup();
    const log = openAgentLog(join(dir, 'agent.log'), 8);

    appendAgentLog(log, 'x'.repeat(32));

    expect(readFileSync(log.path, 'utf-8')).toBe('\n=== age');
    expect(log.bytes).toBe(8);
  });

  it('runLogName builds a filesystem-safe per-run name (no colons)', () => {
    expect(runLogName(new Date(2026, 5, 12, 18, 33, 18, 7))).toBe('agent-20260612-183318-007.log');
  });

  it('runLogName defaults to the current time', () => {
    expect(runLogName()).toMatch(/^agent-\d{8}-\d{6}-\d{3}\.log$/);
  });

  it.each([
    { thrown: new Error('disk full'), message: 'disk full' },
    { thrown: 'disk offline', message: 'disk offline' },
  ])('logs initialization failures instead of swallowing them silently: $message', async ({ thrown, message }) => {
    vi.resetModules();
    const logSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    try {
      vi.doMock('node:fs', async (importOriginal) => {
        const actual = await importOriginal<typeof import('node:fs')>();
        return {
          ...actual,
          writeFileSync: vi.fn(() => {
            throw thrown;
          }),
        };
      });

      const { openAgentLog: mockedOpenAgentLog } = await import('../src/AgentLog.js');
      const path = join('missing', 'agent.log');
      const log = mockedOpenAgentLog(path, 64);

      expect(log).toEqual({ path, maxBytes: 64, bytes: 0 });
      expect(logSpy).toHaveBeenCalledWith(`[AgentLog] failed to initialize ${path}: ${message}`);
    } finally {
      vi.doUnmock('node:fs');
      vi.resetModules();
      logSpy.mockRestore();
    }
  });
});
