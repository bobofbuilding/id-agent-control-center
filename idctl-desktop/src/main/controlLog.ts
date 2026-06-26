// SPDX-License-Identifier: MIT
/**
 * Control-action → brain recorder (main process). Phase 1 of the "drive everything from the
 * Dashboard" refactor: make EVERY operator control action visible to the self-learning brain.
 *
 * Most config/control mutations write only the local settings store (or local fs) and never
 * reach the manager, so the manager→brain event stream never learns them. Even the ones that
 * DO route through the manager (runtime/instructions/spawn/deploy/concurrency) are event-silent
 * server-side. This module mirrors them all to the brain directly — a timeline audit event for
 * every action, plus richer entity/fact/text writes for the ones that deserve them — via the
 * shared BrainClient.
 *
 * It is invoked from ONE choke point: the ipcMain 'idagents:call' handler in main.ts. Because
 * every renderer call funnels there (bridge METHODS, bridge specials, and app-level appCall
 * methods all flow through it), a single registry covers the whole surface without editing any
 * call site. Fire-and-forget + best-effort: it never throws and never delays the IPC reply.
 *
 * Granularity note: this records ALL recognized control actions (the locked "learn everything"
 * decision). The ACTIONS map IS the allow-list — drop an entry to stop learning that action.
 */
import { brain } from '../../../idctl/src/api/brain.ts';

type Summary = { subject?: string; data?: Record<string, unknown>; tags?: string[] };

const s = (v: unknown): string => (typeof v === 'string' ? v : '');
const obj = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
const clip = (v: unknown, n: number): string => s(v).replace(/\s+/g, ' ').trim().slice(0, n);

/**
 * method → summarizer. Presence here = "record this action to the brain." Each summarizer is
 * cheap, synchronous, and secret-free (BrainClient.control redacts secret-named fields again as
 * defense-in-depth). args/result are exactly what the IPC method received/returned.
 */
