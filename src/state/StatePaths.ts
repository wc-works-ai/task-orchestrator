import { basename, join, resolve } from 'node:path';
import { homedir } from 'node:os';

const DEFAULT_STATE_ROOT = 'task-orchestrator';

export interface StatePathInputs {
  readonly repo?: string | undefined;
  readonly stateRoot?: string | undefined;
  readonly tasks?: string | undefined;
  readonly worktrees?: string | undefined;
}

export interface StatePaths {
  readonly repo: string;
  readonly stateRoot: string;
  readonly repoSlug: string;
  readonly tasks: string;
  readonly worktrees: string;
}

export function repoSlug(repoPath: string): string {
  const name = basename(resolve(repoPath));
  const slug = name.replace(/[<>:"/\\|?*\x00-\x1F]+/g, '-').replace(/\.+$/g, '').trim();
  if (!slug) throw new Error(`Cannot derive repo slug from ${repoPath}`);
  return slug;
}

export function defaultStateRoot(): string {
  return join(homedir(), DEFAULT_STATE_ROOT);
}

export function resolveStatePaths(inputs: StatePathInputs): StatePaths {
  if (!inputs.repo) throw new Error('--repo is required (or set ORCH_REPO)');

  const repo = resolve(inputs.repo);
  const stateRoot = resolve(inputs.stateRoot || defaultStateRoot());
  const slug = repoSlug(repo);

  return {
    repo,
    stateRoot,
    repoSlug: slug,
    tasks: resolve(inputs.tasks || join(stateRoot, slug, 'tasks')),
    worktrees: resolve(inputs.worktrees || join(stateRoot, slug, 'worktrees')),
  };
}
