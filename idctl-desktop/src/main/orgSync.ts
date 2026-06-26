// SPDX-License-Identifier: MIT
/**
 * Reactive "Org Sync" — keeps every agent's goals & instructions file in sync with
 * its place in the lead hierarchy AND with the brain's live team-instruction memories.
 *
 * Hierarchy (top → bottom):
 *   primary lead  →  secondary leads (researcher, coder on the default team)  →  team leads  →  workers
 *
 * Each agent's `.id-instructions.md` sidecar gets a marker-fenced "org block" composed
 * from the hierarchy: it tells the agent who it delegates DOWN to and who it relays UP to,
 * and embeds the current brain team-instructions for its team. The block is upserted between
 * markers so any manual instructions the user added are preserved. The sidecar takes effect
 * on the agent's next rebuild — see the "smart" rebuild policy in syncOrg().
 */
import type { ManagerClient } from '../../../idctl/src/api/client.ts';
import type { Agent, Task } from '../../../idctl/src/api/types.ts';
import { loadSettings, type SecondaryLead } from '../../../idctl/src/settings/store.ts';
import { brain } from '../../../idctl/src/api/brain.ts';
import { isActiveStatus } from './work.ts';

const ORG_BEGIN = '<!-- BEGIN id-agents org -->';
const ORG_END = '<!-- END id-agents org -->';
// Cap rebuilds per pass so a fleet-wide instruction change doesn't restart everyone at once
// (writes are cheap and unbounded; only the disruptive rebuilds are throttled).
const MAX_REBUILDS_PER_PASS = 3;

export interface OrgHierarchy {
  primary: { team: string; agent: string } | null;
  secondaries: SecondaryLead[];
  coordinators: Record<string, string>; // team → team-lead agent name
  teams: string[];
}

export interface OrgSyncResult {
  hierarchy: OrgHierarchy;
  agents: number;
  written: number;     // sidecars whose org block changed and were rewritten
  rebuilt: string[];   // agents rebuilt this pass (idle + changed, rate-limited)
  brain: boolean;      // org structure written back to the brain
  skippedBusy: number; // changed sidecars whose agent was mid-task (rebuild deferred)
}

function secondaryDomainTeams(teams: string[]): { research: string[]; coder: string[] } {
  const others = teams.filter((t) => t !== 'default' && t !== 'public').sort((a, b) => a.localeCompare(b));
  const research = others.filter((t) => /research|security|intel|analy|audit/i.test(t));
  const coder = others.filter((t) => !research.includes(t));
  return { research, coder };
}

/** Default secondary leads when none are configured: researcher + coder on `default`,
 *  splitting the other teams by domain (research/security → researcher, the rest → coder). */
function defaultSecondaries(teams: string[]): SecondaryLead[] {
  const { research, coder } = secondaryDomainTeams(teams);
  return [
    { agent: 'researcher', team: 'default', leadsTeams: research },
    { agent: 'coder', team: 'default', leadsTeams: coder },
  ];
}

function mergeConfiguredSecondaries(configured: SecondaryLead[], teams: string[]): SecondaryLead[] {
  const configuredCopy = configured.map((s) => ({
    ...s,
    leadsTeams: Array.from(new Set(s.leadsTeams ?? [])).sort((a, b) => a.localeCompare(b)),
  }));
  const covered = new Set(configuredCopy.flatMap((s) => s.leadsTeams));
  const uncovered = teams.filter((t) => t !== 'default' && t !== 'public' && !covered.has(t));
  if (!uncovered.length) return configuredCopy.sort((a, b) => a.agent.localeCompare(b.agent));

  const { research, coder } = secondaryDomainTeams(uncovered);
  const ensureSecondary = (agent: string): SecondaryLead => {
    let sec = configuredCopy.find((s) => s.agent === agent);
    if (!sec) {
      sec = { agent, team: 'default', leadsTeams: [] };
      configuredCopy.push(sec);
    }
    return sec;
  };
  const addTeams = (agent: string, names: string[]) => {
    if (!names.length) return;
    const sec = ensureSecondary(agent);
    sec.leadsTeams = Array.from(new Set([...(sec.leadsTeams ?? []), ...names])).sort((a, b) => a.localeCompare(b));
  };

  addTeams('researcher', research);
  addTeams('coder', coder);
  return configuredCopy.sort((a, b) => a.agent.localeCompare(b.agent));
}

export async function buildOrgHierarchy(client: ManagerClient): Promise<OrgHierarchy> {
  const cfg = loadSettings();
  const teams = (await client.teams().catch(() => [])).map((t) => t.name).filter(Boolean).sort((a, b) => a.localeCompare(b));
  const coordinators = cfg.coordinators ?? {};
  const primary = cfg.primaryCoordinator ?? null;
  const secondaries = cfg.secondaryLeads?.length ? mergeConfiguredSecondaries(cfg.secondaryLeads, teams) : defaultSecondaries(teams);
  return { primary, secondaries, coordinators, teams };
}

