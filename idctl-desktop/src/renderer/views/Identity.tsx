import { useEffect, useMemo, useState } from 'react';
import { call, type FleetStore } from '../store.ts';
import type { Agent } from '../../../../idctl/src/api/types.ts';
import type { AgentAccount, KeyCapabilities, SessionKey, SessionScope } from '../../../../idctl/src/keys/types.ts';

type EvidenceState = 'verified' | 'warn' | 'missing' | 'self';

interface EvidenceRow {
  layer: string;
  state: EvidenceState;
  evidence: string;
  source: string;
  detail: string;
}

interface AuthorityRow {
  type: string;
  owner: string;
  scope: string;
  expiry: string;
  status: EvidenceState;
}

function shortAddr(a?: string): string {
  return a ? `${a.slice(0, 6)}...${a.slice(-4)}` : '-';
}

function remaining(validUntil: number): string {
  if (validUntil === 0) return 'until revoked';
  const ms = validUntil - Date.now();
  if (ms <= 0) return 'expired';
  const h = Math.round(ms / 3600_000);
  return h < 24 ? `${h}h left` : `${Math.round(h / 24)}d left`;
}

function identityValue(
  a: { idchain_domain?: string | null; ows_wallet?: string | null; metadata?: unknown },
  key: 'idchain_domain' | 'ows_wallet',
): string {
  const meta = a.metadata as { idchain_domain?: unknown; ows_wallet?: unknown } | undefined;
  const direct = key === 'idchain_domain' ? a.idchain_domain : a.ows_wallet;
  const value = direct ?? meta?.[key];
  return typeof value === 'string' ? value.trim() : '';
}

function statusLabel(state: EvidenceState): string {
  if (state === 'verified') return 'verified';
  if (state === 'warn') return 'review';
  if (state === 'self') return 'self-attested';
  return 'missing';
}

function StatusPill({ state }: { state: EvidenceState }) {
  return <span className={`id-pill ${state}`}>{statusLabel(state)}</span>;
}

function riskClass(state: EvidenceState): string {
  return state === 'verified' ? 'ok-text' : state === 'missing' ? 'status-error' : 'warn-text';
}

function agentIdentityRows(agent: Agent | undefined, acct: AgentAccount | undefined, domain: string, wallet: string): EvidenceRow[] {
  const hasDomain = Boolean(domain);
  const hasWallet = Boolean(wallet);
  const hasSafe = Boolean(acct?.smartAccount);
  return [
    {
      layer: 'Personhood / KYA',
      state: 'missing',
      evidence: 'No World ID, KYB, or KYA credential linked',
      source: 'trust layer 0',
      detail: 'Treat as controller evidence only when present; not runtime safety.',
    },
    {
      layer: 'Public identity',
      state: hasDomain ? 'self' : 'missing',
      evidence: hasDomain ? domain : 'No ENS / idchain domain registered',
      source: 'ENS / idchain',
      detail: hasDomain ? 'Name is declared in the agent row; controller proof still needs chain verification.' : 'Register an identity before publishing endpoints or reputation.',
    },
    {
      layer: 'Controller wallet',
      state: hasWallet ? 'self' : 'missing',
      evidence: hasWallet ? shortAddr(wallet) : 'No OWS wallet provisioned',
      source: 'wallet registry',
      detail: 'Wallet control is authority, not reputation. Re-check before privileged actions.',
    },
    {
      layer: 'Agent account',
      state: acct?.deployed ? 'verified' : hasSafe ? 'warn' : 'missing',
      evidence: hasSafe ? shortAddr(acct?.smartAccount) : 'No Safe account',
      source: `chain ${acct?.chainId ?? '-'}`,
      detail: acct?.deployed ? 'Smart account is marked deployed.' : 'Counterfactual account can receive delegations, but on-chain use still needs deployment.',
    },
    {
      layer: 'Context / endpoints',
      state: hasDomain ? 'warn' : 'missing',
      evidence: hasDomain ? 'ENSIP-26 context expected' : 'No agent-context record',
      source: 'ENSIP-26',
      detail: 'Future resolver check should verify MCP, A2A, web endpoint origin, and freshness.',
    },
    {
      layer: 'Manifest / skill',
      state: agent ? 'self' : 'missing',
      evidence: agent ? `${agent.runtime ?? 'runtime'} / ${agent.model ?? 'model'}` : 'No active agent selected',
      source: 'SKILL.md / AIP',
      detail: 'Display as declared capability until manifest hash, signature, and domain proof are checked.',
    },
  ];
}

