/**
 * Platform detection for self-update: map os/arch(/musl) to a release asset
 * name, and detect whether we're a compiled binary (self-update only makes
 * sense there — never under tsx/node dev runs).
 */

import type { Platform } from './types.ts';

/** True when running as a compiled bun single-file exe; false under tsx/node. */
export function isCompiledBinary(): boolean {
  if (process.env.IDCTL_FORCE_DEV === '1') return false;
  if (process.env.IDCTL_FORCE_COMPILED === '1') return true; // test hook
  const underBun = typeof (process as { versions?: { bun?: string } }).versions?.bun === 'string';
  const execIsNode = /[\\/](node|node\.exe)$/.test(process.execPath);
  const tsxLoader = !!process.env.TSX || (process.env.NODE_OPTIONS ?? '').includes('tsx');
  return underBun && !execIsNode && !tsxLoader;
}

/** musl libc detection (Linux only): glibcVersionRuntime absent ⇒ musl. */
export function detectMusl(): boolean {
  if (process.platform !== 'linux') return false;
  try {
    const rep = (process as unknown as { report?: { getReport?: () => { header?: Record<string, unknown> } } }).report?.getReport?.();
    if (rep?.header && !('glibcVersionRuntime' in rep.header)) return true;
  } catch {
    /* fall through */
  }
  return false;
}

export function detectPlatform(): Platform {
  const os_ =
    process.platform === 'darwin' ? 'darwin' : process.platform === 'linux' ? 'linux' : 'windows';
  const arch = process.arch === 'arm64' ? 'arm64' : 'x64';
  const musl = detectMusl();
  const assetName = `idctl-${os_}-${arch}${musl ? '-musl' : ''}`;
  return { os: os_ as Platform['os'], arch, musl, assetName };
}
