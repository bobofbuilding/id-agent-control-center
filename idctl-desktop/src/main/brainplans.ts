/**
 * Brain plans reader (main process). Surfaces the brain's LIVING plan set — the
 * markdown files + README status index under <projectsRoot>/brain/plans/ — read-only
 * and live, so Work → Plans reflects the brain as its files change on disk. We never
 * write here (the brain owns these files).
 */
import { existsSync, readFileSync, readdirSync, writeFileSync, renameSync, rmSync } from 'node:fs';
import { join, basename, resolve } from 'node:path';
import { detectProjectsRoot } from './projects.ts';
import { loadSettings } from '../../../idctl/src/settings/store.ts';

export interface BrainPlan {
  num?: string;
  title: string;
  file: string; // filename within the plans dir
  status?: string; // e.g. "✅ DONE" / "🔄 PARTIAL" / "⏳ PENDING" / "🛑 ON HOLD"
  effort?: string;
  notes?: string;
}

/** Resolve the brain plans dir from the projects root. Falls back to the saved
 *  `projectsRoot` setting (what the Projects page configures) when no explicit
 *  root is passed — detectProjectsRoot itself only reads its arg/env/plist/cwd. */
export function brainPlansDir(configured?: string): string | null {
  const root = detectProjectsRoot(configured ?? loadSettings().projectsRoot);
  if (!root) return null;
  const dir = join(root, 'brain', 'plans');
  return existsSync(dir) ? dir : null;
}

/** Parse the README.md status table into structured rows. Best-effort + forgiving. */
function parseIndex(readme: string): BrainPlan[] {
  const out: BrainPlan[] = [];
  for (const line of readme.split(/\r?\n/)) {
    // | 01 | [Title](file.md) | ✅ DONE | 2h | notes |
    const m = /^\s*\|\s*([^|]*?)\s*\|\s*\[([^\]]+)\]\(([^)]+)\)\s*\|\s*([^|]*?)\s*\|\s*([^|]*?)\s*\|\s*([^|]*?)\s*\|/.exec(line);
    if (!m) continue;
    const file = m[3].trim().replace(/^\.\//, '');
    if (!/\.md$/i.test(file)) continue;
    out.push({
      num: m[1].trim() || undefined,
      title: m[2].trim(),
      file,
      status: m[4].trim() || undefined,
      effort: m[5].trim() || undefined,
      notes: m[6].trim() || undefined,
    });
  }
  return out;
}

/** List brain plans: prefer the README index; fall back to listing *.md files. */
export function listBrainPlans(configured?: string): { dir: string | null; plans: BrainPlan[] } {
  const dir = brainPlansDir(configured);
  if (!dir) return { dir: null, plans: [] };
  let plans: BrainPlan[] = [];
  const readmePath = join(dir, 'README.md');
  if (existsSync(readmePath)) {
    try { plans = parseIndex(readFileSync(readmePath, 'utf8')); } catch { /* ignore */ }
  }
  if (!plans.length) {
    try {
      plans = readdirSync(dir)
        .filter((f) => /\.md$/i.test(f) && f.toLowerCase() !== 'readme.md')
        .sort()
        .map((f) => ({ file: f, title: f.replace(/\.md$/i, '').replace(/^\d+[-_]?/, '').replace(/[-_]/g, ' ') }));
    } catch { /* ignore */ }
  }
  return { dir, plans };
}

/** Read one plan's markdown, guarded to the brain plans dir (no path traversal). */
export function getBrainPlan(file: string, configured?: string): { file: string; content: string } | null {
  const dir = brainPlansDir(configured);
  if (!dir) return null;
  const safe = basename(String(file || '')); // strip any path components
  if (!/\.md$/i.test(safe)) return null;
  const full = resolve(dir, safe);
  if (!full.startsWith(resolve(dir))) return null; // belt-and-suspenders against traversal
  if (!existsSync(full)) return null;
  try { return { file: safe, content: readFileSync(full, 'utf8') }; } catch { return null; }
}

/** Map a free verdict ("done"/"DONE"/"✅ DONE"…) to the README's canonical label. */
function normStatusLabel(s: string): string | null {
  const t = (s || '').toLowerCase();
  if (/done|✅/.test(t)) return '✅ DONE';
  if (/partial|🔄|progress/.test(t)) return '🔄 PARTIAL';
  if (/hold|🛑/.test(t)) return '🛑 ON HOLD';
  if (/pending|⏳|todo|not started/.test(t)) return '⏳ PENDING';
  return null;
}

/**
 * Update ONLY the Status cell of a plan's row in the brain plans README (the table
 * `| # | [title](file) | Status | … |`). Guarded: resolves inside the brain plans
 * dir, only touches the matched row's status column, atomic write. Returns the
 * previous + new label so the UI can show the change.
 */
export function setBrainPlanStatus(file: string, status: string, configured?: string): { ok: boolean; from?: string; to?: string; error?: string } {
  const dir = brainPlansDir(configured);
  if (!dir) return { ok: false, error: 'brain plans dir not found' };
  const safe = basename(String(file || ''));
  if (!/\.md$/i.test(safe)) return { ok: false, error: 'invalid plan file' };
  const label = normStatusLabel(status);
  if (!label) return { ok: false, error: `unrecognized status "${status}"` };
  const readme = join(dir, 'README.md');
  if (!existsSync(readme)) return { ok: false, error: 'README not found' };
  try {
    const lines = readFileSync(readme, 'utf8').split(/\r?\n/);
    let from: string | undefined;
    let changed = false;
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (!line.includes(`](${safe})`) && !line.includes(`](./${safe})`)) continue;
      const parts = line.split('|'); // ['', ' # ', ' [t](f) ', ' status ', ' effort ', ' notes ', '']
      if (parts.length < 6) continue; // not the expected table shape
      from = parts[3].trim();
      parts[3] = ` ${label} `;
      lines[i] = parts.join('|');
      changed = true;
      break;
    }
    if (!changed) return { ok: false, error: 'plan row not found in README' };
    const tmp = `${readme}.${process.pid}.tmp`;
    writeFileSync(tmp, lines.join('\n'));
    try { renameSync(tmp, readme); } catch (e) { try { rmSync(tmp, { force: true }); } catch { /* */ } throw e; }
    return { ok: true, from, to: label };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}
