// SPDX-License-Identifier: MIT
/**
 * Shared command registry — the single source of truth behind the Dashboard command palette
 * (⌘K) and, later, the slide-over control panels. Each command is a small descriptor whose
 * run(ctx) either navigates to a view, opens a drawer panel, or executes an IPC action.
 *
 * Because every IPC mutation flows through the brain-recording choke point in main.ts, any
 * action a command runs is automatically learned by the brain — the palette is a control
 * surface that's brain-aware for free.
 */
import type { FleetStore } from '../store.ts';
import { call } from '../store.ts';

export type Navigate = (view: string) => void;
export type OpenDrawer = (panelId: string) => void;

export interface CommandCtx {
  store: FleetStore;
  navigate: Navigate;
  openDrawer: OpenDrawer;
  /** Transient one-line feedback shown in the palette while/after a command runs. */
  setStatus: (msg: string) => void;
}

export interface Command {
  id: string;
  label: string;
  group: string;
  /** Extra search terms (space-separated) so a command is findable by intent, not just label. */
  keywords?: string;
  /** Right-aligned hint (target view, shortcut, …). */
  hint?: string;
  run: (ctx: CommandCtx) => void | Promise<void>;
}

/** The full-page views the palette can jump to (kept in sync with App's NAV). */
const VIEWS: { id: string; label: string; kw?: string }[] = [
  { id: 'dashboard', label: 'Dashboard', kw: 'home overview fleet' },
  { id: 'inbox', label: 'Inbox', kw: 'messages questions' },
  { id: 'tasks', label: 'Work · Tasks', kw: 'board kanban plans schedule loops dream' },
  { id: 'projects', label: 'Projects', kw: 'repo git register' },
  { id: 'health', label: 'Health', kw: 'status roster probe' },
  { id: 'identity', label: 'Identity & Keys', kw: 'wallet safe session' },
  { id: 'teams', label: 'HR Manager', kw: 'create team agent spawn org' },
  { id: 'modules', label: 'Capabilities', kw: 'skills plugins mcp' },
  { id: 'computer', label: 'Computer Use', kw: 'mac control broker' },
  { id: 'settings', label: 'Settings', kw: 'providers models inference managers update' },
];

/**
 * Build the live command list. Static today; later this composes per-agent / per-team /
 * per-project actions from the store so the palette covers "drive anything" end to end.
 */
export function buildCommands(store: FleetStore): Command[] {
  const cmds: Command[] = [];

  // ── Navigate ──
  for (const v of VIEWS) {
    cmds.push({ id: `go.${v.id}`, label: `Go to ${v.label}`, group: 'Navigate', keywords: v.kw, hint: 'view', run: (c) => c.navigate(v.id) });
  }

  // ── Control panels (slide-over) ──
  cmds.push({ id: 'panel.quick', label: 'Open quick controls', group: 'Control', keywords: 'drawer panel actions', hint: 'drawer', run: (c) => c.openDrawer('quick') });

  // ── Quick actions (run immediately; brain-recorded via the IPC choke point) ──
  cmds.push({
    id: 'projects.sync',
    label: 'Sync workspace projects',
    group: 'Projects',
    keywords: 'register import scan folder root',
    run: async (c) => {
      c.setStatus('Syncing workspace projects…');
      try {
        const r = await call<{ ok?: boolean; added?: number; adopted?: number; total?: number; error?: string }>('projects:syncRoot');
        c.setStatus(r?.ok === false ? `Sync failed: ${r?.error ?? 'unknown'}` : `Synced — ${r?.added ?? 0} added, ${r?.adopted ?? 0} adopted, ${r?.total ?? 0} total`);
        c.store.refresh();
      } catch (e) { c.setStatus(`Sync failed: ${e instanceof Error ? e.message : String(e)}`); }
    },
  });
  cmds.push({
    id: 'org.sync',
    label: 'Org sync now (recompose agent goals)',
    group: 'Org',
    keywords: 'hierarchy leads instructions rebuild brain',
    run: async (c) => {
      c.setStatus('Recomposing org & syncing the brain…');
      try {
        const r = await call<{ written?: number; rebuilt?: string[]; brain?: boolean }>('org:sync', {});
        c.setStatus(`Org synced — ${r?.written ?? 0} goals updated · ${r?.rebuilt?.length ?? 0} rebuilt · brain=${r?.brain ? 'ok' : 'n/a'}`);
      } catch (e) { c.setStatus(`Org sync failed: ${e instanceof Error ? e.message : String(e)}`); }
    },
  });
  cmds.push({
    id: 'fleet.probe',
    label: 'Probe all agents (health check)',
    group: 'Fleet',
    keywords: 'health status ping liveness',
    run: async (c) => {
      c.setStatus('Probing every agent…');
      try { await call('probeAll'); c.setStatus('Probe dispatched to all agents'); }
      catch (e) { c.setStatus(`Probe failed: ${e instanceof Error ? e.message : String(e)}`); }
    },
  });
  cmds.push({
    id: 'fleet.refresh',
    label: 'Refresh fleet snapshot',
    group: 'Fleet',
    keywords: 'reload update poll',
    run: (c) => { c.store.refresh(); c.setStatus('Refreshed'); },
  });

  return cmds;
}

/** Cheap subsequence-aware fuzzy filter + rank over label/group/keywords. */
export function filterCommands(cmds: Command[], query: string): Command[] {
  const q = query.trim().toLowerCase();
  if (!q) return cmds;
  const scored: { c: Command; score: number }[] = [];
  for (const c of cmds) {
    const hay = `${c.label} ${c.group} ${c.keywords ?? ''}`.toLowerCase();
    let score = -1;
    if (hay.includes(q)) score = 100 - hay.indexOf(q); // contiguous match, earlier = better
    else if (subsequence(q, hay)) score = 10;          // fuzzy subsequence fallback
    if (score >= 0) scored.push({ c, score });
  }
  return scored.sort((a, b) => b.score - a.score).map((s) => s.c);
}

function subsequence(needle: string, hay: string): boolean {
  let i = 0;
  for (let j = 0; j < hay.length && i < needle.length; j++) if (hay[j] === needle[i]) i++;
  return i === needle.length;
}
