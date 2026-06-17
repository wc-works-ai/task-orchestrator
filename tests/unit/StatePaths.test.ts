import { describe, expect, it } from 'vitest';
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { defaultStateRoot, repoSlug, resolveStatePaths } from '../../src/state/StatePaths.js';

/** Build a platform-aware absolute path from a Windows-style path string.
 *  On Windows the backslashes are real separators; on Unix they are regular
 *  characters that `resolve` treats as part of file names.  Using `join`
 *  ensures the expected path components are joined with the OS separator. */
function winPath(root: string, ...segments: string[]): string {
  return resolve(join(root, ...segments));
}

describe('StatePaths', () => {
  it('derives global tasks and worktrees from provided state root', () => {
    const paths = resolveStatePaths({
      repo: 'Q:\\Repos\\FabricSparkCST',
      stateRoot: 'Q:\\Orchestrator',
    });

    expect(paths.repo).toBe(winPath('Q:\\Repos\\FabricSparkCST'));
    expect(paths.stateRoot).toBe(winPath('Q:\\Orchestrator'));
    expect(paths.repoSlug).toBe('FabricSparkCST');
    expect(paths.tasks).toBe(winPath('Q:\\Orchestrator', 'tasks'));
    expect(paths.worktrees).toBe(winPath('Q:\\Orchestrator', 'worktrees'));
  });

  it('lets explicit tasks and worktrees override derived paths', () => {
    const paths = resolveStatePaths({
      repo: 'Q:\\Repos\\FabricSparkCST',
      stateRoot: 'Q:\\Orchestrator',
      tasks: 'D:\\Tasks\\FabricSparkCST',
      worktrees: 'E:\\Worktrees\\FabricSparkCST',
    });

    expect(paths.tasks).toBe(winPath('D:\\Tasks\\FabricSparkCST'));
    expect(paths.worktrees).toBe(winPath('E:\\Worktrees\\FabricSparkCST'));
  });

  it('resolves global paths without repo', () => {
    const paths = resolveStatePaths({ stateRoot: 'Q:\\Orchestrator' });

    expect(paths.repo).toBeUndefined();
    expect(paths.repoSlug).toBeUndefined();
    expect(paths.stateRoot).toBe(winPath('Q:\\Orchestrator'));
    expect(paths.tasks).toBe(winPath('Q:\\Orchestrator', 'tasks'));
    expect(paths.worktrees).toBe(winPath('Q:\\Orchestrator', 'worktrees'));
  });

  it('defaults state root to home task-orchestrator folder', () => {
    const paths = resolveStatePaths({ repo: 'Q:\\Repos\\FabricSparkCST' });

    expect(defaultStateRoot()).toBe(join(homedir(), 'task-orchestrator'));
    expect(paths.stateRoot).toBe(resolve(join(homedir(), 'task-orchestrator')));
    expect(paths.tasks).toBe(resolve(join(homedir(), 'task-orchestrator', 'tasks')));
    expect(paths.worktrees).toBe(resolve(join(homedir(), 'task-orchestrator', 'worktrees')));
  });

  it('sanitizes repo slug for folder names', () => {
    expect(repoSlug('Q:\\Repos\\bad:name')).toBe('bad-name');
  });

  it('rejects repo roots that do not produce a slug', () => {
    // On Windows `basename(resolve('Q:\\'))` is empty; on Unix the whole
    // string becomes a single component so it produces a slug.  Use a
    // path that is a bare separator on every platform.
    expect(() => repoSlug('/')).toThrow('Cannot derive repo slug');
  });
});
