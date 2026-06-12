import { afterEach, describe, expect, it } from 'vitest';
import { env } from '../src/env.js';

describe('env', () => {
  const originalMaxFailures = process.env.ORCH_MAX_FAILURES;
  const originalKeepAlive = process.env.ORCH_KEEP_ALIVE;
  const originalIdleSleepMs = process.env.ORCH_IDLE_SLEEP_MS;

  afterEach(() => {
    if (originalMaxFailures === undefined) delete process.env.ORCH_MAX_FAILURES;
    else process.env.ORCH_MAX_FAILURES = originalMaxFailures;
    if (originalKeepAlive === undefined) delete process.env.ORCH_KEEP_ALIVE;
    else process.env.ORCH_KEEP_ALIVE = originalKeepAlive;
    if (originalIdleSleepMs === undefined) delete process.env.ORCH_IDLE_SLEEP_MS;
    else process.env.ORCH_IDLE_SLEEP_MS = originalIdleSleepMs;
  });

  it('defaults maxFailures to 5', () => {
    delete process.env.ORCH_MAX_FAILURES;
    expect(env.maxFailures).toBe(5);
  });

  it('parses infinite maxFailures', () => {
    process.env.ORCH_MAX_FAILURES = 'infinite';
    expect(env.maxFailures).toBe(Infinity);
  });

  it('parses keep-alive settings', () => {
    process.env.ORCH_KEEP_ALIVE = 'true';
    process.env.ORCH_IDLE_SLEEP_MS = '25';
    expect(env.keepAlive).toBe(true);
    expect(env.idleSleepMs).toBe(25);
  });
});
