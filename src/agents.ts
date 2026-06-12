import { PiSpawner, type PiSpawnerOptions } from './PiSpawner.js';
import type { CodingAgent } from './CodingAgent.js';

const SUPPORTED_AGENTS = 'pi';

export function createCodingAgent(name: string | undefined, opts: PiSpawnerOptions): CodingAgent {
  if (name === undefined || name === '' || name === 'pi') return new PiSpawner(opts);
  throw new Error(`Unsupported coding agent "${name}". Supported agents: ${SUPPORTED_AGENTS}`);
}
