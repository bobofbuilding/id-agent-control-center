import { useCallback, useEffect, useState } from 'react';
import { call, type FleetStore } from '../store.ts';
import type { UsageReport, UsageWindow } from '../../../../idctl/src/api/client.ts';
import type { HeadroomPilotSettings } from '../../../../idctl/src/settings/schema.ts';
import { AgentTable } from './AgentTable.tsx';

type HeadroomStatus = {
  cli: { found: boolean; version?: string; error?: string };
  proxy: { url: string; reachable: boolean; httpStatus?: number; error?: string };
};

/** Compact number: 1234 → "1.2k", 2_500_000 → "2.5M". */
function fmt(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(Math.round(n));
}
function fmtTps(n: number): string {
  return n >= 100 ? String(Math.round(n)) : n.toFixed(1);
}
function niceMax(v: number): number {
  const m = Math.max(v, 10);
  for (const c of [25, 50, 100, 200, 300, 500, 1000]) if (m <= c) return c;
  return Math.ceil(m / 500) * 500;
}

/** Semicircular throughput gauge (SVG; fill grows left→right via dash offset). */
function Gauge({ value, max }: { value: number; max: number }) {
  const frac = max > 0 ? Math.max(0, Math.min(value / max, 1)) : 0;
  const path = 'M 18 84 A 72 72 0 0 1 162 84';
  return (
    <svg viewBox="0 0 180 98" className="gauge">
      <path d={path} className="gauge-track" pathLength={100} />
      <path d={path} className="gauge-fill" pathLength={100} strokeDasharray="100" strokeDashoffset={100 - frac * 100} />
      <text x="90" y="68" textAnchor="middle" className="gauge-value">{fmtTps(value)}</text>
      <text x="90" y="86" textAnchor="middle" className="gauge-unit">tok/s</text>
    </svg>
  );
}

function WindowCard({ title, w }: { title: string; w: UsageWindow }) {
  return (
    <div className="usage-card">
      <div className="usage-card-title">{title}</div>
      <div className="usage-stat"><b>{fmt(w.total)}</b><span className="muted small">tokens</span></div>
      <div className="usage-sub muted small">
        {w.count} {w.count === 1 ? 'query' : 'queries'} · {fmt(w.avgPerQuery)}/query · {fmtTps(w.avgTps)} tok/s avg
      </div>
    </div>
  );
}

