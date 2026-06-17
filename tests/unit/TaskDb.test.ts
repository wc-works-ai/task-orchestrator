import { describe, expect, it } from 'vitest';
import { SCHEMA_VERSION, taskDirName } from '../../src/state/TaskDb.js';

describe('TaskDb constants and helpers', () => {
  it('exposes schema version 3 for the priority-column migration', () => {
    expect(SCHEMA_VERSION).toBe(3);
  });

  it('keeps task directory names stable', () => {
    expect(taskDirName(3, 'repo-work')).toBe('T03-repo-work');
  });
});
