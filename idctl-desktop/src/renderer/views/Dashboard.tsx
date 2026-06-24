import { useEffect, useMemo, useState } from 'react';
import { call, resolveCoordinator, type FleetStore, type TeamEvent } from '../store.ts';
import { Chat } from './Chat.tsx';

/**
 * Dashboard = talk to a team lead + watch the fleet. The main panel is a chat locked to a
 * chosen team's lead/coordinator (pick the team from the header — independent of any global
 * active team), beside a slim, live activity feed spanning every team.
 */

const ACTIVE_RE = /stop|offline|dead|exit|error|crash|down|disabled|sleep/i;
function isActive(status?: string): boolean { return !!status && !ACTIVE_RE.test(status); }

function ago(ts?: number): string {
  if (!ts) return '';
  const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.round(s / 60)}m`;
  return `${Math.round(s / 3600)}h`;
}
function str(x: unknown): string { return typeof x === 'string' ? x : ''; }
function agentLabel(idOrName: string, byId: Map<string, string>): string {
  if (!idOrName) return '';
  return byId.get(idOrName) ?? (/^agent_\d+_/.test(idOrName) ? '@' + idOrName.replace(/^agent_\d+_/, '') : idOrName);
}
const QUERY_VERB: Record<string, string> = {
  dispatched: 'was asked', received: 'received a query', processing: 'is thinking',
  delivered: 'replied', done: 'finished', complete: 'finished', completed: 'finished',
  failed: 'failed', timeout: 'timed out', cancelled: 'was cancelled', queued: 'queued a query',
};
function clip(s: string, n: number): string { const t = s.replace(/\s+/g, ' ').trim(); return t.length > n ? t.slice(0, n) + '…' : t; }
function previewOf(d: Record<string, unknown>): string {
  return str(d.message_preview) || str(d.preview) || str(d.message) || str(d.text) || str(d.title) || str(d.note);
}
function replyKind(preview: string): string {
  const p = preview.toLowerCase();
  if (!preview) return '';
  if (/^ready\b/.test(p) || p === 'ok' || p === 'ack') return 'heartbeat';
  if (/\b(error|failed|exception|cannot|denied|timeout)\b/.test(p)) return 'error';
  if (/```|function|const |class |def |import |\bSELECT\b/.test(preview)) return 'code';
  if (/\?$/.test(preview.trim())) return 'question';
  return 'message';
}
function describe(e: { topic: string; actor?: string; data?: Record<string, unknown> }, name: (id: string) => string): string {
  const d = e.data ?? {};
  const who = name(str(d.agent) || str(e.actor) || str(d.from) || str(d.name));
  const t = e.topic;
  if (t.startsWith('query:')) {
    const st = str(d.status) || t.split(':')[1] || '';
    const verb = QUERY_VERB[st] || (st ? `query ${st}` : 'query');
    const preview = previewOf(d);
    const head = who ? `${who} ${verb}` : verb;
    if (preview) { const kind = replyKind(preview); return `${head}${kind ? ` · ${kind}` : ''} · “${clip(preview, 80)}”`; }
    return head;
  }
  if (t.startsWith('task:')) return [who, clip(previewOf(d) || str(d.status) || t.split(':')[1], 90)].filter(Boolean).join(' — ');
  if (t.startsWith('agent:')) return [who, t.split(':')[1]].filter(Boolean).join(' ');
  if (t.startsWith('checkin')) return [name(str(d.delegate)) || who, clip(str(d.title), 80)].filter(Boolean).join(' — ');
  if (/relay|delegat|ask|deleg/.test(t)) { const to = name(str(d.to) || str(d.target) || str(d.delegate)); return [who, to].filter(Boolean).join(' → '); }
  const detail = previewOf(d) || str(d.status);
  return [who, clip(detail, 90)].filter(Boolean).join(' · ') || t;
}
function topicClass(t: string): string {
  if (/online|delivered|done|complete/.test(t)) return 'ok';
  if (/offline|fail|expired|error/.test(t)) return 'err';
  if (/due|pending/.test(t)) return 'warn';
  return 'accent';
}

