import { PiSpawner } from './PiSpawner.js';
import { CopilotCliAgent } from './CopilotCliAgent.js';
import type { CodingAgent, CodingAgentOptions } from './CodingAgent.js';

const REGISTRY: Record<string, (opts: CodingAgentOptions) => CodingAgent> = {
  pi: (opts) => new PiSpawner(opts),
  copilot: (opts) => new CopilotCliAgent(opts),
};

export const SUPPORTED_AGENTS = Object.keys(REGISTRY);

export function createCodingAgent(name: string | undefined, opts: CodingAgentOptions): CodingAgent {
  const key = name === undefined || name === '' ? 'pi' : name;
  const make = REGISTRY[key];
  if (!make) {
    throw new Error(`Unsupported coding agent "${name}". Supported agents: ${SUPPORTED_AGENTS.join(', ')}`);
  }
  return make(opts);
}