type RoleInfo =
  | { role: 'primary' }
  | { role: 'secondary'; sec: SecondaryLead }
  | { role: 'teamlead'; team: string; secondary?: SecondaryLead }
  | { role: 'worker'; team: string; lead?: string };

function classify(agentName: string, team: string, hier: OrgHierarchy): RoleInfo {
  if (hier.primary && agentName === hier.primary.agent) return { role: 'primary' };
  const sec = hier.secondaries.find((s) => s.agent === agentName);
  if (sec) return { role: 'secondary', sec };
  if (hier.coordinators[team] === agentName) {
    return { role: 'teamlead', team, secondary: hier.secondaries.find((s) => s.leadsTeams.includes(team)) };
  }
  return { role: 'worker', team, lead: hier.coordinators[team] };
}

/** Compose the marker-fenced org block for one agent. Deterministic (no timestamps) so the
 *  change-detection in syncOrg() is stable. */
function composeOrgBlock(
  agentName: string,
  team: string,
  hier: OrgHierarchy,
  rosters: Record<string, string[]>,
  brainLines: string[],
): string {
  const info = classify(agentName, team, hier);
  const primaryName = hier.primary?.agent ?? '(primary lead — unset)';
  const out: string[] = ['## Your place in the org'];

  if (info.role === 'primary') {
    out.push('You are the **PRIMARY LEAD** of the whole fleet.');
    const secs = hier.secondaries.map((s) => `**${s.agent}** (oversees ${s.leadsTeams.join(', ') || '—'})`);
    out.push(`Your secondary leads are ${secs.join(' and ')}. They each collect their teams' progress, sequence it, and relay a consolidated status up to you — expect relays from them, not raw per-agent chatter.`);
    out.push(`Set direction and priorities, then hand objectives to your secondary leads: ${hier.secondaries.map((s) => `\`/ask ${s.agent} "<objective>"\``).join(', ')}.`);
  } else if (info.role === 'secondary') {
    out.push(`You are a **SECONDARY LEAD**, reporting up to the primary lead **${primaryName}**.`);
    const leadList = info.sec.leadsTeams.map((t) => `**${hier.coordinators[t] ?? '(no lead)'}** (${t})`).join(', ');
    out.push(`You delegate DOWN to these team leads (and their agents when needed): ${leadList || '— none assigned —'}.`);
    out.push(`Workflow: hand scoped objectives down with \`/ask <team-lead> "..."\`; collect their results; **sequence** them into one coherent summary; relay UP with \`/ask ${primaryName} "<consolidated status, blockers, decisions needed>"\`. You are the buffer between the primary and the teams — absorb detail, surface what matters.`);
  } else if (info.role === 'teamlead') {
    out.push(`You are the **LEAD of the ${team} team**.`);
    const mates = (rosters[team] ?? []).filter((n) => n !== agentName);
    if (mates.length) out.push(`Your teammates: ${mates.map((m) => `**${m}**`).join(', ')}. Break objectives into tasks for them, assign and track to completion.`);
    if (info.secondary) out.push(`You report UP to your secondary lead **${info.secondary.agent}** — relay your team's status, blockers, and completions with \`/ask ${info.secondary.agent} "..."\`. Don't bypass them to the primary.`);
    else out.push(`You report UP to the primary lead **${primaryName}** with \`/ask ${primaryName} "..."\`.`);
  } else {
    out.push(`You are a **member of the ${team} team**.`);
    if (info.lead) out.push(`Your team lead is **${info.lead}**. Do your assigned tasks, mark them done when finished, and surface blockers or questions with \`/ask ${info.lead} "..."\` — your lead relays them up the chain.`);
    else out.push('Do your assigned tasks and mark them done when finished.');
  }

  // PARALLEL-delegation guard (concurrency): every coordinator must fan INDEPENDENT work out at
  // once — synchronous /talk-to to multiple teammates serializes them so 2+ subscription agents
  // can never run at the same time through a lead. See Teams.tsx COORDINATION_TAIL (do not revert).
  if (info.role === 'primary' || info.role === 'secondary' || info.role === 'teamlead') {
    out.push(
      'When you delegate INDEPENDENT work to more than one teammate/lead, **fan it out IN PARALLEL** — ' +
      'fire async `/news-to <agent> "<task>" (trigger:true)` to each at once so they run concurrently on ' +
      'their own processes, then collect via `/news` (bounded; re-send once or report blocked if one goes ' +
      "quiet). Use synchronous `/talk-to` ONLY for a step that needs another's output first, or a single " +
      'quick hand-off. Never run independent delegations one-at-a-time.',
    );
  }

  if (brainLines.length) {
    out.push('', '## Current team instructions (synced from the brain)');
    for (const b of brainLines) out.push(`- ${b}`);
  }
  return `${ORG_BEGIN}\n${out.join('\n')}\n${ORG_END}`;
}

