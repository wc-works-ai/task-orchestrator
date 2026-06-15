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

import { env } from '../shared/env.js';

export const CONVERGENCE_THRESHOLD = env.converge;
export const MAX_FAILURES = env.maxFailures;
