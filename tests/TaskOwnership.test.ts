import { describe, it, expect, beforeEach } from 'vitest';
import { TaskOwnership } from '../src/TaskOwnership.js';

describe('TaskOwnership', () => {
  let owner: TaskOwnership;

  beforeEach(() => { owner = new TaskOwnership(); });

  it('grants ownership of an unowned task', () => {
    expect(owner.acquire(1)).toBe(true);
    expect(owner.has(1)).toBe(true);
    expect(owner.size).toBe(1);
  });

  it('refuses a second acquire of the same task (no double-processing)', () => {
    expect(owner.acquire(1)).toBe(true);
    expect(owner.acquire(1)).toBe(false);
    expect(owner.size).toBe(1);
  });

  it('allows different tasks to be owned concurrently', () => {
    expect(owner.acquire(1)).toBe(true);
    expect(owner.acquire(2)).toBe(true);
    expect(owner.acquire(3)).toBe(true);
    expect(owner.size).toBe(3);
    expect(owner.snapshot().slice().sort((a, b) => a - b)).toEqual([1, 2, 3]);
  });

  it('releases ownership so the task can be acquired again', () => {
    expect(owner.acquire(1)).toBe(true);
    owner.release(1);
    expect(owner.has(1)).toBe(false);
    expect(owner.size).toBe(0);
    expect(owner.acquire(1)).toBe(true);
  });

  it('release is safe when the task is not owned', () => {
    expect(() => owner.release(99)).not.toThrow();
    expect(owner.size).toBe(0);
  });

  it('has() returns false for an unowned task', () => {
    expect(owner.has(7)).toBe(false);
  });

  it('snapshot is an independent copy, not a live view', () => {
    owner.acquire(1);
    const snap = owner.snapshot();
    owner.acquire(2);
    expect(snap).toEqual([1]);
  });
});