function authorityRows(acct: AgentAccount, sessions: SessionKey[], wallet: string): AuthorityRow[] {
  const active = sessions.filter((s) => s.status === 'active');
  const broad = active.some((s) => s.scope.label.includes('full') || s.validUntil === 0);
  return [
    {
      type: 'Cold controller',
      owner: wallet ? shortAddr(wallet) : 'not linked',
      scope: 'ENS, registry, recovery',
      expiry: 'external wallet',
      status: wallet ? 'warn' : 'missing',
    },
    {
      type: 'Safe account',
      owner: shortAddr(acct.owner),
      scope: 'agent authority root',
      expiry: acct.deployed ? 'on-chain' : 'counterfactual',
      status: acct.deployed ? 'verified' : 'warn',
    },
    {
      type: 'Runtime sessions',
      owner: `${active.length} active`,
      scope: broad ? 'contains broad grant' : 'scoped grants',
      expiry: active.length ? active.map((s) => remaining(s.validUntil)).join(', ') : 'none',
      status: active.length === 0 ? 'warn' : broad ? 'warn' : 'verified',
    },
    {
      type: 'Control Center access',
      owner: 'Better Auth operator',
      scope: 'human login, org role, API keys',
      expiry: 'fresh-session required',
      status: 'self',
    },
  ];
}

function riskRows(domain: string, wallet: string, acct: AgentAccount | undefined): { label: string; state: EvidenceState; note: string }[] {
  const active = acct?.sessions.filter((s) => s.status === 'active') ?? [];
  const nonExpiring = active.filter((s) => s.validUntil === 0).length;
  return [
    { label: 'Identity binding', state: domain && wallet ? 'warn' : 'missing', note: domain && wallet ? 'declared, needs controller challenge' : 'name or wallet missing' },
    { label: 'Account deployment', state: acct?.deployed ? 'verified' : 'warn', note: acct?.deployed ? 'Safe marked deployed' : 'counterfactual or absent' },
    { label: 'Session-key hygiene', state: nonExpiring ? 'warn' : active.length ? 'verified' : 'warn', note: nonExpiring ? `${nonExpiring} non-expiring grant` : `${active.length} active grant${active.length === 1 ? '' : 's'}` },
    { label: 'Operator auth', state: 'warn', note: 'wire Better Auth freshness, passkeys, 2FA, org roles' },
    { label: 'Trust resolution', state: 'warn', note: 'add live ENSIP-25/26, EEP, ERC-8004, manifest checks' },
  ];
}

