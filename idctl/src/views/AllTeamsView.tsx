/**
 * AllTeamsView — cross-team fleet health in one screen. Fans out a per-team
 * /agents fetch (via client.withTeam) and rolls each up into online/offline
 * counts and a runtime tally. Enter on a team makes it the active team and
 * drops you into the Dashboard for the drill-in.
 */

import { useCallback, useEffect, useState } from 'react';
import { Box, Text } from 'ink';
import Spinner from 'ink-spinner';
import { useAppCtx } from '../app/context.ts';
import { Select, type SelectItem } from '../components/Select.tsx';
import { theme, shortRuntime, statusColor } from '../app/theme.ts';
import { loadSettings } from '../settings/store.ts';
import { resolveConfigPath } from '../settings/paths.ts';

interface TeamRoll {
  name: string;
  total: number;
  online: number;
  offline: number;
  runtimes: Record<string, number>;
  error?: string;
}

function isOnline(status: string): boolean {
  return statusColor(status) === theme.ok;
}

export function AllTeamsView() {
  const { store, flash, goto } = useAppCtx();
  const [rolls, setRolls] = useState<TeamRoll[]>([]);
  const [cursor, setCursor] = useState(0);
  const [loading, setLoading] = useState(true);

  const refetch = useCallback(async () => {
    const known = loadSettings(resolveConfigPath()).knownTeams ?? null;
    const teams =
      known && known.length > 0
        ? store.teams.filter((t) => known.includes(t.name) || t.name === store.team)
        : store.teams;
    if (teams.length === 0) {
      setLoading(false);
      return;
    }
    const out = await Promise.all(
      teams.map(async (t): Promise<TeamRoll> => {
        try {
          const agents = await store.client.withTeam(t.name).agents();
          const runtimes: Record<string, number> = {};
          let online = 0;
          for (const a of agents) {
            const rt = shortRuntime(a.runtime ?? a.type);
            runtimes[rt] = (runtimes[rt] ?? 0) + 1;
            if (isOnline(a.status)) online++;
          }
          return { name: t.name, total: agents.length, online, offline: agents.length - online, runtimes };
        } catch (err) {
          return { name: t.name, total: t.agentCount, online: 0, offline: 0, runtimes: {}, error: err instanceof Error ? err.message : String(err) };
        }
      }),
    );
    setRolls(out);
    setLoading(false);
  }, [store.teams, store.client]);

  // Initial + periodic refresh (every 5s; lighter than the 3s snapshot loop
  // since this fans out one request per team).
  useEffect(() => {
    refetch();
    const id = setInterval(refetch, 5000);
    return () => clearInterval(id);
  }, [refetch]);

  const grand = rolls.reduce(
    (acc, r) => ({ total: acc.total + r.total, online: acc.online + r.online }),
    { total: 0, online: 0 },
  );

  const items: SelectItem<TeamRoll>[] = rolls.map((r) => ({
    key: r.name,
    label: r.name.padEnd(12).slice(0, 12),
    value: r,
    color: r.name === store.team ? theme.accent : undefined,
    hint: r.error
      ? `⚠ ${r.error}`
      : `${String(r.total).padStart(2)} agents · ${r.online}↑ ${r.offline}↓ · ${runtimeSummary(r.runtimes)}`,
  }));

  return (
    <Box flexDirection="column">
      <Text bold color={theme.accent}>
        All Teams{' '}
        <Text color={theme.dim}>
          · {rolls.length} teams · {grand.online}/{grand.total} agents online
        </Text>
      </Text>
      <Box marginTop={1}>
        {loading && rolls.length === 0 ? (
          <Text color={theme.warn}>
            <Spinner type="dots" /> rolling up teams…
          </Text>
        ) : (
          <Select
            items={items}
            index={cursor}
            onIndexChange={setCursor}
            onSelect={(it) => {
              store.setTeam(it.value.name);
              flash(`switched to ${it.value.name}`, 'ok');
              goto('dash');
            }}
            emptyText="(no teams)"
            maxVisible={12}
          />
        )}
      </Box>
      <Text color={theme.dim}>Enter open a team in the Dashboard · ↑↓ select</Text>
    </Box>
  );
}

function runtimeSummary(runtimes: Record<string, number>): string {
  const parts = Object.entries(runtimes)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([rt, n]) => `${n} ${rt}`);
  return parts.join(', ') || '—';
}
