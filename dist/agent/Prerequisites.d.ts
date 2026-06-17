import type { CodingAgent, PrerequisiteResult } from './CodingAgent.js';
export declare class Prerequisites {
    static check(agent?: CodingAgent): Promise<PrerequisiteResult[]>;
    private static checkNode;
    static format(results: PrerequisiteResult[]): string;
}
