import { useEffect, useMemo, useState } from 'react';
import { call, agentsLeadFirst, resolveCoordinator, type FleetStore } from '../store.ts';
import { offerableRuntimes } from '../../../../idctl/src/settings/runtimeCatalog.ts';
import type { ConfigEntry, DeployPreflight, LibrarySkillEntry, McpServerSpec, TeamTemplate } from '../../../../idctl/src/api/client.ts';
import type { OnboardPlan, OnboardResult } from '../../../../idctl/src/api/onboard.ts';
import { MCP_CATALOG, buildFromCatalog } from '../../../../idctl/src/settings/mcpCatalog.ts';
import { parseTeamSpec, slugName, isReservedName } from '../../../../idctl/src/api/teamSpec.ts';

type ProviderRow = { kind: string; enabled?: boolean; keySource?: string; lastSync?: { status?: string } };

type RelayMode = 'permissive' | 'all' | 'select' | 'none';
type TeamSource =
  | { kind: 'default'; name: 'default' }
  | { kind: 'template'; name: string }
  | { kind: 'config'; name: string };

const HB_INTERVALS = [
  { label: '5 min', s: 300 },
  { label: '15 min', s: 900 },
  { label: '1 hour', s: 3600 },
  { label: '6 hours', s: 21600 },
  { label: '24 hours', s: 86400 },
];
function runtimeLabel(r: string): string {
  return r.replace('claude-code-', 'claude-').replace('claude-agent-sdk', 'claude-sdk').replace('-cli', '');
}

function modeOf(delegates: string[] | null): RelayMode {
  if (delegates === null) return 'permissive';
  if (delegates.includes('*')) return 'all';
  if (delegates.length === 0) return 'none';
  return 'select';
}

// Stable identity for a delegates_to value so we can detect unsaved changes.
function relayKey(d: string[] | null): string {
  if (d === null) return 'permissive';
  if (d.length === 0) return 'none';
  return [...d].sort().join(',');
}

// Human-readable summary of a persisted delegates_to value.
function describeRelay(d: string[] | null): string {
  if (d === null) return 'permissive — any team';
  if (d.includes('*')) return 'all teams';
  if (d.length === 0) return 'blocked — no teams';
  return d.join(', ');
}

/** Ready-made "act as the team coordinator" directive (delegate to teammates). */
const COORDINATOR_PRESET = `## Team coordination (you are the lead)

You are this team's COORDINATOR. You have specialist teammates — by default **coder** (implementation, code, file changes, running commands) and **researcher** (research, analysis, documentation, investigation).

For any NON-TRIVIAL request — anything beyond a quick factual answer, and ESPECIALLY anything involving implementation or research — you MUST delegate the specialist parts to the right teammate rather than doing all of it yourself:

1. Decompose the request into the specialist pieces it needs.
2. Delegate each piece to the best teammate (implementation/code → **coder**, research/analysis/docs → **researcher**) using the **inter-agent** skill.
3. Wait for their replies and synthesize them into one answer, stating who did what.

RELIABILITY — how to delegate:
- STRONGLY PREFER synchronous **/talk-to** (pattern 1 in the inter-agent skill). It blocks until the teammate replies and the MANAGER handles the wait, so you get the result inline and reliably.
- Do NOT hand-roll a long polling loop against a teammate's /news after an async /news-to — that is fragile and can hang for a long time if the teammate doesn't wake. If you find yourself looping on /news waiting for a delegate, STOP and use /talk-to instead.
- Use async /news-to (trigger:true) ONLY for genuine fire-and-forget where you do NOT need the result inline. If you must parallelize, prefer a few sequential /talk-to calls over a fragile async fan-out.

Keep the task board clean: for synchronous /talk-to delegations do NOT attach a tracked manager task (omit the \`task\` field) — you get the reply inline, so a tracked task would just linger unclosed. Only attach a tracked task for async handoffs you will collect later, and mark it done when you do.

Do the work yourself only for trivial one-liners, or when delegation would clearly be slower with no benefit (and say so in one line). Leveraging your team is your primary job as the lead.`;

