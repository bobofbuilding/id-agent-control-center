/**
 * Brain plans reader (main process). Surfaces the brain's LIVING plan set — the
 * markdown files + README status index under <projectsRoot>/brain/plans/ — read-only
 * and live, so Work → Plans reflects the brain as its files change on disk. We never
 * write here (the brain owns these files).
 */
import { existsSync, readFileSync, readdirSync, writeFileSync, renameSync, rmSync, statSync } from 'node:fs';
import { join, basename, resolve, dirname } from 'node:path';
import { execFileSync } from 'node:child_process';
import { detectProjectsRoot } from './projects.ts';
import { loadSettings } from '../../../idctl/src/settings/store.ts';

export interface BrainPlan {
  num?: string;
  title: string;
  file: string; // filename within the plans dir
  status?: string; // e.g. "✅ DONE" / "🔄 PARTIAL" / "⏳ PENDING" / "🛑 ON HOLD"
  effort?: string;
  notes?: string;
  mtime?: number; // plan file's last-modified time (epoch ms) — "last updated"
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
  // Stamp each plan with its file's last-modified time ("last updated"). Best-effort
  // and guarded to the plans dir (the README may reference odd paths).
  for (const p of plans) {
    try {
      const fp = resolve(dir, p.file);
      if (fp.startsWith(resolve(dir))) p.mtime = statSync(fp).mtimeMs;
    } catch { /* file may be missing/renamed — leave mtime undefined */ }
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
/** kebab-case slug for a plan filename (bounded, filesystem-safe). */
function slugify(s: string): string {
  return (s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'plan';
}

/**
 * Promote a draft into the brain's LIVING plan set: write a new `NN-slug.md` plan file with
 * the draft content and insert a README row at status ⏳ PENDING (so it enters the
 * pending → partial → done lifecycle the rest of the Plans tab drives). Best-effort `git add`
 * + commit in the brain repo so the new plan isn't left as an uncommitted file. Returns the
 * created filename + number.
 */
export function createBrainPlan(title: string, content: string, configured?: string): { ok: boolean; file?: string; num?: string; committed?: boolean; error?: string } {
  const dir = brainPlansDir(configured);
  if (!dir) return { ok: false, error: 'brain plans dir not found' };
  const readmePath = join(dir, 'README.md');
  if (!existsSync(readmePath)) return { ok: false, error: 'README not found' };
  const cleanTitle = (title || 'Untitled plan').trim().slice(0, 120);
  try {
    // Next plan number = max existing numeric prefix + 1, zero-padded to 2.
    const nums = readdirSync(dir)
      .map((f) => /^(\d+)/.exec(f)?.[1])
      .filter(Boolean)
      .map((n) => Number(n));
    const next = (nums.length ? Math.max(...nums) : 0) + 1;
    const numStr = String(next).padStart(2, '0');
    const fname = `${numStr}-${slugify(cleanTitle)}.md`;
    const full = resolve(dir, fname);
    if (!full.startsWith(resolve(dir))) return { ok: false, error: 'bad path' };
    if (existsSync(full)) return { ok: false, error: `${fname} already exists` };
    // File body: a single "# Plan NN - Title" heading (drop the draft's own leading H1), then content.
    const body = (content || '').trim().replace(/^#\s+.*(\r?\n)+/, '');
    const fileContent = `# Plan ${next} - ${cleanTitle}\n\n${body}\n`;
    const tmpF = `${full}.${process.pid}.tmp`;
    writeFileSync(tmpF, fileContent);
    renameSync(tmpF, full);
    // Insert a README row right after the last numbered table row.
    const lines = readFileSync(readmePath, 'utf8').split(/\r?\n/);
    let lastRow = -1;
    for (let i = 0; i < lines.length; i++) if (/^\|\s*\d+\s*\|/.test(lines[i])) lastRow = i;
    const row = `| ${numStr} | [${cleanTitle}](${fname}) | ⏳ PENDING | planning+build | Promoted from a Control Center draft. |`;
    if (lastRow >= 0) lines.splice(lastRow + 1, 0, row); else lines.push(row);
    const tmpR = `${readmePath}.${process.pid}.tmp`;
    writeFileSync(tmpR, lines.join('\n'));
    renameSync(tmpR, readmePath);
    // Best-effort commit so the new plan isn't left uncommitted in the brain repo.
    let committed = false;
    try {
      const root = dirname(dir); // …/brain
      execFileSync('git', ['-C', root, 'add', join('plans', fname), join('plans', 'README.md')], { stdio: 'ignore' });
      execFileSync('git', ['-C', root, 'commit', '-m', `Plan ${next}: ${cleanTitle} (⏳ PENDING — promoted from a Control Center draft)`], { stdio: 'ignore' });
      committed = true;
    } catch { /* not a repo / nothing to commit / hooks — leave the files in place */ }
    return { ok: true, file: fname, num: numStr, committed };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

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
