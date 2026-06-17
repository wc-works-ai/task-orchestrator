import type { TaskDb } from './TaskDb.js';
/** Scan the old shard dirs under `tasksRoot` and import each task into `tdb`.
 *  Returns the number of tasks imported (already-present ones are skipped). */
export declare function migrateShards(tdb: TaskDb, tasksRoot: string): number;