export function Teams({ store }: { store: FleetStore }) {
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string>('');
  const [createOpen, setCreateOpen] = useState(false);
  const [importOpen, setImportOpen] = useState(false);

  // Cross-team relay policy (delegates_to) for the active team.
  const activeTeam = store.team ?? 'default';
  const [delegates, setDelegates] = useState<string[] | null>(null);
  const [savedDelegates, setSavedDelegates] = useState<string[] | null>(null); // last persisted value
  const [mode, setMode] = useState<RelayMode>('permissive');
  const [relayBusy, setRelayBusy] = useState(false);
  const [relayMsg, setRelayMsg] = useState<string>(''); // inline feedback next to Save
  const otherTeams = store.teams.map((t) => t.name).filter((n) => n !== activeTeam);

  // Per-agent instructions (system-prompt addendum) — e.g. make the lead coordinate.
  const coordName = resolveCoordinator(store.agents, store.coordinator) ?? store.agents[0]?.name ?? '';
  const [instrAgent, setInstrAgent] = useState('');
  const [instrText, setInstrText] = useState('');
  const [instrSaved, setInstrSaved] = useState('');
  const [instrBusy, setInstrBusy] = useState(false);
  const [instrMsg, setInstrMsg] = useState('');
  const instrTarget = instrAgent && store.agents.some((a) => a.name === instrAgent) ? instrAgent : coordName;
  async function loadInstr(agent: string) {
    if (!agent) { setInstrText(''); setInstrSaved(''); return; }
    const t = await call<string>('agent:getInstructions', agent).catch(() => '');
    setInstrText(t); setInstrSaved(t);
  }
  useEffect(() => { void loadInstr(instrTarget); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [instrTarget, store.team]);
  async function saveInstr() {
    if (!instrTarget) return;
    setInstrBusy(true); setInstrMsg('saving…');
    try {
      const r = await call<{ ok: boolean; needsRebuild?: boolean }>('agent:setInstructions', instrTarget, instrText);
      setInstrSaved(instrText);
      setInstrMsg(r.needsRebuild ? `saved ✓ — rebuilding ${instrTarget}…` : 'saved ✓');
      // Rebuild so the new instructions land in the agent's system prompt now.
      await call('rebuildAgent', instrTarget).catch(() => {});
      setInstrMsg(instrText.trim() ? `saved ✓ — ${instrTarget} rebuilt; it now follows these instructions` : `cleared ✓ — ${instrTarget} rebuilt`);
    } catch (e) {
      setInstrMsg(`save failed: ${e instanceof Error ? e.message : String(e)}`);
    } finally { setInstrBusy(false); }
  }

  async function loadRelay() {
    try {
      const cfg = await call<{ delegates_to: string[] | null }>('teamConfig', activeTeam);
      setDelegates(cfg.delegates_to);
      setSavedDelegates(cfg.delegates_to);
      setMode(modeOf(cfg.delegates_to));
      setRelayMsg('');
    } catch {
      setDelegates(null);
      setSavedDelegates(null);
      setMode('permissive');
    }
  }
  useEffect(() => {
    void loadRelay();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTeam, store.teams.length]);

  function pickMode(m: RelayMode) {
    setRelayMsg('');
    setMode(m);
    if (m === 'permissive') setDelegates(null);
    else if (m === 'all') setDelegates(['*']);
    else if (m === 'none') setDelegates([]);
    else setDelegates((d) => (d && !d.includes('*') ? d : [])); // keep existing selection
  }
  function toggleTeam(name: string) {
    setRelayMsg('');
    setDelegates((d) => {
      const cur = d && !d.includes('*') ? d : [];
      return cur.includes(name) ? cur.filter((x) => x !== name) : [...cur, name];
    });
  }
  // The payload that would be persisted for the current selection, and whether it differs from what's saved.
  const relayPayload: string[] | null = mode === 'permissive' ? null : delegates ?? [];
  const relayDirty = relayKey(relayPayload) !== relayKey(savedDelegates);
  async function saveRelay() {
    setRelayBusy(true);
    setRelayMsg('saving…');
    try {
      const r = await call<{ delegates_to: string[] | null }>('setTeamDelegates', activeTeam, relayPayload);
      setDelegates(r.delegates_to);
      setSavedDelegates(r.delegates_to);
      setMode(modeOf(r.delegates_to));
      setRelayMsg(`saved ✓ (${describeRelay(r.delegates_to)})`);
    } catch (err) {
      setRelayMsg(`failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setRelayBusy(false);
    }
  }

  // Catalogs for the Onboard modal (runtimes/models, library skills, providers).
  const [modelCatalog, setModelCatalog] = useState<Record<string, string[]>>({});
  const [skillCatalog, setSkillCatalog] = useState<string[]>([]);
  const [providers, setProviders] = useState<ProviderRow[]>([]);
  const [onboardOpen, setOnboardOpen] = useState(false);

  useEffect(() => {
    call<Record<string, string[]>>('runtime:models').then(setModelCatalog).catch(() => setModelCatalog({}));
    call<LibrarySkillEntry[]>('librarySkills').then((s) => setSkillCatalog(s.map((x) => x.name))).catch(() => setSkillCatalog([]));
    call<ProviderRow[]>('providers:list').then(setProviders).catch(() => setProviders([]));
  }, [store.lastUpdated]);


  // Per-agent relay overrides (an individual agent can be granted/denied
  // cross-team delegation independently of its team's policy).
  const [agentEditing, setAgentEditing] = useState<string | null>(null);
  const [agentSel, setAgentSel] = useState<string[]>([]);
  async function applyAgent(id: string, delegates: string[] | null, label: string) {
    setBusy(true);
    setMsg(`${label}…`);
    try {
      await call('setAgentDelegates', id, delegates);
      store.refresh();
      setMsg(`${label} ✓`);
    } catch (err) {
      setMsg(`failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setBusy(false);
    }
  }
  // Reassign a local agent to a different team (manager rebuilds it there).
  async function moveAgentToTeam(agentId: string, agentName: string, toTeam: string) {
    if (!toTeam || toTeam === activeTeam) return;
    if (!window.confirm(`Move agent "${agentName}" from "${activeTeam}" to "${toTeam}"?\n\nIt will be rebuilt under the new team and leave ${activeTeam}.`)) return;
    setBusy(true);
    setMsg(`moving ${agentName} → ${toTeam}…`);
    try {
      const r = await call<{ rebuilt?: boolean; warning?: string }>('agent:move', agentId, toTeam);
      store.refresh();
      setMsg(r?.warning ? `moved ${agentName} → ${toTeam} (⚠ ${r.warning})` : `moved ${agentName} → ${toTeam} ✓`);
    } catch (err) {
      setMsg(`failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setBusy(false);
    }
  }
  // Delete an EMPTY team. The manager refuses `default` and any team with agents.
  async function removeTeam(name: string) {
    if (!window.confirm(`Delete team "${name}"?\n\nIt has no agents. This can't be undone.`)) return;
    setBusy(true);
    setMsg(`deleting team ${name}…`);
    try {
      await call('team:delete', name);
      if (name === store.team) await store.setTeam('default');
      store.refresh();
      setMsg(`team ${name} deleted ✓`);
    } catch (err) {
      setMsg(`failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setBusy(false);
    }
  }
  function pickAgentMode(a: { id: string; name: string; metadata?: unknown }, m: RelayMode) {
    if (m === 'select') {
      const cur = (a.metadata as { delegates_to?: unknown })?.delegates_to;
      setAgentSel(Array.isArray(cur) && !cur.includes('*') ? (cur as string[]) : []);
      setAgentEditing(a.id);
    } else {
      setAgentEditing(null);
      void applyAgent(a.id, m === 'permissive' ? null : m === 'all' ? ['*'] : [], `${a.name} relay`);
    }
  }
  function toggleAgentTeam(name: string) {
    setAgentSel((s) => (s.includes(name) ? s.filter((x) => x !== name) : [...s, name]));
  }
  // Lead hierarchy (#10): the primary coordinator across teams.
  const [hier, setHier] = useState<{ primary: { team: string; agent: string } | null; coordinators: Record<string, string> }>({ primary: null, coordinators: {} });
  async function loadHier() {
    setHier(await call<typeof hier>('coordinator:hierarchy').catch(() => ({ primary: null, coordinators: {} })));
  }
  useEffect(() => { void loadHier(); }, [activeTeam, store.lastUpdated]);
  async function makePrimary() {
    const agent = store.coordinator ?? store.agents.find((a) => /^(lead|manager)$/i.test(a.name))?.name;
    if (!agent) return;
    await call('coordinator:setPrimary', store.team ?? 'default', agent);
    await loadHier();
  }

  return (
    <div className="view modules">
      <header className="view-head">
        <h1>Teams</h1>
        <div className="row-actions">
          <button className="btn" disabled={busy} onClick={() => setImportOpen(true)} title="Paste a team spec and auto-create the agents">
            ↥ Import from spec
          </button>
          <button className="btn primary" disabled={busy} onClick={() => setCreateOpen(true)}>
            + New team
          </button>
        </div>
      </header>
      {importOpen ? (
        <ImportTeamModal
          existingTeams={store.teams.map((t) => t.name)}
          providers={providers}
          modelCatalog={modelCatalog}
          onClose={() => setImportOpen(false)}
          onBusy={setBusy}
          onMessage={setMsg}
          onCreated={async (name) => { await store.setTeam(name); store.refresh(); }}
        />
      ) : null}
      {createOpen ? (
        <CreateTeamModal
          existingTeams={store.teams.map((t) => t.name)}
          onClose={() => setCreateOpen(false)}
          onBusy={setBusy}
          onMessage={setMsg}
          onCreated={async (name) => {
            await store.setTeam(name);
            store.refresh();
          }}
        />
      ) : null}
      <section className="card">
        <table className="grid">
          <thead>
            <tr>
              <th>Team</th>
              <th>Agents</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {store.teams.map((t) => (
              <tr key={t.id} className={t.name === store.team ? 'sel' : ''}>
                <td className="b">{t.name === store.team ? '● ' : ''}{t.name}</td>
                <td className="muted">{t.agentCount}</td>
                <td>
                  {t.name !== store.team ? (
                    <button className="btn" disabled={busy} onClick={() => void store.setTeam(t.name)}>
                      Switch
                    </button>
                  ) : (
                    <span className="muted">active</span>
                  )}
                  {t.name !== 'default' && Number(t.agentCount) === 0 ? (
                    <button className="btn" disabled={busy} style={{ marginLeft: 6, color: 'var(--danger, #e5534b)' }} title={`Delete the empty "${t.name}" team`} onClick={() => void removeTeam(t.name)}>
                      Delete
                    </button>
                  ) : null}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <section className="card">
        <div className="row-actions" style={{ justifyContent: 'space-between', alignItems: 'center' }}>
          <div>
            <h3 style={{ margin: 0 }}>Add agents</h3>
            <p className="muted small" style={{ margin: '4px 0 0' }}>
              Create one or more agents in a single pass — pick a team, set each agent's runtime &amp; model, add skills/MCP/heartbeat, and onboard them together.
            </p>
          </div>
          <button className="btn primary" onClick={() => setOnboardOpen(true)}>
            Onboard agents
          </button>
        </div>
      </section>

      {onboardOpen ? (
        <OnboardWizard
          team={activeTeam}
          existingTeams={store.teams.map((t) => t.name)}
          providers={providers}
          modelCatalog={modelCatalog}
          skillCatalog={skillCatalog}
          onClose={() => setOnboardOpen(false)}
          onDone={(createdTeam) => { if (createdTeam) void store.setTeam(createdTeam); store.refresh(); }}
        />
      ) : null}

      <section className="card">
        <h3>Cross-team relay — {activeTeam}</h3>
        <p className="muted small" style={{ marginTop: -4 }}>
          Which teams <b>{activeTeam}</b>'s agents may delegate to (relay work via <span className="mono">/ask &lt;team&gt;/&lt;agent&gt;</span>).
          Unset = permissive (any team).
        </p>
        <div className="relay-modes">
          {([
            ['permissive', 'Any team (default)'],
            ['all', 'All teams (*)'],
            ['select', 'Only selected teams'],
            ['none', 'Blocked (none)'],
          ] as [RelayMode, string][]).map(([m, label]) => (
            <label key={m} className={`relay-mode${mode === m ? ' active' : ''}`}>
              <input type="radio" name="relay-mode" checked={mode === m} onChange={() => pickMode(m)} /> {label}
            </label>
          ))}
        </div>
        {mode === 'select' ? (
          <div className="chips" style={{ marginTop: 10 }}>
            {otherTeams.length === 0 ? (
              <span className="muted small">No other teams to relay to yet.</span>
            ) : (
              otherTeams.map((n) => {
                const on = (delegates ?? []).includes(n);
                return (
                  <button key={n} className={`chip${on ? ' on' : ''}`} onClick={() => toggleTeam(n)}>
                    {on ? '✓ ' : ''}{n}
                  </button>
                );
              })
            )}
          </div>
        ) : null}
        <div className="row-actions" style={{ marginTop: 12 }}>
          <span className="muted small grow">
            saved: <span className="mono">{describeRelay(savedDelegates)}</span>
            {relayDirty ? <span className="warn-text" style={{ marginLeft: 8 }}>● unsaved changes</span> : null}
          </span>
          {relayMsg ? (
            <span className={`small${relayMsg.startsWith('failed') ? ' status-error' : ' ok-text'}`} style={{ marginRight: 10 }}>
              {relayMsg}
            </span>
          ) : null}
          <button className="btn primary" disabled={relayBusy || !relayDirty} onClick={() => void saveRelay()}>
            {relayBusy ? 'Saving…' : 'Save relay policy'}
          </button>
        </div>

        <h3 style={{ marginTop: 18 }}>Per-agent overrides</h3>
        <p className="muted small" style={{ marginTop: -4 }}>
          Override the team policy for an individual agent — e.g. let one agent relay to other teams even when the team is restricted (or block a single agent). Applies immediately.
        </p>
        {store.agents.length === 0 ? (
          <p className="muted small">No agents in {activeTeam}.</p>
        ) : (
          agentsLeadFirst(store.agents, store.coordinator).map((a) => {
            const pol = (a.metadata as { delegates_to?: unknown })?.delegates_to;
            const m = agentEditing === a.id ? 'select' : modeOf(Array.isArray(pol) ? (pol as string[]) : null);
            const label =
              m === 'permissive' ? 'inherits team' : m === 'all' ? 'any team' : m === 'none' ? 'blocked' : Array.isArray(pol) ? pol.join(', ') : '';
            return (
              <div key={a.id} className="kv" style={{ gridTemplateColumns: '130px 1fr', gap: '4px 12px', marginBottom: 10 }}>
                <span className="b">{a.name}</span>
                <span>
                  <select className="cell-select" disabled={busy} value={m} onChange={(e) => pickAgentMode(a, e.target.value as RelayMode)}>
                    <option value="permissive">Inherit team</option>
                    <option value="all">Any team (*)</option>
                    <option value="select">Selected teams…</option>
                    <option value="none">Blocked (none)</option>
                  </select>
                  <span className="muted small" style={{ marginLeft: 8 }}>{label}</span>
                  {agentEditing === a.id ? (
                    <div className="chips" style={{ marginTop: 6 }}>
                      {otherTeams.length === 0 ? (
                        <span className="muted small">No other teams.</span>
                      ) : (
                        otherTeams.map((n) => {
                          const on = agentSel.includes(n);
                          return (
                            <button key={n} className={`chip${on ? ' on' : ''}`} onClick={() => toggleAgentTeam(n)}>
                              {on ? '✓ ' : ''}{n}
                            </button>
                          );
                        })
                      )}
                      <button className="btn" disabled={busy} onClick={() => { void applyAgent(a.id, agentSel, `${a.name} relay`); setAgentEditing(null); }}>
                        Save
                      </button>
                      <button className="btn" onClick={() => setAgentEditing(null)}>Cancel</button>
                    </div>
                  ) : null}
                </span>
                <span>team</span>
                <span>
                  <select
                    className="cell-select"
                    disabled={busy || otherTeams.length === 0}
                    value=""
                    title={otherTeams.length === 0 ? 'No other teams to move to' : `Reassign ${a.name} to another team (rebuilds it there)`}
                    onChange={(e) => { const to = e.target.value; e.currentTarget.value = ''; void moveAgentToTeam(a.id, a.name, to); }}
                  >
                    <option value="">{otherTeams.length === 0 ? 'no other teams' : 'reassign to…'}</option>
                    {otherTeams.map((n) => <option key={n} value={n}>{n}</option>)}
                  </select>
                </span>
              </div>
            );
          })
        )}
      </section>

      <section className="card">
        <h3>Agent instructions — coordination &amp; behavior</h3>
        <p className="muted small" style={{ marginTop: -4 }}>
          A persistent directive added to an agent’s system prompt. Use <b>Coordinator preset</b> on your <b>lead</b> so it delegates implementation/research to its teammates (coder, researcher) instead of doing everything itself, then synthesizes the results. Survives rebuilds; takes effect after the rebuild this triggers.
        </p>
        <div className="row-actions" style={{ gap: 8, alignItems: 'center', marginBottom: 6 }}>
          <span className="muted small">agent</span>
          <select className="cell-select" value={instrTarget} disabled={instrBusy} onChange={(e) => setInstrAgent(e.target.value)}>
            {store.agents.map((a) => <option key={a.id} value={a.name}>{a.name}</option>)}
          </select>
          <button className="btn small" disabled={instrBusy} onClick={() => setInstrText(COORDINATOR_PRESET)}>Coordinator preset</button>
          {instrText.trim() ? <button className="btn small" disabled={instrBusy} onClick={() => setInstrText('')}>Clear</button> : null}
          <span className="grow" />
          {instrMsg ? <span className={`small ${/failed/.test(instrMsg) ? 'status-error' : 'ok-text'}`}>{instrMsg}</span> : null}
          <button className="btn primary small" disabled={instrBusy || instrText === instrSaved} onClick={() => void saveInstr()}>{instrBusy ? '…' : 'Save & rebuild'}</button>
        </div>
        <textarea
          style={{ width: '100%', minHeight: 120, fontFamily: 'var(--mono, ui-monospace, monospace)', fontSize: 12 }}
          placeholder={`Custom instructions for ${instrTarget || 'this agent'} — or click “Coordinator preset”. Leave empty for none.`}
          value={instrText}
          disabled={instrBusy}
          onChange={(e) => setInstrText(e.target.value)}
        />
      </section>

      <section className="card">
        <h3>Lead hierarchy</h3>
        <p className="muted small" style={{ marginTop: -4 }}>
          The primary coordinator across teams — it delegates to each team's lead, which delegates to its workers.
        </p>
        <div className="hierarchy">
          {hier.primary ? (
            <>
              <div className="hier-node primary">
                ⭑ {hier.primary.team}/{hier.primary.agent} <span className="muted">— primary lead</span>
              </div>
              {Object.entries(hier.coordinators)
                .filter(([t, ag]) => !(t === hier.primary!.team && ag === hier.primary!.agent))
                .map(([t, ag]) => (
                  <div className="hier-node child" key={t}>
                    └ {t}/{ag} <span className="muted">— reports to primary</span>
                  </div>
                ))}
            </>
          ) : (
            <div className="muted">
              No primary lead set. With several team leads, designate one as the top of the hierarchy — it delegates
              across teams to the per-team coordinators (via <code>/ask &lt;team&gt;/&lt;agent&gt;</code>).
            </div>
          )}
        </div>
        <div className="row-actions" style={{ marginTop: 10 }}>
          <button className="btn" disabled={busy} onClick={() => void makePrimary()}>
            Make “{activeTeam}” coordinator the primary lead
          </button>
        </div>
      </section>

      {msg ? <p className="muted">{msg}</p> : null}
    </div>
  );
}

function ImportTeamModal({
  existingTeams,
  providers,
  modelCatalog,
  onClose,
  onBusy,
  onMessage,
  onCreated,
}: {
  existingTeams: string[];
  providers: ProviderRow[];
  modelCatalog: Record<string, string[]>;
  onClose: () => void;
  onBusy: (b: boolean) => void;
  onMessage: (m: string) => void;
  onCreated: (name: string) => Promise<void>;
}) {
  const [spec, setSpec] = useState('');
  const [team, setTeam] = useState('');
  const [agents, setAgents] = useState<{ name: string; role: string; description: string }[]>([]);
  // Once the user hand-edits/removes/AI-parses the agent list, the live spec parse
  // stops overwriting it — so manual curation isn't silently discarded mid-edit.
  const [agentsDirty, setAgentsDirty] = useState(false);
  const [runtime, setRuntime] = useState('claude-code-cli');
  const [model, setModel] = useState('');
  const [running, setRunning] = useState(false);
  const [aiParsing, setAiParsing] = useState(false);
  const [error, setError] = useState('');
  const runtimes = useMemo(() => offerableRuntimes(providers), [providers]);
  const models = modelCatalog[runtime] ?? [];
  const parsed = useMemo(() => parseTeamSpec(spec), [spec]);
  const cleanTeam = cleanTeamName(team);
  const collides = Boolean(cleanTeam && existingTeams.includes(cleanTeam));
  // Pre-flight the manager's reserved-word list so a collision is caught before
  // any team/agent is created, not per-agent at spawn time.
  const reservedAgents = useMemo(() => agents.filter((a) => isReservedName(a.name)).map((a) => a.name), [agents]);
  const reservedTeam = isReservedName(cleanTeam);
  // Spec produced agents but no team name — the "pasted a changelog/instructions"
  // signature; nudge the user to review before this becomes a one-click spawn.
  const noSpecTeam = spec.trim().length > 0 && !parsed.team;
  const locked = running || aiParsing;
  const canCreate =
    Boolean(cleanTeam) && agents.length > 0 && !locked && reservedAgents.length === 0 && !reservedTeam;

  // Live deterministic parse as the user pastes/edits the spec; prefill the team
  // name once (don't clobber a manual edit), and don't overwrite a hand-curated
  // agent list. Clearing the spec resets so a fresh paste re-parses cleanly.
  useEffect(() => {
    if (!spec.trim()) { setAgents([]); setAgentsDirty(false); return; }
    if (!agentsDirty) setAgents(parsed.agents);
    if (parsed.team) setTeam((prev) => prev || parsed.team || '');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [spec]);

  async function aiParse() {
    if (!spec.trim()) return;
    setAiParsing(true); setError('');
    onMessage('asking an agent to parse the spec…');
    try {
      const r = await call<{ team: string | null; agents: { name: string; role: string; description: string }[] }>('team:parseSpecAI', spec);
      if (r?.agents?.length) { setAgents(r.agents); setAgentsDirty(true); }
      if (r?.team) setTeam((prev) => prev || r.team || '');
      onMessage(`AI parsed ${r?.agents?.length ?? 0} agent(s)`);
    } catch (e) {
      setError(`AI parse failed: ${e instanceof Error ? e.message : String(e)} — keeping the deterministic parse.`);
    } finally { setAiParsing(false); }
  }

  function updateAgent(i: number, field: 'name' | 'role' | 'description', val: string) {
    setAgentsDirty(true);
    setAgents((prev) => prev.map((a, j) => (j === i ? { ...a, [field]: val } : a)));
  }
  function removeAgent(i: number) { setAgentsDirty(true); setAgents((prev) => prev.filter((_, j) => j !== i)); }

  async function create() {
    if (!cleanTeam) { setError('Team name is required.'); return; }
    if (!agents.length) { setError('No agents to create.'); return; }
    if (reservedTeam) { setError(`“${cleanTeam}” is a reserved word — choose another team name.`); return; }
    if (reservedAgents.length) { setError(`Reserved agent name(s): ${reservedAgents.join(', ')} — rename before creating.`); return; }
    setRunning(true); onBusy(true); setError('');
    onMessage(`importing ${agents.length} agent(s) into ${cleanTeam}…`);
    try {
      const payload = agents.map((a) => ({ name: a.name, role: a.role || undefined, description: a.description || undefined }));
      const r = await call<{ created: string[]; failed: { name: string; error: string }[] }>('team:import', cleanTeam, payload, { runtime, model: model || undefined });
      const c = r?.created?.length ?? 0;
      const f = r?.failed ?? [];
      onMessage(f.length ? `imported ${c}/${agents.length} into ${cleanTeam}; ${f.length} failed` : `imported ${c} agent(s) into ${cleanTeam} ✓`);
      // Only switch the app to the team if something actually landed there (or the
      // team already existed) — don't pin the UI to a phantom team when every spawn failed.
      if (c > 0 || collides) await onCreated(cleanTeam);
      if (!f.length) { onClose(); return; }
      // Partial failure: keep only the agents that still need creating, so re-clicking
      // Create retries just the failures (the succeeded ones already exist → would 409).
      const failedNames = new Set(f.map((x) => x.name));
      setAgentsDirty(true);
      setAgents((prev) => prev.filter((a) => failedNames.has(a.name)));
      setError(`${f.length} failed: ${f.map((x) => `${x.name} (${x.error})`).join('; ')}`);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setError(msg); onMessage(`failed: ${msg}`);
    } finally { setRunning(false); onBusy(false); }
  }

  return (
    <div className="modal-overlay" onMouseDown={() => (running ? undefined : onClose())}>
      <div className="modal onboard-modal create-team-modal" onMouseDown={(e) => e.stopPropagation()}>
        <div className="modal-title">Import team from spec</div>
        <div className="create-team-layout">
          <div>
            <div className="muted small" style={{ marginBottom: 6 }}>paste a team spec</div>
            <textarea
              autoFocus
              style={{ width: '100%', minHeight: 230, fontFamily: 'var(--mono, monospace)', fontSize: 12 }}
              placeholder={'e.g.\n**Recommended Agent Creations For `brain`**\n1. **security-router**\n   Role: first-pass classifier…'}
              value={spec}
              disabled={locked}
              onChange={(e) => { setSpec(e.target.value); setError(''); }}
            />
            <div className="row-actions" style={{ marginTop: 6, justifyContent: 'space-between' }}>
              <button className="btn small" disabled={!spec.trim() || running || aiParsing} onClick={() => void aiParse()}>
                {aiParsing ? 'Asking AI…' : '✦ Ask AI to parse'}
              </button>
              <span className="muted small">{agents.length} agent{agents.length === 1 ? '' : 's'} detected</span>
            </div>
          </div>
          <div>
            <label className="create-field">
              <span>team name</span>
              <input placeholder="lowercase, e.g. brain" value={team} disabled={locked} onChange={(e) => { setTeam(e.target.value); setError(''); }} onBlur={() => setTeam(cleanTeamName(team))} />
            </label>
            {team && team !== cleanTeam ? <p className="muted small">Will create as <span className="mono">{cleanTeam}</span>.</p> : null}
            {reservedTeam ? <p className="status-error small"><span className="mono">{cleanTeam}</span> is a reserved word — choose another team name.</p> : null}
            {collides ? <p className="warn-text small">Team <span className="mono">{cleanTeam}</span> exists — these agents will be added to it.</p> : null}
            {noSpecTeam ? <p className="warn-text small">No team name detected in the spec — double-check the agents below before creating.</p> : null}
            <div className="kv" style={{ gridTemplateColumns: '90px 1fr', gap: '8px 10px', marginTop: 8 }}>
              <span>runtime</span>
              <select className="cell-select" disabled={locked} value={runtime} onChange={(e) => { setRuntime(e.target.value); setModel(''); }}>
                {runtimes.map((r) => <option key={r} value={r}>{runtimeLabel(r)}</option>)}
              </select>
              <span>model</span>
              <select className="cell-select" disabled={locked} value={model} onChange={(e) => setModel(e.target.value)}>
                <option value="">default</option>
                {models.map((m) => <option key={m} value={m}>{m}</option>)}
              </select>
            </div>
            <div className="muted small" style={{ margin: '10px 0 4px' }}>agents to create (editable) — role is a one-line summary, description becomes the agent’s instructions</div>
            <div style={{ maxHeight: 280, overflowY: 'auto' }}>
              {agents.length === 0 ? (
                <p className="muted small">Paste a spec above — or click “Ask AI to parse” for messy formats.</p>
              ) : agents.map((a, i) => (
                <div key={i} style={{ marginBottom: 8, padding: '6px 6px 8px', border: '1px solid var(--border, #2a2a2a)', borderRadius: 6 }}>
                  <div className="kv" style={{ gridTemplateColumns: '150px 1fr 24px', gap: '4px 6px', alignItems: 'center' }}>
                    <input className="mono" style={{ fontSize: 12, ...(isReservedName(a.name) ? { borderColor: 'var(--danger, #e5484d)' } : {}) }} value={a.name} disabled={locked} title={isReservedName(a.name) ? 'reserved word — rename' : undefined} onChange={(e) => updateAgent(i, 'name', e.target.value)} onBlur={(e) => updateAgent(i, 'name', slugName(e.target.value))} />
                    <input style={{ fontSize: 12 }} value={a.role} disabled={locked} maxLength={200} placeholder="role (one line)" onChange={(e) => updateAgent(i, 'role', e.target.value)} />
                    <button className="uv-x" title="Remove" disabled={locked} onClick={() => removeAgent(i)}>✕</button>
                  </div>
                  <textarea
                    style={{ width: '100%', marginTop: 4, fontSize: 11, minHeight: 46, fontFamily: 'inherit', resize: 'vertical' }}
                    value={a.description}
                    disabled={locked}
                    maxLength={2000}
                    placeholder="description / persona — becomes this agent’s operating instructions"
                    onChange={(e) => updateAgent(i, 'description', e.target.value)}
                  />
                </div>
              ))}
            </div>
            {reservedAgents.length ? <p className="status-error small">Reserved name{reservedAgents.length === 1 ? '' : 's'}: <span className="mono">{reservedAgents.join(', ')}</span> — rename before creating.</p> : null}
            {error ? <p className="status-error small">{error}</p> : null}
          </div>
        </div>
        <div className="row-actions" style={{ marginTop: 14 }}>
          <button className="btn" disabled={running} onClick={onClose}>Cancel</button>
          <button className="btn primary" disabled={!canCreate} onClick={() => void create()}>
            {running ? 'Importing…' : `Create team + ${agents.length} agent${agents.length === 1 ? '' : 's'}`}
          </button>
        </div>
      </div>
    </div>
  );
}

function CreateTeamModal({
  existingTeams,
  onClose,
  onBusy,
  onMessage,
  onCreated,
}: {
  existingTeams: string[];
  onClose: () => void;
  onBusy: (busy: boolean) => void;
  onMessage: (msg: string) => void;
  onCreated: (name: string) => Promise<void>;
}) {
  const [templates, setTemplates] = useState<TeamTemplate[]>([]);
  const [configs, setConfigs] = useState<ConfigEntry[]>([]);
  const [source, setSource] = useState<TeamSource>({ kind: 'default', name: 'default' });
  const [name, setName] = useState('');
  const [loadingSources, setLoadingSources] = useState(true);
  const [preflight, setPreflight] = useState<DeployPreflight | null>(null);
  const [preflightStatus, setPreflightStatus] = useState('');
  const [running, setRunning] = useState(false);
  const [error, setError] = useState('');

  const clean = cleanTeamName(name);
  const collides = Boolean(clean && existingTeams.includes(clean));
  const canCreate = Boolean(clean) && !running;

  useEffect(() => {
    let alive = true;
    setLoadingSources(true);
    Promise.all([
      call<TeamTemplate[]>('libraryTeams').catch(() => [] as TeamTemplate[]),
      call<ConfigEntry[]>('configs').catch(() => [] as ConfigEntry[]),
    ]).then(([teamTemplates, serverConfigs]) => {
      if (!alive) return;
      setTemplates(teamTemplates);
      setConfigs(serverConfigs.filter((cfg) => cfg.name !== 'default'));
    }).finally(() => {
      if (alive) setLoadingSources(false);
    });
    return () => {
      alive = false;
    };
  }, []);

  useEffect(() => {
    if (!clean) {
      setPreflight(null);
      setPreflightStatus('');
      return;
    }
    let alive = true;
    const timer = setTimeout(() => {
      setPreflightStatus('checking preflight...');
      setPreflight(null);
      call<DeployPreflight | undefined>('team:preflight', clean)
        .then((pf) => {
          if (!alive) return;
          setPreflight(pf ?? null);
          setPreflightStatus(pf ? '' : 'preflight unavailable');
        })
        .catch(() => {
          if (!alive) return;
          setPreflight(null);
          setPreflightStatus('preflight unavailable');
        });
    }, 350);
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [clean, source.kind, source.name]);

  function pickSource(next: TeamSource) {
    setSource(next);
    setError('');
    if (next.kind === 'config') setName(next.name);
  }

  async function create() {
    if (!clean) {
      setError('Team name is required.');
      return;
    }
    setRunning(true);
    onBusy(true);
    setError('');
    onMessage(source.kind === 'template' ? `installing ${source.name} as ${clean}...` : `creating ${clean}...`);
    try {
      if (source.kind === 'template') {
        await call('team:install', source.name, clean);
        onMessage(`deploying ${clean} from ${source.name}...`);
      } else {
        onMessage(source.kind === 'config' ? `deploying ${clean} from server config...` : `deploying ${clean} from default template...`);
      }
      await call('deployTeam', clean);
      await onCreated(clean);
      onMessage(`created ${clean} ✓`);
      onClose();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setError(msg);
      onMessage(`failed: ${msg}`);
    } finally {
      setRunning(false);
      onBusy(false);
    }
  }

  const selectedTemplate = source.kind === 'template' ? templates.find((t) => t.name === source.name) : undefined;
  const selectedConfig = source.kind === 'config' ? configs.find((c) => c.name === source.name) : undefined;

  return (
    <div className="modal-overlay" onMouseDown={() => (running ? undefined : onClose())}>
      <div className="modal onboard-modal create-team-modal" onMouseDown={(e) => e.stopPropagation()}>
        <div className="modal-title">Create team</div>
        <div className="create-team-layout">
          <div>
            <div className="muted small" style={{ marginBottom: 6 }}>source</div>
            <div className="source-list">
              <button className={`source-option${source.kind === 'default' ? ' active' : ''}`} disabled={running} onClick={() => pickSource({ kind: 'default', name: 'default' })}>
                <b>Default template</b>
                <span>Fresh team from the manager default config.</span>
              </button>
              {templates.map((t) => (
                <button key={t.name} className={`source-option${source.kind === 'template' && source.name === t.name ? ' active' : ''}`} disabled={running} onClick={() => pickSource({ kind: 'template', name: t.name })}>
                  <b>{t.name}</b>
                  <span>{describeTemplate(t)}</span>
                </button>
              ))}
              {configs.map((c) => (
                <button key={c.name} className={`source-option${source.kind === 'config' && source.name === c.name ? ' active' : ''}`} disabled={running} onClick={() => pickSource({ kind: 'config', name: c.name })}>
                  <b>{c.name}</b>
                  <span>{describeConfig(c)}</span>
                </button>
              ))}
              {!loadingSources && templates.length === 0 ? <p className="muted small">No library team templates available; default creation is available.</p> : null}
              {loadingSources ? <p className="muted small">Loading templates...</p> : null}
            </div>
          </div>
          <div>
            <label className="create-field">
              <span>team name</span>
              <input
                autoFocus
                placeholder="lowercase, e.g. research"
                value={name}
                disabled={running}
                onChange={(e) => {
                  setName(e.target.value);
                  setError('');
                }}
                onBlur={() => setName(cleanTeamName(name))}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && canCreate) void create();
                  else if (e.key === 'Escape' && !running) onClose();
                }}
              />
            </label>
            {name && name !== clean ? <p className="muted small">Will create as <span className="mono">{clean}</span>.</p> : null}
            {collides ? <p className="warn-text small">A team named <span className="mono">{clean}</span> already exists; deploy may recreate or overwrite it.</p> : null}
            {source.kind === 'template' && selectedTemplate ? <p className="muted small">Template: {describeTemplate(selectedTemplate)}</p> : null}
            {source.kind === 'config' && selectedConfig ? <p className="muted small">Server config: {describeConfig(selectedConfig)}</p> : null}
            <div className="preflight-box">
              <div className="row-actions" style={{ justifyContent: 'space-between', marginBottom: 8 }}>
                <b>Preflight</b>
                {preflightStatus ? <span className="muted small">{preflightStatus}</span> : null}
              </div>
              {preflight?.agents?.length ? (
                <div className="preflight-agents">
                  {preflight.agents.map((agent) => (
                    <div key={agent.name} className="preflight-agent">
                      <span className="b">{agent.name}</span>
                      <span className="muted small">{agent.runtime || 'default runtime'}{agent.model ? ` · ${agent.model}` : ''}</span>
                    </div>
                  ))}
                </div>
              ) : (
                <p className="muted small">
                  {clean ? 'Preview will appear when the manager supports deploy dry-run.' : 'Enter a team name to preview created agents.'}
                </p>
              )}
              {preflight?.configPath ? <p className="muted small mono">{preflight.configPath}</p> : null}
            </div>
            {error ? <p className="status-error small">{error}</p> : null}
          </div>
        </div>
        <div className="row-actions" style={{ marginTop: 14 }}>
          <button className="btn" disabled={running} onClick={onClose}>Cancel</button>
          <button className="btn primary" disabled={!canCreate} onClick={() => void create()}>
            {running ? 'Creating...' : 'Create team'}
          </button>
        </div>
      </div>
    </div>
  );
}

function OnboardWizard({
  team,
  existingTeams,
  providers,
  modelCatalog,
  skillCatalog,
  onClose,
  onDone,
}: {
  team: string;
  existingTeams: string[];
  providers: ProviderRow[];
  modelCatalog: Record<string, string[]>;
  skillCatalog: string[];
  onClose: () => void;
  onDone: (createdTeam?: string) => void;
}) {
  const runtimes = useMemo(() => offerableRuntimes(providers), [providers]);
  const initialRuntime = runtimes[0] ?? 'claude-code-cli';
  type Row = { name: string; runtime: string; model: string; role: string };
  const blankRow = (): Row => ({ name: '', runtime: initialRuntime, model: '', role: '' });

  // Which team to create into — an existing one, or a brand-new team.
  const teamOptions = useMemo(() => {
    const set = [...existingTeams];
    if (team && !set.includes(team)) set.unshift(team);
    return set;
  }, [existingTeams, team]);
  const [teamSel, setTeamSel] = useState(team || teamOptions[0] || 'default');
  const [newTeam, setNewTeam] = useState('');
  const usingNewTeam = teamSel === '__new__';
  const targetTeam = usingNewTeam ? cleanTeamName(newTeam) : teamSel;

  // One or more agents, each with its own runtime + model.
  const [rows, setRows] = useState<Row[]>([blankRow()]);
  // Options applied to every agent in the batch.
  const [skills, setSkills] = useState<string[]>([]);
  const [mcp, setMcp] = useState('');
  const [wallet, setWallet] = useState(false);
  const [heartbeat, setHeartbeat] = useState(false);
  const [hbInterval, setHbInterval] = useState(3600);
  const [probeAfter, setProbeAfter] = useState(true);
  const [results, setResults] = useState<Array<{ name: string; team: string; result?: OnboardResult; error?: string; running?: boolean }>>([]);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState('');

  const mcpChoices = MCP_CATALOG.filter((entry) => !(entry.inputs ?? []).some((input) => input.required && !input.default));
  const named = rows.map((r) => ({ ...r, slug: slugName(r.name) })).filter((r) => r.slug);
  const reserved = [...new Set(named.filter((r) => isReservedName(r.slug)).map((r) => r.slug))];
  const dupes = [...new Set(named.map((r) => r.slug).filter((s, i, a) => a.indexOf(s) !== i))];
  const canRun = !running && Boolean(targetTeam) && named.length > 0 && reserved.length === 0 && dupes.length === 0;

  function updateRow(i: number, patch: Partial<Row>) {
    setRows((rs) => rs.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  }
  function addRow() { setRows((rs) => [...rs, blankRow()]); }
  function removeRow(i: number) { setRows((rs) => (rs.length <= 1 ? rs : rs.filter((_, j) => j !== i))); }
  function toggleSkill(name: string) {
    setSkills((s) => (s.includes(name) ? s.filter((x) => x !== name) : [...s, name]));
  }

  function planFor(r: Row): OnboardPlan {
    return {
      name: slugName(r.name),
      team: targetTeam,
      runtime: r.runtime || undefined,
      model: r.model || undefined,
      role: r.role.trim() || undefined,
      skills,
      wallet,
      heartbeatSeconds: heartbeat ? hbInterval : undefined,
      mcpServers: mcpFromChoice(mcp),
      probeAfter,
    };
  }

  async function run() {
    if (!targetTeam) { setError('Choose or name a team.'); return; }
    if (reserved.length) { setError(`Reserved agent name(s): ${reserved.join(', ')} — rename.`); return; }
    if (dupes.length) { setError(`Duplicate agent name(s): ${dupes.join(', ')}.`); return; }
    const batch = named.map((r) => ({ name: r.slug, runtime: r.runtime, model: r.model, role: r.role }));
    if (!batch.length) { setError('Add at least one named agent.'); return; }
    setRunning(true);
    setError('');
    setResults(batch.map((b) => ({ name: b.name, team: targetTeam })));
    let anyOk = false;
    // Sequential — the manager serializes local-model spawns anyway, and it keeps
    // the per-agent status readable as each one lands.
    for (let i = 0; i < batch.length; i++) {
      setResults((rs) => rs.map((x, j) => (j === i ? { ...x, running: true } : x)));
      try {
        const res = await call<OnboardResult>('onboard:run', planFor(batch[i]));
        if (res.ok) anyOk = true;
        setResults((rs) => rs.map((x, j) => (j === i ? { ...x, running: false, result: res } : x)));
      } catch (err) {
        setResults((rs) => rs.map((x, j) => (j === i ? { ...x, running: false, error: err instanceof Error ? err.message : String(err) } : x)));
      }
    }
    setRunning(false);
    if (anyOk) onDone(targetTeam);
  }

  return (
    <div className="modal-overlay" onMouseDown={() => (running ? undefined : onClose())}>
      <div className="modal onboard-modal" onMouseDown={(e) => e.stopPropagation()}>
        <div className="modal-title">Onboard agents</div>

        <div className="kv" style={{ gridTemplateColumns: '110px 1fr', gap: '8px 12px', alignItems: 'center' }}>
          <span>team</span>
          <span>
            <select className="cell-select" disabled={running} value={teamSel} onChange={(e) => setTeamSel(e.target.value)}>
              {teamOptions.map((t) => <option key={t} value={t}>{t}</option>)}
              <option value="__new__">＋ new team…</option>
            </select>
            {usingNewTeam ? (
              <input
                style={{ marginLeft: 8, width: 200 }}
                placeholder="new team name"
                value={newTeam}
                disabled={running}
                onChange={(e) => setNewTeam(e.target.value)}
                onBlur={() => setNewTeam(cleanTeamName(newTeam))}
              />
            ) : null}
            {usingNewTeam && newTeam && targetTeam !== newTeam ? (
              <span className="muted small" style={{ marginLeft: 8 }}>→ <span className="mono">{targetTeam}</span></span>
            ) : null}
          </span>
        </div>

        <div className="row-actions" style={{ justifyContent: 'space-between', alignItems: 'center', margin: '14px 0 6px' }}>
          <span className="muted small">agents — each can use its own runtime &amp; model</span>
          <button className="btn small" disabled={running} onClick={addRow}>＋ add agent</button>
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          {rows.map((r, i) => {
            const rowReserved = isReservedName(slugName(r.name));
            return (
              <div key={i} className="kv" style={{ gridTemplateColumns: '1.1fr 1fr 1fr 1.1fr 24px', gap: 6, alignItems: 'center' }}>
                <input
                  className="mono"
                  style={{ fontSize: 12, ...(rowReserved ? { borderColor: 'var(--danger, #e5484d)' } : {}) }}
                  placeholder="name (lowercase)"
                  value={r.name}
                  disabled={running}
                  title={rowReserved ? 'reserved word — rename' : undefined}
                  onChange={(e) => updateRow(i, { name: e.target.value })}
                  onBlur={(e) => updateRow(i, { name: slugName(e.target.value) })}
                />
                <select className="cell-select" style={{ fontSize: 12 }} disabled={running} value={r.runtime} onChange={(e) => updateRow(i, { runtime: e.target.value, model: '' })}>
                  {runtimes.map((rt) => <option key={rt} value={rt}>{runtimeLabel(rt)}</option>)}
                </select>
                <select className="cell-select" style={{ fontSize: 12 }} disabled={running} value={r.model} onChange={(e) => updateRow(i, { model: e.target.value })}>
                  <option value="">(default model)</option>
                  {(modelCatalog[r.runtime] ?? []).map((m) => <option key={m} value={m}>{m}</option>)}
                </select>
                <input style={{ fontSize: 12 }} placeholder="role (optional)" value={r.role} disabled={running} onChange={(e) => updateRow(i, { role: e.target.value })} />
                <button className="uv-x" title="Remove" disabled={running || rows.length <= 1} onClick={() => removeRow(i)}>✕</button>
              </div>
            );
          })}
        </div>

        <div className="muted small" style={{ margin: '14px 0 4px' }}>applied to every agent</div>
        <div className="kv" style={{ gridTemplateColumns: '110px 1fr', gap: '8px 12px', alignItems: 'start' }}>
          <span>skills</span>
          <span className="chips">
            {skillCatalog.length === 0 ? <span className="muted small">no library skills</span> :
              skillCatalog.map((s) => (
                <button key={s} className={`chip${skills.includes(s) ? ' on' : ''}`} disabled={running} onClick={() => toggleSkill(s)}>
                  {skills.includes(s) ? '✓ ' : ''}{s}
                </button>
              ))}
          </span>
          <span>MCP</span>
          <select className="cell-select" disabled={running} value={mcp} onChange={(e) => setMcp(e.target.value)} style={{ maxWidth: 280 }}>
            <option value="">none</option>
            {mcpChoices.map((entry) => <option key={entry.id} value={entry.id}>{entry.name}</option>)}
          </select>
          <span>heartbeat</span>
          <span>
            <input type="checkbox" checked={heartbeat} disabled={running} onChange={(e) => setHeartbeat(e.target.checked)} />{' '}
            <select className="cell-select" disabled={running || !heartbeat} value={hbInterval} onChange={(e) => setHbInterval(Number(e.target.value))}>
              {HB_INTERVALS.map((iv) => <option key={iv.s} value={iv.s}>{iv.label}</option>)}
            </select>
            <span className="muted small" style={{ marginLeft: 12 }}>
              <input type="checkbox" checked={wallet} disabled={running} onChange={(e) => setWallet(e.target.checked)} /> provision OWS wallet
            </span>
            <span className="muted small" style={{ marginLeft: 12 }}>
              <input type="checkbox" checked={probeAfter} disabled={running} onChange={(e) => setProbeAfter(e.target.checked)} /> probe after
            </span>
          </span>
        </div>

        {reserved.length ? <p className="status-error small">Reserved name(s): <span className="mono">{reserved.join(', ')}</span> — rename.</p> : null}
        {dupes.length ? <p className="status-error small">Duplicate name(s): <span className="mono">{dupes.join(', ')}</span>.</p> : null}
        {error ? <p className="status-error small">{error}</p> : null}
        {results.length ? (
          <div className="onboard-checklist" style={{ marginTop: 12 }}>
            {results.map((r) => {
              const failed = Boolean(r.error) || Boolean(r.result?.steps.some((s) => s.status === 'failed'));
              const mark = r.running ? '…' : r.error ? '✗' : r.result?.ok ? '✓' : failed ? '!' : '·';
              const detail = r.error ? r.error
                : r.result ? (r.result.ok ? `onboarded into ${r.team}` : (r.result.steps.filter((s) => s.status === 'failed').map((s) => `${s.label}: ${s.error || 'failed'}`).join('; ') || 'finished with issues'))
                : (r.running ? 'running…' : 'queued');
              const cls = r.error || failed ? 'failed' : r.result?.ok ? 'ok' : r.running ? 'running' : 'pending';
              return (
                <div key={r.name} className="onboard-step" style={{ gridTemplateColumns: '26px minmax(140px, 1fr) minmax(0, 2fr)' }}>
                  <span className={`step-dot ${cls}`}>{mark}</span>
                  <span className="step-label mono">{r.name}</span>
                  <span className={`small ${r.error || failed ? 'status-error' : 'muted'}`}>{detail}</span>
                </div>
              );
            })}
          </div>
        ) : null}

        <div className="row-actions" style={{ marginTop: 14 }}>
          <button className="btn" disabled={running} onClick={onClose}>Close</button>
          <button className="btn primary" disabled={!canRun} onClick={() => void run()}>
            {running ? 'Onboarding…' : `Onboard ${named.length} agent${named.length === 1 ? '' : 's'}`}
          </button>
        </div>
      </div>
    </div>
  );
}

function cleanTeamName(name: string): string {
  return name.trim().toLowerCase().replace(/\s+/g, '-');
}

function countAgents(agents?: number | unknown[]): number | undefined {
  return typeof agents === 'number' ? agents : Array.isArray(agents) ? agents.length : undefined;
}

function describeTemplate(template: TeamTemplate): string {
  const count = countAgents(template.agents);
  return template.description ?? `library template${count != null ? ` · ${count} agents` : ''}`;
}

function describeConfig(config: ConfigEntry): string {
  const count = countAgents(config.agents);
  return `${config.description ?? 'server config'}${count != null ? ` · ${count} agents` : ''}`;
}

function mcpFromChoice(id: string): McpServerSpec[] | undefined {
  if (!id) return undefined;
  const entry = MCP_CATALOG.find((item) => item.id === id);
  if (!entry || entry.inputs?.some((input) => input.required && !input.default)) return undefined;
  const profile = buildFromCatalog(entry, entry.id, {});
  const { enabled: _enabled, ...server } = profile;
  return [server];
}