const ACTIONS: Record<string, (args: unknown[], result: unknown) => Summary> = {
  // ── org / coordination (was client-side-only → brain blind) ──
  'coordinator:set': (a) => ({ subject: `team ${s(a[0])} lead → ${s(a[1])}`, data: { team: s(a[0]), agent: s(a[1]) }, tags: ['org'] }),
  'coordinator:setPrimary': (a) => ({ subject: `primary lead → ${s(a[1])} (${s(a[0])})`, data: { team: s(a[0]), agent: s(a[1]) }, tags: ['org'] }),
  'org:setSecondaryLeads': (a) => ({ subject: 'secondary leads updated', data: { leads: a[0] }, tags: ['org'] }),
  'org:setConfig': (a) => ({ subject: 'org-sync config changed', data: obj(a[0]), tags: ['org', 'cc-config'] }),

  // ── projects registry (was client-side-only) ──
  'projects:save': (a) => { const p = obj(a[0]); return { subject: `project saved: ${s(p.name) || s(p.id)}`, data: { id: p.id, name: p.name, status: p.status, team: p.team, autoCommit: p.autoCommit, tags: p.tags, path: p.path, lead: p.lead, policy: p.policy }, tags: ['project'] }; },
  'projects:remove': (a) => ({ subject: `project removed: ${s(a[0])}`, data: { id: s(a[0]) }, tags: ['project'] }),
  'projects:syncRoot': (a, r) => ({ subject: 'workspace projects synced', data: { root: a[0], ...obj(r) }, tags: ['project'] }),

  // ── task overlays (was client-side-only; the manager has no lane/deps/review field) ──
  'tasks:setLane': (a) => ({ subject: `task ${s(a[0])} → lane ${s(a[1])}`, data: { ref: s(a[0]), lane: s(a[1]) }, tags: ['task'] }),
  'tasks:setDeps': (a) => ({ subject: `task ${s(a[0])} deps set`, data: { ref: s(a[0]), deps: a[1] }, tags: ['task'] }),
  'tasks:setReview': (a) => ({ subject: `task ${s(a[0])} review → ${s(a[1])}`, data: { ref: s(a[0]), state: s(a[1]) }, tags: ['task'] }),

  // ── capability registries (was client-side-only) ──
  'mcp:add': (a) => ({ subject: `mcp server added: ${s(obj(a[0]).name)}`, data: obj(a[0]), tags: ['cc-config', 'mcp'] }),
  'mcp:remove': (a) => ({ subject: `mcp server removed: ${s(a[0])}`, data: { name: s(a[0]) }, tags: ['cc-config', 'mcp'] }),
  'providers:add': (a) => ({ subject: `provider added: ${s(obj(a[0]).name)}`, data: obj(a[0]), tags: ['cc-config', 'provider'] }),
  'providers:remove': (a) => ({ subject: `provider removed: ${s(a[0])}`, data: { name: s(a[0]) }, tags: ['cc-config', 'provider'] }),
  'providers:setDefault': (a) => ({ subject: `default provider → ${s(a[0])}`, data: { name: s(a[0]) }, tags: ['cc-config', 'provider'] }),
  'providers:toggle': (a) => ({ subject: `provider toggled: ${s(a[0])}`, data: { name: s(a[0]) }, tags: ['cc-config', 'provider'] }),
  'providers:connect': (a) => ({ subject: `provider connected: ${s(a[0])}`, data: { name: s(a[0]) }, tags: ['cc-config', 'provider'] }),

  // ── agent/team config writes (manager-routed but event-SILENT → brain didn't learn) ──
  setAgentRuntime: (a) => ({ subject: `agent ${s(a[0])} runtime → ${s(a[1])}`, data: { id: s(a[0]), runtime: s(a[1]), team: s(a[2]) }, tags: ['agent-config'] }),
  setAgentEffort: (a) => ({ subject: `agent ${s(a[0])} effort → ${s(a[1])}`, data: { id: s(a[0]), effort: s(a[1]), team: s(a[2]) }, tags: ['agent-config'] }),
  setAgentSpeed: (a) => ({ subject: `agent ${s(a[0])} speed → ${s(a[1])}`, data: { id: s(a[0]), speed: s(a[1]), team: s(a[2]) }, tags: ['agent-config'] }),
  'agent:setInstructions': (a) => ({ subject: `agent ${s(a[0])} instructions updated`, data: { id: s(a[0]), team: s(a[2]), chars: s(a[1]).length }, tags: ['agent-config'] }),
  'agent:move': (a) => ({ subject: `agent ${s(a[0])} → team ${s(a[1])}`, data: { id: s(a[0]), team: s(a[1]) }, tags: ['agent-config'] }),
  setAgentMcp: (a) => ({ subject: `agent ${s(a[0])} mcp updated`, data: { id: s(a[0]) }, tags: ['agent-config', 'mcp'] }),
  setAgentDelegates: (a) => ({ subject: `agent ${s(a[0])} delegates set`, data: { id: s(a[0]), delegates: a[1] }, tags: ['agent-config'] }),
  setTeamDelegates: (a) => ({ subject: `team ${s(a[0])} delegates set`, data: { team: s(a[0]), delegates: a[1] }, tags: ['team-config'] }),
  spawnAgent: (a) => { const sp = obj(a[0]); return { subject: `agent spawned: ${s(sp.name)}`, data: { name: sp.name, runtime: sp.runtime, model: sp.model, role: sp.role }, tags: ['agent-config', 'lifecycle'] }; },
  deployTeam: (a) => ({ subject: `team deployed: ${s(a[0])}`, data: { team: s(a[0]) }, tags: ['team-config', 'lifecycle'] }),
  'team:lifecycle': (a) => ({ subject: `team ${s(a[0])} ${s(a[1])}`, data: { team: s(a[0]), op: s(a[1]) }, tags: ['team-config', 'lifecycle'] }),
  'team:delete': (a) => ({ subject: `team deleted: ${s(a[0])}`, data: { team: s(a[0]) }, tags: ['team-config', 'lifecycle'] }),
  'team:install': (a) => ({ subject: `team installed: ${s(a[1])} (from ${s(a[0])})`, data: { template: s(a[0]), to: s(a[1]) }, tags: ['team-config'] }),
  rebuildAgent: (a) => ({ subject: `agent rebuilt: ${s(a[0])}`, data: { agent: s(a[0]), team: s(a[1]) }, tags: ['lifecycle'] }),
  'manager:setLocalConcurrency': (a) => ({ subject: `local concurrency → ${Number(a[0])}`, data: { n: Number(a[0]) }, tags: ['cc-config'] }),

  // ── capabilities (skills + computer-use) ──
  installSkill: (a) => ({ subject: `skill installed: ${s(a[0])} → ${s(a[1])}`, data: { skill: s(a[0]), agent: s(a[1]), team: s(a[2]) }, tags: ['capability'] }),
  uninstallSkill: (a) => ({ subject: `skill removed: ${s(a[0])} ✗ ${s(a[1])}`, data: { skill: s(a[0]), agent: s(a[1]), team: s(a[2]) }, tags: ['capability'] }),
  createSkill: (a) => ({ subject: 'skill created', data: obj(a[0]), tags: ['capability'] }),
  deleteSkill: (a) => ({ subject: `skill deleted: ${s(a[0])}`, data: { name: s(a[0]) }, tags: ['capability'] }),
  'cu:attach': (a) => ({ subject: `computer-use attached: ${s(a[1]) || s(a[0])}`, data: { agent: s(a[1]) || s(a[0]) }, tags: ['capability', 'computer-use'] }),
  'cu:detach': (a) => ({ subject: `computer-use detached: ${s(a[1]) || s(a[0])}`, data: { agent: s(a[1]) || s(a[0]) }, tags: ['capability', 'computer-use'] }),

  // ── project work orchestration (project-framed decisions) ──
  'work:createPlan': (a) => ({ subject: `plan dispatched: ${clip(a[0], 80)}`, data: { objective: clip(a[0], 400), subtasks: Array.isArray(a[1]) ? a[1].length : 0, team: s(obj(a[2]).team) }, tags: ['project', 'dispatch'] }),
  'work:fanout': (a) => ({ subject: `fan-out: ${clip(a[0], 80)}`, data: { objective: clip(a[0], 400), teams: a[1] }, tags: ['project', 'dispatch'] }),
  'work:triage': (a) => ({ subject: `triage by ${s(a[0])}`, data: { lead: s(a[0]), team: s(a[1]) }, tags: ['project', 'dispatch'] }),

  // ── brain plans + dreams + questions (out-of-band fs/git; brain learned only incidentally) ──
  'brain:createPlan': (a, r) => ({ subject: `brain plan created: ${clip(a[0], 80)}`, data: obj(r), tags: ['brain-plan'] }),
  'brain:setPlanStatus': (a, r) => ({ subject: `plan ${s(a[0])} → ${s(a[1])}`, data: { file: s(a[0]), ...obj(r) }, tags: ['brain-plan'] }),
  'dreams:save': (a) => { const d = obj(a[0]); return { subject: `dream saved: ${clip(d.title, 80)}`, data: { id: d.id, agent: d.agent, team: d.team, focus: d.focus }, tags: ['dream'] }; },
  'questions:add': (a) => { const q = obj(a[0]); return { subject: `blocker question: ${clip(q.question, 80)}`, data: { id: q.id, agent: q.agent, taskRef: q.taskRef, options: q.options, team: q.team }, tags: ['decision'] }; },
};

