export declare const Status: {
    readonly PENDING: "PENDING";
    readonly FAILED: "FAILED";
    readonly BLOCKED: "BLOCKED";
    readonly CONVERGED: "CONVERGED";
};
export type Status = (typeof Status)[keyof typeof Status];
export declare const inProgress: (id: string) => `IN_PROGRESS:${string}`;
export declare const isInProgress: (s: string) => boolean;
export declare const isActionable: (s: Status | string) => boolean;
export declare const CONVERGENCE_THRESHOLD: number;
export declare const MAX_FAILURES: number;
export declare const statusToShard: (s: Status | string) => string;
export declare const SHARDS: readonly ["pending", "in_progress", "converged", "failed", "blocked"];
