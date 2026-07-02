import type { ManagerClient, McpServerSpec } from './client.ts';
import type { ProbeResult } from './types.ts';

export type StepStatus = 'pending' | 'running' | 'ok' | 'failed' | 'skipped';

export interface StepState {
  key: string;
  label: string;
  status: StepStatus;
  detail?: string;
  error?: string;
}

export interface OnboardPlan {
  name: string;
  team?: string;
  runtime?: string;
  model?: string;
  role?: string;
  /** Full multi-line persona; becomes the agent's roleBody (falls back to role). */
  description?: string;
  expertise?: string[];
  skills?: string[];
  wallet?: boolean;
  /** Interval heartbeat in seconds (omit/0 = no heartbeat). */
  heartbeatSeconds?: number;
  mcpServers?: McpServerSpec[];
  probeAfter?: boolean;
  /**
   * Retry mode for post-spawn failures. Spawn is intentionally not retried
   * because it is the creation boundary.
   */
  retry?: {
    agentId: string;
    stepKeys: string[];
  };
}

export interface OnboardHooks {
  onStep?: (step: StepState, steps: StepState[]) => void;
  prepareRuntime?: (plan: OnboardPlan, client: ManagerClient) => Promise<PreparedRuntime | undefined>;
}

export interface PreparedRuntime {
  /** Runtime used for the initial spawn. Undefined means spawn with the manager default. */
  spawnRuntime?: string;
  /** Model used for the initial spawn. Undefined means spawn with the manager default. */
  spawnModel?: string;
  /** Optional post-spawn runtime/model assignment, run before MCP/rebuild/probe. */
  assignAfterSpawn?: (agentId: string, client: ManagerClient, plan: OnboardPlan) => Promise<string | void>;
  label?: string;
  rebuildLabel?: string;
}

export interface OnboardResult {
  agentId?: string;
  name: string;
  steps: StepState[];
  ok: boolean;
}

type StepKey = 'preflight' | 'spawn' | 'runtime' | 'mcp' | 'rebuild' | 'probe';

