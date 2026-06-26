import { useEffect, useRef, useState } from 'react';
import { call, agentsLeadFirst, type FleetStore, type TeamAgent } from '../store.ts';
import { statusClass } from '../agentStatus.ts';
import type { Agent } from '../../../../idctl/src/api/types.ts';
import { RUNTIMES, offerableRuntimes, effortOptions, runtimeHasEffort, speedOptions, runtimeHasSpeed } from '../../../../idctl/src/settings/runtimeCatalog.ts';

/**
 * The fleet agent grid — per-agent runtime/model switching + lifecycle actions, with a
 * detail panel for the selected agent. Holistic by default: when the app is in "All teams"
 * view it lists every team's agents grouped by team and routes each action to that agent's
 * own team. Extracted from the Dashboard so it can live in HR Manager.
 */

type ProviderRow = { kind: string; enabled?: boolean; keySource?: string; lastSync?: { status?: string } };
type RuntimeFreshness = { runtime: string; count: number; source: 'codex-cache' | 'provider' | 'curated' | 'none'; provider?: string; lastCheckedMs: number | null };
const SOURCE_LABEL: Record<RuntimeFreshness['source'], string> = {
  'codex-cache': 'codex CLI cache', provider: 'live provider sync', curated: 'curated fallback', none: 'no models',
};
function agoMs(ms: number | null): string {
  if (!ms) return 'never';
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}

function runtimeLabel(r: string): string {
  return r.replace('claude-code-', 'claude-').replace('claude-agent-sdk', 'claude-sdk').replace('-cli', '');
}
function modelFamily(model: string): 'claude' | 'openai' | 'ollama' | 'other' {
  const m = model.toLowerCase();
  if (/claude|opus|sonnet|haiku/.test(m)) return 'claude';
  if (/gpt|codex|^o\d|davinci/.test(m)) return 'openai';
  if (/:|qwen|llama|mistral|gemma|phi|deepseek|gpt-oss/.test(m)) return 'ollama';
  return 'other';
}
function runtimeAccepts(runtime: string): Set<string> {
  if (runtime.startsWith('claude')) return new Set(['claude']);
  if (runtime === 'codex') return new Set(['openai']);
  if (runtime === 'cursor-cli') return new Set(['claude', 'openai']);
  if (runtime === 'ollama') return new Set(['ollama']);
  return new Set(['claude', 'openai', 'ollama', 'other']);
}
function runtimeModelMismatch(runtime?: string, model?: string): string | null {
  if (!runtime || !model) return null;
  const fam = modelFamily(model);
  if (fam === 'other') return null;
  return runtimeAccepts(runtime).has(fam) ? null : `${runtimeLabel(runtime)} runtime expects a ${[...runtimeAccepts(runtime)][0]} model, but "${model}" looks like ${fam}`;
}
function short(s?: string): string {
  if (!s) return '—';
  return s.replace('claude-code-cli', 'claude').replace(/^claude-/, '').replace(/-cli$/, '');
}
// Reasoning effort only applies to the subscription runtimes that read ID_AGENT_EFFORT, and
// each accepts a DIFFERENT scale (codex: minimal–high · claude CLI/local: low–xhigh) — see
// effortOptions() in runtimeCatalog. Local servers (ollama) and cursor-cli have no knob.
function effortOf(a: Agent): string {
  const e = a.metadata?.effort;
  return typeof e === 'string' ? e : '';
}
function speedOf(a: Agent): string {
  const s = a.metadata?.speed;
  return typeof s === 'string' && s ? s : 'default';
}
function skillsOf(a: Agent): string[] {
  const s = a.metadata?.skills;
  return Array.isArray(s) ? (s as string[]) : [];
}

