import { useEffect, useRef, useState } from 'react';
import { call, type FleetStore } from '../store.ts';

/**
 * Computer Use (Phase 0): watch your Mac live + let a blessed agent SEE your
 * screen (read-only screenshots). Mouse/keyboard control arrives in a later
 * update. Everything routes through the in-app broker, which only acts while
 * ARMED — the single switch that turns the whole capability on and off.
 */

interface Perms { screenRecording: string; accessibility: boolean; platform: string }
interface Status { armed: boolean; watching: boolean; port: number; url: string; lastAgent: string; actions: number; serverStaged: boolean; captureFailing: boolean }
interface FrameMsg { jpegBase64: string; width: number; height: number; ts: number; display?: { bounds: { width: number; height: number } } }

function agentRuntime(a: { runtime?: string; metadata?: { runtime?: string } }): string {
  return a.runtime ?? a.metadata?.runtime ?? '';
}
function mcpCapable(rt: string): boolean { return /claude|codex/i.test(rt); }

export function ComputerUse({ store }: { store: FleetStore }) {
  const [perms, setPerms] = useState<Perms | null>(null);
  const [status, setStatus] = useState<Status | null>(null);
  const [attached, setAttached] = useState<{ id: string; name: string }[]>([]);
  const [frame, setFrame] = useState<string>('');
  const [frameMeta, setFrameMeta] = useState<FrameMsg | null>(null);
  const [pick, setPick] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');
  const lastFrameAt = useRef(0);

  const eligible = store.agents.filter((a) => mcpCapable(agentRuntime(a)));
  const armed = !!status?.armed;
  const srGranted = perms?.screenRecording === 'granted';

  async function refresh() {
    const [p, s, at] = await Promise.all([
      call<Perms>('cu:permissions').catch(() => null),
      call<Status>('cu:status').catch(() => null),
      call<{ id: string; name: string }[]>('cu:attached').catch(() => []),
    ]);
    if (p) setPerms(p);
    if (s) setStatus(s);
    setAttached(at ?? []);
  }

  useEffect(() => {
    // Tell the broker the live pane is on screen, so the full-screen capture pump
    // ONLY runs while this view is mounted (navigating away stops it entirely).
    void call('cu:watch', true);
    void refresh();
    const t = setInterval(() => void refresh(), 2500);
    const off = window.idagents.onComputerFrame((f) => {
      const fm = f as FrameMsg;
      if (!fm?.jpegBase64) return;
      lastFrameAt.current = Date.now();
      setFrame(`data:image/jpeg;base64,${fm.jpegBase64}`);
      setFrameMeta(fm);
    });
    return () => { clearInterval(t); off(); void call('cu:watch', false); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  // Also pause the pump when the OS window is hidden/minimized.
  useEffect(() => {
    const onVis = () => { void call('cu:watch', document.visibilityState === 'visible'); };
    document.addEventListener('visibilitychange', onVis);
    return () => document.removeEventListener('visibilitychange', onVis);
  }, []);

  async function arm() { setBusy(true); try { await call('cu:arm'); await refresh(); } finally { setBusy(false); } }
  async function disarm() { setBusy(true); try { await call('cu:disarm'); setFrame(''); setFrameMeta(null); await refresh(); } finally { setBusy(false); } }

  async function bless(a: { id: string; name: string }) {
    setBusy(true); setMsg('');
    try {
      await call('cu:attach', a.id, a.name);            // throws on failure → caught below (never silently "succeeds")
      setMsg(`Attaching computer-use to ${a.name} — rebuilding so it picks up the tool…`);
      try {
        await call('rebuildAgent', a.name);             // the rebuild is what actually wires the tool
        await refresh();
        setMsg(`✅ ${a.name} can now see your screen (when armed). Ask it to take a screenshot.`);
      } catch (e) {
        await refresh();
        setMsg(`⚠ Attached, but the rebuild failed (${e instanceof Error ? e.message : e}). Rebuild ${a.name} from Dashboard, then it can see the screen.`);
      }
    } catch (e) {
      setMsg(`✗ Couldn't bless ${a.name}: ${e instanceof Error ? e.message : e}`);
    } finally { setBusy(false); }
  }
  async function unbless(a: { id: string; name: string }) {
    setBusy(true); setMsg('');
    try {
      await call('cu:detach', a.id, a.name);
      await call('rebuildAgent', a.name).catch(() => {});
      await refresh();
      setMsg(`Removed computer-use from ${a.name}.`);
    } catch (e) {
      setMsg(`✗ Couldn't remove from ${a.name}: ${e instanceof Error ? e.message : e}`);
    } finally { setBusy(false); }
  }

  const liveStale = frame && Date.now() - lastFrameAt.current > 4000;

  return (
    <div className="view cu-view">
      <header className="view-head">
        <h1>Computer Use</h1>
        <div className="row-actions" style={{ alignItems: 'center', gap: 10 }}>
          <span className={`cu-armpill ${armed ? 'on' : ''}`}>{armed ? '● ARMED' : '○ disarmed'}</span>
          {armed
            ? <button className="btn icon-danger" disabled={busy} onClick={() => void disarm()}>Disarm</button>
            : <button className="btn primary" disabled={busy || !srGranted} title={srGranted ? '' : 'Grant Screen Recording first'} onClick={() => void arm()}>Arm</button>}
        </div>
      </header>

      <div className="cu-intro muted small">
        Let an agent <b>see</b> your Mac and watch it live here. Nothing happens unless you <b>Arm</b> it, and only
        agents you bless can use it. <b>This build is watch + screenshot only</b> — mouse/keyboard control is coming next.
      </div>

      <div className="cols cu-cols">
        {/* LEFT: the live pane */}
        <section className="card cu-stage">
          <h3>Live view <span className="muted small">· your primary display</span></h3>
          <div className="cu-screen">
            {!srGranted ? (
              <div className="cu-placeholder">
                <div className="cu-ph-title">Screen Recording permission needed</div>
                <div className="muted small">Grant <b>ID Agents Control Center</b> Screen Recording, then relaunch.</div>
              </div>
            ) : !armed ? (
              <div className="cu-placeholder"><div className="cu-ph-title">Press <b>Arm</b> to start the live view</div></div>
            ) : frame ? (
              <img className="cu-frame" src={frame} alt="live screen" />
            ) : status?.captureFailing ? (
              <div className="cu-placeholder">
                <div className="cu-ph-title">Couldn’t capture the screen</div>
                <div className="muted small">macOS reports the permission as granted but capture is empty — this usually needs a relaunch after granting.</div>
                <div className="cu-perm-actions" style={{ justifyContent: 'center', marginTop: 8 }}>
                  <button className="btn" onClick={() => void call('cu:openPermission', 'screen')}>Open Settings ↗</button>
                  <button className="btn" onClick={() => void call('cu:relaunch')}>Relaunch</button>
                </div>
              </div>
            ) : (
              <div className="cu-placeholder"><div className="cu-ph-title">Starting capture…</div></div>
            )}
            {liveStale ? <div className="cu-stale">live view paused</div> : null}
          </div>
          {frameMeta ? <div className="muted small cu-screen-meta">{frameMeta.display?.bounds.width}×{frameMeta.display?.bounds.height} pts · streaming</div> : null}
        </section>

        {/* RIGHT: permissions + bless + safety */}
        <aside className="cu-side">
          <section className="card">
            <h3>Permissions</h3>
            <div className={`cu-perm ${srGranted ? 'ok' : 'bad'}`}>
              <span className="cu-perm-dot" />
              <div className="cu-perm-body">
                <b>Screen Recording</b> <span className="muted small">— to capture the screen</span>
                <div className="muted small">{srGranted ? 'Granted' : `Not granted (${perms?.screenRecording ?? '…'})`}</div>
                {!srGranted ? (
                  <div className="cu-perm-actions">
                    <button className="btn" onClick={() => void call('cu:openPermission', 'screen')}>Open Settings ↗</button>
                    <button className="btn" onClick={() => void call('cu:relaunch')} title="A grant only takes effect after a restart">Relaunch</button>
                    <button className="btn" onClick={() => void refresh()}>Re-check</button>
                  </div>
                ) : null}
              </div>
            </div>
            <div className={`cu-perm ${perms?.accessibility ? 'ok' : 'muted'}`}>
              <span className="cu-perm-dot" />
              <div className="cu-perm-body">
                <b>Accessibility</b> <span className="muted small">— for mouse/keyboard (next update)</span>
                <div className="muted small">{perms?.accessibility ? 'Granted' : 'Not needed yet (input control ships later)'}</div>
              </div>
            </div>
          </section>

          <section className="card">
            <h3>Who can use it</h3>
            <div className="muted small">Bless an agent to let it see your screen (Claude/codex agents only). It rebuilds to pick up the tool.</div>
            <div className="cu-bless-add">
              <select className="cell-select" value={pick} disabled={busy} onChange={(e) => setPick(e.target.value)}>
                <option value="">choose an agent…</option>
                {eligible.filter((a) => !attached.some((x) => x.id === a.id)).map((a) => (
                  <option key={a.id} value={a.id}>{a.name} · {agentRuntime(a)}</option>
                ))}
              </select>
              <button className="btn primary" disabled={busy || !pick} onClick={() => { const a = eligible.find((x) => x.id === pick); if (a) void bless({ id: a.id, name: a.name }); }}>Bless</button>
            </div>
            {attached.length ? (
              <div className="cu-blessed">
                {attached.map((a) => (
                  <div key={a.id} className="cu-blessed-row">
                    <span>🖥️ {a.name}</span>
                    <button className="btn icon-danger" disabled={busy} onClick={() => void unbless(a)}>Remove</button>
                  </div>
                ))}
              </div>
            ) : <div className="muted small" style={{ marginTop: 6 }}>No agents blessed yet.</div>}
            {msg ? <div className="cu-msg small">{msg}</div> : null}
          </section>

          <section className="card cu-safety">
            <h3>Safety</h3>
            <ul className="muted small">
              <li><b>Disarmed by default</b> — the agent can't even screenshot until you Arm.</li>
              <li><b>Only blessed agents</b> — no other agent can reach the controller.</li>
              <li>Screen content is treated as <b>data, never instructions</b>.</li>
              <li>Coming next: live take-over, a panic kill-switch, and approve-every-action mode before any clicking is enabled.</li>
            </ul>
          </section>
        </aside>
      </div>
    </div>
  );
}
