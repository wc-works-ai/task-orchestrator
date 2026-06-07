export const Status = {
  PENDING:   'PENDING',
  FAILED:    'FAILED',
  BLOCKED:   'BLOCKED',
  CONVERGED: 'CONVERGED',
} as const;
export type Status = (typeof Status)[keyof typeof Status];

export const inProgress = (id: string) => `IN_PROGRESS:${id}` as const;
export const isInProgress = (s: string): boolean => s.startsWith('IN_PROGRESS');
export const isActionable = (s: Status | string): boolean =>
  s === Status.PENDING || s === Status.FAILED;

export const CONVERGENCE_THRESHOLD = parseInt(process.env.ORCH_CONVERGE ?? '3', 10);
export const MAX_FAILURES = parseInt(process.env.ORCH_MAX_FAILURES ?? '5', 10);

export const statusToShard = (s: Status | string): string => {
  if (s === Status.PENDING) return 'pending';
  if (s === Status.FAILED) return 'failed';
  if (s === Status.BLOCKED) return 'blocked';
  if (s === Status.CONVERGED) return 'converged';
  return 'in_progress';
};

export const SHARDS = ['pending', 'in_progress', 'converged', 'failed', 'blocked'] as const;
