import { afterEach, describe, expect, it } from 'vitest';
import { env } from '../src/env.js';

describe('env', () => {
  const originalMaxFailures = process.env.ORCH_MAX_FAILURES;
  const originalKeepAlive = process.env.ORCH_KEEP_ALIVE;
  const originalInfinite = process.env.ORCH_INFINITE;
  const originalIdleSleepMs = process.env.ORCH_IDLE_SLEEP_MS;
  const originalAgent = process.env.ORCH_AGENT;
  const originalReasoning = process.env.ORCH_REASONING;
  const originalClaimMaxMs = process.env.ORCH_CLAIM_MAX_MS;
  const originalKeepConverged = process.env.ORCH_KEEP_CONVERGED;

  afterEach(() => {
    if (originalMaxFailures === undefined) delete process.env.ORCH_MAX_FAILURES;
    else process.env.ORCH_MAX_FAILURES = originalMaxFailures;
    if (originalKeepAlive === undefined) delete process.env.ORCH_KEEP_ALIVE;
    else process.env.ORCH_KEEP_ALIVE = originalKeepAlive;
    if (originalInfinite === undefined) delete process.env.ORCH_INFINITE;
    else process.env.ORCH_INFINITE = originalInfinite;
    if (originalIdleSleepMs === undefined) delete process.env.ORCH_IDLE_SLEEP_MS;
    else process.env.ORCH_IDLE_SLEEP_MS = originalIdleSleepMs;
    if (originalAgent === undefined) delete process.env.ORCH_AGENT;
    else process.env.ORCH_AGENT = originalAgent;
    if (originalReasoning === undefined) delete process.env.ORCH_REASONING;
    else process.env.ORCH_REASONING = originalReasoning;
    if (originalClaimMaxMs === undefined) delete process.env.ORCH_CLAIM_MAX_MS;
    else process.env.ORCH_CLAIM_MAX_MS = originalClaimMaxMs;
    if (originalKeepConverged === undefined) delete process.env.ORCH_KEEP_CONVERGED;
    else process.env.ORCH_KEEP_CONVERGED = originalKeepConverged;
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

  it('defaults infinite to false and reads override', () => {
    delete process.env.ORCH_INFINITE;
    expect(env.infinite).toBe(false);
    process.env.ORCH_INFINITE = 'on';
    expect(env.infinite).toBe(true);
  });

  it('defaults agent to pi and reasoning to undefined', () => {
    delete process.env.ORCH_AGENT;
    delete process.env.ORCH_REASONING;
    expect(env.agent).toBe('pi');
    expect(env.reasoning).toBeUndefined();
  });

  it('reads agent and reasoning overrides', () => {
    process.env.ORCH_AGENT = 'copilot';
    process.env.ORCH_REASONING = 'high';
    expect(env.agent).toBe('copilot');
    expect(env.reasoning).toBe('high');
  });

  it('defaults claimMaxMs to 1800000 (30 min) and reads override', () => {
    delete process.env.ORCH_CLAIM_MAX_MS;
    expect(env.claimMaxMs).toBe(1800000);
    process.env.ORCH_CLAIM_MAX_MS = '60000';
    expect(env.claimMaxMs).toBe(60000);
  });

  it('defaults keepConverged to 100 and reads override', () => {
    delete process.env.ORCH_KEEP_CONVERGED;
    expect(env.keepConverged).toBe(100);
    process.env.ORCH_KEEP_CONVERGED = '0';
    expect(env.keepConverged).toBe(0);
    process.env.ORCH_KEEP_CONVERGED = '50';
    expect(env.keepConverged).toBe(50);
  });
});
