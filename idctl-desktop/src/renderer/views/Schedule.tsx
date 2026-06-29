import { useEffect, useState } from 'react';
import { call, useSyncVersion, type FleetStore } from '../store.ts';
import type { CheckIn, ScheduleEntry } from '../../../../idctl/src/api/client.ts';

/** Schedule panel (a tab under Tasks): heartbeats + supervision check-ins.
 *  Recurring objective check-ins live in the Loops tab. */

const HEARTBEAT_MSG = 'Heartbeat: review your checklist and act on anything that needs attention.';
const INTERVALS = [
  { label: '1 min', s: 60 },
  { label: '5 min', s: 300 },
  { label: '15 min', s: 900 },
  { label: '1 hour', s: 3600 },
  { label: '6 hours', s: 21600 },
  { label: '24 hours', s: 86400 },
];

function fmtInterval(sec: number | null): string {
  if (!sec) return '—';
  if (sec < 3600) return `${Math.round(sec / 60)}m`;
  if (sec < 86400) return `${Math.round(sec / 3600)}h`;
  return `${Math.round(sec / 86400)}d`;
}
function relTime(unixSec: number | null): string {
  if (!unixSec) return 'never';
  const s = Math.max(0, Math.round(Date.now() / 1000 - unixSec));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}
/** Relative time from a millisecond-epoch timestamp (check-in fire times). */
function fmtMsAgo(ms?: number | null): string {
  if (!ms) return 'not yet';
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}
function fmtMsIn(ms?: number | null): string {
  if (!ms) return '—';
  const s = Math.round((ms - Date.now()) / 1000);
  if (s <= 0) return 'due now';
  if (s < 60) return `in ${s}s`;
  if (s < 3600) return `in ${Math.round(s / 60)}m`;
  if (s < 86400) return `in ${Math.round(s / 3600)}h`;
  return `in ${Math.round(s / 86400)}d`;
}
const isTerminalTask = (s?: string): boolean => !!s && /done|complete|closed|cancel/i.test(s);

/** A heartbeat is "missed" when active but its last run is older than ~2 intervals. */
function isMissed(s: ScheduleEntry): boolean {
  if (s.kind !== 'heartbeat' || !s.active || !s.intervalSeconds) return false;
  if (!s.lastRunAt) return false;
  return Date.now() / 1000 - s.lastRunAt > s.intervalSeconds * 2;
}

type TeamSchedule = ScheduleEntry & { team?: string };
function targetKey(agent: string, team?: string): string {
  return `${team ?? 'default'}/${agent}`;
}
function scheduleStamp(s: TeamSchedule): string {
  return JSON.stringify({
    active: !!s.active,
    intervalSeconds: s.intervalSeconds ?? null,
    targets: [...(s.targets ?? [])].sort(),
    message: s.message ?? '',
  });
}
function checkinStamp(c: CheckIn): string {
  return JSON.stringify({
    status: String(c.status ?? ''),
    taskStatus: String(c.linkedTask?.status ?? ''),
    taskGone: !!c.linkedTask?.gone,
  });
}
function checkinId(c: CheckIn): string {
  return String(c.id ?? '');
}
function linkedTaskState(c: CheckIn): string {
  if (c.linkedTask?.gone) return 'gone';
  return String(c.linkedTask?.status ?? 'unknown');
}