/** Pull the brain's current team-instruction memories for a team (best-effort, short timeout). */
async function brainInstructions(team: string): Promise<string[]> {
  const memories = await brain.sharedMemory({ tag: 'team-instruction', project: team, limit: 8 });
  return memories
    .filter((m) => m.agent_id === 'team-instructions' && m.content && m.mem_key !== 'org:hierarchy')
    .map((m) => `${String(m.content).trim()}${m.id ? ` [memory:${m.id}]` : ''}`);
}

function renderOrgSummary(hier: OrgHierarchy): string {
  const lines = ['Fleet leadership hierarchy (org chart):', `- Primary lead: ${hier.primary?.agent ?? '(unset)'} (${hier.primary?.team ?? '?'})`];
  for (const s of hier.secondaries) {
    lines.push(`- Secondary lead ${s.agent}: oversees ${s.leadsTeams.join(', ') || '—'}, relays up to ${hier.primary?.agent ?? '(primary)'}`);
    for (const t of s.leadsTeams) lines.push(`    - ${t} team lead: ${hier.coordinators[t] ?? '(none)'}`);
  }
  return lines.join('\n');
}

/** Write the hierarchy back to the brain as a keyed shared memory so the brain holds the
 *  org structure as a source of truth (and the manager can inject it per-dispatch). Uses the
 *  shared BrainClient: visibility='public' (shared:true) so GET /memory/shared returns it;
 *  mem_key upserts by (agent_id, key) so no duplicates. */
async function writeOrgToBrain(hier: OrgHierarchy): Promise<boolean> {
  return brain.memory('team-instructions', {
    content: renderOrgSummary(hier),
    key: 'org:hierarchy',
    tags: ['team-instruction', 'org-structure'],
    shared: true,
  });
}

/** Upsert the org block into the sidecar text, preserving anything outside the markers. */
function upsertOrgBlock(existing: string, block: string): string {
  const b = existing.indexOf(ORG_BEGIN);
  const e = existing.indexOf(ORG_END);
  if (b !== -1 && e !== -1 && e > b) {
    const before = existing.slice(0, b);
    const afterRaw = existing.slice(e + ORG_END.length);
    const after = afterRaw.startsWith('\n') ? afterRaw.slice(1) : afterRaw;
    return `${before}${block}${after}`;
  }
  if (!existing.trim()) return `${block}\n`;
  const sep = existing.endsWith('\n\n') ? '' : existing.endsWith('\n') ? '\n' : '\n\n';
  return `${existing}${sep}${block}\n`;
}

/** An agent is "idle" (safe to rebuild) when it doesn't currently own a task that's being worked. */
function isAgentIdle(agentName: string, tasks: Task[]): boolean {
  return !tasks.some((t) => t.ownerName === agentName && /doing|progress|active|start|claim/i.test(t.status));
}

// A query event whose latest status is one of these is FINISHED; anything else (dispatched /
// received / processing / queued) means the agent is mid-query.
const QUERY_DONE_RE = /deliver|done|complete|fail|cancel|expire|timeout/i;
/**
 * Agents with an IN-FLIGHT query (a chat /ask, not a tracked task) — they must NOT be rebuilt:
 * a rebuild stops the agent, which cancels its pending query, so the user's chat reply is lost
 * ("the query was lost. Please resend."). isAgentIdle() only looks at TASKS and is blind to this,
 * so we read each team's recent event tail and flag any agent whose latest `query:*` event hasn't
 * reached a terminal status. Best-effort (bounded event window); a miss only risks the pre-existing
 * behavior, a false-positive just defers a rebuild one pass (harmless).
 */
