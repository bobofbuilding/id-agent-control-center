/**
 * assign — bridge a discovered model onto a manager agent. No new manager
 * endpoints needed; uses POST /agents/:id/model (+ optional rebuild).
 *
 * Hard truths surfaced to the UI (verified against the manager source):
 *  - Only agents with type==='claude' accept a model (ollama-runtime agents
 *    qualify; remote/public ones do not). assignableAgents() pre-filters.
 *  - The change is NOT live: the agent must be restarted to load it.
 *  - idctl cannot change an agent's RUNTIME or the manager's OLLAMA_BASE_URL
 *    over HTTP — those are creation-time / manager-env concerns.
 */

import type { ManagerClient } from '../api/client.ts';
import type { Agent } from '../api/types.ts';

export interface AssignResult {
  message: string;
  restarted: boolean;
}

/** Agents that can actually accept a model assignment. */
export function isAssignable(a: Agent): boolean {
  return (a.type ?? '') === 'claude';
}
export function assignableAgents(agents: Agent[]): Agent[] {
  return agents.filter(isAssignable);
}

/** Why an agent can't take a model (for dimmed UI rows). */
export function ineligibleReason(a: Agent): string | undefined {
  if (isAssignable(a)) return undefined;
  return `runtime "${a.runtime ?? a.type ?? 'remote'}" has no local model`;
}

/**
 * Assign `model` to the agent, optionally restarting to apply immediately.
 * When restart is requested we prefer the /remote `/model` path because it runs
 * the manager's alias resolver (Claude shortcuts expand); for raw ids (e.g.
 * `qwen3:4b`) it stores verbatim. The REST route is used for the no-restart
 * path so we get the manager's exact confirmation message back.
 */
export async function assignModel(
  client: ManagerClient,
  agent: Agent,
  model: string,
  opts: { restart?: boolean; signal?: AbortSignal } = {},
): Promise<AssignResult> {
  if (!isAssignable(agent)) {
    throw new Error(ineligibleReason(agent) ?? 'agent does not accept a model');
  }
  if (opts.restart) {
    await client.remote(`/model ${agent.name} ${model}`, undefined, opts.signal);
    await client.restartAgent(agent.name, opts.signal);
    return { message: `model set to ${model} and ${agent.name} restarting`, restarted: true };
  }
  const r = await client.setAgentModel(agent.id, model, opts.signal);
  return { message: r.message ?? 'model updated (restart the agent to apply)', restarted: false };
}
