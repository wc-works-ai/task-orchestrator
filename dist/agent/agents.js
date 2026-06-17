import { PiAgent } from './PiAgent.js';
import { CopilotAgent } from './CopilotAgent.js';
import { ExecAgent } from './ExecAgent.js';
const REGISTRY = {
    pi: (opts) => new PiAgent(opts),
    copilot: (opts) => new CopilotAgent(opts),
    exec: (opts) => new ExecAgent(opts),
};
export const SUPPORTED_AGENTS = Object.keys(REGISTRY);
export function createCodingAgent(name, opts) {
    const key = name === undefined || name === '' ? 'pi' : name;
    const make = REGISTRY[key];
    if (!make) {
        throw new Error(`Unsupported coding agent "${name}". Supported agents: ${SUPPORTED_AGENTS.join(', ')}`);
    }
    return make(opts);
}
//# sourceMappingURL=agents.js.map