import { describe, expect, it } from 'vitest';
import { resolve } from 'node:path';
import { repoSlug, resolveStatePaths } from '../src/StatePaths.js';

describe('StatePaths', () => {
  it('derives tasks and worktrees from required state root and repo slug', () => {
    const paths = resolveStatePaths({
      repo: 'Q:\\Repos\\FabricSparkCST',
      stateRoot: 'Q:\\Orchestrator',
    });

    expect(paths.repo).toBe(resolve('Q:\\Repos\\FabricSparkCST'));
    expect(paths.stateRoot).toBe(resolve('Q:\\Orchestrator'));
    expect(paths.repoSlug).toBe('FabricSparkCST');
    expect(paths.tasks).toBe(resolve('Q:\\Orchestrator\\FabricSparkCST\\tasks'));
    expect(paths.worktrees).toBe(resolve('Q:\\Orchestrator\\FabricSparkCST\\worktrees'));
  });

  it('lets explicit tasks and worktrees override derived paths', () => {
    const paths = resolveStatePaths({
      repo: 'Q:\\Repos\\FabricSparkCST',
      stateRoot: 'Q:\\Orchestrator',
      tasks: 'D:\\Tasks\\FabricSparkCST',
      worktrees: 'E:\\Worktrees\\FabricSparkCST',
    });

    expect(paths.tasks).toBe(resolve('D:\\Tasks\\FabricSparkCST'));
    expect(paths.worktrees).toBe(resolve('E:\\Worktrees\\FabricSparkCST'));
  });

  it('requires repo', () => {
    expect(() => resolveStatePaths({ stateRoot: 'Q:\\Orchestrator' }))
      .toThrow('--repo is required');
  });

  it('requires state root', () => {
    expect(() => resolveStatePaths({ repo: 'Q:\\Repos\\FabricSparkCST' }))
      .toThrow('--state-root is required');
  });

  it('sanitizes repo slug for folder names', () => {
    expect(repoSlug('Q:\\Repos\\bad:name')).toBe('bad-name');
  });
});
