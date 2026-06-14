import { mkdirSync, writeFileSync, readdirSync, renameSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { resolve, dirname } from 'node:path';

export interface AddTaskOptions {
  readonly goal?: string;
  readonly metric?: string;
  readonly scope?: readonly string[];
  /** Git branch this task targets for worktree creation and merge. Defaults to current HEAD. */
  readonly targetBranch?: string;
  /** Repository directory for detecting the current branch. */
  readonly repoDir?: string;
}

function detectBranch(repoDir?: string): string | undefined {
  try {
    const branch = execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'],
      { cwd: repoDir ?? process.cwd(), encoding: 'utf-8' }).trim();
    /* v8 ignore next -- detached HEAD returns literal 'HEAD'; unreachable in normal test env */
    return branch && branch !== 'HEAD' ? branch : undefined;
  } catch { return undefined; }
}

function readTaskDirectoryEntries(path: string): readonly string[] {
  try {
    return readdirSync(path);
  } catch {
    return [];
  }
}

export function addTask(tasksDir: string, name: string, opts: AddTaskOptions = {}) {
  if (!name || /[/\\<>:"|?*]/.test(name) || name.includes('..') || /^\s|\s$/.test(name)) {
    throw new Error(`Invalid task name "${name}": must not contain path separators, shell metacharacters, or leading/trailing whitespace`);
  }
  if (opts.metric && !/^\w+$/.test(opts.metric)) {
    throw new Error(`Invalid metric name "${opts.metric}": must match /^\\w+$/ (letters, digits, underscore)`);
  }
  let next = 0;
  for (const s of ['pending','in_progress','converged','failed','blocked']) {
    for (const e of readTaskDirectoryEntries(resolve(tasksDir, s))) {
      const m = e.match(/^T(\d+)-/); if (m?.[1]) next = Math.max(next, parseInt(m[1]!, 10));
    }
  }
  next++;

  const goal = opts.goal ?? `TODO: describe what T${next} should accomplish`;
  const metric = opts.metric ?? 'goal';
  const scope = opts.scope?.length ? opts.scope : ['TODO: add scope files'];

  const taskName = `T${String(next).padStart(2, '0')}-${name}`;
  const finalDir = resolve(tasksDir, 'pending', taskName);
  const branch = opts.targetBranch ?? detectBranch(opts.repoDir);

  // Atomic task creation: write all files to a staging directory, then rename
  // into pending/ as the last step. This prevents a running loop from picking
  // up a half-written task (race condition: mkdir visible but benchmark.js not
  // yet written → ENOENT crash).
  const stagingDir = resolve(tasksDir, `.staging-${taskName}-${process.pid}`);
  mkdirSync(stagingDir, { recursive: true });
  try {
    writeFileSync(resolve(stagingDir, '.status'), 'PENDING\n');
    writeFileSync(resolve(stagingDir, '.dependencies'), '');

    // Persist the target branch so the worktree is created from and merged
    // into the correct branch, even if HEAD changes between creation and pickup.
    if (branch) {
      writeFileSync(resolve(stagingDir, '.target_branch'), branch + '\n');
    }
    writeFileSync(resolve(stagingDir, 'autoresearch.md'), [
      `# T${next} — ${goal}`,
      '## Goal', goal,
      '## Metrics',
      `- \`${metric}\` — task-specific deliverable; replace the placeholder check in \`benchmark.js\``,
      '- `build` — `npm run c` must pass',
      '- `test` — `npm run t` must pass',
      '## Scope', ...scope.map(f => `- ${f}`),
      '## Acceptance',
      '- Task benchmark: `benchmark.js` runs task-specific checks and emits `METRIC name=value` lines.',
      '- Global verify: `ORCH_VERIFY_CMD` runs repo-wide gates before merge (for example `npm run tc` for coverage).',
      '- ALL emitted metrics must be 0 for convergence.',
      '- Convergence requires 3 consecutive zero runs.',
    ].join('\n'));
    writeFileSync(resolve(stagingDir, 'benchmark.js'), [
      '#!/usr/bin/env node',
      "import { execSync } from 'node:child_process';",
      '',
      '// Task benchmark scaffold: emit one METRIC line per acceptance criterion.',
      '// ALL metrics must be 0 before the task can converge.',
      'const report = (name, value) => console.log(`METRIC ${name}=${value}`);',
      '',
      'const check = (name, command) => {',
      '  try {',
      "    execSync(command, { stdio: 'ignore' });",
      '    report(name, 0);',
      '  } catch {',
      '    report(name, 1);',
      '  }',
      '};',
      '',
      `// TODO: replace this placeholder with a real command that exits 0 only when the ${metric} deliverable is done.`,
      `check('${metric}', 'node -e "process.exit(1)"');`,
      '',
      '// Keep task-specific checks here. Put repo-wide gates like coverage in ORCH_VERIFY_CMD',
      '// so they run globally before merge (for example: npm run tc).',
      "check('build', 'npm run c');",
      "check('test', 'npm run t');",
    ].join('\n'));

    // Atomic: rename staging → pending (single filesystem operation)
    mkdirSync(dirname(finalDir), { recursive: true });
    renameSync(stagingDir, finalDir);
  /* v8 ignore start -- defensive cleanup; hard to trigger (rename over dir succeeds on most OS) */
  } catch (e: unknown) {
    try { rmSync(stagingDir, { recursive: true, force: true }); }
    catch (cleanupError: unknown) {
      console.error(`[addTask] failed to remove staging directory ${stagingDir}: ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`);
    }
    throw e;
  }
  /* v8 ignore stop */

  return { number: next, name, directory: finalDir, goal, metric, scope, targetBranch: branch };
}
