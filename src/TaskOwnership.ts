/**
 * In-process task ownership tracker.
 *
 * Prevents the same task (by task number) from being processed by two workers
 * inside a single orchestrator process at the same time. It is a plain
 * in-memory guard layered on top of the cross-process file-claim protocol
 * (see TaskState.claim): the file claim arbitrates between machines/processes,
 * while this set arbitrates between concurrent workers in one process.
 *
 * It is intentionally simple — a Set of task numbers. Every operation is O(1),
 * does no I/O, and never blocks. It is NOT a lock: acquiring a task that is
 * already owned fails fast (returns false) instead of waiting. The caller is
 * expected to skip that task this cycle and try again later.
 */
export class TaskOwnership {
  readonly #owned = new Set<number>();

  /**
   * Take ownership of a task number for this process.
   * Returns true if ownership was granted, false if the task is already owned.
   */
  acquire(taskNumber: number): boolean {
    if (this.#owned.has(taskNumber)) return false;
    this.#owned.add(taskNumber);
    return true;
  }

  /**
   * Release ownership of a task number. Safe to call even if the task is not
   * currently owned. Callers MUST release only after the task's lifecycle and
   * any shard transition have fully settled, so a later cycle cannot re-pick a
   * half-moved task.
   */
  release(taskNumber: number): void {
    this.#owned.delete(taskNumber);
  }

  /** True if the given task number is currently owned by this process. */
  has(taskNumber: number): boolean {
    return this.#owned.has(taskNumber);
  }

  /** Number of tasks currently owned. */
  get size(): number {
    return this.#owned.size;
  }

  /** Snapshot of currently owned task numbers (for diagnostics and tests). */
  snapshot(): readonly number[] {
    return [...this.#owned];
  }
}
