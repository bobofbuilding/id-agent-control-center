/**
 * useManager — the reactive store behind the whole TUI.
 *
 * Owns three independent loops against the manager daemon:
 *   1. snapshot poll  — /agents + /teams + /manager/inbox/pending every refreshMs
 *   2. event stream   — /events?since=<cursor> long-poll, appended to a ring buffer
 *   3. connection     — derived from whether the loops are erroring
 *
 * Everything is exposed as plain React state so any view just reads it. Loops
 * are torn down on unmount and paused while the manager is unreachable (with a
 * short backoff) so we don't hammer a dead socket.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { ManagerClient, NetworkError } from '../api/client.ts';
import type { Agent, InboxItem, ManagerEvent, Team } from '../api/types.ts';

export type Connection = 'connecting' | 'online' | 'offline';

export interface ManagerStore {
  client: ManagerClient;
  team: string | undefined;
  connection: Connection;
  agents: Agent[];
  teams: Team[];
  events: ManagerEvent[];
  inbox: InboxItem[];
  lastError?: string;
  lastUpdated?: number;
  /** Force an immediate snapshot refresh. */
  refresh: () => void;
  /** Switch the active team (re-points all loops). */
  setTeam: (team: string | undefined) => void;
  /** Re-point the live store at a different manager (used by Settings). */
  setConnection: (conn: { url: string; team?: string; apiKey?: string }) => void;
}

const EVENT_BUFFER = 200;

export function useManager(client0: ManagerClient): ManagerStore {
  const [client, setClient] = useState(client0);
  const [connection, setConnState] = useState<Connection>('connecting');
  const [agents, setAgents] = useState<Agent[]>([]);
  const [teams, setTeams] = useState<Team[]>([]);
  const [events, setEvents] = useState<ManagerEvent[]>([]);
  const [inbox, setInbox] = useState<InboxItem[]>([]);
  const [lastError, setLastError] = useState<string>();
  const [lastUpdated, setLastUpdated] = useState<number>();
  const [refreshTick, setRefreshTick] = useState(0);

  const refresh = useCallback(() => setRefreshTick((t) => t + 1), []);
  const setTeam = useCallback((team: string | undefined) => {
    setEvents([]); // event cursor is team-scoped; start clean
    setAgents([]);
    setClient((c) => c.withTeam(team));
  }, []);

  const setConnection = useCallback((conn: { url: string; team?: string; apiKey?: string }) => {
    setEvents([]);
    setAgents([]);
    setTeams([]);
    setConnState('connecting');
    setClient((c) => c.withConfig({ managerUrl: conn.url, team: conn.team, apiKey: conn.apiKey }));
  }, []);

  // ---- Snapshot loop: agents + teams + inbox --------------------------------
  useEffect(() => {
    let alive = true;
    const ctrl = new AbortController();
    let timer: ReturnType<typeof setTimeout>;

    const tick = async () => {
      try {
        const [ag, tm, ib] = await Promise.all([
          client.agents(ctrl.signal),
          client.teams(ctrl.signal),
          client.inboxPending(ctrl.signal).catch(() => [] as InboxItem[]),
        ]);
        if (!alive) return;
        setAgents(ag);
        setTeams(tm);
        setInbox(ib);
        setConnState('online');
        setLastError(undefined);
        setLastUpdated(Date.now());
      } catch (err) {
        if (!alive) return;
        if ((err as Error)?.name === 'AbortError') return;
        setConnState('offline');
        setLastError(err instanceof Error ? err.message : String(err));
      } finally {
        if (alive) {
          const delay = connectionDelay(client.managerUrl);
          timer = setTimeout(tick, delay);
        }
      }
    };
    tick();
    return () => {
      alive = false;
      ctrl.abort();
      clearTimeout(timer);
    };
    // Re-run whenever the client (team/url) changes or a manual refresh fires.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client, refreshTick]);

  // ---- Event stream loop ----------------------------------------------------
  useEffect(() => {
    let alive = true;
    const ctrl = new AbortController();
    let since = 0;

    const loop = async () => {
      while (alive) {
        try {
          const resp = await client.events(since, { wait: 25, limit: 100 }, ctrl.signal);
          if (!alive) return;
          if (resp.events.length > 0) {
            setEvents((prev) => [...prev, ...resp.events].slice(-EVENT_BUFFER));
          }
          since = resp.next_seq ?? since;
        } catch (err) {
          if (!alive || (err as Error)?.name === 'AbortError') return;
          // Manager unreachable — back off before retrying so we don't spin.
          await sleep(3000);
        }
      }
    };
    loop();
    return () => {
      alive = false;
      ctrl.abort();
    };
  }, [client]);

  return {
    client,
    team: client.team,
    connection,
    agents,
    teams,
    events,
    inbox,
    lastError,
    lastUpdated,
    refresh,
    setTeam,
    setConnection,
  };
}

function connectionDelay(_url: string): number {
  const n = Number(process.env.IDCTL_REFRESH_MS);
  return Number.isFinite(n) && n >= 500 ? n : 3000;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
