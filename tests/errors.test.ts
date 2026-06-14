import { describe, it, expect, vi } from 'vitest';
import {
  Severity,
  OrchestratorError,
  DbCorruptError,
  DbBusyError,
  DbInitError,
  handleOrchestratorError,
  withRetry,
} from '../src/errors.js';

function fakeLogger() {
  return { warn: vi.fn(), error: vi.fn() };
}

// WARN production classes arrive in later todos; a fixture exercises the branch.
class SampleWarn extends OrchestratorError {
  readonly severity = Severity.WARN;
  readonly action = 'skip and continue';
}

describe('OrchestratorError', () => {
  it('captures message, severity, action, taskId, and the subclass name', () => {
    const e = new DbCorruptError('db is corrupt', 7);
    expect(e).toBeInstanceOf(Error);
    expect(e.message).toBe('db is corrupt');
    expect(e.name).toBe('DbCorruptError');
    expect(e.severity).toBe(Severity.FATAL);
    expect(e.action).toContain('state.db');
    expect(e.taskId).toBe(7);
  });

  it('leaves taskId undefined when not provided', () => {
    const e = new DbBusyError('locked');
    expect(e.taskId).toBeUndefined();
    expect(e.severity).toBe(Severity.FATAL);
  });

  it('DbInitError is fatal with an actionable hint', () => {
    const e = new DbInitError('no WAL');
    expect(e.severity).toBe(Severity.FATAL);
    expect(e.action).toContain('WAL');
    expect(e.name).toBe('DbInitError');
  });
});

describe('handleOrchestratorError', () => {
  it('stops the loop and logs an error on FATAL', () => {
    const log = fakeLogger();
    expect(handleOrchestratorError(new DbCorruptError('x'), log)).toBe('stop');
    expect(log.error).toHaveBeenCalledOnce();
    expect(log.warn).not.toHaveBeenCalled();
  });

  it('continues and warns on WARN', () => {
    const log = fakeLogger();
    expect(handleOrchestratorError(new SampleWarn('bad task'), log)).toBe('continue');
    expect(log.warn).toHaveBeenCalledOnce();
    expect(log.error).not.toHaveBeenCalled();
  });

  it('treats an unknown Error as a task-level warning and continues', () => {
    const log = fakeLogger();
    expect(handleOrchestratorError(new Error('boom'), log)).toBe('continue');
    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining('boom'));
  });

  it('stringifies a non-Error throwable in the warning', () => {
    const log = fakeLogger();
    expect(handleOrchestratorError('weird', log)).toBe('continue');
    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining('weird'));
  });
});

describe('withRetry', () => {
  it('returns the result when fn succeeds on the first try', () => {
    expect(withRetry(() => 42, { sleep: () => {} })).toBe(42);
  });

  it('retries transient SQLITE_BUSY then succeeds, backing off exponentially', () => {
    const slept: number[] = [];
    let calls = 0;
    const result = withRetry(
      () => {
        calls++;
        if (calls < 3) throw { errcode: 5, errstr: 'database is locked' };
        return 'ok';
      },
      { sleep: ms => slept.push(ms), baseMs: 10 },
    );
    expect(result).toBe('ok');
    expect(calls).toBe(3);
    expect(slept).toEqual([10, 20]);
  });

  it('detects SQLITE_LOCKED (errcode 6) as transient', () => {
    let calls = 0;
    const result = withRetry(
      () => {
        calls++;
        if (calls < 2) throw { errcode: 6 };
        return 'ok';
      },
      { sleep: () => {}, baseMs: 1 },
    );
    expect(result).toBe('ok');
    expect(calls).toBe(2);
  });

  it('detects busy via extended result codes (low byte)', () => {
    let calls = 0;
    withRetry(
      () => {
        calls++;
        if (calls < 2) throw { errcode: 261 }; // SQLITE_BUSY_RECOVERY
        return 1;
      },
      { sleep: () => {}, baseMs: 1 },
    );
    expect(calls).toBe(2);
  });

  it('throws DbBusyError when BUSY retries are exhausted', () => {
    expect(() =>
      withRetry(() => { throw { errcode: 5 }; }, { tries: 2, sleep: () => {} }),
    ).toThrowError(DbBusyError);
  });

  it('maps SQLITE_CORRUPT to DbCorruptError without retrying', () => {
    let calls = 0;
    expect(() =>
      withRetry(() => { calls++; throw { errcode: 11 }; }, { sleep: () => {} }),
    ).toThrowError(DbCorruptError);
    expect(calls).toBe(1);
  });

  it('maps SQLITE_NOTADB (errcode 26) to DbCorruptError', () => {
    expect(() =>
      withRetry(() => { throw { errcode: 26 }; }, { sleep: () => {} }),
    ).toThrowError(DbCorruptError);
  });

  it('rethrows non-sqlite errors unchanged', () => {
    const boom = new Error('app bug');
    expect(() => withRetry(() => { throw boom; }, { sleep: () => {} })).toThrowError(boom);
  });

  it('rethrows a throwable that has no numeric errcode', () => {
    const weird = { nope: true };
    expect(() => withRetry(() => { throw weird; }, { sleep: () => {} })).toThrow();
  });

  it('rethrows a nullish throwable (covers the optional-chaining guard)', () => {
    let thrown: unknown = 'unset';
    try {
      withRetry(() => { throw null; }, { sleep: () => {} });
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeNull();
  });

  it('uses a real backoff sleep by default (covers the default sleeper)', () => {
    let calls = 0;
    const result = withRetry(() => {
      calls++;
      if (calls < 2) throw { errcode: 5 };
      return 'ok';
    }, { baseMs: 1 });
    expect(result).toBe('ok');
    expect(calls).toBe(2);
  });
});
