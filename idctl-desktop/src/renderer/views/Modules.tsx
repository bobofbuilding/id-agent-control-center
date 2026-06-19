import { Fragment, useEffect, useState } from 'react';
import { call, type FleetStore } from '../store.ts';
import type { LibrarySkillEntry, LibraryPluginEntry, McpServerSpec, SetMcpResult } from '../../../../idctl/src/api/client.ts';
import {
  type McpServerProfile,
  type McpTransport,
} from '../../../../idctl/src/settings/schema.ts';
import { MCP_CATALOG, buildFromCatalog } from '../../../../idctl/src/settings/mcpCatalog.ts';

const TRANSPORTS: McpTransport[] = ['stdio', 'http', 'sse'];

interface TestResult { ok?: boolean; tools?: string[]; error?: string; testing?: boolean }

/** Strip the registry-only `enabled` flag to get the on-the-wire spec. */
function toSpec(p: McpServerProfile): McpServerSpec {
  const { enabled: _enabled, ...spec } = p;
  return spec;
}
/** Render a compact test result (✓ N tools / ✕ error / testing…). */
function TestCell({ r }: { r?: TestResult }) {
  if (!r || (r.ok === undefined && !r.testing && !r.error)) return <span className="muted">—</span>;
  if (r.testing) return <span className="warn-text">testing…</span>;
  if (r.ok) return <span className="ok-text" title={(r.tools ?? []).join(', ')}>✓ {r.tools?.length ?? 0} tools</span>;
  return <span className="status-error" title={r.error}>✕ {(r.error ?? 'failed').slice(0, 44)}</span>;
}

/** Parse "KEY=value, KEY2=value2" into an object (or undefined if empty). */
function parseKV(s: string): Record<string, string> | undefined {
  const out: Record<string, string> = {};
  for (const pair of s.split(',')) {
    const eq = pair.indexOf('=');
    if (eq < 0) continue;
    const k = pair.slice(0, eq).trim();
    const v = pair.slice(eq + 1).trim();
    if (k) out[k] = v;
  }
  return Object.keys(out).length ? out : undefined;
}

