/**
 * Renderer-side live store. Talks to the manager only through the IPC bridge
 * (window.idagents.call). Mirrors the TUI's polling/streaming loops: a 3s
 * snapshot poll (agents/teams/inbox) plus a long-poll event cursor.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import type { Agent, Team, ManagerEvent, InboxItem } from '../../../idctl/src/api/types.ts';

export type Connection = 'connecting' | 'online' | 'offline';

/**
 * Pluggable data transport so the same UI runs under any shell:
 *   - Electron: IPC bridge (window.idagents)
 *   - Tauri:    a webview-side adapter (ManagerClient over the Tauri HTTP plugin)
 * The shell's entry point calls setTransport() before rendering.
 */
export type Transport = (method: string, args: unknown[]) => Promise<{ ok: boolean; result?: unknown; error?: string }>;

let transport: Transport | null = null;
export function setTransport(t: Transport): void {
  transport = t;
}

/** Typed call over the active transport. Throws on the error envelope. */
export async function call<T = unknown>(method: string, ...args: unknown[]): Promise<T> {
  if (!transport) throw new Error('no transport configured');
  const res = await transport(method, args);
  if (!res.ok) throw new Error(res.error || 'manager error');
  return res.result as T;
}

export interface FleetStore {
  connection: Connection;
  managerUrl: string;
  team?: string;
  coordinator?: string;
  agents: Agent[];
  teams: Team[];
  events: ManagerEvent[];
  inbox: InboxItem[];
  lastError?: string;
  lastUpdated?: number;
  refresh: () => void;
  setTeam: (team: string) => Promise<void>;
  setCoordinator: (agent: string) => Promise<void>;
}

const EVENT_BUFFER = 250;

export function useFleet(): FleetStore {
  const [connection, setConnection] = useState<Connection>('connecting');
  const [managerUrl, setManagerUrl] = useState('');
  const [team, setTeamState] = useState<string | undefined>(undefined);
  const [coordinator, setCoordinatorState] = useState<string | undefined>(undefined);
  const [agents, setAgents] = useState<Agent[]>([]);
  const [teams, setTeams] = useState<Team[]>([]);
  const [events, setEvents] = useState<ManagerEvent[]>([]);
  const [inbox, setInbox] = useState<InboxItem[]>([]);
  const [lastError, setLastError] = useState<string>();
  const [lastUpdated, setLastUpdated] = useState<number>();
  const [tick, setTick] = useState(0);
  const epoch = useRef(0); // bump on team change to reset the event cursor loop

  const refresh = useCallback(() => setTick((t) => t + 1), []);

  const setTeam = useCallback(async (t: string) => {
    const i = await call<{ team?: string; coordinator?: string }>('setTeam', t);
    setTeamState(i.team);
    setCoordinatorState(i.coordinator ?? undefined);
    setEvents([]);
    setAgents([]);
    epoch.current += 1;
    refresh();
  }, [refresh]);

  const setCoordinator = useCallback(async (agent: string) => {
    await call('coordinator:set', team ?? 'default', agent);
    setCoordinatorState(agent);
  }, [team]);

  // Snapshot poll.
  useEffect(() => {
    let alive = true;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const [info, ag, tm, ib] = await Promise.all([
          call<{ managerUrl: string; team?: string; coordinator?: string }>('info'),
          call<Agent[]>('agents'),
          call<Team[]>('teams'),
          call<InboxItem[]>('inboxPending').catch(() => [] as InboxItem[]),
        ]);
        if (!alive) return;
        setManagerUrl(info.managerUrl);
        setTeamState(info.team);
        setCoordinatorState(info.coordinator ?? undefined);
        setAgents(ag);
        setTeams(tm);
        setInbox(ib);
        setConnection('online');
        setLastError(undefined);
        setLastUpdated(Date.now());
      } catch (err) {
        if (!alive) return;
        setConnection('offline');
        setLastError(err instanceof Error ? err.message : String(err));
      } finally {
        if (alive) timer = setTimeout(poll, 3000);
      }
    };
    poll();
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [tick]);

  // Event-stream cursor loop.
  useEffect(() => {
    let alive = true;
    let since = 0;
    const myEpoch = epoch.current;
    const loop = async () => {
      while (alive && epoch.current === myEpoch) {
        try {
          const resp = await call<{ events: ManagerEvent[]; next_seq: number }>('events', since);
          if (!alive) return;
          if (resp.events?.length) setEvents((prev) => [...prev, ...resp.events].slice(-EVENT_BUFFER));
          since = resp.next_seq ?? since;
        } catch {
          await new Promise((r) => setTimeout(r, 3000));
        }
      }
    };
    loop();
    return () => {
      alive = false;
    };
  }, [tick]);

  return { connection, managerUrl, team, coordinator, agents, teams, events, inbox, lastError, lastUpdated, refresh, setTeam, setCoordinator };
}
