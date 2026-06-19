/**
 * `idctl upgrade` — check, download+verify, and stage the latest release
 * (applied on next launch). `--check` reports only. `--probe`/`--post` are
 * internal verbs used by apply.ts (health probe / post-update greeting).
 *
 * Exit codes: 0 ok / up-to-date / staged · 1 error · 10 update-available
 * (with --check) · 13 permission-denied.
 */

import { accessSync, constants } from 'node:fs';
import { resolveConfigPath } from '../settings/paths.ts';
import { loadSettings } from '../settings/store.ts';
import { defaultUpdateSettings } from '../settings/schema.ts';
import { IDCTL_VERSION } from '../version.ts';
import { isCompiledBinary } from '../update/platform.ts';
import { checkForUpdate } from '../update/check.ts';
import { downloadAndVerify } from '../update/download.ts';
import { stageUpdate } from '../update/stage.ts';
import { execDir } from '../update/paths.ts';

const C = { reset: '\x1b[0m', dim: '\x1b[2m', bold: '\x1b[1m', green: '\x1b[32m', red: '\x1b[31m', yellow: '\x1b[33m' };

export interface UpgradeArgs {
  check: boolean;
  probe: boolean;
  post: boolean;
  configPath?: string;
}

export async function runUpgrade(p: UpgradeArgs): Promise<number> {
  if (p.probe) return 0; // internal: started successfully, exit fast
  if (p.post) {
    process.stdout.write(`${C.green}idctl updated → v${IDCTL_VERSION}${C.reset}\n`);
    return 0;
  }

  if (!isCompiledBinary()) {
    process.stdout.write(
      `${C.yellow}self-update is disabled when running from source (tsx/node).${C.reset}\n` +
        `Running v${IDCTL_VERSION}. Build a binary (npm run build:bin) or install a release to enable upgrades.\n`,
    );
    return 0;
  }

  const cfg = loadSettings(resolveConfigPath(p.configPath));
  const u = cfg.update ?? defaultUpdateSettings();
  const res = await checkForUpdate({
    repo: u.updateRepo,
    manifestUrl: u.updateManifestUrl,
    intervalHours: u.checkIntervalHours,
    force: true,
  });

  if (res.status === 'error') {
    process.stderr.write(`${C.red}update check failed:${C.reset} ${res.message}\n`);
    return 1;
  }
  if (res.status !== 'available') {
    process.stdout.write(`${C.green}already up to date${C.reset} (v${IDCTL_VERSION})\n`);
    return 0;
  }

  process.stdout.write(
    `update available: ${C.bold}v${res.info.version}${C.reset} (current v${IDCTL_VERSION})` +
      `${res.info.notesUrl ? `\n  notes: ${res.info.notesUrl}` : ''}\n`,
  );
  if (p.check) return 10;

  // Pre-flight writability so we fail fast BEFORE downloading.
  try {
    accessSync(execDir(), constants.W_OK);
  } catch {
    process.stderr.write(
      `${C.red}cannot write ${execDir()} (permission denied).${C.reset}\n` +
        `Re-run with elevated privileges (sudo idctl upgrade) or reinstall into a user-writable dir on PATH (e.g. ~/.local/bin).\n`,
    );
    return 13;
  }

  process.stdout.write('downloading & verifying…\n');
  try {
    const dl = await downloadAndVerify(res.info);
    stageUpdate(res.info, dl);
    process.stdout.write(
      `${C.green}staged v${res.info.version}.${C.reset} It will be applied automatically on your next launch.\n` +
        `Run \`idctl\` again to upgrade now.\n`,
    );
    return 0;
  } catch (e) {
    process.stderr.write(
      `${C.red}upgrade failed:${C.reset} ${e instanceof Error ? e.message : e}\nYour current binary is unchanged.\n`,
    );
    return 1;
  }
}
