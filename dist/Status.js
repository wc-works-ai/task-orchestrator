export const Status = {
    PENDING: 'PENDING',
    FAILED: 'FAILED',
    BLOCKED: 'BLOCKED',
    CONVERGED: 'CONVERGED',
};
export const inProgress = (id) => `IN_PROGRESS:${id}`;
export const isInProgress = (s) => s.startsWith('IN_PROGRESS');
export const isActionable = (s) => s === Status.PENDING || s === Status.FAILED;
import { env } from './env.js';
export const CONVERGENCE_THRESHOLD = env.converge;
export const MAX_FAILURES = env.maxFailures;
export const statusToShard = (s) => {
    if (s === Status.PENDING)
        return 'pending';
    if (s === Status.FAILED)
        return 'failed';
    if (s === Status.BLOCKED)
        return 'blocked';
    if (s === Status.CONVERGED)
        return 'converged';
    return 'in_progress';
};
export const SHARDS = ['pending', 'in_progress', 'converged', 'failed', 'blocked'];
//# sourceMappingURL=Status.js.map