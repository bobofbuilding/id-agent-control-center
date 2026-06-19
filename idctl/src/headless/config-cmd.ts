/** `idctl config` (show) and `idctl init` (materialize) — headless, no TTY. */

import { existsSync } from 'node:fs';
import { resolveConfigPath } from '../settings/paths.ts';
import { loadSettings, saveSettings, redactKey } from '../settings/store.ts';

const C = { reset: '\x1b[0m', dim: '\x1b[2m', bold: '\x1b[1m', cyan: '\x1b[36m', green: '\x1b[32m' };

export function runConfig(configPath: string | undefined, init: boolean): number {
  const file = resolveConfigPath(configPath);

  if (init) {
    if (existsSync(file)) {
      process.stdout.write(`config already exists: ${file}\n`);
    } else {
      saveSettings(loadSettings(file), file);
      process.stdout.write(`${C.green}created${C.reset} ${file}\n`);
    }
    return 0;
  }

  const cfg = loadSettings(file);
  const exists = existsSync(file);
  process.stdout.write(`${C.bold}config${C.reset} ${file} ${exists ? '' : C.dim + '(not created yet — run `idctl init`)' + C.reset}\n`);

  process.stdout.write(
    `\n${C.bold}teams${C.reset} · default: ${C.cyan}${cfg.defaultTeam ?? 'default'}${C.reset}` +
      ` · known: ${cfg.knownTeams ? cfg.knownTeams.join(', ') : C.dim + 'all (unfiltered)' + C.reset}\n`,
  );

  process.stdout.write(`\n${C.bold}managers${C.reset} (${cfg.managers.length})${cfg.defaultManager ? ` · default: ${C.cyan}${cfg.defaultManager}${C.reset}` : ''}\n`);
  for (const m of cfg.managers) {
    process.stdout.write(`  ${m.name.padEnd(12)} ${m.url}${m.team ? ` · ${m.team}` : ''} · key ${redactKey(m.apiKey)}\n`);
  }
  if (cfg.managers.length === 0) process.stdout.write(`  ${C.dim}(none — default connection is http://127.0.0.1:4100)${C.reset}\n`);

  process.stdout.write(`\n${C.bold}providers${C.reset} (${cfg.providers.length})\n`);
  for (const p of cfg.providers) {
    process.stdout.write(`  ${p.name.padEnd(12)} ${p.kind.padEnd(18)} ${p.baseUrl} · ${p.enabled ? 'on' : 'off'}${p.default ? ' · default' : ''} · key ${redactKey(p.apiKey)}\n`);
  }
  if (cfg.providers.length === 0) process.stdout.write(`  ${C.dim}(none — add in the TUI: view 0 → p → n)${C.reset}\n`);
  return 0;
}