export function AgentTable({ store, onProbe, probeBusy }: { store: FleetStore; onProbe?: (a: TeamAgent) => void; probeBusy?: string | null }) {
  const cols = onProbe ? 9 : 8;
  const [selected, setSelected] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [catalog, setCatalog] = useState<Record<string, string[]>>({});
  const [providers, setProviders] = useState<ProviderRow[]>([]);
  const [coords, setCoords] = useState<Record<string, string>>({}); // team → coordinator (lead) name
  const [showStopped, setShowStopped] = useState(false); // by default the grid shows only running agents
  const [freshness, setFreshness] = useState<RuntimeFreshness[]>([]);
  const [showModels, setShowModels] = useState(false);
  const modelRefs = useRef<Record<string, HTMLSelectElement | null>>({});
  const viewAll = store.viewAll;
  const orderedAgents = agentsLeadFirst(store.agents, store.coordinator);
  const shown: TeamAgent[] = viewAll ? store.allAgents : orderedAgents;
  const sel: TeamAgent | undefined = shown.find((a) => a.id === selected) ?? shown[0];
  const teamOf = (a: TeamAgent): string | undefined => (viewAll ? a.team : undefined);
  const groups = viewAll
    ? Object.values(
        store.allAgents.reduce<Record<string, { team: string; agents: TeamAgent[] }>>((acc, a) => {
          const t = a.team ?? '—';
          (acc[t] ??= { team: t, agents: [] }).agents.push(a);
          return acc;
        }, {}),
      ).sort((x, y) => {
        const xa = x.agents.some((a) => statusClass(a.status) === 'ok');
        const ya = y.agents.some((a) => statusClass(a.status) === 'ok');
        return xa !== ya ? (xa ? -1 : 1) : x.team.localeCompare(y.team);
      })
    : [];
  const isActive = (a: TeamAgent) => statusClass(a.status) === 'ok';
  const activeCount = shown.filter(isActive).length;
  const stoppedCount = shown.length - activeCount;

  useEffect(() => {
    call<Record<string, string[]>>('runtime:models').then(setCatalog).catch(() => setCatalog({}));
    call<ProviderRow[]>('providers:list').then(setProviders).catch(() => setProviders([]));
    call<{ coordinators?: Record<string, string> }>('coordinator:hierarchy').then((h) => setCoords(h.coordinators ?? {})).catch(() => {});
    call<RuntimeFreshness[]>('runtime:freshness').then(setFreshness).catch(() => setFreshness([]));
  }, [store.lastUpdated]);

  // ★ set an agent as its team's coordinator (lead) — works per-team in the holistic view.
  const teamFor = (a: TeamAgent) => a.team ?? store.team ?? 'default';
  const isLead = (a: TeamAgent) => (coords[teamFor(a)] ?? (teamFor(a) === store.team ? store.coordinator : undefined)) === a.name;
  async function makeLead(a: TeamAgent) {
    const team = teamFor(a);
    try { await call('coordinator:set', team, a.name); setCoords((c) => ({ ...c, [team]: a.name })); store.refresh(); }
    catch (err) { window.alert(`couldn't set lead: ${err instanceof Error ? err.message : String(err)}`); }
  }
  useEffect(() => {
    call<Record<string, string[]>>('runtime:probe').then(setCatalog).catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function probeRuntimes() {
    setBusy('probe runtimes');
    try {
      setCatalog(await call<Record<string, string[]>>('runtime:probe'));
      setFreshness(await call<RuntimeFreshness[]>('runtime:freshness').catch(() => freshness));
      setShowModels(true);
    }
    catch (err) { window.alert(`probe failed: ${err instanceof Error ? err.message : String(err)}`); }
    finally { setBusy(null); }
  }
  async function run(label: string, cmd: string, team?: string) {
    setBusy(label);
    try { await call('remote', cmd, undefined, team); store.refresh(); }
    catch (err) { window.alert(`${label} failed: ${err instanceof Error ? err.message : String(err)}`); }
    finally { setBusy(null); }
  }
  async function setModel(a: TeamAgent, model: string) {
    if (!model || model === a.model) return;
    const team = teamOf(a);
    setBusy(`model ${a.name}`);
    try {
      await call('remote', `/model ${a.name} ${model}`, undefined, team);
      await call('remote', `/agent ${a.name} rebuild`, undefined, team);
      store.refresh(); setBusy(null);
    } catch (err) { setBusy(`model change failed — ${err instanceof Error ? err.message : String(err)}`); setTimeout(() => setBusy(null), 4000); }
  }
  function action(a: TeamAgent, act: string) {
    if (!act) return;
    const team = teamOf(a);
    if (act === 'Delete') {
      if (window.confirm(`Delete agent "${a.name}"? Working files are left in place.`)) void run(`delete ${a.name}`, `/delete ${a.name}`, team);
      return;
    }
    if (act === 'Reset session') {
      // Start a fresh conversation — drops the agent's accumulated context. Use this to deflate a
      // bloated codex session (multi-million-token prompts) so its next turns are cheap again.
      void run(`reset session ${a.name}`, `/clear ${a.name}`, team);
      return;
    }
    void run(`${act} ${a.name}`, `/agent ${a.name} ${act.toLowerCase()}`, team);
  }
  async function setEffort(a: TeamAgent, effort: string) {
    if (effort === effortOf(a)) return;
    const team = teamOf(a);
    setBusy(`effort ${a.name}`);
    try {
      await call('setAgentEffort', a.id, effort, team);
      // Rebuild so the agent's harness picks up the new ID_AGENT_EFFORT on its next launch.
      await call('remote', `/agent ${a.name} rebuild`, undefined, team);
      store.refresh(); setBusy(null);
    } catch (err) { setBusy(`effort change failed — ${err instanceof Error ? err.message : String(err)}`); setTimeout(() => setBusy(null), 4000); }
  }
  async function setSpeed(a: TeamAgent, speed: string) {
    if (speed === speedOf(a)) return;
    const team = teamOf(a);
    setBusy(`speed ${a.name}`);
    try {
      await call('setAgentSpeed', a.id, speed, team);
      // Rebuild so the agent's harness picks up the new ID_AGENT_SPEED on its next launch.
      await call('remote', `/agent ${a.name} rebuild`, undefined, team);
      store.refresh(); setBusy(null);
    } catch (err) { setBusy(`speed change failed — ${err instanceof Error ? err.message : String(err)}`); setTimeout(() => setBusy(null), 4000); }
  }
  async function setRuntime(a: TeamAgent, runtime: string) {
    if (!runtime || runtime === a.runtime) return;
    const team = teamOf(a);
    setBusy(`runtime ${a.name}`);
    try {
      await call('setAgentRuntime', a.id, runtime, team);
      const models = catalog[runtime] ?? [];
      const model = !a.model || runtimeModelMismatch(runtime, a.model) ? models[0] ?? a.model : a.model;
      if (model && model !== a.model) await call('remote', `/model ${a.name} ${model}`, undefined, team);
      store.refresh();
      setTimeout(() => { try { modelRefs.current[a.id]?.showPicker?.(); } catch { /* no activation */ } }, 250);
      await call('remote', `/agent ${a.name} rebuild`, undefined, team);
      store.refresh(); setBusy(null);
    } catch (err) { setBusy(`runtime change failed — ${err instanceof Error ? err.message : String(err)}`); setTimeout(() => setBusy(null), 4000); }
  }

  const renderRow = (a: TeamAgent) => {
    const runtimeModels = catalog[a.runtime ?? ''] ?? [];
    const modelOpts = Array.from(new Set([a.model, ...runtimeModels].filter(Boolean))) as string[];
    const isLocal = (a.type ?? '') === 'claude' || RUNTIMES.includes(a.runtime ?? '');
    const runtimeOpts = Array.from(new Set([a.runtime, ...offerableRuntimes(providers, a.runtime ?? undefined)].filter(Boolean))) as string[];
    const mismatch = runtimeModelMismatch(a.runtime, a.model);
    return (
      <tr key={`${a.team ?? ''}-${a.id}`} className={sel?.id === a.id ? 'sel' : ''} onClick={() => setSelected(a.id)}>
        <td className="b">
          <button className={`star${isLead(a) ? ' on' : ''}`} title={isLead(a) ? `${a.name} is ${teamFor(a)}'s lead` : `Make ${a.name} the lead of ${teamFor(a)}`}
            onClick={(e) => { e.stopPropagation(); if (!isLead(a)) void makeLead(a); }} style={{ marginRight: 5 }}>{isLead(a) ? '★' : '☆'}</button>
          {a.name}
        </td>
        <td><span className={`dot ${statusClass(a.status)}`} /> {a.status}</td>
        <td onClick={(e) => e.stopPropagation()}>
          {isLocal ? (
            <select className="cell-select" value={a.runtime ?? ''} onChange={(e) => void setRuntime(a, e.target.value)}>
              {runtimeOpts.map((r) => <option key={r} value={r}>{runtimeLabel(r)}</option>)}
            </select>
          ) : (
            <span className="muted" title="remote agents have no switchable runtime">{short(a.runtime ?? a.type)}</span>
          )}
        </td>
        <td onClick={(e) => e.stopPropagation()}>
          <select ref={(el) => { modelRefs.current[a.id] = el; }} className={`cell-select${mismatch ? ' mismatch' : ''}`} value={a.model ?? ''} onChange={(e) => void setModel(a, e.target.value)} title={mismatch ?? undefined}>
            {modelOpts.map((m) => <option key={m} value={m}>{short(m)}</option>)}
          </select>
          {mismatch ? <span className="warn-text" title={mismatch} style={{ marginLeft: 4, cursor: 'help' }}>⚠</span> : null}
        </td>
        <td onClick={(e) => e.stopPropagation()}>
          {runtimeHasEffort(a.runtime) ? (
            <select className="cell-select" value={effortOf(a)} onChange={(e) => void setEffort(a, e.target.value)}
              title={`Reasoning effort for the ${runtimeLabel(a.runtime ?? '')} runtime — lower spends fewer subscription tokens per turn`}>
              <option value="">default</option>
              {effortOptions(a.runtime).map((eff) => <option key={eff} value={eff}>{eff}</option>)}
            </select>
          ) : (
            <span className="muted" title="local & cursor runtimes have no reasoning-effort setting">—</span>
          )}
        </td>
        <td onClick={(e) => e.stopPropagation()}>
          {runtimeHasSpeed(a.runtime) ? (
            <select className="cell-select" value={speedOf(a)} onChange={(e) => void setSpeed(a, e.target.value)}
              title={`Output speed for the ${runtimeLabel(a.runtime ?? '')} runtime`}>
              {speedOptions(a.runtime).map((speed) => <option key={speed} value={speed}>{speed}</option>)}
            </select>
          ) : (
            <span className="muted" title="this runtime has no output-speed setting">—</span>
          )}
        </td>
        <td className="muted" title="port is assigned by the manager">{a.port || '—'}</td>
        <td onClick={(e) => e.stopPropagation()}>
          <select className="cell-select" value="" onChange={(e) => { action(a, e.target.value); e.target.value = ''; }}>
            <option value="">⋯</option>
            <option>Start</option>
            <option>Stop</option>
            <option>Rebuild</option>
            <option>Reset session</option>
            <option>Probe</option>
            <option>Delete</option>
          </select>
        </td>
        {onProbe ? (
          <td onClick={(e) => e.stopPropagation()}>
            <button className="btn small" disabled={probeBusy === a.name} onClick={() => onProbe(a)}>{probeBusy === a.name ? '…' : 'Probe'}</button>
          </td>
        ) : null}
      </tr>
    );
  };

  return (
    <>
      <section className="card grow" style={{ minWidth: 0 }}>
        <div className="row-actions" style={{ alignItems: 'center', marginBottom: 8 }}>
          <h3 style={{ margin: 0 }}>Fleet <span className="muted small">· {activeCount} active{busy ? ` · ${busy}…` : ''}</span></h3>
          <span className="grow" />
          {stoppedCount ? (
            <label className="muted small" style={{ display: 'inline-flex', alignItems: 'center', gap: 5, cursor: 'pointer' }} title="By default only running agents are shown — reveal stopped ones to start/manage them">
              <input type="checkbox" checked={showStopped} onChange={(e) => setShowStopped(e.target.checked)} /> show stopped ({stoppedCount})
            </label>
          ) : null}
          <button className="btn small" onClick={() => setShowModels((v) => !v)} title="Show each runtime's model list, where it comes from, and when it was last refreshed">
            {showModels ? 'Hide models' : `Models${freshness.length ? ` (${freshness.filter((f) => f.count).length})` : ''}`}
          </button>
          <button className="btn" disabled={!!busy} onClick={() => void probeRuntimes()} title="Probe each runtime's backing inference provider for its newest available models (also auto-refreshes every 6h)">Probe runtimes</button>
        </div>
        {showModels ? (
          <div className="card" style={{ background: 'var(--bg-2)', margin: '0 0 8px', padding: '6px 10px' }}>
            <div className="muted small" style={{ marginBottom: 4 }}>
              Per-runtime models &amp; freshness — auto-refreshed on boot + every 6h, or hit <b>Probe runtimes</b> now.
            </div>
            {freshness.filter((f) => f.count || f.source !== 'none').map((f) => (
              <div key={f.runtime} className="row-actions" style={{ gap: 8, alignItems: 'baseline', padding: '2px 0' }}>
                <b style={{ minWidth: 130 }}>{runtimeLabel(f.runtime)}</b>
                <span className="muted small" style={{ minWidth: 64 }}>{f.count} model{f.count === 1 ? '' : 's'}</span>
                <span className={`small ${f.source === 'curated' || f.source === 'none' ? 'warn-text' : 'ok-text'}`} style={{ minWidth: 140 }}
                  title={f.source === 'curated' ? 'No live model API for this runtime — using a curated fallback list (subscription runtimes have no /models endpoint).' : SOURCE_LABEL[f.source]}>
                  {SOURCE_LABEL[f.source]}{f.provider ? ` · ${f.provider}` : ''}
                </span>
                <span className="muted small">{f.lastCheckedMs ? `checked ${agoMs(f.lastCheckedMs)}` : ''}</span>
              </div>
            ))}
            {freshness.length === 0 ? <div className="muted small">Loading model freshness…</div> : null}
          </div>
        ) : null}
        <table className="grid">
          <thead>
            <tr><th>Agent</th><th>Status</th><th>Runtime</th><th>Model</th><th title="Reasoning effort — lower spends fewer subscription tokens (codex & Claude CLI only)">Effort</th><th title="Output speed — Claude Code runtimes only">Speed</th><th>Port</th><th>Actions</th>{onProbe ? <th>Probe</th> : null}</tr>
          </thead>
          <tbody>
            {groups.flatMap((g) => {
              // The team's actual ★ lead floats to the top of its group (not just a "lead"-named agent).
              const teamLead = coords[g.team] ?? (g.team === store.team ? store.coordinator : undefined);
              const rows = agentsLeadFirst(g.agents, teamLead).filter((a) => showStopped || isActive(a as TeamAgent));
              if (!rows.length) return [];
              return [
                <tr key={`hdr-${g.team}`} className="group-row">
                  <td colSpan={cols} className="muted small b" style={{ background: 'var(--panel, #1b1b1b)', padding: '4px 8px' }}>
                    {g.team} · {g.agents.filter((x) => statusClass(x.status) === 'ok').length}/{g.agents.length} running
                  </td>
                </tr>,
                ...rows.map((a) => renderRow(a as TeamAgent)),
              ];
            })}
            {activeCount === 0 && !showStopped ? (
              <tr><td colSpan={cols} className="muted center pad">{store.connection === 'offline' ? 'manager unreachable' : stoppedCount ? 'no running agents — tick “show stopped” to start one' : 'no agents'}</td></tr>
            ) : null}
          </tbody>
        </table>
      </section>

      {sel ? (
        <section className="card detail">
          <h3>{sel.name}</h3>
          <div className="kv">
            <span>status</span><b><span className={`dot ${statusClass(sel.status)}`} /> {sel.status}</b>
            {viewAll ? (<><span>team</span><b>{sel.team ?? '—'}</b></>) : null}
            <span>runtime</span><b>{sel.runtime ?? sel.type ?? '—'}</b>
            <span>model</span><b>{sel.model ?? '—'}</b>
            <span>speed</span><b>{runtimeHasSpeed(sel.runtime) ? speedOf(sel) : '—'}</b>
            <span>port</span><b>{sel.port || '—'}</b>
            <span>skills</span>
            <b>{skillsOf(sel).length ? <span className="chips">{skillsOf(sel).map((s) => <span className="chip" key={s}>{s}</span>)}</span> : <span className="muted">none</span>}</b>
            <span>workdir</span><b className="mono small">{sel.workingDirectory ?? '—'}</b>
          </div>
        </section>
      ) : null}
    </>
  );
}
