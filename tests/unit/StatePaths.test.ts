import { describe, expect, it } from 'vitest';
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { defaultStateRoot, repoSlug, resolveStatePaths } from '../../src/state/StatePaths.js';

describe('StatePaths', () => {
  it('derives tasks and worktrees from provided state root and repo slug', () => {
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

  it('defaults state root to home task-orchestrator folder', () => {
    const paths = resolveStatePaths({ repo: 'Q:\\Repos\\FabricSparkCST' });

    expect(defaultStateRoot()).toBe(join(homedir(), 'task-orchestrator'));
    expect(paths.stateRoot).toBe(resolve(join(homedir(), 'task-orchestrator')));
    expect(paths.tasks).toBe(resolve(join(homedir(), 'task-orchestrator', 'FabricSparkCST', 'tasks')));
    expect(paths.worktrees).toBe(resolve(join(homedir(), 'task-orchestrator', 'FabricSparkCST', 'worktrees')));
  });

  it('sanitizes repo slug for folder names', () => {
    expect(repoSlug('Q:\\Repos\\bad:name')).toBe('bad-name');
  });

  it('rejects repo roots that do not produce a slug', () => {
    expect(() => repoSlug('Q:\\')).toThrow('Cannot derive repo slug');
  });
});
