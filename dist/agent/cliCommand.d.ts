export interface ResolvedCommand {
    readonly command: string;
    readonly args: string[];
}
export declare function resolveCliCommand(bin: string, args: readonly string[]): ResolvedCommand;
