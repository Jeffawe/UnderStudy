/**
 * Picking a reasoner.
 *
 * ONLY ONE OF THE TWO IS SELECTABLE HERE, and that asymmetry is real rather
 * than an omission. `HostAgentReasoner` is constructed directly by
 * `session.ts` because the caller needs more than the `Reasoner` interface
 * exposes — `pending`, `nextSuspensionOr()`, `answer()` — which is the
 * machinery that lets an MCP tool call return at a suspension instead of
 * blocking on a human. Anything that can be satisfied by the plain interface
 * (the CLI, a scheduled run, anything headless) wants this factory.
 *
 * So: Mode B is chosen by being in an agent session; Mode A is chosen here.
 */

import type { Reasoner } from '../../core/types.js';
import { BedrockReasoner } from './bedrock.js';

export function createReasoner(id = process.env.REASONER ?? 'bedrock'): Reasoner {
  switch (id) {
    case 'bedrock':
      return new BedrockReasoner();
    case 'host-agent':
      throw new Error(
        'the host-agent reasoner cannot be built here — it suspends, so it is only usable ' +
          'through the MCP server (run_plan / resume_run). Use REASONER=bedrock for headless runs.',
      );
    default:
      throw new Error(`unknown REASONER '${id}'`);
  }
}

export { BedrockReasoner };
export { HostAgentReasoner, vocabularyLines } from './host-agent.js';
