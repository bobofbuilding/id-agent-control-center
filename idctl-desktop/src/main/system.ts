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
  cpuCores: number;
  /** GPU / chipset model (macOS only); undefined elsewhere. */
  gpu?: string;
  /** GPU core count (macOS only). */
  gpuCores?: number;
  totalRamGB: number;
  /** Free / total space on the volume holding the home dir; null if unavailable. */
  freeDiskGB: number | null;
  totalDiskGB: number | null;
}

// The system_profiler probe is slowish (~1s) but its result is static — cache it
// so only the first Settings open pays for it; disk free is re-read every call.
let _gpuCache: { gpu?: string; gpuCores?: number } | null = null;
async function detectGpu(): Promise<{ gpu?: string; gpuCores?: number }> {
  if (_gpuCache) return _gpuCache;
  let out: { gpu?: string; gpuCores?: number } = {};
  if (osPlatform() === 'darwin') {
    try {
      const { stdout } = await execFileP('system_profiler', ['SPDisplaysDataType'], { timeout: 6000 });
      const gpu = stdout.match(/Chipset Model:\s*(.+)/)?.[1]?.trim();
      const cores = stdout.match(/Total Number of Cores:\s*(\d+)/)?.[1];
      out = { gpu, gpuCores: cores ? Number(cores) : undefined };
    } catch {
      /* system_profiler unavailable / timed out */
    }
  }
  _gpuCache = out;
  return out;
}

export async function getHardware(): Promise<HardwareInfo> {
  let freeDiskGB: number | null = null;
  let totalDiskGB: number | null = null;
  try {
    const s = await statfs(homedir());
    freeDiskGB = +(((s.bavail as number) * (s.bsize as number)) / GB).toFixed(1);
    totalDiskGB = Math.round(((s.blocks as number) * (s.bsize as number)) / GB);
  } catch {
    /* statfs unavailable on this platform/runtime */
  }
  const { gpu, gpuCores } = await detectGpu();
  return {
    platform: osPlatform(),
    arch: osArch(),
    appleSilicon: osPlatform() === 'darwin' && osArch() === 'arm64',
    cpu: cpus()[0]?.model ?? 'unknown',
    cpuCores: cpus().length,
    gpu,
    gpuCores,
    totalRamGB: +(totalmem() / GB).toFixed(1),
    freeDiskGB,
    totalDiskGB,
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
