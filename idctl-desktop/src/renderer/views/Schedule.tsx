import { useEffect, useState } from 'react';
import { call, type FleetStore } from '../store.ts';
import type { CheckIn, ScheduleEntry } from '../../../../idctl/src/api/client.ts';

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
function fmtTime(localTimeSeconds: number | null): string {
  if (localTimeSeconds == null) return '';
  const h = Math.floor(localTimeSeconds / 3600);
  const m = Math.floor((localTimeSeconds % 3600) / 60);
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}
function relTime(unixSec: number | null): string {
  if (!unixSec) return 'never';
  const s = Math.max(0, Math.round(Date.now() / 1000 - unixSec));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}
/** A heartbeat is "missed" when active but its last run is older than ~2 intervals. */
function isMissed(s: ScheduleEntry): boolean {
  if (s.kind !== 'heartbeat' || !s.active || !s.intervalSeconds) return false;
  if (!s.lastRunAt) return false; // never run yet ≠ missed
  return Date.now() / 1000 - s.lastRunAt > s.intervalSeconds * 2;
}

export function Schedule({ store }: { store: FleetStore }) {
  const [schedules, setSchedules] = useState<ScheduleEntry[]>([]);
  const [checkins, setCheckins] = useState<CheckIn[]>([]);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');
  // per-agent heartbeat interval selection
  const [hbInterval, setHbInterval] = useState<Record<string, number>>({});
  // add-checkin form
  const [ciAgent, setCiAgent] = useState('');
  const [ciTime, setCiTime] = useState('09:00');
  const [ciDays, setCiDays] = useState('mon,tue,wed,thu,fri');
  const [ciMsg, setCiMsg] = useState('');

  async function reload() {
    setSchedules(await call<ScheduleEntry[]>('schedules').catch(() => []));
    setCheckins(await call<CheckIn[]>('checkins').catch(() => []));
  }
  useEffect(() => {
    reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [store.team, store.lastUpdated]);

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

  const heartbeats = schedules.filter((s) => s.kind === 'heartbeat');
  const calendars = schedules.filter((s) => s.kind === 'calendar');
  function hbFor(agent: string): ScheduleEntry | undefined {
    return heartbeats.find((s) => s.targets.includes(agent));
  }

  async function setHeartbeat(agent: string) {
    const seconds = hbInterval[agent] ?? hbFor(agent)?.intervalSeconds ?? 3600;
    const existing = heartbeats.filter((h) => h.targets.includes(agent));
    // Replace semantics, ADD-then-PRUNE: only remove the old heartbeat(s) AFTER
    // the new one is durably created, so a failed add never leaves the agent
    // unmonitored. (Brief overlap is harmless; the prune removes all priors.)
    await act(`heartbeat ${agent}`, async () => {
      await call('addHeartbeat', agent, seconds, HEARTBEAT_MSG, 'internal');
      for (const s of existing) await call('removeSchedule', s.id);
      setHbInterval((m) => {
        const next = { ...m };
        delete next[agent]; // fall back to the reloaded interval, not the transient pick
        return next;
      });
    });
  }
  async function addCheckin() {
    if (!ciAgent || !ciMsg.trim()) {
      setMsg('check-in needs an agent and a message');
      return;
    }
    const days = ciDays.replace(/\s+/g, ''); // tolerate "mon, tue" → "mon,tue"
    const isDate = /^\d{4}-\d{2}-\d{2}$/.test(days);
    if (!isDate && !/^(mon|tue|wed|thu|fri|sat|sun)(,(mon|tue|wed|thu|fri|sat|sun))*$/.test(days)) {
      setMsg('days must be e.g. mon,tue,wed or a single YYYY-MM-DD date');
      return;
    }
    const t = ciTime.trim();
    const tm = t.match(/^(\d{2}):(\d{2})$/);
    if (!tm || Number(tm[1]) > 23 || Number(tm[2]) > 59) {
      setMsg('time must be HH:MM (24h), e.g. 09:00');
      return;
    }
    await act(`check-in for ${ciAgent}`, () => call('addCalendarCheckin', ciAgent, t, days, ciMsg.trim(), { delivery: 'talk' }));
    setCiMsg('');
  }

  const names = store.agents.map((a) => a.name);

  return (
    <div className="view modules">
      <header className="view-head">
        <h1>Schedule &amp; Heartbeats</h1>
        {msg ? <span className="muted small">{msg}</span> : null}
      </header>

      <section className="card">
        <h3>Heartbeats — periodic agent self-checks</h3>
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
            {store.agents.map((a) => {
              const hb = hbFor(a.name);
              const missed = hb ? isMissed(hb) : false;
              const failed = !!hb && hb.active && hb.lastStatus === 'failed';
              return (
                <tr key={a.id}>
                  <td className="b">{a.name}</td>
                  <td className="muted">{hb ? fmtInterval(hb.intervalSeconds) : 'off'}</td>
                  <td className={missed || failed ? 'status-error' : hb?.active ? 'ok-text' : 'muted'}>
                    {!hb ? '—' : missed ? '⚠ missed' : failed ? '⚠ last run failed' : hb.active ? '♥ on' : 'paused'}
                  </td>
                  <td className="muted small">{hb ? relTime(hb.lastRunAt) : ''}</td>
                  <td onClick={(e) => e.stopPropagation()}>
                    <select
                      className="cell-select"
                      disabled={busy}
                      value={hbInterval[a.name] ?? hb?.intervalSeconds ?? 3600}
                      onChange={(e) => setHbInterval((m) => ({ ...m, [a.name]: Number(e.target.value) }))}
                    >
                      {INTERVALS.map((iv) => (
                        <option key={iv.s} value={iv.s}>
                          {iv.label}
                        </option>
                      ))}
                    </select>{' '}
                    <button className="btn" disabled={busy} onClick={() => void setHeartbeat(a.name)}>
                      {hb ? 'Update' : 'Enable'}
                    </button>
                  </td>
                  <td className="row-actions">
                    {hb ? (
                      <>
                        <button
                          className="btn"
                          disabled={busy}
                          onClick={() => void act(`${hb.active ? 'pause' : 'resume'} ${a.name}`, () => call(hb.active ? 'pauseSchedule' : 'resumeSchedule', hb.id))}
                        >
                          {hb.active ? 'Pause' : 'Resume'}
                        </button>
                        <button className="btn" disabled={busy} onClick={() => void act(`disable ${a.name}`, () => call('removeSchedule', hb.id))}>
                          ✕
                        </button>
                      </>
                    ) : null}
                  </td>
                </tr>
              );
            })}
            {store.agents.length === 0 ? (
              <tr>
                <td colSpan={6} className="muted center pad">
                  {store.connection === 'offline' ? 'manager unreachable' : 'no agents in this team'}
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </section>

      <section className="card">
        <h3>Recurring check-ins</h3>
        <table className="grid">
          <tbody>
            {calendars.map((s) => (
              <tr key={s.id}>
                <td className="b">{s.targets.join(', ')}</td>
                <td>
                  <span className="mono">{fmtTime(s.localTimeSeconds)}</span>{' '}
                  <span className="muted">{s.daysOfWeek || s.localDate || ''}</span>
                </td>
                <td className="muted small">{s.message}</td>
                <td className={s.active ? 'ok-text' : 'muted'}>{s.active ? 'active' : 'paused'}</td>
                <td className="row-actions">
                  <button className="btn" disabled={busy} onClick={() => void act(s.active ? 'pause' : 'resume', () => call(s.active ? 'pauseSchedule' : 'resumeSchedule', s.id))}>
                    {s.active ? 'Pause' : 'Resume'}
                  </button>
                  <button className="btn" disabled={busy} onClick={() => void act('remove', () => call('removeSchedule', s.id))}>
                    ✕
                  </button>
                </td>
              </tr>
            ))}
            {calendars.length === 0 ? (
              <tr>
                <td colSpan={5} className="muted center pad">
                  No recurring check-ins. Add one below (e.g. weekdays 09:00 → "review the queue").
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
        <div className="add-provider">
          <select value={ciAgent} disabled={busy} onChange={(e) => setCiAgent(e.target.value)}>
            <option value="">agent…</option>
            {names.map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </select>
          <input style={{ width: 70 }} disabled={busy} placeholder="09:00" value={ciTime} onChange={(e) => setCiTime(e.target.value)} />
          <input style={{ width: 170 }} disabled={busy} placeholder="mon,tue,… or YYYY-MM-DD" value={ciDays} onChange={(e) => setCiDays(e.target.value)} />
          <input placeholder="message / prompt" disabled={busy} value={ciMsg} onChange={(e) => setCiMsg(e.target.value)} />
          <button className="btn primary" disabled={busy} onClick={() => void addCheckin()}>
            Add check-in
          </button>
        </div>
        <p className="muted small" style={{ marginTop: 6 }}>
          Days: comma-separated <span className="mono">mon,tue,wed,thu,fri,sat,sun</span>, or a single <span className="mono">YYYY-MM-DD</span> date. Delivered to the agent at the given local time.
        </p>
      </section>

      <section className="card grow">
        <h3>Supervision check-ins ({checkins.length})</h3>
        {checkins.length === 0 ? (
          <p className="muted">No active supervision check-ins.</p>
        ) : (
          <div className="feed-list">
            {checkins.map((c, i) => (
              <div className="feed-row" key={String(c.id ?? i)}>
                <span className="dot warn" />
                <span>{String(c.title ?? c.delegate ?? c.id ?? 'check-in')}</span>
                {c.delegate ? <span className="muted">→ {c.delegate}</span> : null}
                {c.status ? <span className="muted small">· {c.status}</span> : null}
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
