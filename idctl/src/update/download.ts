/**
 * Download a release asset and verify it before it is ever trusted: sha256 must
 * match the published checksum AND the bytes must carry a valid executable
 * magic (Mach-O on darwin, ELF on linux). A hash-matching-but-garbage artifact
 * is rejected here, before staging.
 */

import crypto from 'node:crypto';
import { detectPlatform } from './platform.ts';
import { IDCTL_VERSION } from '../version.ts';
import type { UpdateInfo, VerifiedDownload } from './types.ts';

const UA = `idctl/${IDCTL_VERSION}`;

export async function downloadAndVerify(info: UpdateInfo): Promise<VerifiedDownload> {
  const plat = detectPlatform();

  const res = await fetch(info.assetUrl, { headers: { 'User-Agent': UA } });
  if (!res.ok) throw new Error(`download failed: ${res.status}`);
  const bytes = Buffer.from(await res.arrayBuffer());
  if (bytes.length < 1024) throw new Error('downloaded asset implausibly small');

  let expected = info.sha256?.toLowerCase();
  if (!expected && info.shasumsUrl) {
    const txt = await (await fetch(info.shasumsUrl, { headers: { 'User-Agent': UA } })).text();
    expected = parseShasums(txt).get(plat.assetName)?.toLowerCase();
  }
  if (!expected) throw new Error('no checksum available — refusing to install');

  const got = crypto.createHash('sha256').update(bytes).digest('hex');
  if (got !== expected) {
    throw new Error(`checksum mismatch (got ${got.slice(0, 12)}…, want ${expected.slice(0, 12)}…)`);
  }
  if (!hasExecutableMagic(bytes, plat.os)) {
    throw new Error('verified bytes are not a valid executable image');
  }
  return { bytes, sha256: got };
}

export function parseShasums(txt: string): Map<string, string> {
  const m = new Map<string, string>();
  for (const line of txt.split('\n')) {
    const mt = line.match(/^([0-9a-fA-F]{64})\s+\*?(\S+)\s*$/);
    if (mt) m.set(mt[2], mt[1]);
  }
  return m;
}

/** Mach-O (thin/fat, 32/64) on darwin, ELF on linux. */
function hasExecutableMagic(b: Buffer, os: string): boolean {
  if (b.length < 4) return false;
  if (os === 'linux') return b[0] === 0x7f && b[1] === 0x45 && b[2] === 0x4c && b[3] === 0x46; // \x7fELF
  const be = b.readUInt32BE(0);
  const le = b.readUInt32LE(0);
  const machO = new Set([0xfeedfacf, 0xfeedface, 0xcafebabe, 0xbebafeca, 0xcffaedfe, 0xcefaedfe]);
  return machO.has(be) || machO.has(le);
}
