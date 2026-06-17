export interface AddTaskOptions {
    readonly goal?: string;
    readonly metric?: string;
    readonly scope?: readonly string[];
}
export declare function addTask(tasksDir: string, name: string, opts?: AddTaskOptions): {
    number: number;
    name: string;
    directory: string;
    goal: string;
    metric: string;
    scope: readonly string[];
};
