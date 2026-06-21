/**
 * Chat attachments (main process — needs the native file dialog + filesystem).
 *
 *   pickChatFiles()              → multi-select "attach files" dialog
 *   saveChatFiles(destDir, srcs) → copy picked files into <destDir>/uploads/,
 *                                  binary-safe, basename-sanitized, no clobber
 *
 * Files land in a folder the target agent can read (its workspace, or the
 * focused project folder); the Chat composer then references the saved absolute
 * paths in the message so the agent can open/read them (images included).
 */

import { BrowserWindow, dialog } from 'electron';
import { existsSync, mkdirSync, statSync, lstatSync, constants } from 'node:fs';
import { copyFile } from 'node:fs/promises';
import { join, basename, extname } from 'node:path';

const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.svg', '.heic', '.heif', '.tiff', '.avif']);
const isImage = (name: string): boolean => IMAGE_EXT.has(extname(name).toLowerCase());

export interface PickedFile {
  path: string;
  name: string;
  size: number;
  isImage: boolean;
}

export async function pickChatFiles(): Promise<PickedFile[]> {
  const opts: Electron.OpenDialogOptions = { title: 'Attach files', properties: ['openFile', 'multiSelections'] };
  const win = BrowserWindow.getFocusedWindow();
  const res = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts);
  if (res.canceled) return [];
  return res.filePaths.map((p) => {
    let size = 0;
    try { size = statSync(p).size; } catch { /* unreadable */ }
    return { path: p, name: basename(p), size, isImage: isImage(p) };
  });
}

export interface SavedFile {
  name: string;
  path: string;
  size: number;
  isImage: boolean;
}

/** Any entry exists at `p` — including a (possibly dangling) symlink. lstat, so
 *  we never treat a symlink as "free" and then write through it. */
function entryExists(p: string): boolean {
  try { lstatSync(p); return true; } catch { return false; }
}

/** A destination filename that doesn't collide with an existing entry (foo.png → foo-1.png). */
function uniqueName(dir: string, name: string): string {
  if (!entryExists(join(dir, name))) return name;
  const ext = extname(name);
  const stem = name.slice(0, name.length - ext.length);
  for (let i = 1; i < 1000; i++) {
    const candidate = `${stem}-${i}${ext}`;
    if (!entryExists(join(dir, candidate))) return candidate;
  }
  return `${stem}-${Date.now().toString(36)}${ext}`;
}

/** Copy selected files into <destDir>/uploads/ (binary-safe). Never escapes the
 *  dir or writes through a symlink, and never overwrites an existing entry. */
export async function saveChatFiles(destDir: string, sources: string[]): Promise<{ ok: boolean; dir?: string; files: SavedFile[]; skipped: string[]; error?: string }> {
  if (!destDir || !existsSync(destDir)) return { ok: false, files: [], skipped: [], error: 'destination folder not found' };
  const dir = join(destDir, 'uploads');
  try { mkdirSync(dir, { recursive: true }); } catch (e) { return { ok: false, files: [], skipped: [], error: e instanceof Error ? e.message : String(e) }; }
  const files: SavedFile[] = [];
  const skipped: string[] = [];
  for (const src of Array.isArray(sources) ? sources : []) {
    const base = src ? basename(src) : '';
    try {
      if (!src || !existsSync(src)) { if (base) skipped.push(base); continue; }
      const name = uniqueName(dir, base); // basename → no path traversal
      const dest = join(dir, name);
      // COPYFILE_EXCL: fail (don't follow/overwrite) if anything is already at
      // dest — closes the dangling-symlink-create + live-symlink-overwrite holes.
      await copyFile(src, dest, constants.COPYFILE_EXCL);
      let size = 0;
      try { size = statSync(dest).size; } catch { /* ignore */ }
      files.push({ name, path: dest, size, isImage: isImage(name) });
    } catch {
      if (base) skipped.push(base);
    }
  }
  return { ok: true, dir, files, skipped };
}