export function Dashboard({ store }: { store: FleetStore }) {
  // Teams that currently have ≥1 running agent (idle teams hidden from the picker).
  const activeTeams = useMemo(
    () => store.teams.map((t) => t.name).filter((n) => store.allAgents.some((a) => a.team === n && isActive(a.status))),
    [store.teams, store.allAgents],
  );
  // The chat targets a CHOSEN team's lead — independent of the global active team.
  // Default to the active team (if running) else the first team with running agents.
  const [chatTeam, setChatTeam] = useState<string>('');
  useEffect(() => {
    setChatTeam((cur) => {
      if (cur && activeTeams.includes(cur)) return cur;
      if (store.team && activeTeams.includes(store.team)) return store.team;
      return activeTeams[0] ?? store.team ?? 'default';
    });
  }, [activeTeams, store.team]);

  const teamAgents = useMemo(() => store.allAgents.filter((a) => a.team === chatTeam), [store.allAgents, chatTeam]);
  // For the active team we honor the user's ★ coordinator; for any other team fall
  // back to the role heuristic (lead/manager → first agent).
  const lead = resolveCoordinator(teamAgents, chatTeam === store.team ? store.coordinator : undefined) ?? 'lead';

  // Holistic activity feed: recent events across EVERY team (newest first).
  const [events, setEvents] = useState<TeamEvent[]>([]);
  useEffect(() => {
    let live = true;
    const load = () => call<TeamEvent[]>('events:multi', 80).then((r) => { if (live) setEvents(r); }).catch(() => {});
    void load();
    const iv = setInterval(load, 4000);
    return () => { live = false; clearInterval(iv); };
  }, []);
  const agentById = useMemo(() => new Map(store.allAgents.map((a) => [a.id, a.name] as const)), [store.allAgents]);
  const resolveAgent = (id: string) => agentLabel(id, agentById);

  return (
    <div className="view" style={{ display: 'flex', flexDirection: 'column', minHeight: 0 }}>
      <header className="view-head" style={{ display: 'flex', alignItems: 'baseline', gap: 12 }}>
        <h1>Dashboard</h1>
        <label className="muted small" style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          talk to
          <select value={chatTeam} onChange={(e) => setChatTeam(e.target.value)} style={{ maxWidth: 260 }}>
            {(activeTeams.length ? activeTeams : [chatTeam].filter(Boolean)).map((t) => {
              const tl = resolveCoordinator(store.allAgents.filter((a) => a.team === t), t === store.team ? store.coordinator : undefined) ?? 'lead';
              return <option key={t} value={t}>{t}{t === store.team ? ' (active)' : ''} · {tl}</option>;
            })}
          </select>
        </label>
      </header>

      {/* Explicit flex row so the chat fills the left and the activity tile always shows on the right. */}
      <div style={{ display: 'flex', gap: 14, flex: 1, minHeight: 0, alignItems: 'stretch' }}>
        {/* Lead chat: locked to the chosen team's lead (no agent picker — Chat renders its own card). */}
        <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column' }}>
          <Chat store={store} embedded teamOverride={chatTeam} lockTarget={lead} key={chatTeam} />
        </div>

        {/* marginTop offsets the chat's control row so the tile top squares with the chat card
            top (when no project is focused; a focused project's banner adds a little extra). */}
        <aside className="card" style={{ width: 560, flexShrink: 0, marginTop: 38, display: 'flex', flexDirection: 'column', minHeight: 0 }}>
          <h3 style={{ marginTop: 0 }}>Activity <span className="muted small">· all teams{events.length ? ` (${events.length})` : ''}</span></h3>
          <div className="feed-list" style={{ flex: 1, overflowY: 'auto', minHeight: 0 }}>
            {[...events].reverse().slice(0, 80).map((e) => (
              <div className="feed-row" key={`${e.team ?? ''}-${e.seq}`} title={e.topic}>
                <span className={`topic ${topicClass(e.topic)}`}>{e.topic.split(':')[0]}</span>
                <span className="desc">{e.team ? <span className="muted" style={{ marginRight: 4 }}>[{e.team}]</span> : null}{describe(e, resolveAgent)}</span>
                {e.timestamp ? <span className="muted t">{ago(e.timestamp)}</span> : null}
              </div>
            ))}
            {events.length === 0 ? <div className="muted">waiting for events…</div> : null}
          </div>
        </aside>
      </div>
    </div>
  );
}
