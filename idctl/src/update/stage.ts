/**
 * Stage verified bytes next to the running binary (so the later rename is
 * atomic) and record pending.json. Never touches the live binary. An EACCES
 * here (read-only install dir) fails BEFORE the running binary is ever at risk.
 */

import { writeFileSync, mkdirSync, existsSync, readFileSync, unlinkSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { stagingPath, pendingFile, updateStateDir } from './paths.ts';
import { IDCTL_VERSION } from '../version.ts';
import type { PendingUpdate, UpdateInfo, VerifiedDownload } from './types.ts';

export function stageUpdate(info: UpdateInfo, dl: VerifiedDownload): PendingUpdate {
  const tmp = stagingPath();
  writeFileSync(tmp, dl.bytes, { mode: 0o755 }); // EACCES here ⇒ live binary untouched
  if (process.platform === 'darwin') {
    // Defensive: a quarantined ad-hoc-signed binary is SIGKILLed by Gatekeeper.
    spawnSync('xattr', ['-d', 'com.apple.quarantine', tmp], { stdio: 'ignore' });
  }

  const pending: PendingUpdate = {
    fromVersion: IDCTL_VERSION,
    toVersion: info.version,
    stagedPath: tmp,
    sha256: dl.sha256,
    stagedAt: new Date().toISOString(),
    notesUrl: info.notesUrl,
  };
  mkdirSync(updateStateDir(), { recursive: true, mode: 0o700 });
  writeFileSync(pendingFile(), JSON.stringify(pending, null, 2) + '\n', { mode: 0o600 });
  return pending;
}

export function readPending(): PendingUpdate | null {
  try {
    const p = JSON.parse(readFileSync(pendingFile(), 'utf8')) as PendingUpdate;
    if (p && p.stagedPath && existsSync(p.stagedPath)) return p;
  } catch {
    /* none */
  }
  return null;
}

export function clearPending(): void {
  try {
    unlinkSync(pendingFile());
  } catch {
    /* ignore */
  }
}
