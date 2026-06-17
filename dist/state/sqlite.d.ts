export type SqlValue = null | number | bigint | string | NodeJS.ArrayBufferView;
export type SqlParams = readonly SqlValue[] | Record<string, SqlValue>;
export type Row = Record<string, SqlValue>;
export interface RunResult {
    readonly changes: number;
    readonly lastInsertRowid: number;
}
export interface Db {
    run(sql: string, params?: SqlParams): RunResult;
    get<T = Row>(sql: string, params?: SqlParams): T | undefined;
    all<T = Row>(sql: string, params?: SqlParams): T[];
    exec(sql: string): void;
    transaction<T>(fn: () => T): T;
    close(): void;
}
/** Open (creating if needed) the state database with our standard settings. */
export declare function openDb(path: string): Db;
/** WAL can silently fall back to 'delete' on unsupported volumes; refuse that. */
export declare function requireWal(journalMode: string | undefined): void;
