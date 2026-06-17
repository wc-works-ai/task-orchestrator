export interface PrerequisiteResult {
    readonly name: string;
    readonly ok: boolean;
    readonly message: string;
}
export declare class Prerequisites {
    static check(): Promise<PrerequisiteResult[]>;
    private static checkNode;
    private static checkPi;
    private static checkAuth;
    static format(results: PrerequisiteResult[]): string;
}
