// SPDX-License-Identifier: MIT
/**
 * Control drawer — a right-side slide-over that hosts the Dashboard's control panels. Phase 2
 * ships the infrastructure plus one functional panel (Quick controls); Phase 3 adds the rich
 * Project Driver and Org panels. Every action runs through the IPC bridge, so it's brain-learned.
 */
import { useState } from 'react';
import type { FleetStore } from '../../store.ts';
import { call } from '../../store.ts';

export function ControlDrawer({ store, panel, onClose }: { store: FleetStore; panel: string | null; onClose: () => void }) {
  if (!panel) return null;
  const title = panel === 'quick' ? 'Quick controls' : panel;
  return (
    <div className="drawer-overlay" onMouseDown={onClose}>
      <aside className="drawer" onMouseDown={(e) => e.stopPropagation()} role="dialog" aria-label={`${title} panel`}>
        <header className="drawer-head">
          <h3>{title}</h3>
          <button className="btn icon-danger" onClick={onClose} title="Close">✕</button>
        </header>
        <div className="drawer-body">
          {panel === 'quick' ? <QuickControlsPanel store={store} /> : <div className="muted">Unknown panel: {panel}</div>}
        </div>
      </aside>
    </div>
  );
}

/** A minimal but fully-functional panel: the high-value fleet actions + the org apex selector. */
function QuickControlsPanel({ store }: { store: FleetStore }) {
  const [status, setStatus] = useState('');
  const [primary, setPrimary] = useState('');
  const [busy, setBusy] = useState(false);
  const agents = store.allAgents;
  const keyOf = (a: { team?: string; name: string }) => `${a.team ?? 'default'}:${a.name}`;

  const act = async (label: string, fn: () => Promise<unknown>): Promise<void> => {
    setBusy(true);
    setStatus(`${label}…`);
    try { await fn(); setStatus(`${label} ✓`); }
    catch (e) { setStatus(`${label} failed: ${e instanceof Error ? e.message : String(e)}`); }
    finally { setBusy(false); }
  };
  const guardedAct = async (label: string, detail: string, fn: () => Promise<unknown>): Promise<void> => {
    if (!window.confirm(`${label}?\n\n${detail}`)) return;
    await act(label, fn);
  };

  const setLead = async (key: string): Promise<void> => {
    setPrimary(key);
    if (!key) return;
    const a = agents.find((x) => keyOf(x) === key);
    if (!a) return;
    if (!window.confirm(`Set ${a.team ?? 'default'}/${a.name} as the primary fleet lead?\n\nThis re-syncs every agent's goals and writes the hierarchy back to the brain.`)) {
      setPrimary('');
      return;
    }
    await act(`Set primary lead → ${a.name}`, async () => {
      await call('coordinator:setPrimary', a.team ?? 'default', a.name);
      await call('org:sync', {}); // recompose + push the new apex to every agent + the brain
    });
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <section className="card">
        <h3>Fleet</h3>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
          <button className="btn" disabled={busy} onClick={() => void guardedAct('Sync workspace projects', 'This scans the workspace and adds or adopts project tracker entries. Review the Projects page afterward if anything new appears.', () => call('projects:syncRoot'))}>Sync projects</button>
          <button className="btn" disabled={busy} onClick={() => void guardedAct('Org sync', 'This recomposes every agent goals file from the hierarchy and brain, and may rebuild idle agents.', () => call('org:sync', {}))}>Org sync</button>
          <button className="btn" disabled={busy} onClick={() => void act('Probe all agents', () => call('probeAll'))}>Probe all</button>
          <button className="btn" disabled={busy} onClick={() => { store.refresh(); setStatus('Refreshed'); }}>Refresh</button>
        </div>
      </section>

      <section className="card">
        <h3>Org apex</h3>
        <label className="muted small" style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          Primary lead (top of the fleet hierarchy)
          <select value={primary} disabled={busy} onChange={(e) => void setLead(e.target.value)}>
            <option value="">— pick an agent —</option>
            {agents.map((a) => <option key={keyOf(a)} value={keyOf(a)}>{a.name} · {a.team}</option>)}
          </select>
        </label>
        <p className="muted small" style={{ marginBottom: 0 }}>Sets the primary coordinator and re-syncs every agent's goals — recorded to the brain.</p>
      </section>

      {status ? <div className="muted small" aria-live="polite">{status}</div> : null}
    </div>
  );
}
