/**
 * Headless snapshot commands. These never open the Ink UI, so they run fine
 * in a pipe / CI / non-TTY context and double as the smoke test for the API
 * client. `idctl status` prints a human table; `--json` prints raw JSON.
 */

import { ManagerClient, NetworkError } from '../api/client.ts';
import type { Config } from '../config.ts';

const C = {
  reset: '\x1b[0m',
  dim: '\x1b[2m',
  bold: '\x1b[1m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  red: '\x1b[31m',
  cyan: '\x1b[36m',
};

function statusColor(s: string): string {
  if (/running|online|ok/i.test(s)) return C.green;
  if (/start|pending|processing|probing/i.test(s)) return C.yellow;
  return C.red;
}

export async function runStatus(cfg: Config, opts: { json: boolean }): Promise<number> {
  const client = new ManagerClient(cfg);
  try {
    const [health, teams, agents] = await Promise.all([
      client.health(),
      client.teams(),
      client.agents(),
    ]);

    if (opts.json) {
      process.stdout.write(JSON.stringify({ health, teams, agents }, null, 2) + '\n');
      return 0;
    }

    const team = cfg.team ?? health.team ?? 'default';
    process.stdout.write(
      `${C.bold}ID Agents Control Center${C.reset}  ${C.dim}${cfg.managerUrl}${C.reset}\n`,
    );
    process.stdout.write(
      `manager ${C.green}● ${health.status}${C.reset}   team ${C.cyan}${team}${C.reset}   ` +
        `${agents.length} agent(s)   ${teams.length} team(s)\n\n`,
    );

    if (agents.length === 0) {
      process.stdout.write(`${C.dim}(no agents in team "${team}")${C.reset}\n`);
    } else {
      const rows = agents.map((a) => ({
        name: a.name,
        runtime: a.runtime ?? a.type ?? '—',
        model: a.model ?? '—',
        port: a.port ? String(a.port) : '—',
        status: a.status,
      }));
      const w = {
        name: Math.max(5, ...rows.map((r) => r.name.length)),
        runtime: Math.max(7, ...rows.map((r) => r.runtime.length)),
        model: Math.max(5, ...rows.map((r) => r.model.length)),
        port: Math.max(4, ...rows.map((r) => r.port.length)),
      };
      const pad = (s: string, n: number) => s.padEnd(n);
      process.stdout.write(
        `${C.dim}${pad('NAME', w.name)}  ${pad('RUNTIME', w.runtime)}  ${pad('MODEL', w.model)}  ${pad('PORT', w.port)}  STATUS${C.reset}\n`,
      );
      for (const r of rows) {
        process.stdout.write(
          `${pad(r.name, w.name)}  ${C.dim}${pad(r.runtime, w.runtime)}${C.reset}  ` +
            `${pad(r.model, w.model)}  ${C.dim}${pad(r.port, w.port)}${C.reset}  ` +
            `${statusColor(r.status)}●${C.reset} ${r.status}\n`,
        );
      }
    }

    // Surface anything waiting on a human, since that's actionable.
    try {
      const pending = await client.inboxPending();
      if (pending.length > 0) {
        process.stdout.write(
          `\n${C.yellow}${C.bold}⚠ ${pending.length} message(s) awaiting your reply${C.reset} ` +
            `${C.dim}(run \`idctl\` → Inbox)${C.reset}\n`,
        );
        for (const p of pending.slice(0, 3)) {
          process.stdout.write(`  ${C.dim}${p.from ?? 'manager'}:${C.reset} ${p.message.slice(0, 80)}\n`);
        }
      }
    } catch {
      /* inbox is best-effort in the snapshot */
    }
    return 0;
  } catch (err) {
    const down = err instanceof NetworkError;
    process.stderr.write(
      `${C.red}${down ? 'Cannot reach manager' : 'Manager error'}${C.reset} at ${cfg.managerUrl}\n` +
        `  ${err instanceof Error ? err.message : String(err)}\n`,
    );
    if (down) {
      process.stderr.write(
        `${C.dim}Is the daemon up? Try:\n` +
          `  curl -4 -sS ${cfg.managerUrl}/health\n` +
          `  (cd id-agents && node dist/start-agent-manager.js)${C.reset}\n`,
      );
    }
    return 1;
  }
}
