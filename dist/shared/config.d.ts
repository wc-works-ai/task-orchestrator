export interface ConfigItem {
    readonly group: string;
    readonly env: string;
    readonly flag?: string;
    readonly kind: 'string' | 'boolean' | 'number';
    readonly def: string;
    readonly desc: string;
}
export declare const CONFIG_SPEC: readonly ConfigItem[];
export declare function formatSettingsHelp(): string;
export declare function formatEffectiveConfig(values: Record<string, unknown>, environ: NodeJS.ProcessEnv): string;
export interface HelpItem {
    readonly name: string;
    readonly desc: string;
}
export declare const COMMAND_SPEC: readonly HelpItem[];
export declare const OPERATION_SPEC: readonly HelpItem[];
export interface ExampleItem {
    readonly cmd: string;
    readonly desc: string;
}
export declare const EXAMPLES: readonly ExampleItem[];
/** Live setting values shown in the help footer (resolved by the caller). */
export interface HelpSettings {
    readonly agent: string;
    readonly model: string;
    readonly reasoning: string;
    readonly parallel: number;
    readonly converge: number;
    readonly maxFailures: string;
    readonly autoStash: boolean;
    readonly noWorktree: boolean;
    readonly logLevel: string;
}
/** Build the full `--help` output from the declarative specs above, the passed
 *  version, and a resolved settings snapshot. Pure — the caller supplies the
 *  version (see version.ts) and current settings (from env). */
export declare function formatHelp(version: string, s: HelpSettings): string;
