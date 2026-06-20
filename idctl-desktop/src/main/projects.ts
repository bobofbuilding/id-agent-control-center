/**
 * Project folder + git support for the Projects page (main process only — needs
 * the filesystem, `git`, and the native folder picker).
 *
 *   pickProjectFolder()  → native "choose a directory" dialog
 *   projectReadme(path)  → first H1 as name + first real paragraph as description
 *   projectGit(path)     → branch, remotes, fork?, ahead/behind vs the main branch
 *   projectGitRun(path)  → run a WHITELISTED git command (fetch/pull/status/log)
 *
 * ahead/behind is measured against the relevant remote's default branch: for a
 * fork (an `upstream` remote distinct from `origin`) we compare to upstream's
 * main (so "ahead" = your custom commits); otherwise to origin's main.
 */

import { BrowserWindow, dialog, shell } from 'electron';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, basename } from 'node:path';

const execFileP = promisify(execFile);

/** Run a git command in `cwd`, returning trimmed stdout (throws on failure). */
async function git(cwd: string, args: string[], timeoutMs = 10000): Promise<string> {
  const { stdout } = await execFileP('git', args, { cwd, timeout: timeoutMs });
  return stdout.trim();
}
async function gitOk(cwd: string, args: string[]): Promise<boolean> {
  return git(cwd, args).then(() => true).catch(() => false);
}

export async function pickProjectFolder(): Promise<string | null> {
  const opts: Electron.OpenDialogOptions = { title: 'Choose a project folder', properties: ['openDirectory', 'createDirectory'] };
  const win = BrowserWindow.getFocusedWindow();
  const res = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts);
  return res.canceled || !res.filePaths[0] ? null : res.filePaths[0];
}

export function openProjectFolder(path: string): { ok: boolean } {
  try { void shell.openPath(path); return { ok: true }; } catch { return { ok: false }; }
}

function clip(s: string, n: number): string {
  const t = s.replace(/\s+/g, ' ').trim();
  return t.length > n ? t.slice(0, n) + '…' : t;
}
/** ASCII-art banners / box-drawing dividers: too few real letters for prose. */
function looksLikeArt(s: string): boolean {
  const alnum = (s.match(/[A-Za-z0-9]/g) || []).length;
  return s.length >= 8 && alnum / s.length < 0.45;
}

