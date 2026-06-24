/**
 * Plan store (main process). Each plan is one JSON file under <config>/plans/,
 * holding the current markdown plus a versioned changelog of revisions, so a
 * requested plan is saved, can be regenerated/updated, and keeps its history.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, rmSync, renameSync, statSync, chmodSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';

function plansDir(): string {
  const env = process.env.IDCTL_CONFIG?.trim();
  const base = env
    ? dirname(env)
    : process.env.XDG_CONFIG_HOME?.trim()?.startsWith('/')
      ? join(process.env.XDG_CONFIG_HOME.trim(), 'idctl')
      : join(homedir(), '.config', 'idctl');
  const dir = join(base, 'plans');
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

export type PlanStatus = 'draft' | 'active' | 'done' | 'archived';
/** One changelog entry: the plan's content + the note for that version. */
export interface PlanRevision { version: number; at: number; note: string; content: string }
export interface Plan {
  id: string;
  title: string;
  request: string;       // the original objective the plan was generated from
  agent?: string;        // which agent generated/last-updated it
  team: string;
  status: PlanStatus;
  content: string;       // current plan markdown (== latest revision)
  version: number;       // current version (== revisions.length)
  revisions: PlanRevision[];
  tags?: string[];       // user-assigned tags/categories for organizing
  createdAt: number;
  updatedAt: number;
}
export interface PlanSummary { id: string; title: string; status: PlanStatus; version: number; agent?: string; team: string; updatedAt: number; tags?: string[] }

function fileFor(id: string): string {
  const safe = String(id).replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 80);
  if (!safe) throw new Error('invalid plan id');
  return join(plansDir(), `${safe}.json`);
}

export function listPlans(team?: string): PlanSummary[] {
  const dir = plansDir();
  const out: PlanSummary[] = [];
  for (const f of readdirSync(dir)) {
    if (!f.endsWith('.json')) continue;
    try {
      const p = JSON.parse(readFileSync(join(dir, f), 'utf8')) as Plan;
      if (team && p.team !== team) continue;
      out.push({ id: p.id, title: p.title || '(untitled plan)', status: p.status ?? 'draft', version: p.version ?? 1, agent: p.agent, team: p.team, updatedAt: p.updatedAt || 0, tags: Array.isArray(p.tags) ? p.tags : [] });
    } catch { /* skip corrupt */ }
  }
  return out.sort((a, b) => b.updatedAt - a.updatedAt);
}

export function getPlan(id: string): Plan | null {
  try {
    const f = fileFor(id);
    if (!existsSync(f)) return null;
    return JSON.parse(readFileSync(f, 'utf8')) as Plan;
  } catch { return null; }
}

export function savePlan(plan: Plan): { ok: boolean; id: string } {
  if (!plan?.id) throw new Error('plan id required');
  const f = fileFor(plan.id);
  const now = Date.now();
  const payload: Plan = {
    ...plan,
    title: (plan.title || '').slice(0, 200),
    // Keep history bounded — the most recent 50 revisions (with full content).
    revisions: (Array.isArray(plan.revisions) ? plan.revisions : []).slice(-50),
    createdAt: plan.createdAt || now,
    updatedAt: now,
  };
  const tmp = `${f}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(payload, null, 2) + '\n', { mode: 0o600 });
  try { renameSync(tmp, f); } catch (e) { try { rmSync(tmp, { force: true }); } catch { /* */ } throw e; }
  try { if ((statSync(f).mode & 0o077) !== 0) chmodSync(f, 0o600); } catch { /* best-effort */ }
  return { ok: true, id: plan.id };
}

export function removePlan(id: string): { ok: boolean } {
  try { rmSync(fileFor(id), { force: true }); return { ok: true }; } catch { return { ok: false }; }
}
