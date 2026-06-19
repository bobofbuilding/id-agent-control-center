/**
 * Config path resolution. Precedence (first match wins), per the XDG Base
 * Directory spec and common CLI convention (gh/aws/kubectl):
 *   1. explicit --config <path> flag
 *   2. IDCTL_CONFIG env var (absolute path to the FILE)
 *   3. $XDG_CONFIG_HOME/idctl/config.json   (only if XDG_CONFIG_HOME is absolute)
 *   4. ~/.config/idctl/config.json          (default; same on macOS & Linux)
 *
 * Works identically whether idctl runs via tsx or as a compiled bun binary —
 * resolution only reads process.env and os.homedir() at call time.
 */

import { homedir } from 'node:os';
import { isAbsolute, join, dirname, resolve } from 'node:path';

function expandHome(p: string): string {
  if (p === '~') return homedir();
  if (p.startsWith('~/')) return join(homedir(), p.slice(2));
  return p;
}

export function resolveConfigPath(flag?: string): string {
  if (flag && flag.trim()) {
    const p = expandHome(flag.trim());
    return isAbsolute(p) ? p : resolve(process.cwd(), p);
  }
  const env = process.env.IDCTL_CONFIG?.trim();
  if (env) {
    const p = expandHome(env);
    return isAbsolute(p) ? p : resolve(process.cwd(), p);
  }
  const xdg = process.env.XDG_CONFIG_HOME?.trim();
  if (xdg && isAbsolute(xdg)) {
    return join(xdg, 'idctl', 'config.json');
  }
  return join(homedir(), '.config', 'idctl', 'config.json');
}

export function configDir(file: string): string {
  return dirname(file);
}
