import type { CodingAgent, CodingAgentOptions } from './CodingAgent.js';
export declare const SUPPORTED_AGENTS: string[];
export declare function createCodingAgent(name: string | undefined, opts: CodingAgentOptions): CodingAgent;