export function Modules({ store }: { store: FleetStore }) {
  const [mcp, setMcp] = useState<McpServerProfile[]>([]);
  const [skills, setSkills] = useState<LibrarySkillEntry[]>([]);
  const [plugins, setPlugins] = useState<LibraryPluginEntry[]>([]);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string>('');
  const [tab, setTab] = useState<'mcp' | 'skills' | 'plugins'>(() => {
    const t = new URLSearchParams(window.location.search).get('tab');
    return t === 'skills' || t === 'plugins' ? t : 'mcp';
  });

  // Multi-agent targets within the active team. Capabilities apply to ALL
  // selected agents; switch teams with the team picker in the header. Default
  // (untouched) = every agent in the team; toggling switches to an explicit set.
  const activeTeam = store.team ?? 'default';
  const [touched, setTouched] = useState(false);
  const [explicit, setExplicit] = useState<Set<string>>(new Set());
  useEffect(() => {
    setTouched(false);
    setExplicit(new Set());
    setNote('');
  }, [store.team]);
  const selectedIds: Set<string> = touched ? explicit : new Set(store.agents.map((a) => a.id));
  const targetAgents = store.agents.filter((a) => selectedIds.has(a.id));
  const targetCount = targetAgents.length;
  function baseSet(): Set<string> {
    return touched ? explicit : new Set(store.agents.map((a) => a.id));
  }
  function toggleAgent(id: string) {
    const n = baseSet();
    n.has(id) ? n.delete(id) : n.add(id);
    setExplicit(n);
    setTouched(true);
  }
  function selectAll() { setExplicit(new Set(store.agents.map((a) => a.id))); setTouched(true); }
  function selectNone() { setExplicit(new Set()); setTouched(true); }

  // How many selected agents currently have a given MCP server / skill.
  function mcpCount(name: string): number {
    return targetAgents.filter((a) => (((a.metadata as any)?.mcpServers ?? []) as { name: string }[]).some((s) => s.name === name)).length;
  }
  function skillCount(skill: string): number {
    return targetAgents.filter((a) => (((a.metadata as any)?.skills ?? []) as string[]).includes(skill)).length;
  }

  // add-MCP: catalog-driven (default) + custom (advanced)
  const [catId, setCatId] = useState<string>(MCP_CATALOG[0]?.id ?? '');
  const [catName, setCatName] = useState<string>(MCP_CATALOG[0]?.id ?? '');
  const [catInputs, setCatInputs] = useState<Record<string, string>>({});
  const [showCustom, setShowCustom] = useState(false);
  // custom form
  const [transport, setTransport] = useState<McpTransport>('stdio');
  const [mName, setMName] = useState('');
  const [cmd, setCmd] = useState('npx');
  const [argsStr, setArgsStr] = useState('');
  const [url, setUrl] = useState('');
  const [envStr, setEnvStr] = useState('');
  // per-key test results: 'cat', 'custom', or a registered server name
  const [test, setTest] = useState<Record<string, TestResult>>({});

  const catEntry = MCP_CATALOG.find((e) => e.id === catId);
  function pickCatalog(id: string) {
    setCatId(id);
    const e = MCP_CATALOG.find((x) => x.id === id);
    setCatName(e?.id ?? '');
    setCatInputs(Object.fromEntries((e?.inputs ?? []).map((i) => [i.key, i.default ?? ''])));
    setTest((t) => ({ ...t, cat: {} }));
  }
  function buildCatalog(): McpServerProfile | null {
    if (!catEntry) return null;
    for (const inp of catEntry.inputs ?? []) {
      if (inp.required && !(catInputs[inp.key] ?? inp.default ?? '').trim()) return null;
    }
    return buildFromCatalog(catEntry, catName, catInputs);
  }
  function buildCustom(): McpServerProfile | null {
    const name = mName.trim();
    if (!name) return null;
    if (transport === 'stdio') {
      if (!cmd.trim()) return null;
      return { name, transport, command: cmd.trim(), ...(argsStr.trim() && { args: argsStr.trim().split(/\s+/) }), ...(parseKV(envStr) && { env: parseKV(envStr) }), enabled: true };
    }
    if (!url.trim()) return null;
    return { name, transport, url: url.trim(), ...(parseKV(envStr) && { headers: parseKV(envStr) }), enabled: true };
  }

  async function reload() {
    setMcp(await call<McpServerProfile[]>('mcp:list').catch(() => []));
    setSkills(await call<LibrarySkillEntry[]>('librarySkills').catch(() => []));
    setPlugins(await call<LibraryPluginEntry[]>('libraryPlugins').catch(() => []));
  }
  useEffect(() => {
    reload();
  }, [store.team, store.lastUpdated]);
  useEffect(() => {
    pickCatalog(MCP_CATALOG[0]?.id ?? '');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function runTest(key: string, profile: McpServerProfile | null) {
    if (!profile) {
      setTest((t) => ({ ...t, [key]: { ok: false, error: 'fill the required fields first' } }));
      return;
    }
    setTest((t) => ({ ...t, [key]: { testing: true } }));
    const res = await call<TestResult>('mcp:test', toSpec(profile)).catch((e) => ({ ok: false, error: e instanceof Error ? e.message : String(e) }));
    setTest((t) => ({ ...t, [key]: res }));
  }
  async function addProfile(profile: McpServerProfile | null, after: () => void) {
    if (!profile) return;
    setBusy(true);
    try {
      setMcp(await call<McpServerProfile[]>('mcp:add', profile));
      after();
    } finally {
      setBusy(false);
    }
  }

  // Apply an action to every selected agent (sequentially, in the active team).
  async function applyToTargets(label: string, fn: (a: { id: string; name: string; metadata?: unknown }) => Promise<unknown>) {
    if (targetCount === 0) {
      setNote('select at least one agent above');
      return;
    }
    setBusy(true);
    setNote(`${label} · ${targetCount} agent${targetCount > 1 ? 's' : ''}…`);
    try {
      for (const a of targetAgents) await fn(a);
      setNote(`${label} ✓ (${targetCount})`);
      store.refresh();
    } catch (err) {
      setNote(`${label} failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setBusy(false);
    }
  }
  function curMcp(a: { metadata?: unknown }): McpServerSpec[] {
    return ((a.metadata as any)?.mcpServers ?? []) as McpServerSpec[];
  }
  async function attachServer(p: McpServerProfile) {
    await applyToTargets(`attach ${p.name}`, async (a) => {
      const next = [...curMcp(a).filter((s) => s.name !== p.name), toSpec(p)];
      await call<SetMcpResult>('setAgentMcp', a.id, next);
    });
  }
  async function detachServer(p: McpServerProfile) {
    await applyToTargets(`detach ${p.name}`, async (a) => {
      await call<SetMcpResult>('setAgentMcp', a.id, curMcp(a).filter((s) => s.name !== p.name));
    });
  }
  async function rebuildTargets() {
    await applyToTargets('rebuild', (a) => call('rebuildAgent', a.name));
  }
  async function installSkillAll(skill: string) {
    await applyToTargets(`install ${skill}`, (a) => call('installSkill', skill, a.name));
  }
  // # selected agents that have at least one MCP server attached (→ show Rebuild).
  const anyAttached = targetAgents.some((a) => curMcp(a).length > 0);
  const targetLabel = targetCount === 0 ? 'no agents' : targetCount === 1 ? targetAgents[0].name : `${targetCount} agents`;

  return (
    <div className="view modules">
      <header className="view-head">
        <h1>Capabilities</h1>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', justifyContent: 'flex-end' }}>
          <span className="muted small">team</span>
          <select className="cell-select" value={activeTeam} onChange={(e) => void store.setTeam(e.target.value)}>
            {store.teams.map((t) => (
              <option key={t.id} value={t.name}>{t.name}</option>
            ))}
          </select>
          <span className="muted small">apply to</span>
          {store.agents.length === 0 ? (
            <span className="muted small">(no agents)</span>
          ) : (
            <>
              <span className="chips">
                {store.agents.map((a) => {
                  const on = selectedIds.has(a.id);
                  return (
                    <button key={a.id} className={`chip${on ? ' on' : ''}`} disabled={busy} onClick={() => toggleAgent(a.id)}>
                      {on ? '✓ ' : ''}{a.name}
                    </button>
                  );
                })}
              </span>
              <button className="btn small" disabled={busy} onClick={() => (targetCount === store.agents.length ? selectNone() : selectAll())}>
                {targetCount === store.agents.length ? 'none' : 'all'}
              </button>
            </>
          )}
        </div>
      </header>

      <div className="tabs">
        {([
          ['mcp', 'MCP servers'],
          ['skills', 'Skills'],
          ['plugins', 'Plugins'],
        ] as ['mcp' | 'skills' | 'plugins', string][]).map(([id, label]) => (
          <button key={id} className={`tab${tab === id ? ' active' : ''}`} onClick={() => setTab(id)}>
            {label}
          </button>
        ))}
      </div>

      {note ? <div className="muted small">{note}</div> : null}

      {tab === 'mcp' ? (
      <section className="card grow">
        <h3>MCP servers — new tools via external servers</h3>
        <p className="muted small" style={{ marginTop: -4 }}>
          External tool servers your agent connects to — they give it brand-new <b>tools</b> (filesystem, web search, databases, GitHub…). Pick one, <b>Test</b> it (launches it and lists its tools), then <b>Attach</b> to <b>{targetLabel}</b> and Rebuild. Attach/Detach apply to every selected agent. Claude-runtime agents only.
        </p>
        <table className="grid">
          <thead>
            <tr>
              <th>name</th>
              <th>endpoint</th>
              <th>attached</th>
              <th>test</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {mcp.map((p) => {
              const tr = test[p.name];
              const have = mcpCount(p.name);
              return (
                <tr key={p.name}>
                  <td className="b">{p.name} <span className="muted small">{p.transport}</span></td>
                  <td className="mono small">{p.transport === 'stdio' ? [p.command, ...(p.args ?? [])].join(' ') : p.url}</td>
                  <td className={have > 0 ? 'ok-text small' : 'muted small'}>{have}/{targetCount}</td>
                  <td className="small"><TestCell r={tr} /></td>
                  <td className="row-actions">
                    <button className="btn" disabled={busy || targetCount === 0 || have === targetCount} onClick={() => void attachServer(p)}>Attach</button>
                    <button className="btn" disabled={busy || have === 0} onClick={() => void detachServer(p)}>Detach</button>
                    <button className="btn" disabled={tr?.testing} onClick={() => void runTest(p.name, p)}>{tr?.testing ? '…' : 'Test'}</button>
                    <button className="btn" onClick={() => void call('mcp:remove', p.name).then(() => reload())}>✕</button>
                  </td>
                </tr>
              );
            })}
            {mcp.length === 0 ? (
              <tr>
                <td colSpan={5} className="muted center pad">No MCP servers registered yet — add one below.</td>
              </tr>
            ) : null}
          </tbody>
        </table>

        {anyAttached ? (
          <div className="row-actions" style={{ marginTop: 10 }}>
            <span className="muted small grow">attach/detach updates take effect on rebuild</span>
            <button className="btn" disabled={busy || targetCount === 0} onClick={() => void rebuildTargets()}>Rebuild {targetLabel}</button>
          </div>
        ) : null}

        <h3 style={{ marginTop: 18 }}>Add a server</h3>
        <div className="kv" style={{ gridTemplateColumns: '120px 1fr', gap: '8px 12px' }}>
          <span>from catalog</span>
          <b>
            <select value={catId} onChange={(e) => pickCatalog(e.target.value)}>
              {MCP_CATALOG.map((e) => (
                <option key={e.id} value={e.id}>{e.name}</option>
              ))}
            </select>
          </b>
          {catEntry ? (
            <>
              <span></span>
              <b className="muted small">{catEntry.description}</b>
              <span>name</span>
              <b><input style={{ width: 200 }} value={catName} onChange={(e) => setCatName(e.target.value)} /></b>
              {(catEntry.inputs ?? []).map((inp) => (
                <Fragment key={inp.key}>
                  <span>{inp.label}{inp.required ? ' *' : ''}</span>
                  <b>
                    <input
                      style={{ width: 320 }}
                      type={inp.secret ? 'password' : 'text'}
                      placeholder={inp.placeholder}
                      value={catInputs[inp.key] ?? ''}
                      onChange={(e) => setCatInputs((c) => ({ ...c, [inp.key]: e.target.value }))}
                    />
                  </b>
                </Fragment>
              ))}
            </>
          ) : null}
        </div>
        <div className="row-actions" style={{ marginTop: 10 }}>
          <span className="grow small"><TestCell r={test.cat} /></span>
          <button className="btn" disabled={test.cat?.testing} onClick={() => void runTest('cat', buildCatalog())}>{test.cat?.testing ? 'Testing…' : 'Test'}</button>
          <button className="btn primary" disabled={busy || !buildCatalog()} onClick={() => void addProfile(buildCatalog(), () => setTest((t) => ({ ...t, cat: {} })))}>Add</button>
        </div>

        <button className="btn small" style={{ marginTop: 12 }} onClick={() => setShowCustom((s) => !s)}>
          {showCustom ? '− custom server' : '+ custom server (advanced)'}
        </button>
        {showCustom ? (
          <>
            <div className="kv" style={{ gridTemplateColumns: '120px 1fr', gap: '8px 12px', marginTop: 8 }}>
              <span>transport</span>
              <b>
                <select className="cell-select" value={transport} onChange={(e) => setTransport(e.target.value as McpTransport)}>
                  {TRANSPORTS.map((t) => (<option key={t} value={t}>{t}</option>))}
                </select>
              </b>
              <span>name</span>
              <b><input style={{ width: 200 }} placeholder="name" value={mName} onChange={(e) => setMName(e.target.value)} /></b>
              {transport === 'stdio' ? (
                <>
                  <span>command</span>
                  <b><input style={{ width: 200 }} placeholder="npx" value={cmd} onChange={(e) => setCmd(e.target.value)} /></b>
                  <span>args</span>
                  <b><input style={{ width: 360 }} placeholder="-y @scope/pkg /tmp (space-separated)" value={argsStr} onChange={(e) => setArgsStr(e.target.value)} /></b>
                  <span>env</span>
                  <b><input style={{ width: 360 }} placeholder="KEY=value, KEY2=value2" value={envStr} onChange={(e) => setEnvStr(e.target.value)} /></b>
                </>
              ) : (
                <>
                  <span>url</span>
                  <b><input style={{ width: 360 }} placeholder="https://host/mcp" value={url} onChange={(e) => setUrl(e.target.value)} /></b>
                  <span>headers</span>
                  <b><input style={{ width: 360 }} placeholder="Authorization=Bearer …" value={envStr} onChange={(e) => setEnvStr(e.target.value)} /></b>
                </>
              )}
            </div>
            <div className="row-actions" style={{ marginTop: 8 }}>
              <span className="grow small"><TestCell r={test.custom} /></span>
              <button className="btn" disabled={test.custom?.testing} onClick={() => void runTest('custom', buildCustom())}>{test.custom?.testing ? 'Testing…' : 'Test'}</button>
              <button className="btn primary" disabled={busy || !buildCustom()} onClick={() => void addProfile(buildCustom(), () => { setMName(''); setArgsStr(''); setEnvStr(''); setUrl(''); setTest((t) => ({ ...t, custom: {} })); })}>Add custom</button>
            </div>
          </>
        ) : null}
      </section>
      ) : null}

      {tab === 'skills' ? (
      <section className="card grow">
        <h3>Skills — know-how for the agent</h3>
        <p className="muted small" style={{ marginTop: -4 }}>
          Markdown instructions installed into an agent — procedures and conventions that teach it <i>how</i> to do things with the tools it already has (e.g. task-discipline, wallet, inter-agent). Installing on <b>{targetLabel}</b> takes effect immediately (applies to every selected agent).
        </p>
        <table className="grid">
          <thead>
            <tr><th>name</th><th>installed</th><th></th></tr>
          </thead>
          <tbody>
            {skills.map((s) => {
              const have = skillCount(s.name);
              const all = targetCount > 0 && have === targetCount;
              return (
                <tr key={s.name}>
                  <td className="b">{s.name}</td>
                  <td className={have > 0 ? 'ok-text' : 'muted'}>{have}/{targetCount}</td>
                  <td className="row-actions">
                    <button className="btn" disabled={busy || targetCount === 0 || all} onClick={() => void installSkillAll(s.name)}>
                      {all ? 'Installed' : `Install → ${targetLabel}`}
                    </button>
                  </td>
                </tr>
              );
            })}
            {skills.length === 0 ? (
              <tr>
                <td colSpan={3} className="muted center pad">
                  No library skills found on this manager.
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </section>
      ) : null}

      {tab === 'plugins' ? (
      <section className="card grow">
        <h3>Plugins — bundled extensions</h3>
        <p className="muted small" style={{ marginTop: -4 }}>
          Packaged Claude Code extensions that can bundle skills, MCP servers, slash-commands, and scripts together. These ship with the manager (<span className="mono">plugins/claude-code</span>); they're attached to agents via team config.
        </p>
        <table className="grid">
          <thead>
            <tr>
              <th>name</th>
              <th>version</th>
              <th>description</th>
            </tr>
          </thead>
          <tbody>
            {plugins.map((p) => (
              <tr key={p.name}>
                <td className="b">{p.name}</td>
                <td className="muted small">{p.version ?? '—'}</td>
                <td className="muted">{p.description ?? ''}</td>
              </tr>
            ))}
            {plugins.length === 0 ? (
              <tr>
                <td colSpan={3} className="muted center pad">
                  No plugins found. Plugins live in <span className="mono">plugins/claude-code</span> on the manager host.
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </section>
      ) : null}
    </div>
  );
}
