export const Status = {
    PENDING: 'PENDING',
    FAILED: 'FAILED',
    BLOCKED: 'BLOCKED',
    CONVERGED: 'CONVERGED',
};
export const inProgress = (id) => `IN_PROGRESS:${id}`;
export const isInProgress = (s) => s.startsWith('IN_PROGRESS');
export const isActionable = (s) => s === Status.PENDING || s === Status.FAILED;
import { env } from '../shared/env.js';
export const CONVERGENCE_THRESHOLD = env.converge;
export const MAX_FAILURES = env.maxFailures;
//# sourceMappingURL=Status.js.map