export function Health({ store }: { store: FleetStore }) {
  const [probing, setProbing] = useState<string | null>(null);
  const [usage, setUsage] = useState<UsageReport | null | undefined>(undefined); // undefined = loading
  const [headroom, setHeadroom] = useState<HeadroomStatus | null | undefined>(undefined);
  const [pilot, setPilot] = useState<HeadroomPilotSettings | null | undefined>(undefined);
  const [pilotSaving, setPilotSaving] = useState(false);
  const [usageAt, setUsageAt] = useState<number>(0); // when usage was last refreshed
  const [, setTick] = useState(0); // 1 Hz re-render so "updated Ns ago" stays live

  const loadUsage = useCallback(async () => {
    try {
      setUsage(await call<UsageReport | null>('usage'));
      setUsageAt(Date.now());
    } catch {
      setUsage(null);
    }
  }, []);
  // Auto-refresh: on the fleet poll AND on a 15s timer, so new agents/models (and fresh
  // generations) show up on their own — no manual refresh needed.
  useEffect(() => { void loadUsage(); }, [loadUsage, store.lastUpdated]);

  const loadHeadroom = useCallback(async () => {
    try {
      const [status, policy] = await Promise.all([
        call<HeadroomStatus>('headroom:status'),
        call<HeadroomPilotSettings>('headroom:pilot'),
      ]);
      setHeadroom(status);
      setPilot(policy);
    } catch {
      setHeadroom(null);
      setPilot(null);
    }
  }, []);
  useEffect(() => { void loadHeadroom(); }, [loadHeadroom, store.lastUpdated]);

  useEffect(() => {
    const iv = setInterval(() => void loadUsage(), 15000);
    const t = setInterval(() => setTick((n) => n + 1), 1000);
    return () => { clearInterval(iv); clearInterval(t); };
  }, [loadUsage]);
  const agoStr = (ms: number) => { if (!ms) return ''; const s = Math.max(0, Math.round((Date.now() - ms) / 1000)); return s < 60 ? `${s}s ago` : s < 3600 ? `${Math.round(s / 60)}m ago` : `${Math.round(s / 3600)}h ago`; };

  // The fleet roster is the shared, live AgentTable below. Probing routes to the agent's
  // own team (holistic) or the active team — it exercises the dispatch path; the agent's
  // live status (in the roster) and the throughput gauge reflect the result.
  async function probe(which: 'all' | string, team?: string) {
    setProbing(which);
    try {
      await call(which === 'all' ? 'probeAll' : 'probeOne', ...(which === 'all' ? [] : [which, team]));
    } catch (err) {
      window.alert(`probe failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setProbing(null);
      void loadUsage(); // refresh throughput after exercising agents
    }
  }
  async function savePilot(partial: Partial<HeadroomPilotSettings>) {
    setPilotSaving(true);
    try {
      setPilot(await call<HeadroomPilotSettings>('headroom:setPilot', partial));
    } catch (err) {
      window.alert(`Headroom pilot update failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setPilotSaving(false);
    }
  }
  // Gauge reads the most recent live throughput, falling back to the 24h average.
  const gaugeVal = usage ? (usage.recent?.tps ?? usage.day.avgTps ?? 0) : 0;
  const gaugeMax = usage ? niceMax(Math.max(gaugeVal, usage.day.avgTps, usage.week.avgTps)) : 100;
  const localAgents = usage?.day.agents ?? [];
  const localModels = usage?.day.models ?? [];

  return (
    <div className="view">
      <header className="view-head">
        <h1>Health &amp; Probes</h1>
        <button className="btn primary" disabled={!!probing} onClick={() => void probe('all')}>
          {probing === 'all' ? 'Probing…' : 'Probe all'}
        </button>
      </header>

      <section className="card">
        <div className="row-actions" style={{ alignItems: 'baseline' }}>
          <h3 className="grow">Local-model token usage <span className="muted small">· all local models (Ollama · LM Studio · OpenAI-compatible)</span></h3>
          <span className="muted small" title="auto-refreshes on the fleet poll + every 15s">{usageAt ? `updated ${agoStr(usageAt)}` : usage === undefined ? 'loading…' : ''}</span>
        </div>
        {usage === undefined ? (
          <p className="muted small">Loading…</p>
        ) : usage === null ? (
          <p className="muted small">Token usage isn't available on this manager (no <span className="mono">/usage</span> route).</p>
        ) : usage.week.count === 0 ? (
          <p className="muted small">
            No local-model activity recorded yet. Token usage is captured from every <b>local-model</b> agent (Ollama, LM Studio, or any OpenAI-compatible local server) — probe or message one and this fills in. (Cloud API runtimes are intentionally excluded.)
          </p>
        ) : (
          <div className="usage-grid">
            <div className="gauge-wrap">
              <Gauge value={gaugeVal} max={gaugeMax} />
              <div className="gauge-cap">
                throughput <span className="muted small">(rate)</span>
                {usage.recent ? <span className="muted small"> · last run: {usage.recent.agent}</span> : null}
              </div>
              <div className="muted small" style={{ textAlign: 'center' }}>
                24h avg {fmtTps(usage.day.avgTps)} · 7d avg {fmtTps(usage.week.avgTps)} tok/s
              </div>
            </div>
            <WindowCard title="Last 24 hours" w={usage.day} />
            <WindowCard title="Last 7 days" w={usage.week} />
            {localModels.length > 0 ? (
              <div className="usage-card grow">
                <div className="usage-card-title">By model · 24h <span className="muted small">(total tokens · rate)</span></div>
                {localModels.slice(0, 8).map((m) => (
                  <div className="usage-agent-row" key={m.model}>
                    <span className="b mono">{m.model}</span>
                    <span className="muted small grow">{fmt(m.total ?? m.output)} tokens · {m.count}q</span>
                    <span className="ok-text small" title="average throughput rate (not a total)">{fmtTps(m.avgTps)} tok/s avg</span>
                  </div>
                ))}
              </div>
            ) : null}
            {localAgents.length > 0 ? (
              <div className="usage-card grow">
                <div className="usage-card-title">By agent · 24h <span className="muted small">(total tokens · rate)</span></div>
                {localAgents.slice(0, 8).map((a) => (
                  <div className="usage-agent-row" key={a.agent}>
                    <span className="b">{a.agent}</span>
                    <span className="muted small grow">{fmt(a.total ?? a.output)} tokens · {a.count}q</span>
                    <span className="ok-text small" title="average throughput rate (not a total)">{fmtTps(a.avgTps)} tok/s avg</span>
                  </div>
                ))}
              </div>
            ) : null}
          </div>
        )}
      </section>

      <section className="card">
        <div className="row-actions" style={{ alignItems: 'baseline' }}>
          <h3 className="grow">Headroom pilot</h3>
          <button className="btn small" onClick={() => void loadHeadroom()}>Refresh</button>
        </div>
        {headroom === undefined ? (
          <p className="muted small">Checking local Headroom status…</p>
        ) : headroom === null ? (
          <p className="muted small">Headroom status is unavailable in this build.</p>
        ) : (
          <div className="kv" style={{ gridTemplateColumns: '130px 1fr', gap: '5px 12px' }}>
            <span>CLI</span>
            <b className={headroom.cli.found ? 'ok-text' : 'muted'}>
              {headroom.cli.found ? `installed${headroom.cli.version ? ` · ${headroom.cli.version}` : ''}` : 'not installed'}
            </b>
            <span>MCP preset</span>
            <b className="muted small">Capabilities → MCP servers → Headroom (context compression)</b>
            <span>proxy</span>
            <b className={headroom.proxy.reachable ? 'ok-text' : 'muted'}>
              {headroom.proxy.reachable
                ? `reachable · ${headroom.proxy.url}${headroom.proxy.httpStatus ? ` · HTTP ${headroom.proxy.httpStatus}` : ''}`
                : `passthrough recommended · ${headroom.proxy.url}`}
            </b>
            <span>policy</span>
            <b className="muted small">Optional only. Keep source-code, secrets, policy text, and validator evidence on direct routes unless a task explicitly opts in.</b>
          </div>
        )}
        {pilot ? (
          <>
            <div className="kv" style={{ gridTemplateColumns: '150px 1fr', gap: '7px 12px', marginTop: 12 }}>
              <span>pilot opt-in</span>
              <b>
                <input
                  type="checkbox"
                  checked={pilot.enabled}
                  disabled={pilotSaving}
                  onChange={(e) => void savePilot({ enabled: e.target.checked, mode: e.target.checked ? (pilot.mode === 'off' ? 'mcp' : pilot.mode) : 'off' })}
                />{' '}
                <span className={pilot.enabled ? 'ok-text small' : 'muted small'}>{pilot.enabled ? 'enabled for selected canary routes' : 'disabled by default'}</span>
              </b>
              <span>mode</span>
              <b>
                <select
                  className="cell-select"
                  value={pilot.mode}
                  disabled={pilotSaving || !pilot.enabled}
                  onChange={(e) => void savePilot({ mode: e.target.value as HeadroomPilotSettings['mode'] })}
                >
                  <option value="off">off</option>
                  <option value="mcp">MCP tools only</option>
                  <option value="proxy">local proxy route</option>
                  <option value="mcp-and-proxy">MCP + proxy</option>
                </select>
              </b>
              <span>measurement</span>
              <b className="row-actions" style={{ justifyContent: 'flex-start', gap: 8, flexWrap: 'wrap' }}>
                <label className="muted small">canary <input type="number" min={0} max={100} style={{ width: 58 }} value={pilot.canaryPercent} disabled={pilotSaving} onChange={(e) => void savePilot({ canaryPercent: Number(e.target.value) })} />%</label>
                <label className="muted small">holdout <input type="number" min={0} max={100} style={{ width: 58 }} value={pilot.holdoutPercent} disabled={pilotSaving} onChange={(e) => void savePilot({ holdoutPercent: Number(e.target.value) })} />%</label>
                <label className="muted small">min context <input type="number" min={1000} step={1000} style={{ width: 84 }} value={pilot.minContextTokens} disabled={pilotSaving} onChange={(e) => void savePilot({ minContextTokens: Number(e.target.value) })} /> tokens</label>
              </b>
              <span>state</span>
              <b className="row-actions" style={{ justifyContent: 'flex-start', gap: 8, flexWrap: 'wrap' }}>
                <select
                  className="cell-select"
                  value={pilot.stateIsolation}
                  disabled={pilotSaving}
                  onChange={(e) => void savePilot({ stateIsolation: e.target.value as HeadroomPilotSettings['stateIsolation'] })}
                >
                  <option value="per-agent">per agent</option>
                  <option value="per-team">per team</option>
                </select>
                <input
                  style={{ flex: '1 1 260px' }}
                  placeholder="optional state root, e.g. ~/.headroom/idacc"
                  value={pilot.stateRoot ?? ''}
                  disabled={pilotSaving}
                  onChange={(e) => void savePilot({ stateRoot: e.target.value })}
                />
              </b>
              <span>telemetry</span>
              <b>
                <select
                  className="cell-select"
                  value={pilot.telemetry}
                  disabled={pilotSaving}
                  style={{ minWidth: 150 }}
                  onChange={(e) => void savePilot({ telemetry: e.target.value as HeadroomPilotSettings['telemetry'] })}
                >
                  <option value="verify-before-pilot">verify build first</option>
                  <option value="off">force off</option>
                  <option value="on">operator enabled</option>
                </select>
              </b>
              <span>passthrough</span>
              <b className="chips">{pilot.passthroughContent.map((x) => <span className="chip tag" key={x}>{x}</span>)}</b>
              <span>validation gates</span>
              <b className="muted small">{pilot.validationGates.join(' · ')}</b>
            </div>
            {pilotSaving ? <p className="muted small">Saving pilot policy…</p> : null}
          </>
        ) : null}
      </section>

      {/* The fleet roster is the shared AgentTable — runtime/model dropdowns + lifecycle
          actions + per-row Probe, live & holistic (all teams grouped in "All teams" view). */}
      <AgentTable store={store} onProbe={(a) => void probe(a.name, store.viewAll ? a.team : undefined)} probeBusy={probing} />
    </div>
  );
}
