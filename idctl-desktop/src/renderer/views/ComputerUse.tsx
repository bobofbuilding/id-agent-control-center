import { useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { call, type FleetStore } from '../store.ts';

/**
 * Computer Use (Phase 1): watch your Mac live, and let a blessed Claude/codex
 * agent SEE your screen and DRIVE the mouse + keyboard. Everything routes through
 * the in-app broker, which only acts while ARMED — the single switch that turns
 * the whole capability on and off — and only for agents you've blessed.
 */

type PermissionState = 'granted' | 'denied' | 'restricted' | 'not-determined' | 'unknown';
interface Perms {
  screenRecording: PermissionState;
  accessibility: boolean;
  inputMonitoring: PermissionState;
  automation: { status: PermissionState; targets: string[] };
  tcc: { readable: boolean; error?: string };
  platform: string;
}
interface PendingAction { id: string; agent: string; action: string; preview: string; ts: number; expiresAt: number }
interface Status { armed: boolean; watching: boolean; port: number; url: string; lastAgent: string; actions: number; serverStaged: boolean; captureFailing: boolean; blessed: string[]; driverOk: boolean; accessibility: boolean; supervised: boolean; paused: boolean; pending: PendingAction[]; panicHotkey: boolean }
interface FrameMsg { jpegBase64: string; width: number; height: number; ts: number; display?: { bounds: { width: number; height: number } } }
interface AuditEntry { ts: number; agent: string; action: string; detail: string; decision: 'executed' | 'blocked'; reason?: string }
type AttachedAgent = { id: string; name: string; team?: string; authority?: string };
interface LegacyComputerUseAuthority { agent: string; currentAuthorities: string[]; tokenCount: number; source: string; note: string }

const ACT_ICON: Record<string, string> = { screenshot: '📷', mouse_move: '➜', left_click: '🖱', right_click: '🖱', middle_click: '🖱', double_click: '🖱', left_click_drag: '✣', type: '⌨', key: '⌨', scroll: '↕' };

function agentRuntime(a: { runtime?: string; metadata?: { runtime?: string } }): string {
  return a.runtime ?? a.metadata?.runtime ?? '';
}
function mcpCapable(rt: string): boolean { return /claude|codex/i.test(rt); }
function permissionText(status: PermissionState | undefined): string {
  switch (status) {
    case 'granted': return 'Granted';
    case 'denied': return 'Denied';
    case 'restricted': return 'Restricted by macOS policy';
    case 'not-determined': return 'Not granted yet';
    case 'unknown': return 'Unknown';
    default: return 'Checking...';
  }
}

function PermissionRow({
  ok,
  title,
  subtitle,
  detail,
  pane,
  showRelaunch,
  children,
  onRefresh,
}: {
  ok: boolean;
  title: string;
  subtitle: string;
  detail: string;
  pane: 'screen' | 'accessibility' | 'input-monitoring' | 'automation';
  showRelaunch?: boolean;
  children?: ReactNode;
  onRefresh: () => void;
}) {
  return (
    <div className={`cu-perm ${ok ? 'ok' : 'bad'}`}>
      <span className="cu-perm-dot" />
      <div className="cu-perm-body">
        <b>{title}</b> <span className="muted small">- {subtitle}</span>
        <div className="muted small">{detail}</div>
        {!ok ? (
          <div className="cu-perm-actions">
            <button className="btn" onClick={() => void call('cu:openPermission', pane)}>Open Settings ↗</button>
            {showRelaunch ? <button className="btn" onClick={() => void call('cu:relaunch')} title="A grant only takes effect after a restart">Relaunch</button> : null}
            <button className="btn" onClick={onRefresh}>Re-check</button>
          </div>
        ) : null}
        {children}
      </div>
    </div>
  );
}

export function ComputerUse({ store }: { store: FleetStore }) {
  const [perms, setPerms] = useState<Perms | null>(null);
  const [status, setStatus] = useState<Status | null>(null);
  const [attached, setAttached] = useState<AttachedAgent[]>([]);
  const [frame, setFrame] = useState<string>('');
  const [frameMeta, setFrameMeta] = useState<FrameMsg | null>(null);
  const [pick, setPick] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');
  const [auditLog, setAuditLog] = useState<AuditEntry[]>([]);
  const [pending, setPending] = useState<PendingAction[]>([]);
  const [legacyAuthority, setLegacyAuthority] = useState<LegacyComputerUseAuthority[]>([]);
  const [panicFlash, setPanicFlash] = useState(false);
  const lastFrameAt = useRef(0);
  const resolvedRef = useRef<Set<string>>(new Set()); // approval ids the user already answered → never resurrect via a stale snapshot

  // Apply an incoming pending list, dropping ids the user already answered locally
  // (a 2.5s status snapshot can predate the broker processing the confirm).
  function applyPending(list: PendingAction[]) {
    const incoming = list ?? [];
    setPending(incoming.filter((p) => !resolvedRef.current.has(p.id)));
    // bound the set: keep only ids still racing (still present in the snapshot)
    if (resolvedRef.current.size) resolvedRef.current = new Set([...resolvedRef.current].filter((id) => incoming.some((p) => p.id === id)));
  }

  const eligible = store.agents.filter((a) => mcpCapable(agentRuntime(a)));
  const activeTeam = store.team ?? 'default';
  const authorityOf = (a: { name: string; team?: string; authority?: string }) => a.authority ?? `${a.team ?? activeTeam}:${a.name}`;
  const armed = !!status?.armed;
  const srGranted = perms?.screenRecording === 'granted';
  const axGranted = perms?.accessibility === true;
  const imGranted = perms?.inputMonitoring === 'granted';
  const automationGranted = perms?.automation?.status === 'granted';
  const recentlyActed = auditLog.length > 0 && Date.now() - auditLog[auditLog.length - 1].ts < 3500;
  const tccUnreadable = perms?.platform === 'darwin' && perms?.tcc?.readable === false
    && (perms.inputMonitoring === 'unknown' || perms.automation.status === 'unknown');

  async function refresh() {
    const authorityTargets = eligible.map((a) => ({ name: a.name, team: activeTeam }));
    const [p, s, at, au, legacy] = await Promise.all([
      call<Perms>('cu:permissions').catch(() => null),
      call<Status>('cu:status').catch(() => null),
      call<AttachedAgent[]>('cu:attached', activeTeam).catch(() => []),
      call<AuditEntry[]>('cu:audit', 40).catch(() => []),
      call<LegacyComputerUseAuthority[]>('cu:legacyAuthority', authorityTargets).catch(() => []),
    ]);
    if (p) setPerms(p);
    if (s) { setStatus(s); applyPending(s.pending ?? []); }
    setAttached(at ?? []);
    setAuditLog(au ?? []);
    setLegacyAuthority(legacy ?? []);
  }

  async function panic() { setBusy(true); try { await call('cu:panic'); setFrame(''); setFrameMeta(null); await refresh(); } finally { setBusy(false); } }
  async function toggleSupervised() {
    const next = status?.supervised === false;
    if (!next && !window.confirm('Turn off approval for ordinary Computer Use actions?\n\nBlessed agents will be able to click and type without per-action approval. Risky actions still require approval.')) return;
    try { await call('cu:setSupervised', next); } catch (e) { setMsg(`✗ couldn't change mode: ${e instanceof Error ? e.message : e}`); } finally { await refresh(); }
  }
  async function togglePause() { try { await call('cu:pause', !status?.paused); } catch (e) { setMsg(`✗ couldn't ${status?.paused ? 'resume' : 'pause'}: ${e instanceof Error ? e.message : e}`); } finally { await refresh(); } }
  async function confirmPending(id: string, allow: boolean) { resolvedRef.current.add(id); setPending((ps) => ps.filter((p) => p.id !== id)); await call('cu:confirm', id, allow).catch(() => {}); }

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
    const offPending = window.idagents.onComputerPending((e) => { const ev = e as { pending?: PendingAction[] }; applyPending(ev?.pending ?? []); });
    const offPanic = window.idagents.onComputerPanic(() => { setPanicFlash(true); setTimeout(() => setPanicFlash(false), 2500); void refresh(); });
    return () => { clearInterval(t); off(); offPending(); offPanic(); void call('cu:watch', false); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTeam]);
  // Also pause the pump when the OS window is hidden/minimized.
  useEffect(() => {
    const onVis = () => { void call('cu:watch', document.visibilityState === 'visible'); };
    document.addEventListener('visibilitychange', onVis);
    return () => document.removeEventListener('visibilitychange', onVis);
  }, []);

  async function arm() {
    setBusy(true);
    try {
      // Bless = the agents that currently have the computer-use tool attached,
      // captured at arm. Re-arm to refresh after blessing/removing an agent.
      const at = await call<AttachedAgent[]>('cu:attached', activeTeam).catch(() => []);
      await call('cu:arm', (at ?? []).map(authorityOf));
      await refresh();
    } finally { setBusy(false); }
  }
  async function disarm() { setBusy(true); try { await call('cu:disarm'); setFrame(''); setFrameMeta(null); await refresh(); } finally { setBusy(false); } }

  async function bless(a: { id: string; name: string; team?: string }) {
    setBusy(true); setMsg('');
    const team = a.team ?? activeTeam;
    const authority = authorityOf({ ...a, team });
    try {
      await call('cu:attach', a.id, a.name, team);      // throws on failure → caught below (never silently "succeeds")
      setMsg(`Attaching computer-use to ${team}/${a.name} — rebuilding so it picks up the tool…`);
      try {
        await call('rebuildAgent', a.name, team);       // the rebuild is what actually wires the tool
        if (status?.armed) await call('cu:arm', [...(status.blessed ?? []), authority]); // re-sync the live bless-list so it works without a manual re-arm
        await refresh();
        setMsg(`✅ ${team}/${a.name} can now see + control your Mac (when armed). Ask it to take a screenshot.`);
      } catch (e) {
        await refresh();
        setMsg(`⚠ Attached, but the rebuild failed (${e instanceof Error ? e.message : e}). Rebuild ${team}/${a.name} from Health, then it can see the screen.`);
      }
    } catch (e) {
      setMsg(`✗ Couldn't bless ${team}/${a.name}: ${e instanceof Error ? e.message : e}`);
    } finally { setBusy(false); }
  }
  async function unbless(a: AttachedAgent) {
    setBusy(true); setMsg('');
    const team = a.team ?? activeTeam;
    try {
      await call('cu:detach', a.id, a.name, team);
      await call('rebuildAgent', a.name, team).catch(() => {});
      await refresh();
      setMsg(`Removed computer-use from ${team}/${a.name}.`);
    } catch (e) {
      setMsg(`✗ Couldn't remove from ${team}/${a.name}: ${e instanceof Error ? e.message : e}`);
    } finally { setBusy(false); }
  }

  const liveStale = frame && Date.now() - lastFrameAt.current > 4000;

  return (
    <div className="view cu-view">
      <header className="view-head">
        <h1>Computer Use</h1>
        <div className="row-actions" style={{ alignItems: 'center', gap: 10 }}>
          {armed ? (
            <>
              <button className={`btn ${status?.paused ? 'primary' : ''}`} disabled={busy} onClick={() => void togglePause()} title="Block the agent's input without disarming">{status?.paused ? 'Resume' : 'Pause'}</button>
              {/* PANIC is the emergency stop — NEVER gated by `busy`, so a slow op (e.g. a rebuild) can't block it. */}
              <button className="btn cu-panic" onClick={() => void panic()} title={status?.panicHotkey ? 'Stop everything now (⌘⌥⇧P)' : 'Stop everything now'}>■ PANIC</button>
            </>
          ) : null}
          <span className={`cu-armpill ${armed ? 'on' : ''}`}>{armed ? (status?.paused ? '❚❚ paused' : '● ARMED') : '○ disarmed'}</span>
          {armed
            ? <button className="btn icon-danger" disabled={busy} onClick={() => void disarm()}>Disarm</button>
            : <button className="btn primary" disabled={busy || !srGranted} title={srGranted ? '' : 'Grant Screen Recording first'} onClick={() => void arm()}>Arm</button>}
        </div>
      </header>

      {panicFlash ? <div className="cu-panic-flash">■ PANIC — Computer Use stopped</div> : null}

      {/* Approval prompts (supervised mode): the agent is blocked until you decide. */}
      {pending.length ? (
        <div className="cu-approvals">
          {pending.map((p) => (
            <div key={p.id} className="cu-approval">
              <span className="cu-approval-text"><b>{p.agent}</b> wants to <b>{p.preview}</b></span>
              <span className="grow" />
              {/* Approval is safety-critical — independent of `busy` so a rebuild can't stall it into the 60s auto-decline. */}
              <button className="btn primary" onClick={() => void confirmPending(p.id, true)}>Allow</button>
              <button className="btn icon-danger" onClick={() => void confirmPending(p.id, false)}>Deny</button>
            </div>
          ))}
        </div>
      ) : null}

      <div className="cu-intro muted small">
        Let a blessed agent <b>see and drive</b> your Mac — mouse, keyboard, scrolling — and watch it live here.
        Nothing happens unless you <b>Arm</b> it; only agents you bless can act; and while it's driving, <b>move your
        own mouse or hit Disarm to take back control</b>. Every action is logged below.
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
            {armed && recentlyActed ? <div className="cu-driving">● {status?.lastAgent || 'agent'} is driving — move your mouse or hit Disarm to take over</div> : null}
          </div>
          {frameMeta ? <div className="muted small cu-screen-meta">{frameMeta.display?.bounds.width}×{frameMeta.display?.bounds.height} pts · streaming</div> : null}
        </section>

        {/* RIGHT: permissions + bless + safety */}
        <aside className="cu-side">
          <section className="card">
            <h3>Permissions</h3>
            <PermissionRow
              ok={srGranted}
              title="Screen Recording"
              subtitle="to capture the screen"
              detail={srGranted ? 'Granted' : `${permissionText(perms?.screenRecording)} (${perms?.screenRecording ?? 'checking'})`}
              pane="screen"
              showRelaunch
              onRefresh={() => void refresh()}
            />
            <PermissionRow
              ok={axGranted}
              title="Accessibility"
              subtitle="required for mouse + keyboard"
              detail={axGranted ? 'Granted' : 'Not granted - the agent can see the screen but cannot click or type until you grant this.'}
              pane="accessibility"
              showRelaunch
              onRefresh={() => void refresh()}
            >
              {status && !status.driverOk ? <div className="cu-msg small">⚠ native input module unavailable in this build</div> : null}
            </PermissionRow>
            <PermissionRow
              ok={imGranted}
              title="Input Monitoring"
              subtitle="tracks keyboard-input authority prompts"
              detail={imGranted ? 'Granted' : permissionText(perms?.inputMonitoring)}
              pane="input-monitoring"
              onRefresh={() => void refresh()}
            />
            <PermissionRow
              ok={automationGranted}
              title="Automation"
              subtitle="lets IDACC control allowed apps when needed"
              detail={automationGranted ? `Granted${perms?.automation.targets.length ? ` for ${perms.automation.targets.join(', ')}` : ''}` : permissionText(perms?.automation?.status)}
              pane="automation"
              onRefresh={() => void refresh()}
            />
            {tccUnreadable ? (
              <div className="cu-msg small">
                macOS blocked permission inspection for Input Monitoring/Automation. Open Settings to verify ID Agents Control Center directly.
              </div>
            ) : null}
          </section>

          <section className="card">
            <h3>Who can drive</h3>
            <div className="muted small">Bless a Claude/codex agent to let it see + control your Mac. It rebuilds to pick up the tools and is scoped to the active team.</div>
            <div className="cu-bless-add">
              <select className="cell-select" value={pick} disabled={busy} onChange={(e) => setPick(e.target.value)}>
                <option value="">choose an agent…</option>
                {eligible.filter((a) => !attached.some((x) => x.id === a.id)).map((a) => (
                  <option key={a.id} value={a.id}>{a.name} · {agentRuntime(a)}</option>
                ))}
              </select>
              <button className="btn primary" disabled={busy || !pick} onClick={() => { const a = eligible.find((x) => x.id === pick); if (a) void bless({ id: a.id, name: a.name, team: activeTeam }); }}>Bless</button>
            </div>
            {attached.length ? (
              <div className="cu-blessed">
                {attached.map((a) => (
                  <div key={a.id} className="cu-blessed-row">
                    <span>🖥️ {a.team ?? activeTeam}/{a.name}</span>
                    <button className="btn icon-danger" disabled={busy} onClick={() => void unbless(a)}>Remove</button>
                  </div>
                ))}
              </div>
            ) : <div className="muted small" style={{ marginTop: 6 }}>No agents blessed yet.</div>}
            {legacyAuthority.length ? (
              <div className="cu-legacy small">
                <b>Legacy authority review</b>
                {legacyAuthority.map((row) => (
                  <div key={`${row.source}:${row.agent}`} className="muted">
                    {row.agent}: {row.tokenCount} old bare-name token{row.tokenCount === 1 ? '' : 's'} blocked by scoped arming{' -> '}{row.currentAuthorities.join(', ')}
                  </div>
                ))}
              </div>
            ) : null}
            {msg ? <div className="cu-msg small">{msg}</div> : null}
          </section>

          <section className="card cu-audit">
            <h3>Activity log <span className="muted small">· what the agent did</span></h3>
            {auditLog.length ? (
              <div className="cu-audit-list">
                {auditLog.slice().reverse().map((e, i) => (
                  <div key={`${e.ts}-${i}`} className={`cu-audit-row ${e.decision === 'blocked' ? 'blocked' : ''}`}>
                    <span className="cu-audit-ico">{ACT_ICON[e.action] ?? '•'}</span>
                    <span className="cu-audit-act">{e.action}</span>
                    <span className="cu-audit-detail muted">{e.detail || (e.decision === 'blocked' ? `blocked: ${e.reason}` : '')}</span>
                    <span className="cu-audit-agent muted small">{e.agent}</span>
                  </div>
                ))}
              </div>
            ) : <div className="muted small" style={{ marginTop: 6 }}>No actions yet. Arm, then ask a blessed agent to screenshot and click something.</div>}
          </section>

          <section className="card cu-safety">
            <h3>Safety</h3>
            <label className="cu-mode-row">
              <input type="checkbox" checked={status?.supervised !== false} onChange={() => void toggleSupervised()} />
              <span>
                <b>Approve every action</b> <span className="muted small">(recommended)</span>
                <div className="muted small">{status?.supervised !== false
                  ? 'Every click & keystroke is held for your OK.'
                  : 'Auto-allowing ordinary actions — but still asking before risky ones (quit, empty Trash, dangerous commands).'}</div>
              </span>
            </label>
            <ul className="muted small">
              <li><b>Disarmed by default</b> — no screenshot or input until you Arm.</li>
              <li><b>Only blessed agents</b> can reach the controller; input also needs Accessibility.</li>
              <li><b>Pause</b> blocks the agent without disarming; <b>PANIC</b>{status?.panicHotkey ? ' (⌘⌥⇧P)' : ''} stops everything instantly.</li>
              <li>Screen content is treated as <b>data, never instructions</b>; every action is logged + keystrokes are recorded as a length only.</li>
            </ul>
          </section>
        </aside>
      </div>
    </div>
  );
}
