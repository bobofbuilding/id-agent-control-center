import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { configDir, resolveConfigPath } from '../../../idctl/src/settings/paths.ts';
import { estimateTokens, optimizeAskCommandCore, type ContextBudgetDecision, type ContextBudgetOptions } from '../shared/contextBudget.ts';

export interface ContextBudgetRecord {
  id: string;
  createdAt: number;
  source: string;
  team?: string;
  target?: string;
  route: ContextBudgetDecision['route'];
  originalTokens: number;
  sentTokens: number;
  savedTokens: number;
  savingsRatio: number;
  transforms: string[];
  reasons: string[];
  guardrails: string[];
  originalHash: string;
  sentHash: string;
  originalCommand: string;
  sentCommand: string;
}

export interface ContextBudgetReport {
  coreEnabled: true;
  frontendSurface: 'hidden';
  inspected: number;
  optimized: number;
  direct: number;
  protectedDirect: number;
  originalTokens: number;
  sentTokens: number;
  savedTokens: number;
  savingsRatio: number;
  recent: ContextBudgetRecord[];
  storageDir: string;
  policy: {
    route: 'deterministic-first';
    headroomEngine: 'not-required-for-core-budgeting';
    retrieval: 'local-audit-records-only';
  };
  qualityGuards: string[];
}

const MAX_RECENT = 80;
const recent: ContextBudgetRecord[] = [];
const totals = {
  inspected: 0,
  optimized: 0,
  direct: 0,
  protectedDirect: 0,
  originalTokens: 0,
  sentTokens: 0,
  savedTokens: 0,
};

function budgetDir(): string {
  const dir = join(configDir(resolveConfigPath()), 'context-budget');
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

function hashText(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

function recordId(hash: string): string {
  return `cb_${Date.now().toString(36)}_${hash.slice(0, 12)}`;
}

function writeRecord(record: ContextBudgetRecord): void {
  const dir = budgetDir();
  const file = join(dir, `${record.id}.json`);
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(record, null, 2) + '\n', { mode: 0o600 });
  try {
    renameSync(tmp, file);
  } catch (err) {
    try { rmSync(tmp, { force: true }); } catch { /* ignore cleanup */ }
    throw err;
  }
}

function remember(decision: ContextBudgetDecision): void {
  totals.inspected += 1;
  totals.originalTokens += decision.originalTokens;
  totals.sentTokens += decision.sentTokens;
  totals.savedTokens += decision.savedTokens;
  if (decision.changed) totals.optimized += 1;
  else totals.direct += 1;
  if (decision.protectedContent.length) totals.protectedDirect += 1;

  if (!decision.changed) return;
  const originalHash = hashText(decision.originalCommand);
  const sentHash = hashText(decision.command);
  const record: ContextBudgetRecord = {
    id: recordId(originalHash),
    createdAt: Date.now(),
    source: decision.source,
    team: decision.team,
    target: decision.target,
    route: decision.route,
    originalTokens: decision.originalTokens,
    sentTokens: decision.sentTokens,
    savedTokens: decision.savedTokens,
    savingsRatio: decision.savingsRatio,
    transforms: decision.transforms,
    reasons: decision.reasons,
    guardrails: decision.guardrails,
    originalHash,
    sentHash,
    originalCommand: decision.originalCommand,
    sentCommand: decision.command,
  };
  recent.unshift(record);
  recent.splice(MAX_RECENT);
  try { writeRecord(record); } catch { /* audit persistence is best-effort; dispatch must not fail */ }
}

export function optimizeAskCommand(command: string, options: ContextBudgetOptions = {}): ContextBudgetDecision {
  const decision = optimizeAskCommandCore(command, options);
  remember(decision);
  return decision;
}

export function contextBudgetReport(): ContextBudgetReport {
  const savedTokens = totals.savedTokens;
  const originalTokens = totals.originalTokens;
  const sentTokens = totals.sentTokens;
  return {
    coreEnabled: true,
    frontendSurface: 'hidden',
    inspected: totals.inspected,
    optimized: totals.optimized,
    direct: totals.direct,
    protectedDirect: totals.protectedDirect,
    originalTokens,
    sentTokens,
    savedTokens,
    savingsRatio: originalTokens > 0 ? savedTokens / originalTokens : 0,
    recent: recent.slice(0, 20),
    storageDir: budgetDir(),
    policy: {
      route: 'deterministic-first',
      headroomEngine: 'not-required-for-core-budgeting',
      retrieval: 'local-audit-records-only',
    },
    qualityGuards: [
      'Only /ask payloads are eligible; manager lifecycle commands pass through unchanged.',
      'Secrets, auth material, agent instruction sidecars, active code patches, and wallet/key material always use the direct route.',
      'The hot path uses deterministic whitespace, exact-duplicate, and background-section compaction only; no AI summarizer rewrites prompts before dispatch.',
      'If savings are below the minimum gate, the exact original prompt is sent.',
      'Optimized prompts are stored with hashes and the original command in a local 0600 audit record for recovery and sampling.',
    ],
  };
}

export function readContextBudgetRecord(id: string): ContextBudgetRecord | null {
  const safe = String(id || '').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 80);
  if (!safe) return null;
  const file = join(budgetDir(), `${safe}.json`);
  if (!existsSync(file)) return null;
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as ContextBudgetRecord;
  } catch {
    return null;
  }
}

export function loadRecentContextBudgetRecords(limit = 20): ContextBudgetRecord[] {
  try {
    return readdirSync(budgetDir())
      .filter((f) => /^cb_.*\.json$/.test(f))
      .map((f) => {
        const path = join(budgetDir(), f);
        try { return JSON.parse(readFileSync(path, 'utf8')) as ContextBudgetRecord; } catch { return null; }
      })
      .filter((r): r is ContextBudgetRecord => !!r)
      .sort((a, b) => b.createdAt - a.createdAt)
      .slice(0, Math.max(1, Math.min(100, Math.floor(limit))));
  } catch {
    return [];
  }
}

export function contextBudgetDryRun(command: string, options: ContextBudgetOptions = {}): ContextBudgetDecision {
  const decision = optimizeAskCommandCore(command, { ...options, source: options.source ?? 'dry-run' });
  return {
    ...decision,
    originalTokens: decision.originalTokens || estimateTokens(command),
  };
}
