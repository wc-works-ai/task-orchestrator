import { basename, join, resolve } from 'node:path';
import { homedir } from 'node:os';
const DEFAULT_STATE_ROOT = 'task-orchestrator';
export function repoSlug(repoPath) {
    // Normalize Windows backslashes so cross-platform tests produce consistent slugs.
    const normalized = repoPath.replace(/\\/g, '/');
    const name = basename(resolve(normalized));
    const slug = name.replace(/[<>:"/\\|?*\x00-\x1F]+/g, '-').replace(/\.+$/g, '').trim();
    if (!slug)
        throw new Error(`Cannot derive repo slug from ${repoPath}`);
    return slug;
}
export function defaultStateRoot() {
    return join(homedir(), DEFAULT_STATE_ROOT);
}
export function resolveStatePaths(inputs) {
    const repo = inputs.repo ? resolve(inputs.repo) : undefined;
    const stateRoot = resolve(inputs.stateRoot || defaultStateRoot());
    const slug = repo ? repoSlug(repo) : undefined;
    return {
        repo,
        stateRoot,
        repoSlug: slug,
        tasks: resolve(inputs.tasks || join(stateRoot, 'tasks')),
        worktrees: resolve(inputs.worktrees || join(stateRoot, 'worktrees')),
    };
}
//# sourceMappingURL=StatePaths.js.map