export function Schedule({ store }: { store: FleetStore }) {
  const syncVersion = useSyncVersion(['schedules', 'checkins', 'loops', 'work']);
  const [schedules, setSchedules] = useState<ScheduleEntry[]>([]);
  const [allSchedules, setAllSchedules] = useState<TeamSchedule[]>([]);
  const [checkins, setCheckins] = useState<CheckIn[]>([]);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');
  const [hbInterval, setHbInterval] = useState<Record<string, number>>({});
  const [showClosed, setShowClosed] = useState(false);

  async function reload() {
    setSchedules(await call<ScheduleEntry[]>('schedules').catch(() => []));
    setAllSchedules(await call<TeamSchedule[]>('schedules:allTeams').catch(() => []));
    setCheckins(await call<CheckIn[]>('checkins').catch(() => []));
  }
  useEffect(() => {
    reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [store.team, store.lastUpdated, syncVersion]);

  async function act(label: string, fn: () => Promise<unknown>) {
    setBusy(true);
    setMsg(label + '…');
    try {
      await fn();
      await reload();
      setMsg(label + ' ✓');
    } catch (err) {
      setMsg(`${label} failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setBusy(false);
    }
  }
  async function guardedScheduleAct(label: string, detail: string, fn: () => Promise<unknown>) {
    if (!window.confirm(`${label}?\n\n${detail}`)) return;
    await act(label, fn);
  }
  async function freshSchedules(): Promise<TeamSchedule[]> {
    const all = await call<TeamSchedule[]>('schedules:allTeams').catch(() => [] as TeamSchedule[]);
    if (all.length) return all;
    const local = await call<ScheduleEntry[]>('schedules').catch(() => [] as ScheduleEntry[]);
    return local.map((s) => ({ ...s, team: store.team ?? 'default' }));
  }
  function schedulesForAgent(list: TeamSchedule[], agent: string, team?: string): TeamSchedule[] {
    return list.filter((s) => s.kind === 'heartbeat' && s.targets.includes(agent) && (!team || s.team === team));
  }
  function scheduleIds(list: TeamSchedule[]): string {
    return list.map((s) => `${s.team ?? 'default'}:${s.id}:${scheduleStamp(s)}`).sort().join('|');
  }
  async function ensureHeartbeatFresh(agent: string, team: string | undefined, rendered: TeamSchedule[], action: string): Promise<TeamSchedule[] | null> {
    const fresh = schedulesForAgent(await freshSchedules(), agent, team);
    if (scheduleIds(rendered) !== scheduleIds(fresh)) {
      window.alert([
        `${action} blocked: the heartbeat for ${team ? `${team}/` : ''}${agent} changed since this row rendered.`,
        '',
        `Shown: ${rendered.length ? rendered.map((s) => `${fmtInterval(s.intervalSeconds)} ${s.active ? 'active' : 'paused'}`).join(', ') : 'off'}`,
        `Current: ${fresh.length ? fresh.map((s) => `${fmtInterval(s.intervalSeconds)} ${s.active ? 'active' : 'paused'}`).join(', ') : 'off'}`,
        '',
        'The schedule list will refresh; review the current heartbeat before applying another change.',
      ].join('\n'));
      await reload();
      return null;
    }
    return fresh;
  }
  async function ensureScheduleFresh(s: TeamSchedule, action: string): Promise<TeamSchedule | null> {
    const fresh = (await freshSchedules()).find((x) => x.id === s.id && (s.team ? x.team === s.team : true)) ?? null;
    if (!fresh) {
      window.alert(`${action} blocked: this schedule no longer exists.`);
      await reload();
      return null;
    }
    if (scheduleStamp(s) !== scheduleStamp(fresh)) {
      window.alert([
        `${action} blocked: this schedule changed since the row rendered.`,
        '',
        `Shown: ${fmtInterval(s.intervalSeconds)} ${s.active ? 'active' : 'paused'}`,
        `Current: ${fmtInterval(fresh.intervalSeconds)} ${fresh.active ? 'active' : 'paused'}`,
        '',
        'The schedule list will refresh; review the current row before applying another change.',
      ].join('\n'));
      await reload();
      return null;
    }
    return fresh;
  }
  async function closeCheckinFresh(c: CheckIn, label = 'closing check-in'): Promise<void> {
    const id = checkinId(c);
    if (!id) return;
    const fresh = (await call<CheckIn[]>('checkins').catch(() => [] as CheckIn[])).find((x) => checkinId(x) === id) ?? null;
    if (!fresh) {
      window.alert('Close blocked: this check-in no longer exists.');
      await reload();
      return;
    }
    if (checkinStamp(c) !== checkinStamp(fresh)) {
      window.alert([
        'Close blocked: this check-in changed since the row rendered.',
        '',
        `Shown: ${String(c.status ?? 'unknown')} / task ${linkedTaskState(c)}`,
        `Current: ${String(fresh.status ?? 'unknown')} / task ${linkedTaskState(fresh)}`,
        '',
        'The check-in list will refresh; review the current row before closing it.',
      ].join('\n'));
      await reload();
      return;
    }
    if (!/(active|snoozed)/i.test(String(fresh.status))) {
      window.alert('Close blocked: this check-in is no longer active.');
      await reload();
      return;
    }
    await act(label, () => call('checkins:close', id));
  }

  const fleetAgents = store.allAgents.length ? store.allAgents : store.agents.map((a) => ({ ...a, team: store.team ?? 'default' }));
  const shownSchedules = allSchedules.length ? allSchedules : schedules.map((s) => ({ ...s, team: store.team ?? 'default' }));
  const heartbeats = shownSchedules.filter((s) => s.kind === 'heartbeat');
  function hbFor(agent: string, team?: string): TeamSchedule | undefined {
    return heartbeats.find((s) => s.targets.includes(agent) && (!team || s.team === team));
  }

  // Heartbeats whose target ISN'T an agent in the current team's roster — they'd otherwise be
  // invisible (the per-agent table only iterates this team's agents), so a cross-team or
  // manager-level heartbeat (e.g. a "task-master") never showed up. Surface them all here.
  const rosterKeys = new Set(fleetAgents.map((a) => targetKey(a.name, a.team)));
  const otherHeartbeats = allSchedules.filter(
    (s) => s.kind === 'heartbeat' && (Array.isArray(s.targets) ? s.targets : []).some((t) => !rosterKeys.has(targetKey(t, s.team))),
  );

  // Cleaner: open check-ins still watching a finished OR removed task — safe to close in bulk.
  const staleCheckins = checkins.filter(
    (c) => /(active|snoozed)/i.test(String(c.status)) && (isTerminalTask(c.linkedTask?.status) || c.linkedTask?.gone),
  );
  async function cleanUp() {
    if (!staleCheckins.length) return;
    const fresh = await call<CheckIn[]>('checkins').catch(() => [] as CheckIn[]);
    const freshStale = fresh.filter(
      (c) => /(active|snoozed)/i.test(String(c.status)) && (isTerminalTask(c.linkedTask?.status) || c.linkedTask?.gone),
    );
    const renderedIds = staleCheckins.map(checkinId).filter(Boolean).sort().join('|');
    const freshIds = freshStale.map(checkinId).filter(Boolean).sort().join('|');
    if (renderedIds !== freshIds) {
      window.alert(`Clean up blocked: the stale check-in set changed from ${staleCheckins.length} to ${freshStale.length} item${freshStale.length === 1 ? '' : 's'}.\n\nThe list will refresh; review the current stale check-ins before closing them.`);
      await reload();
      return;
    }
    if (!window.confirm(`Close ${freshStale.length} stale check-in${freshStale.length === 1 ? '' : 's'}?\n\nThis bulk-closes check-ins linked to finished or removed tasks.`)) return;
    await act(`cleaning up ${freshStale.length} stale check-in${freshStale.length === 1 ? '' : 's'}`, async () => {
      for (const c of freshStale) await call('checkins:close', checkinId(c));
    });
  }

  async function setHeartbeat(agent: string, team?: string) {
    const key = targetKey(agent, team);
    const seconds = hbInterval[key] ?? hbFor(agent, team)?.intervalSeconds ?? 3600;
    const existing = heartbeats.filter((h) => h.targets.includes(agent) && (!team || h.team === team));
    const freshExisting = await ensureHeartbeatFresh(agent, team, existing, `${existing.length ? 'Update' : 'Enable'} heartbeat`);
    if (!freshExisting) return;
    if (!window.confirm(`${freshExisting.length ? 'Update' : 'Enable'} heartbeat for ${team ? `${team}/` : ''}${agent}?\n\nThis creates or replaces a recurring internal manager check-in.`)) return;
    // ADD-then-PRUNE: create the new heartbeat before removing the old, so a
    // failed add never leaves the agent unmonitored.
    await act(`heartbeat ${agent}`, async () => {
      await call('addHeartbeat', agent, seconds, HEARTBEAT_MSG, 'internal', team);
      for (const s of freshExisting) await call('removeSchedule', s.id, s.team);
      setHbInterval((m) => { const next = { ...m }; delete next[key]; return next; });
    });
  }
  async function mutateSchedule(s: TeamSchedule, label: string, detail: string, op: 'pauseSchedule' | 'resumeSchedule' | 'removeSchedule') {
    const fresh = await ensureScheduleFresh(s, label);
    if (!fresh) return;
    await guardedScheduleAct(label, detail, () => call(op, fresh.id, fresh.team));
  }

  return (
    <>
      {msg ? <div className="muted small" style={{ marginBottom: 8 }}>{msg}</div> : null}

      <section className="card">
        <h3 style={{ marginBottom: 2 }}>Heartbeats — periodic agent self-checks</h3>
        <p className="muted small" style={{ marginTop: 0 }}>
          On its interval, a heartbeat delivers the agent an internal nudge — <i>“review your checklist and act on anything that needs attention”</i> —
          so it wakes up, re-checks its open tasks &amp; supervision check-ins, and acts even when nothing new was dispatched. It’s a keep-alive + self-audit, not a health ping. <b>Missed</b> = no run in ~2 intervals; <b>last run failed</b> = the agent errored on its last nudge.
        </p>
        <table className="grid">
          <thead>
            <tr>
              <th>Agent</th>
              <th>Interval</th>
              <th>Status</th>
              <th>Last run</th>
              <th>Set interval</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {fleetAgents.map((a) => {
              const hb = hbFor(a.name, a.team);
              const missed = hb ? isMissed(hb) : false;
              const failed = !!hb && hb.active && hb.lastStatus === 'failed';
              const key = targetKey(a.name, a.team);
              return (
                <tr key={`${key}:${a.id}`}>
                  <td className="b">{a.name} <span className="muted small">· {a.team ?? store.team ?? 'default'}</span></td>
                  <td className="muted">{hb ? fmtInterval(hb.intervalSeconds) : 'off'}</td>
                  <td className={missed || failed ? 'status-error' : hb?.active ? 'ok-text' : 'muted'}>
                    {!hb ? '—' : missed ? '⚠ missed' : failed ? '⚠ last run failed' : hb.active ? '♥ on' : 'paused'}
                  </td>
                  <td className="muted small">{hb ? relTime(hb.lastRunAt) : ''}</td>
                  <td onClick={(e) => e.stopPropagation()}>
                    <select
                      className="cell-select"
                      disabled={busy}
                      value={hbInterval[key] ?? hb?.intervalSeconds ?? 3600}
                      onChange={(e) => setHbInterval((m) => ({ ...m, [key]: Number(e.target.value) }))}
                    >
                      {INTERVALS.map((iv) => <option key={iv.s} value={iv.s}>{iv.label}</option>)}
                    </select>{' '}
                    <button className="btn" disabled={busy} onClick={() => void setHeartbeat(a.name, a.team)}>{hb ? 'Update' : 'Enable'}</button>
                  </td>
                  <td className="row-actions">
                    {hb ? (
                      <>
                        <button className="btn" disabled={busy} onClick={() => void mutateSchedule(hb, `${hb.active ? 'pause' : 'resume'} ${a.name}`, `${hb.active ? 'Pauses' : 'Resumes'} this recurring heartbeat for ${a.team ?? store.team ?? 'default'}/${a.name}.`, hb.active ? 'pauseSchedule' : 'resumeSchedule')}>
                          {hb.active ? 'Pause' : 'Resume'}
                        </button>
                        <button className="btn" disabled={busy} onClick={() => void mutateSchedule(hb, `disable ${a.name}`, `Removes this recurring heartbeat for ${a.team ?? store.team ?? 'default'}/${a.name}.`, 'removeSchedule')}>✕</button>
                      </>
                    ) : null}
                  </td>
                </tr>
              );
            })}
            {fleetAgents.length === 0 ? (
              <tr><td colSpan={6} className="muted center pad">{store.connection === 'offline' ? 'manager unreachable' : 'no agents available'}</td></tr>
            ) : null}
          </tbody>
        </table>

        {otherHeartbeats.length ? (
          <div style={{ marginTop: 12 }}>
            <div className="muted small b" style={{ marginBottom: 4 }}>
              Other heartbeats <span className="muted small">· {otherHeartbeats.length} on other teams / agents not in “{store.team}” (shown so none are hidden)</span>
            </div>
            <table className="grid">
              <thead>
                <tr><th>Target</th><th>Team</th><th>Interval</th><th>Status</th><th>Last run</th><th></th></tr>
              </thead>
              <tbody>
                {[...otherHeartbeats]
                  .sort((a, b) => String(a.team).localeCompare(String(b.team)) || String(a.targets?.[0]).localeCompare(String(b.targets?.[0])))
                  .map((s) => {
                    const missed = isMissed(s);
                    const failed = !!s.active && s.lastStatus === 'failed';
                    return (
                      <tr key={`${s.team}-${s.id}`}>
                        <td className="b">{(Array.isArray(s.targets) ? s.targets : []).join(', ') || '—'}</td>
                        <td className="muted small">{s.team ?? '—'}</td>
                        <td className="muted">{fmtInterval(s.intervalSeconds)}</td>
                        <td className={missed || failed ? 'status-error' : s.active ? 'ok-text' : 'muted'}>
                          {missed ? '⚠ missed' : failed ? '⚠ last run failed' : s.active ? '♥ on' : 'paused'}
                        </td>
                        <td className="muted small">{relTime(s.lastRunAt)}</td>
                        <td className="row-actions">
                          <button className="btn" disabled={busy} onClick={() => void mutateSchedule(s, `${s.active ? 'pause' : 'resume'} ${s.targets?.[0]}`, `${s.active ? 'Pauses' : 'Resumes'} this recurring heartbeat on ${s.team ?? 'unknown team'}.`, s.active ? 'pauseSchedule' : 'resumeSchedule')}>
                            {s.active ? 'Pause' : 'Resume'}
                          </button>
                          <button className="btn" disabled={busy} title="Remove this heartbeat" onClick={() => void mutateSchedule(s, `remove ${s.targets?.[0]}`, `Removes this recurring heartbeat on ${s.team ?? 'unknown team'}.`, 'removeSchedule')}>✕</button>
                        </td>
                      </tr>
                    );
                  })}
              </tbody>
            </table>
          </div>
        ) : null}
      </section>

      <section className="card grow">
        {(() => {
          const ranked = [...checkins].sort((a, b) => {
            const open = (c: CheckIn) => (/(active|snoozed)/i.test(String(c.status)) ? 0 : 1);
            return open(a) - open(b) || (a.nextFireAt ?? Infinity) - (b.nextFireAt ?? Infinity);
          });
          const openCount = ranked.filter((c) => /(active|snoozed)/i.test(String(c.status))).length;
          const closedCount = ranked.length - openCount;
          const stale = ranked.filter((c) => /(active|snoozed)/i.test(String(c.status)) && isTerminalTask(c.linkedTask?.status)).length;
          // Closed check-ins are archived (hidden) by default so the list stays focused on what's live.
          const visible = showClosed ? ranked : ranked.filter((c) => /(active|snoozed)/i.test(String(c.status)));
          return (
            <>
              <div className="row-actions" style={{ alignItems: 'center', marginBottom: 4 }}>
                <h3 style={{ margin: 0 }}>Supervision check-ins</h3>
                <span className="muted small">· {openCount} active</span>
                {closedCount ? (
                  <button className="link-btn small muted" title={showClosed ? 'Hide closed (archived) check-ins' : 'Show closed (archived) check-ins'} onClick={() => setShowClosed((v) => !v)}>
                    · {closedCount} closed {showClosed ? '▾ hide' : '▸ show'}
                  </button>
                ) : null}
                <span className="grow" />
                {staleCheckins.length > 0 ? (
                  <button className="btn small" disabled={busy} title="Close all check-ins still watching finished or removed tasks" onClick={() => void cleanUp()}>
                    🧹 Clean up {staleCheckins.length}
                  </button>
                ) : stale > 0 ? <span className="warn-text small">⚠ {stale} watching finished work</span> : null}
              </div>
              <p className="muted small" style={{ marginTop: 0 }}>
                A check-in watches a delegated task and pings the agent that delegated it on a cadence, auto-closing when the task is done.
              </p>
              {ranked.length === 0 ? (
                <p className="muted center pad">No supervision check-ins — these appear when an agent delegates tracked work to a teammate.</p>
              ) : visible.length === 0 ? (
                <p className="muted center pad">No active check-ins. {closedCount} closed — <button className="link-btn" onClick={() => setShowClosed(true)}>show archived</button>.</p>
              ) : (
                <div className="ci-list">
                  {visible.map((c, i) => {
                    const open = /(active|snoozed)/i.test(String(c.status));
                    const lt = c.linkedTask;
                    const title = lt?.gone ? 'a removed task' : (lt?.title || 'a delegated task');
                    const taskDone = isTerminalTask(lt?.status);
                    const fired = typeof c.iterationCount === 'number' ? c.iterationCount : 0;
                    const cap = c.maxIterations ? `/${c.maxIterations}` : '';
                    const meta = [
                      lt?.owner ? `${lt.owner}` : null,
                      c.intervalSeconds ? `every ${fmtInterval(c.intervalSeconds)}` : null,
                      `checked ${fired}${cap}×`,
                      open ? `next ${fmtMsIn(c.nextFireAt)}` : (c.closedReason ? `closed · ${c.closedReason}` : `last ${fmtMsAgo(c.lastFireAt)}`),
                    ].filter(Boolean).join(' · ');
                    return (
                      <div className={`ci-row${open ? '' : ' closed'}`} key={String(c.id ?? i)}>
                        <span className={`dot ${open ? (taskDone ? 'warn' : 'ok') : 'muted'}`} />
                        <div className="ci-main">
                          <div className="ci-title b" title={lt?.name || String(c.id)}>Watching: {title}</div>
                          <div className="muted small">
                            {meta}
                            {open && taskDone ? <span className="warn-text"> · ⚠ task already {lt?.status} — safe to close</span> : null}
                          </div>
                        </div>
                        {open ? (
                          <button className="btn small" disabled={busy} title="Stop this check-in firing" onClick={() => void closeCheckinFresh(c)}>Close</button>
                        ) : (
                          <span className="muted small" style={{ alignSelf: 'center' }}>{c.status}</span>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
            </>
          );
        })()}
      </section>
    </>
  );
}
