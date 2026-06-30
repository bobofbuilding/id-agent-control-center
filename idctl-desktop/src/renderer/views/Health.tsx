import { useCallback, useEffect, useState } from 'react';
import { call, type FleetStore } from '../store.ts';
import type { UsageAgent, UsageModel, UsageReport, UsageWindow } from '../../../../idctl/src/api/client.ts';
import { AgentTable } from './AgentTable.tsx';

type ProbeTarget = { id?: string; name: string; team: string; status?: string };
type UsageRow = UsageAgent | UsageModel;

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
function ageLabel(ms: number | null | undefined): string {
  if (!ms) return '';
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
  return s < 60 ? `${s}s ago` : s < 3600 ? `${Math.round(s / 60)}m ago` : `${Math.round(s / 3600)}h ago`;
}
function epochMs(value: number | null | undefined): number | null {
  if (!value || !Number.isFinite(value)) return null;
  return value < 10_000_000_000 ? value * 1000 : value;
}
function totalTokens(row: UsageRow): number {
  return row.total ?? row.output ?? 0;
}
function rowName(row: UsageRow): string {
  return 'model' in row ? row.model : row.agent;
}
function topUsage<T extends UsageRow>(rows?: T[]): T | undefined {
  return [...(rows ?? [])].sort((a, b) => totalTokens(b) - totalTokens(a))[0];
}
function sortedUsage<T extends UsageRow>(rows?: T[]): T[] {
  return [...(rows ?? [])].sort((a, b) => totalTokens(b) - totalTokens(a));
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

function probeLive(status?: string): boolean {
  const s = String(status || '').toLowerCase();
  return !!s && !/stop|offline|dead|exit|error|crash|down|disabled|sleep/.test(s);
}
function probeTargetStamp(targets: ProbeTarget[]): string {
  return targets
    .map((t) => `${t.team}:${t.id ?? ''}:${t.name}:${t.status ?? ''}`)
    .sort()
    .join('|');
}

function UsageList({ title, rows, empty }: { title: string; rows: UsageRow[]; empty: string }) {
  const shown = sortedUsage(rows).slice(0, 8);
  return (
    <div className="usage-card usage-list">
      <div className="usage-card-title">{title}</div>
      {shown.length ? shown.map((row) => (
        <div className="usage-agent-row" key={rowName(row)}>
          <span className="b mono">{rowName(row)}</span>
          <span className="muted small grow">{fmt(totalTokens(row))} tokens · {row.count}q</span>
          <span className="ok-text small" title="average output throughput rate">{fmtTps(row.avgTps)} tok/s</span>
        </div>
      )) : <span className="muted small">{empty}</span>}
    </div>
  );
}

function UsageSection({
  usage,
  usageAt,
  error,
  onRefresh,
}: {
  usage: UsageReport | null | undefined;
  usageAt: number;
  error: string | null;
  onRefresh: () => void;
}) {
  const gaugeVal = usage ? (usage.recent?.tps ?? usage.day.avgTps ?? 0) : 0;
  const gaugeMax = usage ? niceMax(Math.max(gaugeVal, usage.day.avgTps, usage.week.avgTps)) : 100;
  const localAgents = usage?.day.agents ?? [];
  const localModels = usage?.day.models ?? [];
  const topAgent = topUsage(localAgents);
  const topModel = topUsage(localModels);
  const recentAt = epochMs(usage?.recent?.at);
  const throughputLabel = usage?.recent?.tps != null ? 'Recent sample' : '24h average';

  return (
    <section className="card health-section">
      <div className="row-actions health-section-head">
        <h3 className="grow">Token throughput</h3>
        <span className="muted small" title="auto-refreshes every 15s and after probes">{usageAt ? `updated ${ageLabel(usageAt)}` : usage === undefined ? 'loading...' : ''}</span>
        <button className="btn small" onClick={onRefresh}>Refresh</button>
      </div>
      {usage === undefined ? (
        <p className="muted small">Loading local-model usage...</p>
      ) : usage === null ? (
        <p className="muted small">
          {error
            ? `Token usage refresh failed: ${error}`
            : <>Token usage is not available on this manager (no <span className="mono">/usage</span> route).</>}
        </p>
      ) : usage.week.count === 0 ? (
        <p className="muted small">
          No local-model activity recorded yet. Probe or message a local-model agent and Health will start tracking throughput. Cloud API runtimes are excluded.
        </p>
      ) : (
        <>
          <div className="health-metrics">
            <div className="health-metric primary">
              <span>{throughputLabel}</span>
              <b>{fmtTps(gaugeVal)} tok/s</b>
              <small>{usage.recent ? `${usage.recent.agent} · ${usage.recent.model}${recentAt ? ` · ${ageLabel(recentAt)}` : ''}` : 'fallback from 24h average'}</small>
            </div>
            <div className="health-metric">
              <span>24h tokens</span>
              <b>{fmt(usage.day.total)}</b>
              <small>{usage.day.count} turns · {fmt(usage.day.avgPerQuery)}/turn</small>
            </div>
            <div className="health-metric">
              <span>7d tokens</span>
              <b>{fmt(usage.week.total)}</b>
              <small>{usage.week.count} turns · {fmtTps(usage.week.avgTps)} tok/s avg</small>
            </div>
            <div className="health-metric">
              <span>Top spender</span>
              <b>{topAgent ? rowName(topAgent) : 'none'}</b>
              <small>{topAgent ? `${fmt(totalTokens(topAgent))} tokens` : 'no 24h agent data'}</small>
            </div>
            <div className="health-metric">
              <span>Top model</span>
              <b>{topModel ? rowName(topModel) : 'none'}</b>
              <small>{topModel ? `${fmt(totalTokens(topModel))} tokens` : 'no 24h model data'}</small>
            </div>
          </div>
          <div className="usage-grid">
            <div className="gauge-wrap">
              <Gauge value={gaugeVal} max={gaugeMax} />
              <div className="gauge-cap">throughput</div>
              <div className="muted small" style={{ textAlign: 'center' }}>
                24h avg {fmtTps(usage.day.avgTps)} · 7d avg {fmtTps(usage.week.avgTps)} tok/s
              </div>
            </div>
            <WindowCard title="Last 24 hours" w={usage.day} />
            <WindowCard title="Last 7 days" w={usage.week} />
          </div>
          <div className="usage-breakdown">
            <UsageList title="By model - 24h" rows={localModels} empty="No model breakdown from this manager yet." />
            <UsageList title="By agent - 24h" rows={localAgents} empty="No agent breakdown from this manager yet." />
          </div>
        </>
      )}
    </section>
  );
}

export function Health({ store, navigate }: { store: FleetStore; navigate?: (view: string) => void }) {
  const [probing, setProbing] = useState<string | null>(null);
  const [usage, setUsage] = useState<UsageReport | null | undefined>(undefined); // undefined = loading
  const [usageError, setUsageError] = useState<string | null>(null);
  const [usageAt, setUsageAt] = useState<number>(0); // when usage was last refreshed
  const [, setTick] = useState(0); // 1 Hz re-render so "updated Ns ago" stays live

  const loadUsage = useCallback(async () => {
    try {
      setUsage(await call<UsageReport | null>('usage'));
      setUsageError(null);
      setUsageAt(Date.now());
    } catch (err) {
      setUsage(null);
      setUsageError(err instanceof Error ? err.message : String(err));
      setUsageAt(Date.now());
    }
  }, []);
  // Auto-refresh usage on open/manager reconnect and every 15s. Avoid tying this
  // to the 3s fleet poll; throughput is its own observability stream.
  useEffect(() => { void loadUsage(); }, [loadUsage, store.connection, store.managerUrl]);

  useEffect(() => {
    const iv = setInterval(() => void loadUsage(), 15000);
    const t = setInterval(() => setTick((n) => n + 1), 1000);
    return () => { clearInterval(iv); clearInterval(t); };
  }, [loadUsage]);

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
  async function currentProbeTargets(): Promise<ProbeTarget[]> {
    const groups = await call<Array<{ team: string; agents: ProbeTarget[] }>>('agents:allTeams').catch(() => null);
    const targets = groups
      ? groups.flatMap((g) => g.agents.map((a) => ({ id: a.id, name: a.name, status: a.status, team: g.team })))
      : store.agents.map((a) => ({ id: a.id, name: a.name, status: a.status, team: store.team ?? 'default' }));
    return targets.filter((a) => probeLive(a.status));
  }
  async function probeAllVisible() {
    if (probing) return;
    setProbing('all');
    try {
      const targets = await currentProbeTargets();
      if (!targets.length) {
        window.alert('No running agents are available to probe. Use Health > show stopped to review stopped agents.');
        return;
      }
      const teams = [...new Set(targets.map((t) => t.team))].sort();
      const sample = targets.slice(0, 12).map((t) => `- ${t.team}/${t.name} (${t.status ?? 'unknown'})`);
      if (!window.confirm([
        `Probe ${targets.length} running agent${targets.length === 1 ? '' : 's'} across ${teams.length} team${teams.length === 1 ? '' : 's'}?`,
        '',
        ...sample,
        targets.length > sample.length ? `- ...and ${targets.length - sample.length} more` : '',
        '',
        'This exercises each current agent probe route and refreshes usage afterward. Stopped agents are skipped.',
      ].filter(Boolean).join('\n'))) return;
      const afterConfirm = await currentProbeTargets();
      if (probeTargetStamp(afterConfirm) !== probeTargetStamp(targets)) {
        window.alert('Probe all blocked: the running-agent set changed during confirmation. Health will refresh; review the current roster and try again.');
        store.refresh();
        return;
      }
      const results = await Promise.allSettled(afterConfirm.map((target) => call('probeOne', target.name, target.team)));
      const failed = results.filter((r) => r.status === 'rejected').length;
      if (failed) window.alert(`Probe completed with ${failed}/${afterConfirm.length} failed probe${failed === 1 ? '' : 's'}. Review the refreshed Health roster for details.`);
    } finally {
      setProbing(null);
      void loadUsage();
    }
  }
  return (
    <div className="view">
      <header className="view-head">
        <h1>Health &amp; Probes</h1>
        <button className="btn primary" disabled={!!probing} onClick={() => void probeAllVisible()}>
          {probing === 'all' ? 'Probing…' : 'Probe all'}
        </button>
      </header>

      <UsageSection usage={usage} usageAt={usageAt} error={usageError} onRefresh={() => void loadUsage()} />

      {/* The fleet roster is the shared AgentTable — runtime/model dropdowns + lifecycle
          actions + per-row Probe, live & holistic (all teams grouped in "All teams" view). */}
      <AgentTable store={store} onProbe={(a) => void probe(a.name, store.viewAll ? a.team : undefined)} probeBusy={probing} navigate={navigate} />
    </div>
  );
}
