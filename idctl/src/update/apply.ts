/**
 * Apply a staged update at launch, BEFORE anything renders. Encodes every
 * adversarial mitigation:
 *  - dev-mode + env-guard + isNewer short-circuit ⇒ no re-exec loop, no source-mode swap
 *  - re-verify staged sha256 ⇒ defense-in-depth
 *  - backup → atomic rename → 5s health probe → rollback to .bak on any failure
 *  - never collapse a signal-killed child to exit 0
 *  - sweep orphaned staging temp files from crashed prior runs
 */

import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import crypto from 'node:crypto';
import { backupPath, execDir, stagingGlobPrefix } from './paths.ts';
import { isCompiledBinary } from './platform.ts';
import { readPending, clearPending } from './stage.ts';
import { isNewer } from './version.ts';
import { IDCTL_VERSION } from '../version.ts';

const ENV_GUARD = 'IDCTL_SELFUPDATE_REEXEC'; // breaks any conceivable re-exec loop

function sweepOrphans(): void {
  try {
    for (const f of fs.readdirSync(execDir())) {
      if (f.startsWith(stagingGlobPrefix())) {
        try {
          fs.unlinkSync(join(execDir(), f));
        } catch {
          /* ignore */
        }
      }
    }
  } catch {
    /* ignore */
  }
}

/**
 * Returns true iff it applied an update and re-exec'd (caller must then return
 * immediately — the process has already handed off / exited).
 */
export function applyPendingAndReExec(): boolean {
  if (process.env[ENV_GUARD] === '1') {
    delete process.env[ENV_GUARD];
    sweepOrphans();
    return false;
  }
  if (!isCompiledBinary()) return false;

  const pending = readPending();
  if (!pending) {
    sweepOrphans();
    return false;
  }
  if (!isNewer(pending.toVersion, IDCTL_VERSION)) {
    clearPending();
    sweepOrphans();
    return false;
  }

  const execPath = process.execPath;
  const bak = backupPath();
  try {
    const staged = fs.readFileSync(pending.stagedPath);
    if (crypto.createHash('sha256').update(staged).digest('hex') !== pending.sha256) {
      throw new Error('staged binary failed re-verification');
    }

    // 1. Backup current binary BEFORE any swap.
    fs.copyFileSync(execPath, bak);
    fs.chmodSync(bak, 0o755);

    // 2. Atomic rename staged → execPath (works while running on POSIX).
    fs.renameSync(pending.stagedPath, execPath);
    fs.chmodSync(execPath, 0o755);

    // 3. Health-probe the new binary in a child (5s). Never mask signal death.
    const probe = spawnSync(execPath, ['upgrade', '--probe'], {
      stdio: 'ignore',
      timeout: 5000,
      env: { ...process.env, [ENV_GUARD]: '1' },
    });
    if (probe.error || probe.signal || probe.status !== 0) {
      // 4. Rollback to the byte-identical backup.
      fs.renameSync(bak, execPath);
      fs.chmodSync(execPath, 0o755);
      clearPending();
      process.stderr.write(
        `idctl: update to ${pending.toVersion} failed health probe (${probe.signal ?? probe.error ?? 'exit ' + probe.status}); rolled back.\n`,
      );
      return false;
    }

    // 5. Success: clean up, then re-exec into the new binary running the user's
    // ORIGINAL command. The env guard makes the child skip this apply step, so
    // there is no re-exec loop; pending is already cleared and isNewer would
    // short-circuit anyway (triple-guarded). This makes a restart upgrade AND
    // do what the user asked, in one step.
    try {
      fs.unlinkSync(bak);
    } catch {
      /* ignore */
    }
    clearPending();
    sweepOrphans();
    process.stderr.write(`idctl: upgraded ${pending.fromVersion} → ${pending.toVersion}\n`);
    const r = spawnSync(execPath, process.argv.slice(2), {
      stdio: 'inherit',
      env: { ...process.env, [ENV_GUARD]: '1' },
    });
    if (r.signal || r.error) {
      process.stderr.write(`idctl: new binary did not start (${r.signal ?? r.error}).\n`);
      process.exit(1);
    }
    process.exit(r.status ?? 0);
  } catch (e) {
    // Any failure before/at rename leaves the live binary intact; restore .bak if present.
    try {
      if (fs.existsSync(bak)) {
        fs.renameSync(bak, execPath);
        fs.chmodSync(execPath, 0o755);
      }
    } catch {
      /* ignore */
    }
    clearPending();
    process.stderr.write(
      `idctl: could not apply pending update (${e instanceof Error ? e.message : e}); kept current version.\n`,
    );
    return false;
  }
}