/** Pull a name (clean H1 title) and description (first real paragraph) from a README. */
export function projectReadme(path: string): { found: boolean; name?: string; description?: string } {
  if (!path || !existsSync(path)) return { found: false };
  let file = '';
  try {
    const f = readdirSync(path).find((n) => /^readme(\.(md|markdown|txt|rst))?$/i.test(n));
    if (f) file = join(path, f);
  } catch {
    /* unreadable dir */
  }
  if (!file) return { found: false, name: basename(path) };
  try {
    const text = readFileSync(file, 'utf8');
    // Name: the first H1 that's a clean, short title (not an ASCII-art banner or a
    // long instructional heading); otherwise fall back to the folder name.
    let name = basename(path);
    for (const m of text.matchAll(/^#\s+(.+?)\s*$/gm)) {
      const h = m[1].replace(/[#*`_]/g, '').trim();
      if (h && h.length <= 50 && !looksLikeArt(h)) { name = h; break; }
    }
    // Description: first prose paragraph — skip headings, badges, images, html,
    // lists, quotes, hr/underlines, and ASCII-art lines.
    let description = '';
    let pastTitle = false;
    for (const raw of text.split('\n')) {
      const s = raw.trim();
      if (!s) { if (pastTitle && description) break; continue; }
      if (/^#{1,6}\s/.test(s)) { pastTitle = true; continue; }
      if (/^[-=]{3,}$/.test(s)) continue;
      if (/^!?\[!?\[/.test(s) || /^<\/?[a-z]/i.test(s)) continue;
      if (/^[-*+]\s|^\d+\.\s|^>/.test(s)) continue;
      if (looksLikeArt(s)) continue;
      const cleaned = s.replace(/\[([^\]]+)\]\([^)]*\)/g, '$1').replace(/[*_`#>]/g, '').trim();
      if (cleaned && !looksLikeArt(cleaned)) { description = cleaned; break; }
    }
    return { found: true, name, description: description ? clip(description, 240) : undefined };
  } catch {
    return { found: false, name: basename(path) };
  }
}

export interface GitInfo {
  isRepo: boolean;
  branch?: string;
  remoteUrl?: string;
  upstreamUrl?: string;
  isFork?: boolean;
  ahead?: number;
  behind?: number;
  dirty?: boolean;
  compareRef?: string;
  error?: string;
}

/** Resolve a remote's default branch (origin/HEAD → name, else main/master). */
async function defaultBranchOf(path: string, remote: string): Promise<string> {
  const sym = await git(path, ['symbolic-ref', `refs/remotes/${remote}/HEAD`]).catch(() => '');
  if (sym) return sym.replace(`refs/remotes/${remote}/`, '');
  for (const b of ['main', 'master', 'develop']) {
    if (await gitOk(path, ['rev-parse', '--verify', `${remote}/${b}`])) return b;
  }
  return 'main';
}

export async function projectGit(path: string): Promise<GitInfo> {
  if (!path || !existsSync(path)) return { isRepo: false, error: 'folder not found' };
  try {
    if ((await git(path, ['rev-parse', '--is-inside-work-tree']).catch(() => '')) !== 'true') {
      return { isRepo: false };
    }
    const branch = await git(path, ['rev-parse', '--abbrev-ref', 'HEAD']).catch(() => '');
    const remotes = (await git(path, ['remote']).catch(() => '')).split('\n').filter(Boolean);
    const remoteUrl = remotes.includes('origin') ? await git(path, ['remote', 'get-url', 'origin']).catch(() => '') : '';
    const upstreamUrl = remotes.includes('upstream') ? await git(path, ['remote', 'get-url', 'upstream']).catch(() => '') : '';
    const isFork = !!upstreamUrl && upstreamUrl !== remoteUrl;
    const dirty = !!(await git(path, ['status', '--porcelain']).catch(() => ''));

    const remote = isFork ? 'upstream' : (remotes.includes('origin') ? 'origin' : remotes[0]);
    let ahead: number | undefined;
    let behind: number | undefined;
    let compareRef: string | undefined;
    if (remote) {
      const def = await defaultBranchOf(path, remote);
      compareRef = `${remote}/${def}`;
      if (await gitOk(path, ['rev-parse', '--verify', compareRef])) {
        const counts = await git(path, ['rev-list', '--left-right', '--count', `${compareRef}...HEAD`]).catch(() => '');
        const m = counts.split(/\s+/).map((n) => Number(n));
        if (m.length === 2 && Number.isFinite(m[0]) && Number.isFinite(m[1])) {
          behind = m[0];
          ahead = m[1];
        }
      }
    }
    return { isRepo: true, branch, remoteUrl: remoteUrl || undefined, upstreamUrl: upstreamUrl || undefined, isFork, ahead, behind, dirty, compareRef };
  } catch (e) {
    return { isRepo: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/** Whitelisted git commands the Projects page can run. */
const GIT_ACTIONS: Record<string, string[]> = {
  fetch: ['fetch', '--all', '--prune'],
  pull: ['pull', '--ff-only'],
  status: ['status', '-sb'],
  log: ['log', '--oneline', '--decorate', '-15'],
  diff: ['diff', '--stat'],
};

export async function projectGitRun(path: string, action: string): Promise<{ ok: boolean; output: string }> {
  const args = GIT_ACTIONS[action];
  if (!args) return { ok: false, output: `unknown git action: ${action}` };
  if (!path || !existsSync(path)) return { ok: false, output: 'folder not found' };
  try {
    const { stdout, stderr } = await execFileP('git', args, { cwd: path, timeout: 90000 });
    return { ok: true, output: `${stdout}${stderr}`.trim() || '(no output)' };
  } catch (e) {
    const err = e as { stdout?: string; stderr?: string; message?: string };
    return { ok: false, output: `${err.stdout ?? ''}${err.stderr ?? ''}${err.message ?? ''}`.trim() };
  }
}