export async function runOnboarding(
  baseClient: ManagerClient,
  plan: OnboardPlan,
  hooks: OnboardHooks = {},
): Promise<OnboardResult> {
  const client = plan.team ? baseClient.withTeam(plan.team) : baseClient;
  const retrying = plan.retry != null;
  const retryKeys = new Set<StepKey>((plan.retry?.stepKeys ?? []).filter(isStepKey));
  const steps: StepState[] = [];
  let agentId = plan.retry?.agentId;
  let needsRebuild = false;
  let preparedRuntime: PreparedRuntime | undefined;

  const emit = (step: StepState) => hooks.onStep?.({ ...step }, steps.map((s) => ({ ...s })));

  const run = async (
    key: StepKey,
    label: string,
    fn: () => Promise<string | void>,
    opts: { failSoft?: boolean; skip?: boolean; skipDetail?: string } = {},
  ): Promise<StepState> => {
    const step: StepState = {
      key,
      label,
      status: opts.skip ? 'skipped' : 'running',
      ...(opts.skipDetail ? { detail: opts.skipDetail } : {}),
    };
    steps.push(step);
    emit(step);
    if (opts.skip) return step;

    try {
      const detail = await fn();
      step.status = 'ok';
      if (detail) step.detail = detail;
    } catch (err) {
      step.status = 'failed';
      step.error = err instanceof Error ? err.message : String(err);
      if (!opts.failSoft) {
        emit(step);
        return step;
      }
    }
    emit(step);
    return step;
  };

  if (!retrying) {
    const preflight = await run('preflight', 'Validate name + team', async () => {
      const name = plan.name.trim();
      if (!name) throw new Error('Agent name is required.');
      const taken = (await client.agents()).some((a) => a.name === name);
      if (taken) throw new Error(`An agent named "${name}" already exists in this team.`);
      preparedRuntime = await hooks.prepareRuntime?.(plan, client);
    });
    if (preflight.status === 'failed') return finish();

    const spawn = await run('spawn', `Spawn ${plan.name}`, async () => {
      const res = await client.spawnAgent({
        name: plan.name.trim(),
        runtime: emptyToUndefined(preparedRuntime ? preparedRuntime.spawnRuntime : plan.runtime),
        model: emptyToUndefined(preparedRuntime ? preparedRuntime.spawnModel : plan.model),
        role: emptyToUndefined(plan.role),
        description: emptyToUndefined(plan.description),
        expertise: nonEmpty(plan.expertise),
        skills: nonEmpty(plan.skills),
        heartbeatSeconds: plan.heartbeatSeconds && plan.heartbeatSeconds > 0 ? plan.heartbeatSeconds : undefined,
        wallet: plan.wallet,
      });
      agentId = res.id;
      return `id ${res.id}${res.port ? ` :${res.port}` : ''}`;
    });
    if (spawn.status === 'failed' || !agentId) return finish();
  } else {
    await run('preflight', 'Validate name + team', async () => {}, {
      skip: true,
      skipDetail: 'retry mode',
    });
    await run('spawn', `Spawn ${plan.name}`, async () => {}, {
      skip: true,
      skipDetail: `already spawned (${agentId})`,
    });
  }

  if (preparedRuntime?.assignAfterSpawn || (retrying && retryKeys.has('runtime'))) {
    const shouldRunRuntime = !retrying || retryKeys.has('runtime');
    const runtime = await run(
      'runtime',
      preparedRuntime?.label ?? 'Assign runtime',
      async () => {
        preparedRuntime = preparedRuntime ?? await hooks.prepareRuntime?.(plan, client);
        if (!preparedRuntime?.assignAfterSpawn) return 'not needed';
        const detail = await preparedRuntime.assignAfterSpawn(agentId!, client, plan);
        needsRebuild = true;
        return detail;
      },
      shouldRunRuntime ? {} : { skip: true, skipDetail: 'not selected for retry' },
    );
    if (runtime.status === 'failed') return finish();
  }

  if (plan.mcpServers?.length) {
    const shouldRunMcp = !retrying || retryKeys.has('mcp');
    const mcp = await run(
      'mcp',
      'Attach MCP servers',
      async () => {
        const res = await client.setAgentMcp(agentId!, plan.mcpServers!);
        needsRebuild = needsRebuild || Boolean(res.needsRebuild);
        return `${res.mcpServers.length} server${res.mcpServers.length === 1 ? '' : 's'}`;
      },
      shouldRunMcp
        ? { failSoft: true }
        : { skip: true, skipDetail: 'not selected for retry' },
    );
    if (mcp.status === 'failed' && !preparedRuntime?.assignAfterSpawn) needsRebuild = false;
  } else if (!retrying) {
    await run('mcp', 'Attach MCP servers', async () => {}, { skip: true, skipDetail: 'none selected' });
  }

  const shouldRunRebuild = needsRebuild || (retrying && retryKeys.has('rebuild'));
  const rebuildLabel = preparedRuntime?.rebuildLabel ?? 'Rebuild to apply MCP';
  if (shouldRunRebuild) {
    await run('rebuild', rebuildLabel, () => client.restartAgent(plan.name), { failSoft: true });
  } else if (!retrying || retryKeys.has('mcp')) {
    await run('rebuild', rebuildLabel, async () => {}, {
      skip: true,
      skipDetail: needsRebuild ? undefined : 'not needed',
    });
  }

  const shouldProbe = plan.probeAfter !== false && (!retrying || retryKeys.has('probe'));
  if (shouldProbe) {
    await run('probe', 'Health probe', () => probeWithGrace(client, plan.name), {
      failSoft: true,
    });
  } else if (!retrying && plan.probeAfter === false) {
    await run('probe', 'Health probe', async () => {}, { skip: true, skipDetail: 'disabled' });
  }

  return finish();

  function finish(): OnboardResult {
    return {
      agentId,
      name: plan.name,
      steps,
      ok: steps.every((s) => s.status === 'ok' || s.status === 'skipped'),
    };
  }
}

function summarizeProbe(probe: ProbeResult): string {
  const firstFailed = probe.results.find((r) => r.status !== 'ok');
  if (probe.failed > 0) throw new Error(firstFailed?.error ?? `${probe.failed} probe(s) failed`);
  return `${probe.passed}/${probe.probed} passed`;
}

/**
 * Probe with a startup grace: a freshly-spawned agent takes a couple seconds to
 * bind its HTTP server, so an immediate probe gets a (transient) connection
 * failure. Retry for a short window before declaring the probe failed, so we
 * don't red-flag agents that are simply still booting.
 */
async function probeWithGrace(client: ManagerClient, name: string, graceMs = 12_000): Promise<string> {
  const deadline = Date.now() + graceMs;
  let last = '';
  for (;;) {
    try {
      const probe = await client.probeOne(name);
      if (probe.failed === 0) return summarizeProbe(probe); // healthy → done
      last = probe.results.find((r) => r.status !== 'ok')?.error ?? `${probe.failed} probe(s) failed`;
    } catch (e) {
      last = e instanceof Error ? e.message : String(e);
    }
    if (Date.now() >= deadline) throw new Error(last || 'probe failed after startup grace');
    await new Promise((r) => setTimeout(r, 2_000));
  }
}

function nonEmpty(values: string[] | undefined): string[] | undefined {
  const filtered = (values ?? []).map((v) => v.trim()).filter(Boolean);
  return filtered.length > 0 ? filtered : undefined;
}

function emptyToUndefined(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function isStepKey(key: string): key is StepKey {
  return key === 'preflight' || key === 'spawn' || key === 'runtime' || key === 'mcp' || key === 'rebuild' || key === 'probe';
}
