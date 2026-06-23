/**
 * Append-only audit of every Computer Use action — the record of what an agent
 * did (or was blocked from doing) on the Mac. Three sinks:
 *  1. an in-memory ring the Computer Use view tails live,
 *  2. a 0600 JSONL file under ~/.config/idctl/computeruse/audit/,
 *  3. a best-effort mirror to the manager's /activity ring so it ALSO shows in Chat.
 * Keystrokes are recorded as a length, never the literal text, so secrets typed
 * into a field aren't written to disk.
 */
import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

export interface AuditEntry {
  ts: number;
  agent: string;
  action: string;
  detail: string;
  decision: 'executed' | 'blocked';
  reason?: string;
}

const RING: AuditEntry[] = [];
const RING_MAX = 600;

function auditDir(): string {
  const d = join(homedir(), '.config', 'idctl', 'computeruse', 'audit');
  mkdirSync(d, { recursive: true, mode: 0o700 });
  return d;
}
function dayFile(ts: number): string {
  // One file per UTC day; cheap rotation, no unbounded single file.
  const d = new Date(ts);
  const stamp = `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, '0')}${String(d.getUTCDate()).padStart(2, '0')}`;
  return join(auditDir(), `${stamp}.jsonl`);
}

/** Best-effort mirror to the manager so computer-use actions appear in Chat. */
function mirrorToManager(e: AuditEntry, team: string): void {
  if (!team) return;
  try {
    void fetch('http://127.0.0.1:4100/activity/record', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ agent: e.agent, team, kind: e.decision === 'blocked' ? 'error' : 'tool', tool: 'mac-control', summary: `${e.action}: ${e.detail}${e.decision === 'blocked' ? ` (blocked: ${e.reason})` : ''}` }),
      signal: AbortSignal.timeout(2500),
    }).catch(() => {});
  } catch { /* never let auditing throw */ }
}

export function audit(e: AuditEntry, team = ''): void {
  RING.push(e);
  if (RING.length > RING_MAX) RING.splice(0, RING.length - RING_MAX);
  try { appendFileSync(dayFile(e.ts), JSON.stringify(e) + '\n', { mode: 0o600 }); } catch { /* */ }
  mirrorToManager(e, team);
}

export function recentAudit(n = 120): AuditEntry[] {
  return RING.slice(-Math.max(1, Math.min(n, RING_MAX)));
}
