import { useEffect, useState } from 'react';
import { call, agentsLeadFirst, resolveCoordinator, type FleetStore } from '../store.ts';
import { usePrompt } from '../components/prompt.tsx';
import { offerableRuntimes } from '../../../../idctl/src/settings/runtimeCatalog.ts';
import type { AgentAccount } from '../../../../idctl/src/keys/types.ts';

type ProviderRow = { kind: string; enabled?: boolean; keySource?: string; lastSync?: { status?: string } };
import type { LibrarySkillEntry } from '../../../../idctl/src/api/client.ts';

type RelayMode = 'permissive' | 'all' | 'select' | 'none';

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

function shortAddr(a?: string | null): string {
  return a ? `${a.slice(0, 6)}…${a.slice(-4)}` : '—';
}

function identityValue(a: { idchain_domain?: string | null; ows_wallet?: string | null; metadata?: unknown }, key: 'idchain_domain' | 'ows_wallet' | 'skillmesh_address'): string {
  const meta = a.metadata as { idchain_domain?: unknown; ows_wallet?: unknown; skillmesh_address?: unknown } | undefined;
  const direct = key === 'idchain_domain' ? a.idchain_domain : key === 'ows_wallet' ? a.ows_wallet : undefined;
  const value = direct ?? meta?.[key];
  return typeof value === 'string' ? value.trim() : '';
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
  const prompt = usePrompt();

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

  // Add-agent form (populate a team — esp. a new empty one).
  const [na, setNa] = useState({ name: '', runtime: 'claude-code-cli', model: '', role: '', expertise: '', heartbeat: false, hbInterval: 3600, wallet: false });
  const [naSkills, setNaSkills] = useState<string[]>([]);
  const [modelCatalog, setModelCatalog] = useState<Record<string, string[]>>({});
  const [skillCatalog, setSkillCatalog] = useState<string[]>([]);
  const [providers, setProviders] = useState<ProviderRow[]>([]);
  const [adding, setAdding] = useState(false);

  useEffect(() => {
    call<Record<string, string[]>>('runtime:models').then(setModelCatalog).catch(() => setModelCatalog({}));
    call<LibrarySkillEntry[]>('librarySkills').then((s) => setSkillCatalog(s.map((x) => x.name))).catch(() => setSkillCatalog([]));
    call<ProviderRow[]>('providers:list').then(setProviders).catch(() => setProviders([]));
  }, [store.lastUpdated]);

  const naModels = modelCatalog[na.runtime] ?? [];
  function toggleNaSkill(name: string) {
    setNaSkills((s) => (s.includes(name) ? s.filter((x) => x !== name) : [...s, name]));
  }
  async function addAgent() {
    const name = na.name.trim().toLowerCase().replace(/\s+/g, '-');
    if (!name) {
      setMsg('agent needs a name');
      return;
    }
    setAdding(true);
    setMsg(`creating agent ${name} in ${activeTeam}…`);
    try {
      await call('spawnAgent', {
        name,
        runtime: na.runtime,
        model: na.model || undefined,
        skills: naSkills,
        heartbeatSeconds: na.heartbeat ? na.hbInterval : undefined,
        role: na.role.trim() || undefined,
        expertise: na.expertise.split(',').map((x) => x.trim()).filter(Boolean),
        wallet: na.wallet,
      });
      setMsg(`created agent ${name} ✓${na.wallet ? ' (wallet provisioning…)' : ''}`);
      setNa((p) => ({ ...p, name: '', role: '', expertise: '' }));
      setNaSkills([]);
      store.refresh();
    } catch (err) {
      setMsg(`failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setAdding(false);
    }
  }

  // Per-agent relay overrides (an individual agent can be granted/denied
  // cross-team delegation independently of its team's policy).
  const [agentEditing, setAgentEditing] = useState<string | null>(null);
  const [agentSel, setAgentSel] = useState<string[]>([]);
  const [accounts, setAccounts] = useState<Record<string, AgentAccount>>({});

  async function loadAccounts() {
    const names = store.agents.map((a) => a.name);
    if (names.length === 0) {
      setAccounts({});
      return;
    }
    const list = await call<AgentAccount[]>('keys:list', names).catch(() => []);
    setAccounts(Object.fromEntries(list.map((a) => [a.agent, a])));
  }
  useEffect(() => { void loadAccounts(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [store.lastUpdated, activeTeam]);

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
  async function identityAction(agent: string, action: 'register' | 'provision') {
    setBusy(true);
    setMsg(`${action === 'register' ? 'registering identity' : 'provisioning wallet'} for ${agent}…`);
    try {
      await call(action === 'register' ? 'identity:register' : 'wallet:provision', agent);
      await loadAccounts();
      store.refresh();
      setMsg(`${agent} ${action === 'register' ? 'identity registered' : 'wallet provisioned'} ✓`);
    } catch (err) {
      setMsg(`failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setBusy(false);
    }
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

  async function newTeam() {
    const name = await prompt({ title: 'New team name (created from the default template):', placeholder: 'lowercase, e.g. research', okLabel: 'Create team' });
    if (!name) return;
    const clean = name.trim().toLowerCase().replace(/\s+/g, '-');
    if (!clean) return;
    setBusy(true);
    setMsg(`creating ${clean}…`);
    try {
      await call('deployTeam', clean);
      await store.setTeam(clean);
      setMsg(`created ${clean} ✓`);
    } catch (err) {
      setMsg(`failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="view modules">
      <header className="view-head">
        <h1>Teams</h1>
        <button className="btn primary" disabled={busy} onClick={() => void newTeam()}>
          + New team
        </button>
      </header>
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
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <section className="card">
        <h3>Add agent — {activeTeam}</h3>
        <p className="muted small" style={{ marginTop: -4 }}>
          Create and start a new agent in <b>{activeTeam}</b>. Only a name is required; everything else has sensible defaults.
        </p>
        <div className="kv" style={{ gridTemplateColumns: '110px 1fr', gap: '8px 12px' }}>
          <span>name</span>
          <b>
            <input style={{ width: 220 }} placeholder="lowercase, e.g. analyst" value={na.name} disabled={adding} onChange={(e) => setNa((p) => ({ ...p, name: e.target.value }))} />
          </b>
          <span>runtime · model</span>
          <b>
            <select
              className="cell-select"
              disabled={adding}
              value={na.runtime}
              onChange={(e) => setNa((p) => ({ ...p, runtime: e.target.value, model: '' }))}
            >
              {offerableRuntimes(providers).map((r) => (
                <option key={r} value={r}>{runtimeLabel(r)}</option>
              ))}
            </select>{' '}
            <select className="cell-select" disabled={adding} value={na.model} onChange={(e) => setNa((p) => ({ ...p, model: e.target.value }))}>
              <option value="">(default)</option>
              {naModels.map((m) => (
                <option key={m} value={m}>{m}</option>
              ))}
            </select>
          </b>
          <span>role · expertise</span>
          <b>
            <input style={{ width: 160 }} placeholder="role, e.g. auditor" value={na.role} disabled={adding} onChange={(e) => setNa((p) => ({ ...p, role: e.target.value }))} />{' '}
            <input style={{ width: 240 }} placeholder="expertise (comma-separated)" value={na.expertise} disabled={adding} onChange={(e) => setNa((p) => ({ ...p, expertise: e.target.value }))} />
          </b>
          <span>skills</span>
          <b>
            {skillCatalog.length === 0 ? (
              <span className="muted small">no library skills</span>
            ) : (
              <span className="chips">
                {skillCatalog.map((s) => {
                  const on = naSkills.includes(s);
                  return (
                    <button key={s} className={`chip${on ? ' on' : ''}`} disabled={adding} onClick={() => toggleNaSkill(s)}>
                      {on ? '✓ ' : ''}{s}
                    </button>
                  );
                })}
              </span>
            )}
          </b>
          <span>heartbeat</span>
          <b>
            <input type="checkbox" checked={na.heartbeat} disabled={adding} onChange={(e) => setNa((p) => ({ ...p, heartbeat: e.target.checked }))} />{' '}
            <select className="cell-select" disabled={adding || !na.heartbeat} value={na.hbInterval} onChange={(e) => setNa((p) => ({ ...p, hbInterval: Number(e.target.value) }))}>
              {HB_INTERVALS.map((iv) => (
                <option key={iv.s} value={iv.s}>{iv.label}</option>
              ))}
            </select>
            <span className="muted small" style={{ marginLeft: 10 }}>
              <input type="checkbox" checked={na.wallet} disabled={adding} onChange={(e) => setNa((p) => ({ ...p, wallet: e.target.checked }))} /> provision OWS wallet
            </span>
          </b>
        </div>
        <div className="row-actions" style={{ marginTop: 12 }}>
          <button className="btn primary" disabled={adding || !na.name.trim()} onClick={() => void addAgent()}>
            Add agent
          </button>
        </div>
      </section>

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
            const domain = identityValue(a, 'idchain_domain');
            const wallet = identityValue(a, 'ows_wallet');
            const acct = accounts[a.name];
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
                <span>identity</span>
                <span>
                  <div className="kv" style={{ gridTemplateColumns: '120px 1fr', gap: '3px 10px' }}>
                    <span>ENS / ID-chain</span>
                    <b className={domain ? 'mono' : 'muted'}>{domain || '—'}</b>
                    <span>OWS wallet</span>
                    <b className={wallet ? 'mono' : 'muted'}>{wallet ? shortAddr(wallet) : 'not provisioned'}</b>
                    <span>Safe account</span>
                    <b>
                      {acct ? (
                        <>
                          <span className="mono">{shortAddr(acct.smartAccount)}</span>{' '}
                          <span className={acct.deployed ? 'ok-text small' : 'warn-text small'}>
                            {acct.deployed ? '● deployed' : '○ counterfactual'}
                          </span>
                        </>
                      ) : (
                        <span className="muted">—</span>
                      )}
                    </b>
                  </div>
                  <div className="row-actions" style={{ marginTop: 6, justifyContent: 'flex-start', alignItems: 'center', flexWrap: 'wrap' }}>
                    <button className="btn small" disabled={busy} onClick={() => void identityAction(a.name, 'register')}>
                      Register identity
                    </button>
                    {!wallet ? (
                      <button className="btn small" disabled={busy} onClick={() => void identityAction(a.name, 'provision')}>
                        Provision wallet
                      </button>
                    ) : null}
                  </div>
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
