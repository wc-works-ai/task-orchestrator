import { TaskState } from './TaskState.js';

type Counts = {
  converged: number;
  failed: number;
  blocked: number;
  pending: number;
  inProgress: number;
};

function countTasks(tasks: readonly TaskState[]): Counts {
  const counts: Counts = { converged: 0, failed: 0, blocked: 0, pending: 0, inProgress: 0 };
  for (const task of tasks) {
    if (task.isConverged) counts.converged++;
    else if (task.isFailed) counts.failed++;
    else if (task.isBlocked) counts.blocked++;
    else if (task.isPending) counts.pending++;
    else if (task.isInProgress) counts.inProgress++;
  }
  return counts;
}

function sortedTasks(all: Map<string, TaskState>): TaskState[] {
  return [...all.values()].sort((a, b) => a.taskNumber - b.taskNumber);
}

function taskIcon(task: TaskState): string {
  if (task.isConverged) return '✅';
  if (task.isFailed) return '❌';
  if (task.isBlocked) return '🚫';
  if (task.isPending) return '⬜';
  if (task.isInProgress) return '🔄';
  return '❓';
}

function taskStatus(task: TaskState): string {
  if (task.isConverged) return 'converged';
  if (task.isFailed) return 'failed';
  if (task.isBlocked) return 'blocked';
  if (task.isPending) return 'pending';
  if (task.isInProgress) return 'in_progress';
  return 'unknown';
}

export async function formatOverview(tasksDir: string, tick: number): Promise<string> {
  const tasks = sortedTasks(await TaskState.scan(tasksDir));
  const counts = countTasks(tasks);
  const running = tasks.filter(t => t.isInProgress).map(t => `T${t.taskNumber}`).join(',') || 'none';
  return `Overview: running=${running} converged=${counts.converged} failed=${counts.failed} blocked=${counts.blocked} pending=${counts.pending} (tick ${tick})`;
}

export async function printOverview(tasksDir: string, tick: number): Promise<void> {
  console.log(await formatOverview(tasksDir, tick));
}

export async function formatRunSummary(tasksDir: string, ticks: number): Promise<string[]> {
  const tasks = sortedTasks(await TaskState.scan(tasksDir));
  const counts = countTasks(tasks);
  const lines = [
    `Summary: converged=${counts.converged} failed=${counts.failed} blocked=${counts.blocked} pending=${counts.pending} in_progress=${counts.inProgress} (${ticks} ticks)`,
  ];
  for (const task of tasks) {
    const attempts = task.isPending ? '' : `  attempts=${task.failureCount}`;
    lines.push(`  ${taskIcon(task)} T${task.taskNumber} ${taskStatus(task)}${attempts}`);
  }
  return lines;
}

export async function printRunSummary(tasksDir: string, ticks: number): Promise<void> {
  for (const line of await formatRunSummary(tasksDir, ticks)) console.log(line);
}
