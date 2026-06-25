import { useCallback, useEffect, useState } from 'react';
import { call, type FleetStore } from '../store.ts';
import type { ProbeResult } from '../../../../idctl/src/api/types.ts';
import type { UsageReport, UsageWindow } from '../../../../idctl/src/api/client.ts';
import { AgentTable } from './AgentTable.tsx';

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
  const [result, setResult] = useState<ProbeResult | null>(null);
  const [probing, setProbing] = useState<string | null>(null);
  const [usage, setUsage] = useState<UsageReport | null | undefined>(undefined); // undefined = loading

  const loadUsage = useCallback(async () => {
    try {
      setUsage(await call<UsageReport | null>('usage'));
    } catch {
      setUsage(null);
    }
  }, []);
  useEffect(() => { void loadUsage(); }, [loadUsage, store.lastUpdated]);

  // The fleet roster is the shared, live AgentTable below. Probing routes to the agent's
  // own team (holistic) or the active team.
  async function probe(which: 'all' | string, team?: string) {
    setProbing(which);
    setResult(null);
    try {
      const r = await call<ProbeResult>(which === 'all' ? 'probeAll' : 'probeOne', ...(which === 'all' ? [] : [which, team]));
      setResult(r);
    } catch (err) {
      setResult({ team: store.team ?? '', probed: 0, passed: 0, failed: 1, results: [{ name: which, status: 'failed', error: err instanceof Error ? err.message : String(err) }] });
    } finally {
      setProbing(null);
      void loadUsage(); // refresh throughput after exercising agents
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
          <button className="btn small" onClick={() => void loadUsage()}>Refresh</button>
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

      {/* The fleet roster is the shared AgentTable — runtime/model dropdowns + lifecycle
          actions + per-row Probe, live & holistic (all teams grouped in "All teams" view). */}
      <AgentTable store={store} onProbe={(a) => void probe(a.name, store.viewAll ? a.team : undefined)} probeBusy={probing} />

      <section className="card feed">
        <h3>Probe result</h3>
        {result ? (
          <div>
            <p className={result.failed > 0 ? 'status-error' : 'ok-text'}>{result.passed}/{result.probed} ok</p>
            {result.results.map((r) => (
              <div className="feed-row" key={r.name}>
                <span className={`dot ${r.status === 'ok' ? 'ok' : 'err'}`} />
                <span>{r.name}</span>
                <span className="muted t">{r.duration_ms != null ? `${r.duration_ms}ms` : ''}</span>
                {r.error ? <div className="muted small">{r.error}</div> : null}
              </div>
            ))}
          </div>
        ) : (
          <p className="muted">Run a probe (per-row or “Probe all”) to verify each agent responds on its dispatch path.</p>
        )}
      </section>
    </div>
  );
}
