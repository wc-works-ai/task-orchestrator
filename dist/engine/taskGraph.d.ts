/** One task in the dependency graph. `deps` are the task numbers this task
 *  depends on (they must converge first). */
export interface GraphNode {
    readonly number: number;
    readonly status: string;
    readonly goal: string;
    readonly deps: readonly number[];
}
/**
 * Render the task dependency DAG as text. Tasks are listed in topological order
 * (dependencies before dependents) and indented by depth so the structure is
 * visible. `→` lists each task's direct dependencies. Missing dependencies are
 * flagged, and any tasks caught in a cycle are reported separately.
 */
export declare function formatTaskGraph(nodes: readonly GraphNode[]): string[];
