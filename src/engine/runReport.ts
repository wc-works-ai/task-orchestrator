import { join } from 'node:path';
import { TaskState } from '../state/TaskState.js';
import { TaskDb } from '../state/TaskDb.js';

type Counts = {
  failed: number;
  blocked: number;
  pending: number;
  inProgress: number;
};

function countTasks(tasks: readonly TaskState[]): Counts {
  const counts: Counts = { failed: 0, blocked: 0, pending: 0, inProgress: 0 };
  for (const task of tasks) {
    if (task.isFailed) counts.failed++;
    else if (task.isBlocked) counts.blocked++;
    else if (task.isPending) counts.pending++;
    else counts.inProgress++; // scan yields only these 4 states; IN_PROGRESS is the fallback
  }
  return counts;
}

function sortedTasks(all: Map<string, TaskState>): TaskState[] {
  return [...all.values()].sort((a, b) => a.taskNumber - b.taskNumber);
}

// scan() yields only PENDING/IN_PROGRESS/FAILED/BLOCKED, so the final fallback
// covers IN_PROGRESS — no "unknown" state is reachable.
function taskIcon(task: TaskState): string {
  if (task.isFailed) return '❌';
  if (task.isBlocked) return '🚫';
  if (task.isPending) return '⬜';
  return '🔄';
}

function taskStatus(task: TaskState): string {
  if (task.isFailed) return 'failed';
  if (task.isBlocked) return 'blocked';
  if (task.isPending) return 'pending';
  return 'in_progress';
}

export async function formatOverview(tasksDir: string, tick: number): Promise<string> {
  const tdb = TaskDb.open(join(tasksDir, 'state.db'));
  try {
    const tasks = sortedTasks(TaskState.scan(tdb, tasksDir));
    const counts = countTasks(tasks);
    const convergedCount = TaskState.countConverged(tdb);
    const running = tasks.filter(t => t.isInProgress).map(t => `T${t.taskNumber}`).join(',') || 'none';
    return `Overview: running=${running} converged=${convergedCount} failed=${counts.failed} blocked=${counts.blocked} pending=${counts.pending} (tick ${tick})`;
  } finally {
    tdb.close();
  }
}

export async function printOverview(tasksDir: string, tick: number): Promise<void> {
  console.log(await formatOverview(tasksDir, tick));
}

export async function formatRunSummary(tasksDir: string, ticks: number): Promise<string[]> {
  const tdb = TaskDb.open(join(tasksDir, 'state.db'));
  try {
    const tasks = sortedTasks(TaskState.scan(tdb, tasksDir));
    const counts = countTasks(tasks);
    const convergedCount = TaskState.countConverged(tdb);
    const lines = [
      `Summary: converged=${convergedCount} failed=${counts.failed} blocked=${counts.blocked} pending=${counts.pending} in_progress=${counts.inProgress} (${ticks} ticks)`,
    ];
    for (const task of tasks) {
      const attempts = task.isPending ? '' : `  attempts=${task.failureCount}`;
      const priority = task.priority !== 0 ? `  priority=${task.priority}` : '';
      lines.push(`  ${taskIcon(task)} T${task.taskNumber} ${taskStatus(task)}${priority}${attempts}`);
    }
    return lines;
  } finally {
    tdb.close();
  }
}

export async function printRunSummary(tasksDir: string, ticks: number): Promise<void> {
  for (const line of await formatRunSummary(tasksDir, ticks)) console.log(line);
}