/** Actions that ALSO warrant a richer write (entity upsert / text ingest) beyond the timeline. */
const EXTRAS: Record<string, (args: unknown[], result: unknown) => void> = {
  'projects:save': (a) => {
    const p = obj(a[0]);
    if (!p.id) return;
    const id = `project:${s(p.id)}`;
    void brain.entity({
      id, type: 'project', name: s(p.name) || s(p.id), status: s(p.status) || 'active',
      tags: ['project', ...(Array.isArray(p.tags) ? p.tags.map(String) : [])],
      data: { team: p.team, autoCommit: p.autoCommit, path: p.path, links: p.links, lead: p.lead, policy: p.policy },
    });
    void brain.facts([
      { entity_id: id, field: 'team', value: s(p.team) },
      { entity_id: id, field: 'status', value: s(p.status) },
      ...(p.lead ? [{ entity_id: id, field: 'lead', value: s(p.lead) }] : []),
    ]);
  },
  'brain:createPlan': (a, r) => {
    const res = obj(r);
    if (!res.ok) return;
    void brain.ingestText({ sourceKind: 'idagents-brain-plan', sourceId: `brain-plan:${s(res.file)}`, title: s(a[0]), content: s(a[1]), metadata: { num: res.num, file: res.file } });
  },
  'dreams:save': (a) => {
    const d = obj(a[0]);
    if (!d.id || !s(d.content).trim()) return;
    void brain.ingestText({ sourceKind: 'idagents-dream', sourceId: `dream:${s(d.id)}`, title: s(d.title) || 'dream', content: s(d.content), metadata: { agent: d.agent, team: d.team, focus: d.focus } });
  },
};

/** Mirror a successful control action to the brain. Best-effort, never throws, never awaited. */
export function recordControlAction(method: string, args: unknown[], result: unknown): void {
  try {
    const summarize = ACTIONS[method];
    if (summarize) {
      let out: Summary;
      try { out = summarize(args, result) ?? {}; } catch { out = {}; }
      void brain.control(method, out);
    }
    const extra = EXTRAS[method];
    if (extra) { try { extra(args, result); } catch { /* best-effort */ } }
  } catch { /* telemetry must never break the IPC reply */ }
}

/** The set of methods that are recorded (for tests / introspection). */
export const RECORDED_ACTIONS = new Set(Object.keys(ACTIONS));
