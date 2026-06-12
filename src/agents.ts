import { PiSpawner, type PiSpawnerOptions } from './PiSpawner.js';
import { CopilotCliAgent } from './CopilotCliAgent.js';
import type { CodingAgent } from './CodingAgent.js';

const SUPPORTED_AGENTS = 'pi, copilot';

export function createCodingAgent(name: string | undefined, opts: PiSpawnerOptions): CodingAgent {
  if (name === undefined || name === '' || name === 'pi') return new PiSpawner(opts);
  if (name === 'copilot') return new CopilotCliAgent(opts);
  throw new Error(`Unsupported coding agent "${name}". Supported agents: ${SUPPORTED_AGENTS}`);
}
