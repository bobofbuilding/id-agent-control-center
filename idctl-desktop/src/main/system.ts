/**
 * Host system info for the machine the control center is commanding. In the
 * common setup the manager runs on the SAME machine as this app (manager at
 * 127.0.0.1:4100), so local detection reflects where Ollama actually runs and
 * where models download. Used to warn when a model is too large for RAM/disk.
 *
 * Also exposes a "run in Terminal" helper so a stack's install/uninstall command
 * runs visibly in the user's own shell (never silently) — they see it and can
 * abort. We never execute anything without the user clicking through.
 */

import { totalmem, cpus, platform as osPlatform, arch as osArch, homedir } from 'node:os';
import { statfs } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileP = promisify(execFile);
const GB = 1024 ** 3;

export interface HardwareInfo {
  platform: string;
  arch: string;
  /** macOS + arm64 → unified memory; the RAM figure bounds GPU use too. */
  appleSilicon: boolean;
  cpu: string;
  totalRamGB: number;
  /** Free space on the volume holding the home dir; null if unavailable. */
  freeDiskGB: number | null;
}

export async function getHardware(): Promise<HardwareInfo> {
  let freeDiskGB: number | null = null;
  try {
    const s = await statfs(homedir());
    freeDiskGB = +(((s.bavail as number) * (s.bsize as number)) / GB).toFixed(1);
  } catch {
    /* statfs unavailable on this platform/runtime */
  }
  return {
    platform: osPlatform(),
    arch: osArch(),
    appleSilicon: osPlatform() === 'darwin' && osArch() === 'arm64',
    cpu: cpus()[0]?.model ?? 'unknown',
    totalRamGB: +(totalmem() / GB).toFixed(1),
    freeDiskGB,
  };
}

/**
 * Open the user's Terminal and run a command there. Visible + abortable in their
 * own shell — we never run installers silently. macOS only (osascript); returns
 * the command either way so the UI can fall back to clipboard if Terminal
 * automation is blocked.
 */
export async function runInTerminal(command: string): Promise<{ ok: boolean; ran: boolean; command: string; error?: string }> {
  const cmd = String(command || '').trim();
  if (!cmd) return { ok: false, ran: false, command: cmd, error: 'empty command' };
  try {
    const osa = `tell application "Terminal"\n  activate\n  do script "${cmd.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"\nend tell`;
    await execFileP('osascript', ['-e', osa], { timeout: 8000 });
    return { ok: true, ran: true, command: cmd };
  } catch (e) {
    return { ok: false, ran: false, command: cmd, error: e instanceof Error ? e.message : String(e) };
  }
}
