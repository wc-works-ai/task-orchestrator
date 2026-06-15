import { describe, expect, it } from 'vitest';
import { SCHEMA_VERSION, taskDirName } from '../../src/state/TaskDb.js';

describe('TaskDb constants and helpers', () => {
  it('exposes schema version 2 for the repo-column migration', () => {
    expect(SCHEMA_VERSION).toBe(2);
  });

  it('keeps task directory names stable', () => {
    expect(taskDirName(3, 'repo-work')).toBe('T03-repo-work');
  });
});
