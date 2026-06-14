import { mkdirSync, writeFileSync, renameSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { resolve, join } from 'node:path';
import { TaskDb } from './TaskDb.js';
import { env } from './env.js';

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

export function addTask(tasksDir: string, name: string, opts: AddTaskOptions = {}) {
  if (!name || /[/\\<>:"|?*]/.test(name) || name.includes('..') || /^\s|\s$/.test(name)) {
    throw new Error(`Invalid task name "${name}": must not contain path separators, shell metacharacters, or leading/trailing whitespace`);
  }
  if (opts.metric && !/^\w+$/.test(opts.metric)) {
    throw new Error(`Invalid metric name "${opts.metric}": must match /^\\w+$/ (letters, digits, underscore)`);
  }

  const branch = opts.targetBranch ?? detectBranch(opts.repoDir);
  // Freeze the retry limit at creation; Infinity (unlimited) stores as NULL.
  const maxFailures = Number.isFinite(env.maxFailures) ? env.maxFailures : null;

  const tdb = TaskDb.open(join(tasksDir, 'state.db'));
  try {
    // Insert as CREATING: the task is reserved but invisible to pick() until
    // its content is written and it is promoted to PENDING.
    const { id, taskNumber, dir } = tdb.insert({ name, maxFailures, targetBranch: branch ?? null });

    const goal = opts.goal ?? `TODO: describe what T${taskNumber} should accomplish`;
    const metric = opts.metric ?? 'goal';
    const scope = opts.scope?.length ? opts.scope : ['TODO: add scope files'];
    const finalDir = resolve(tasksDir, dir);

    // Write content to a staging dir, then rename in as one step so the final
    // directory is all-or-nothing even if a write fails partway through.
    const stagingDir = resolve(tasksDir, `.staging-${dir}-${process.pid}`);
    mkdirSync(stagingDir, { recursive: true });
    try {
      writeFileSync(resolve(stagingDir, 'autoresearch.md'), [
        `# T${taskNumber} — ${goal}`,
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

      renameSync(stagingDir, finalDir);
    /* v8 ignore start -- defensive cleanup; rename rarely fails after a clean staging write */
    } catch (e: unknown) {
      try { rmSync(stagingDir, { recursive: true, force: true }); }
      catch (cleanupError: unknown) {
        console.error(`[addTask] failed to remove staging directory ${stagingDir}: ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`);
      }
      throw e;
    }
    /* v8 ignore stop */

    // Publish the fully-written task.
    tdb.promote(id);

    return { number: taskNumber, name, directory: finalDir, goal, metric, scope, targetBranch: branch };
  } finally {
    tdb.close();
  }
}