export function Identity({ store }: { store: FleetStore }) {
  const [caps, setCaps] = useState<KeyCapabilities | null>(null);
  const [accounts, setAccounts] = useState<Record<string, AgentAccount>>({});
  const [presets, setPresets] = useState<{ scopes: SessionScope[]; ttls: { label: string; ms: number }[] } | null>(null);
  const [sel, setSel] = useState<string | null>(null);
  const [scopeIdx, setScopeIdx] = useState(0);
  const [ttlIdx, setTtlIdx] = useState(1);
  const [busy, setBusy] = useState(false);

  const names = store.agents.map((a) => a.name);
  const selected = sel ?? names[0];
  const acct = selected ? accounts[selected] : undefined;
  const selAgent = selected ? store.agents.find((a) => a.name === selected) : undefined;
  const domain = selAgent ? identityValue(selAgent, 'idchain_domain') : '';
  const wallet = selAgent ? identityValue(selAgent, 'ows_wallet') : '';

  const evidence = useMemo(() => agentIdentityRows(selAgent, acct, domain, wallet), [selAgent, acct, domain, wallet]);
  const risks = useMemo(() => riskRows(domain, wallet, acct), [domain, wallet, acct]);
  const authorities = useMemo(() => (acct ? authorityRows(acct, acct.sessions, wallet) : []), [acct, wallet]);
  const activeSessions = acct?.sessions.filter((s) => s.status === 'active').length ?? 0;
  const verifiedLayers = evidence.filter((e) => e.state === 'verified').length;

  async function reload() {
    if (names.length === 0) return;
    const list = await call<AgentAccount[]>('keys:list', names);
    setAccounts(Object.fromEntries(list.map((a) => [a.agent, a])));
  }

  useEffect(() => {
    call<KeyCapabilities>('keys:caps').then(setCaps).catch(() => {});
    call<{ scopes: SessionScope[]; ttls: { label: string; ms: number }[] }>('keys:presets').then(setPresets).catch(() => {});
  }, []);

  useEffect(() => {
    reload();
  }, [store.agents.length]);

  async function act(method: string, ...args: unknown[]) {
    setBusy(true);
    try {
      await call(method, ...args);
      await reload();
    } finally {
      setBusy(false);
    }
  }

  async function identityAction(agent: string, action: 'register' | 'provision') {
    setBusy(true);
    try {
      await call(action === 'register' ? 'identity:register' : 'wallet:provision', agent);
      store.refresh();
      await reload();
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="view identity-view">
      <header className="view-head">
        <div>
          <h1>Identity & Keys</h1>
          <div className="muted small">Agent public identity, local authority, human operator access, and reputation evidence.</div>
        </div>
        <span className="muted">
          {caps?.chainLabel}
          {caps && !caps.live ? ' · MOCK' : ''}
        </span>
      </header>

      <div className="cols identity-shell">
        <section className="card identity-agents">
          <h3>Agents</h3>
          {store.agents.map((a) => (
            <button key={a.id} className={`target${a.name === selected ? ' active' : ''}`} onClick={() => setSel(a.name)}>
              <span>{a.name}</span>
              <span className="muted small">{identityValue(a, 'idchain_domain') || a.status || 'unbound'}</span>
            </button>
          ))}
        </section>

        <section className="grow identity-main">
          {acct ? (
            <>
              <section className="card identity-hero">
                <div>
                  <div className="muted small">selected agent</div>
                  <h2>{selected}</h2>
                  <div className="identity-subtitle">
                    <span className={domain ? 'mono' : 'muted'}>{domain || 'no ENS / idchain name'}</span>
                    <span className="muted">registry and reputation checks pending live resolver wiring</span>
                  </div>
                </div>
                <div className="identity-metrics">
                  <div><b>{verifiedLayers}/5</b><span>verified layers</span></div>
                  <div><b>{activeSessions}</b><span>active sessions</span></div>
                  <div><b>{acct.deployed ? 'live' : 'draft'}</b><span>Safe account</span></div>
                </div>
              </section>

              <div className="identity-grid">
                <section className="card">
                  <h3>Public Identity</h3>
                  <div className="kv identity-kv">
                    <span>ENS / ID-chain</span>
                    <b className={domain ? 'mono' : 'muted'}>{domain || '-'}</b>
                    <span>OWS wallet</span>
                    <b className={wallet ? 'mono' : 'muted'}>{wallet ? shortAddr(wallet) : 'not provisioned'}</b>
                    <span>Safe</span>
                    <b className="mono">{shortAddr(acct.smartAccount)}</b>
                    <span>owner</span>
                    <b className="mono">{shortAddr(acct.owner)}</b>
                  </div>
                  <div className="row-actions identity-actions">
                    <button className="btn" disabled={busy} onClick={() => void identityAction(selected!, 'register')}>
                      Register identity
                    </button>
                    {!wallet ? (
                      <button className="btn" disabled={busy} onClick={() => void identityAction(selected!, 'provision')}>
                        Provision wallet
                      </button>
                    ) : null}
                    <button className="btn" disabled={busy} onClick={() => void act('keys:ensure', selected)}>
                      Create account
                    </button>
                    <button className="btn" disabled={busy || acct.deployed} onClick={() => void act('keys:deploy', selected)}>
                      Deploy
                    </button>
                  </div>
                </section>

                <section className="card">
                  <h3>Risk & Health</h3>
                  <div className="risk-list">
                    {risks.map((r) => (
                      <div key={r.label} className="risk-row">
                        <span className={`dot ${r.state === 'verified' ? 'ok' : r.state === 'missing' ? 'err' : 'warn'}`} />
                        <b>{r.label}</b>
                        <span className={riskClass(r.state)}>{r.note}</span>
                      </div>
                    ))}
                  </div>
                </section>
              </div>

              <section className="card">
                <h3>Trust Resolution Stack</h3>
                <div className="evidence-grid">
                  {evidence.map((row) => (
                    <div key={row.layer} className="evidence-row">
                      <div>
                        <b>{row.layer}</b>
                        <p className="muted small">{row.detail}</p>
                      </div>
                      <StatusPill state={row.state} />
                      <span className="mono small">{row.source}</span>
                      <span>{row.evidence}</span>
                    </div>
                  ))}
                </div>
              </section>

              <section className="card">
                <h3>Keys & Authority</h3>
                <table className="grid identity-table">
                  <thead>
                    <tr>
                      <th>Authority</th>
                      <th>Owner</th>
                      <th>Scope</th>
                      <th>Expiry / proof</th>
                      <th>Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {authorities.map((a) => (
                      <tr key={a.type}>
                        <td className="b">{a.type}</td>
                        <td className="mono muted">{a.owner}</td>
                        <td>{a.scope}</td>
                        <td>{a.expiry}</td>
                        <td><StatusPill state={a.status} /></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </section>

              <section className="card">
                <h3>Session Keys ({acct.sessions.length})</h3>
                <table className="grid identity-table">
                  <thead>
                    <tr>
                      <th>Scope</th>
                      <th>Signer</th>
                      <th>Spend cap</th>
                      <th>Validity</th>
                      <th>Action</th>
                    </tr>
                  </thead>
                  <tbody>
                    {acct.sessions.map((s) => (
                      <tr key={s.id}>
                        <td className="b">{s.scope.label}</td>
                        <td className="mono muted">{shortAddr(s.address)}</td>
                        <td className="mono small">{s.scope.spendLimitWei === '0' ? '0 / no cap' : s.scope.spendLimitWei}</td>
                        <td className={s.status === 'active' ? 'ok-text' : s.status === 'revoked' ? 'status-error' : 'muted'}>
                          {s.status === 'active' ? remaining(s.validUntil) : s.status}
                        </td>
                        <td className="row-actions">
                          {s.status === 'active' ? (
                            <button className="btn" disabled={busy} onClick={() => void act('keys:revoke', selected, s.id)}>
                              Revoke
                            </button>
                          ) : null}
                        </td>
                      </tr>
                    ))}
                    {acct.sessions.length === 0 ? (
                      <tr>
                        <td colSpan={5} className="muted">
                          No session keys yet.
                        </td>
                      </tr>
                    ) : null}
                  </tbody>
                </table>

                {presets ? (
                  <div className="issue-row">
                    <select value={scopeIdx} onChange={(e) => setScopeIdx(Number(e.target.value))}>
                      {presets.scopes.map((s, i) => (
                        <option key={i} value={i}>
                          {s.label}
                        </option>
                      ))}
                    </select>
                    <select value={ttlIdx} onChange={(e) => setTtlIdx(Number(e.target.value))}>
                      {presets.ttls.map((t, i) => (
                        <option key={i} value={i}>
                          {t.label}
                        </option>
                      ))}
                    </select>
                    <button
                      className="btn primary"
                      disabled={busy}
                      onClick={() => void act('keys:issue', selected, scopeIdx, presets.ttls[ttlIdx].ms)}
                    >
                      Issue session key
                    </button>
                  </div>
                ) : null}
              </section>

              <div className="identity-grid">
                <section className="card">
                  <h3>Human Operator Access</h3>
                  <div className="auth-list">
                    <div><StatusPill state="self" /><span>Better Auth should own human login, org role, sessions, passkeys, 2FA, and control-plane API keys.</span></div>
                    <div><StatusPill state="warn" /><span>Sensitive mutations require a fresh session plus passkey or 2FA before key rotation, reveal, export, or rebinding.</span></div>
                    <div><StatusPill state="missing" /><span>Better Auth is not proof of ENS ownership, wallet control, ERC-8004 identity, or agent runtime authenticity.</span></div>
                  </div>
                </section>

                <section className="card">
                  <h3>Reputation Evidence</h3>
                  <div className="auth-list">
                    <div><StatusPill state="warn" /><span>EEP endorsements and ERC-8004 feedback should be weighted by source, recency, task context, and suspicious clusters.</span></div>
                    <div><StatusPill state="warn" /><span>Validation results should show validator, method, confidence, stake or slash status, and exact job reference.</span></div>
                    <div><StatusPill state="self" /><span>Use layered evidence, not a single global score; trust tier never implies permission to spend or sign.</span></div>
                  </div>
                </section>
              </div>

              <p className="muted small">
                Current key provider is mock-backed. The page is structured for live ENSIP-25/26, ERC-8004, EEP, manifest, Better Auth, and Safe4337 checks without changing the operator workflow.
              </p>
            </>
          ) : (
            <section className="card">
              <p className="muted">Select an agent.</p>
            </section>
          )}
        </section>
      </div>
    </div>
  );
}