async function collectQueryBusy(client: ManagerClient, teams: string[]): Promise<Set<string>> {
  const busy = new Set<string>();
  await Promise.all(
    teams.map(async (team) => {
      const tc = client.withTeam(team);
      try {
        const head = await tc.events(0, { wait: 0, limit: 1 });
        const next = Number((head as { next_seq?: number }).next_seq) || 0;
        const r = await tc.events(Math.max(0, next - 150), { wait: 0, limit: 150 });
        const latest = new Map<string, { seq: number; status: string }>(); // agent → its newest query-event status
        for (const e of (r.events ?? []) as { topic?: string; seq?: number; actor?: string; data?: Record<string, unknown> }[]) {
          const topic = String(e.topic ?? '');
          if (!topic.startsWith('query:')) continue;
          const d = e.data ?? {};
          const agent = String(d.agent ?? e.actor ?? d.target ?? d.name ?? '');
          if (!agent) continue;
          const seq = Number(e.seq) || 0;
          const prev = latest.get(agent);
          if (!prev || seq >= prev.seq) latest.set(agent, { seq, status: topic.slice('query:'.length) });
        }
        for (const [agent, { status }] of latest) if (!QUERY_DONE_RE.test(status)) busy.add(agent);
      } catch { /* best-effort */ }
    }),
  );
  return busy;
}

/**
 * One reconcile pass: recompose every agent's org block, write the ones that changed, and
 * (smart policy) rebuild a changed agent only if it's idle — rate-limited per pass.
 */
export async function syncOrg(client: ManagerClient, opts: { autoRebuild?: boolean } = {}): Promise<OrgSyncResult> {
  const autoRebuild = opts.autoRebuild !== false;
  const hier = await buildOrgHierarchy(client);

  const rosters: Record<string, string[]> = {};
  const all: { agent: Agent; team: string }[] = [];
  for (const team of hier.teams) {
    const ags = await client.withTeam(team).agents().catch(() => [] as Agent[]);
    rosters[team] = ags.filter((a) => isActiveStatus(a.status)).map((a) => a.name);
    for (const a of ags) all.push({ agent: a, team });
  }
  const brainByTeam: Record<string, string[]> = {};
  for (const team of hier.teams) brainByTeam[team] = await brainInstructions(team);
  const tasks = await client.tasks().catch(() => [] as Task[]);
  // Agents mid-chat-query (a rebuild would cancel the query → "the query was lost. Please resend.").
  const queryBusy = autoRebuild ? await collectQueryBusy(client, hier.teams) : new Set<string>();
  const brain = await writeOrgToBrain(hier);

  let written = 0;
  let skippedBusy = 0;
  const rebuilt: string[] = [];
  for (const { agent, team } of all) {
    const block = composeOrgBlock(agent.name, team, hier, rosters, brainByTeam[team] ?? []);
    const tc = client.withTeam(team);
    const current = await tc.agentInstructions(agent.name).catch(() => '');
    const next = upsertOrgBlock(current, block);
    if (next.trim() === current.trim()) continue;
    await tc.setAgentInstructions(agent.name, next).catch(() => {});
    written++;
    if (!autoRebuild || !isActiveStatus(agent.status)) continue;
    if (!isAgentIdle(agent.name, tasks)) { skippedBusy++; continue; }   // mid-task → defer to next natural rebuild
    if (queryBusy.has(agent.name)) { skippedBusy++; continue; }         // mid-chat-query → defer (rebuild would lose the reply)
    if (rebuilt.length >= MAX_REBUILDS_PER_PASS) { skippedBusy++; continue; }
    await tc.remote(`/agent ${agent.name} rebuild`).catch(() => {});
    rebuilt.push(agent.name);
  }
  return { hierarchy: hier, agents: all.length, written, rebuilt, brain, skippedBusy };
}

/**
 * Start the reactive loop: one pass shortly after boot, then every `intervalMs`. Single-flight.
 * Returns a stop function. Honors the `orgSync.enabled` config flag (default on). Takes a getter
 * so it always uses the live client even if it's reassigned (manager/team switch).
 */
export function startOrgSyncLoop(getClient: () => ManagerClient, intervalMs = 5 * 60_000): () => void {
  let running = false;
  let stopped = false;
  const tick = async (): Promise<void> => {
    if (running || stopped) return;
    const cfg = loadSettings();
    if (cfg.orgSync?.enabled === false) return; // explicitly disabled
    running = true;
    try {
      const r = await syncOrg(getClient(), { autoRebuild: cfg.orgSync?.autoRebuild !== false });
      if (r.written || r.rebuilt.length) {
        console.log(`[org-sync] ${r.written} goals updated · rebuilt ${r.rebuilt.length} (${r.rebuilt.join(', ') || '—'}) · ${r.skippedBusy} deferred (busy) · brain=${r.brain}`);
      }
    } catch (e) {
      console.error('[org-sync] pass failed:', e instanceof Error ? e.message : e);
    } finally {
      running = false;
    }
  };
  const startTimer = setTimeout(() => void tick(), 15_000); // let the app settle first
  (startTimer as { unref?: () => void }).unref?.();
  const h = setInterval(() => void tick(), intervalMs);
  (h as { unref?: () => void }).unref?.();
  return () => { stopped = true; clearTimeout(startTimer); clearInterval(h); };
}
