/**
 * Update-state paths. Metadata (pending.json, check.json) lives beside the
 * config under ~/.config/idctl/update/. The staged binary bytes MUST live in
 * dirname(execPath) so the eventual rename is intra-filesystem (atomic) — a
 * verified findings invariant.
 */

import { join, dirname, basename } from 'node:path';
import { configDir, resolveConfigPath } from '../settings/paths.ts';

export function updateStateDir(): string {
  return join(configDir(resolveConfigPath()), 'update');
}
export function pendingFile(): string {
  return join(updateStateDir(), 'pending.json');
}
export function checkCacheFile(): string {
  return join(updateStateDir(), 'check.json');
}

// Binary-adjacent paths (same filesystem ⇒ atomic rename).
export function execDir(): string {
  return dirname(process.execPath);
}
export function execName(): string {
  return basename(process.execPath);
}
export function stagingPath(): string {
  return join(execDir(), `.${execName()}.new-${process.pid}`);
}
export function backupPath(): string {
  return join(execDir(), `.${execName()}.bak`);
}
export function stagingGlobPrefix(): string {
  return `.${execName()}.new-`;
}
