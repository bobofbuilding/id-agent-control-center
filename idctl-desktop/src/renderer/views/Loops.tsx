import { useEffect, useState } from 'react';
import { call, type FleetStore } from '../store.ts';
import type { ScheduleEntry } from '../../../../idctl/src/api/client.ts';

/**
 * Loops — recurring objectives the manager runs on a cadence (built on calendar
 * check-ins, so they run 24/7 even when this app is closed). Builder + tracker.
 */

const CADENCES = [
  { label: 'every day', days: 'mon,tue,wed,thu,fri,sat,sun' },
  { label: 'weekdays', days: 'mon,tue,wed,thu,fri' },
  { label: 'weekends', days: 'sat,sun' },
  { label: 'weekly (Mon)', days: 'mon' },
];

function qArg(s: string): string { return `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`; }
function fmtTime(sec: number | null): string {
  if (sec == null) return '';
  return `${String(Math.floor(sec / 3600)).padStart(2, '0')}:${String(Math.floor((sec % 3600) / 60)).padStart(2, '0')}`;
}
function relTime(sec: number | null): string {
  if (!sec) return 'never';
  const s = Math.max(0, Math.round(Date.now() / 1000 - sec));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}
function cadenceLabel(s: ScheduleEntry): string {
  const days = s.daysOfWeek || s.localDate || '';
  const known = CADENCES.find((c) => c.days === days);
  return `${known ? known.label : days} · ${fmtTime(s.localTimeSeconds)}`;
}

export function Loops({ store }: { store: FleetStore }) {
  const [schedules, setSchedules] = useState<ScheduleEntry[]>([]);
  const [busy, setBusy] = useState(false);
  const [running, setRunning] = useState<string | null>(null);
  const [msg, setMsg] = useState('');
  const [agent, setAgent] = useState('');
  const [objective, setObjective] = useState('');
  const [time, setTime] = useState('09:00');
  const [days, setDays] = useState('mon,tue,wed,thu,fri');

  async function reload() { setSchedules(await call<ScheduleEntry[]>('schedules').catch(() => [])); }
  useEffect(() => { void reload(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [store.team, store.lastUpdated]);

  const loops = schedules.filter((s) => s.kind === 'calendar');

  async function act(label: string, fn: () => Promise<unknown>) {
    setBusy(true); setMsg(`${label}…`);
    try { await fn(); await reload(); setMsg(`${label} ✓`); }
    catch (err) { setMsg(`${label} failed: ${err instanceof Error ? err.message : String(err)}`); }
    finally { setBusy(false); }
  }

  async function addLoop() {
    if (!agent || !objective.trim()) { setMsg('pick an agent and write an objective'); return; }
    const d = days.replace(/\s+/g, '');
    if (!/^(mon|tue|wed|thu|fri|sat|sun)(,(mon|tue|wed|thu|fri|sat|sun))*$/.test(d)) { setMsg('pick a cadence'); return; }
    if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(time.trim())) { setMsg('time must be HH:MM (24h), e.g. 09:00'); return; }
    await act(`loop for ${agent}`, () => call('addCalendarCheckin', agent, time.trim(), d, objective.trim(), { delivery: 'talk' }));
    setObjective('');
  }

  /** Fire the loop's objective once, right now (doesn't change the schedule). */
  async function runNow(s: ScheduleEntry) {
    const targets = Array.isArray(s.targets) ? s.targets : [];
    if (!targets.length) return;
    setRunning(s.id); setMsg(`running ${targets.join(', ')}…`);
    try {
      for (const t of targets) await call('dispatch', `/ask ${t} ${qArg(s.message)}`);
      setMsg('ran once ✓');
    } catch (err) { setMsg(`run failed: ${err instanceof Error ? err.message : String(err)}`); }
    finally { setRunning(null); }
  }

  const names = store.agents.map((a) => a.name);

  return (
    <>
      <section className="card">
        <div className="row-actions" style={{ alignItems: 'baseline' }}>
          <h3 className="grow">Loops <span className="muted small">· recurring objectives the manager runs on a cadence (24/7)</span></h3>
          {msg ? <span className={`small ${/failed/.test(msg) ? 'status-error' : 'muted'}`}>{msg}</span> : null}
        </div>
        <table className="grid">
          <thead>
            <tr><th>Agent</th><th>Objective</th><th>Cadence</th><th>Status</th><th>Last run</th><th></th></tr>
          </thead>
          <tbody>
            {loops.map((s) => (
              <tr key={s.id}>
                <td className="b">{(Array.isArray(s.targets) ? s.targets : []).join(', ') || '—'}</td>
                <td className="small">{s.message}</td>
                <td className="muted small mono">{cadenceLabel(s)}</td>
                <td className={s.lastStatus === 'failed' ? 'status-error small' : s.active ? 'ok-text small' : 'muted small'}>
                  {s.lastStatus === 'failed' ? '⚠ failed' : s.active ? '● looping' : 'paused'}
                </td>
                <td className="muted small">{relTime(s.lastRunAt)}</td>
                <td className="row-actions">
                  <button className="btn" disabled={busy || running !== null} title="Run the objective once now" onClick={() => void runNow(s)}>{running === s.id ? '…' : 'Run now'}</button>
                  <button className="btn" disabled={busy || running === s.id} onClick={() => void act(s.active ? 'pause' : 'resume', () => call(s.active ? 'pauseSchedule' : 'resumeSchedule', s.id))}>{s.active ? 'Pause' : 'Resume'}</button>
                  <button className="btn icon-danger" disabled={busy || running === s.id} title="Delete loop" onClick={() => void act('remove', () => call('removeSchedule', s.id))}>✕</button>
                </td>
              </tr>
            ))}
            {loops.length === 0 ? <tr><td colSpan={6} className="muted center pad">No loops yet. Build one below — e.g. weekdays 09:00 → “review the SkillMesh queue and report blockers”.</td></tr> : null}
          </tbody>
        </table>
      </section>

      <section className="card">
        <h3>New loop</h3>
        <div className="kv" style={{ gridTemplateColumns: '110px 1fr', gap: '8px 12px' }}>
          <span>agent</span>
          <b>
            <select className="cell-select" value={agent} disabled={busy} onChange={(e) => setAgent(e.target.value)}>
              <option value="">choose an agent…</option>
              {names.map((n) => <option key={n} value={n}>{n}</option>)}
            </select>
          </b>
          <span>objective</span>
          <b><textarea style={{ width: '100%', minHeight: 44 }} placeholder="what the agent should do each run, e.g. “check open PRs and summarize what needs review”" value={objective} disabled={busy} onChange={(e) => setObjective(e.target.value)} /></b>
          <span>cadence</span>
          <b style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
            <select className="cell-select" value={days} disabled={busy} onChange={(e) => setDays(e.target.value)}>
              {CADENCES.map((c) => <option key={c.days} value={c.days}>{c.label}</option>)}
            </select>
            <span className="muted small">at</span>
            <input style={{ width: 70 }} disabled={busy} value={time} onChange={(e) => setTime(e.target.value)} placeholder="09:00" />
            <span className="muted small">local time</span>
          </b>
        </div>
        <div className="row-actions" style={{ marginTop: 10 }}>
          <span className="grow" />
          <button className="btn primary" disabled={busy || !agent || !objective.trim()} onClick={() => void addLoop()}>Create loop</button>
        </div>
        <p className="muted small" style={{ marginTop: 6 }}>
          Loops are dispatched by the manager on the cadence (they keep running when this app is closed). Use <b>Run now</b> to fire one immediately. Status reflects the last scheduled run.
        </p>
      </section>
    </>
  );
}
