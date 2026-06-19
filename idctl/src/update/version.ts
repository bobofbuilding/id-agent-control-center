/** Dependency-free semver-lite comparison. */

/** Strip a single leading "v" and surrounding whitespace. */
export function clean(v: string): string {
  return v.replace(/^v/, '').trim();
}

/**
 * True iff `remote` is strictly newer than `local`. Equal ⇒ false — this is
 * load-bearing for re-exec-loop prevention (a staged build equal to the running
 * one must NOT be treated as an upgrade).
 */
export function isNewer(remote: string, local: string): boolean {
  const a = clean(remote).split('.').map((n) => parseInt(n, 10) || 0);
  const b = clean(local).split('.').map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    if (x !== y) return x > y;
  }
  return false;
}
