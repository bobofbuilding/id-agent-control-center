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

interface ControllerProof {
  agent: string;
  wallet: string;
  nonce: string;
  message: string;
  signature: string;
  verifiedAt: number;
  expiresAt: number;
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

function isSignatureLike(value: string): boolean {
  return /^0x[0-9a-fA-F]{130,}$/.test(value.trim());
}

function proofMatchesWallet(proof: ControllerProof | undefined, wallet: string): boolean {
  return Boolean(proof?.verifiedAt && proof.expiresAt > Date.now() && proof.signature && wallet && proof.wallet.toLowerCase() === wallet.toLowerCase());
}

function agentIdentityRows(
  agent: Agent | undefined,
  acct: AgentAccount | undefined,
  domain: string,
  wallet: string,
  controllerVerified: boolean,
): EvidenceRow[] {
  const hasDomain = Boolean(domain);
  const hasWallet = Boolean(wallet);
  const hasSafe = Boolean(acct?.smartAccount);
  return [
    {
      layer: 'Controller challenge',
      state: controllerVerified ? 'verified' : hasWallet ? 'warn' : 'missing',
      evidence: controllerVerified ? `signed nonce from ${shortAddr(wallet)}` : hasWallet ? 'Controller signature required' : 'No controller wallet linked',
      source: 'controller wallet',
      detail: controllerVerified
        ? 'Local proof-of-control is recorded for this controller wallet.'
        : 'Sign a fresh nonce from the controller wallet before treating self-attested rows as controlled.',
    },
    {
      layer: 'Public identity',
      state: hasDomain ? (controllerVerified ? 'verified' : 'self') : 'missing',
      evidence: hasDomain ? domain : 'No ENS / idchain domain registered',
      source: 'ENS / idchain',
      detail: hasDomain
        ? controllerVerified
          ? 'Name is controller-attested locally; live resolver verification is still pending.'
          : 'Name is declared in the agent row; controller proof still needs verification.'
        : 'Register an identity before publishing endpoints or reputation.',
    },
    {
      layer: 'Controller wallet',
      state: hasWallet ? (controllerVerified ? 'verified' : 'self') : 'missing',
      evidence: hasWallet ? shortAddr(wallet) : 'No OWS wallet provisioned',
      source: 'wallet registry',
      detail: controllerVerified ? 'Wallet control proof gates privileged identity and key actions.' : 'Wallet control is authority, not reputation. Re-check before privileged actions.',
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
      state: agent ? (controllerVerified ? 'verified' : 'self') : 'missing',
      evidence: agent ? `${agent.runtime ?? 'runtime'} / ${agent.model ?? 'model'}` : 'No active agent selected',
      source: 'SKILL.md / AIP',
      detail: controllerVerified ? 'Runtime declaration is accepted under the current controller proof.' : 'Display as declared capability until manifest hash, signature, and domain proof are checked.',
    },
  ];
}

function authorityRows(acct: AgentAccount, sessions: SessionKey[], wallet: string, controllerVerified: boolean): AuthorityRow[] {
  const active = sessions.filter((s) => s.status === 'active');
  const broad = active.some((s) => s.scope.label.includes('full') || s.validUntil === 0);
  return [
    {
      type: 'Cold controller',
      owner: wallet ? shortAddr(wallet) : 'not linked',
      scope: 'ENS, registry, recovery',
      expiry: controllerVerified ? 'fresh challenge' : 'external wallet',
      status: controllerVerified ? 'verified' : wallet ? 'warn' : 'missing',
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

function riskRows(domain: string, wallet: string, acct: AgentAccount | undefined, controllerVerified: boolean): { label: string; state: EvidenceState; note: string }[] {
  const active = acct?.sessions.filter((s) => s.status === 'active') ?? [];
  const nonExpiring = active.filter((s) => s.validUntil === 0).length;
  return [
    { label: 'Identity binding', state: domain && wallet ? (controllerVerified ? 'verified' : 'warn') : 'missing', note: domain && wallet ? (controllerVerified ? 'controller proof recorded' : 'declared, needs controller challenge') : 'name or wallet missing' },
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
  const [error, setError] = useState<string | null>(null);
  const [proofs, setProofs] = useState<Record<string, ControllerProof>>({});

  const names = store.agents.map((a) => a.name);
  const selected = sel ?? names[0];
  const acct = selected ? accounts[selected] : undefined;
  const selAgent = selected ? store.agents.find((a) => a.name === selected) : undefined;
  const domain = selAgent ? identityValue(selAgent, 'idchain_domain') : '';
  const wallet = selAgent ? identityValue(selAgent, 'ows_wallet') : '';
  const proof = selected ? proofs[selected] : undefined;
  const controllerVerified = proofMatchesWallet(proof, wallet);

  const evidence = useMemo(() => agentIdentityRows(selAgent, acct, domain, wallet, controllerVerified), [selAgent, acct, domain, wallet, controllerVerified]);
  const risks = useMemo(() => riskRows(domain, wallet, acct, controllerVerified), [domain, wallet, acct, controllerVerified]);
  const authorities = useMemo(() => (acct ? authorityRows(acct, acct.sessions, wallet, controllerVerified) : []), [acct, wallet, controllerVerified]);
  const activeSessions = acct?.sessions.filter((s) => s.status === 'active').length ?? 0;
  const verifiedLayers = evidence.filter((e) => e.state === 'verified').length;
  const issueScope = presets?.scopes[scopeIdx];
  const issueTtl = presets?.ttls[ttlIdx];
  const issueBlocked = Boolean(issueScope && (issueScope.label.includes('full') || issueScope.spendLimitWei === '0' || issueTtl?.ms === 0));

  async function reload() {
    if (names.length === 0) return;
    try {
      const list = await call<AgentAccount[]>('keys:list', names);
      setAccounts(Object.fromEntries(list.map((a) => [a.agent, a])));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load key accounts');
    }
  }

  useEffect(() => {
    call<KeyCapabilities>('keys:caps').then(setCaps).catch((err) => setError(err instanceof Error ? err.message : 'Failed to load key capabilities'));
    call<{ scopes: SessionScope[]; ttls: { label: string; ms: number }[] }>('keys:presets').then(setPresets).catch((err) => setError(err instanceof Error ? err.message : 'Failed to load key presets'));
  }, []);

  useEffect(() => {
    reload();
  }, [store.agents.length]);

  async function act(method: string, ...args: unknown[]) {
    setError(null);
    setBusy(true);
    try {
      await call(method, ...args);
      await reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : `${method} failed`);
    } finally {
      setBusy(false);
    }
  }

  async function identityAction(agent: string, action: 'register' | 'provision') {
    setError(null);
    setBusy(true);
    try {
      await call(action === 'register' ? 'identity:register' : 'wallet:provision', agent);
      store.refresh();
      await reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : `${action} failed`);
    } finally {
      setBusy(false);
    }
  }

  async function startChallenge() {
    if (!selected || !wallet) return;
    setError(null);
    setBusy(true);
    try {
      const challenge = await call<ControllerProof>('identity:controllerChallenge', selected, wallet);
      setProofs((prev) => ({ ...prev, [selected]: challenge }));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to start controller challenge');
    } finally {
      setBusy(false);
    }
  }

  function updateSignature(signature: string) {
    if (!selected || !proof) return;
    setProofs((prev) => ({
      ...prev,
      [selected]: { ...proof, signature, verifiedAt: 0 },
    }));
  }

  async function verifyControllerProof() {
    if (!selected || !proof) return;
    if (!isSignatureLike(proof.signature)) {
      setError('Paste a 0x-prefixed controller-wallet signature for the challenge message.');
      return;
    }
    setError(null);
    setBusy(true);
    try {
      const verified = await call<ControllerProof>('identity:controllerVerify', selected, wallet, proof.signature);
      setProofs((prev) => ({ ...prev, [selected]: verified }));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to verify controller signature');
    } finally {
      setBusy(false);
    }
  }

  function requireControllerProof(label: string, fn: () => void) {
    if (!controllerVerified) {
      setError(`${label} requires a signed controller-wallet challenge first.`);
      return;
    }
    fn();
  }

  function issueSession() {
    if (!presets || !selected) return;
    if (!controllerVerified) {
      setError('Issue session key requires a signed controller-wallet challenge first.');
      return;
    }
    if (issueBlocked) {
      setError('Refusing to issue uncapped, full, or non-expiring session keys from this screen. Choose a capped scope and finite TTL.');
      return;
    }
    void act('keys:issue', selected, scopeIdx, presets.ttls[ttlIdx].ms);
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
                  <div><b>{verifiedLayers}/{evidence.length}</b><span>verified layers</span></div>
                  <div><b>{activeSessions}</b><span>active sessions</span></div>
                  <div><b>{acct.deployed ? 'live' : 'draft'}</b><span>Safe account</span></div>
                </div>
              </section>

              {error ? (
                <div className="identity-alert" role="alert">
                  <b>Action failed</b>
                  <span>{error}</span>
                  <button className="btn" onClick={() => setError(null)}>Dismiss</button>
                </div>
              ) : null}

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
                    <button className="btn" disabled={busy || !controllerVerified} onClick={() => requireControllerProof('Register identity', () => void identityAction(selected!, 'register'))}>
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
                    <button className="btn" disabled={busy || acct.deployed || !controllerVerified} onClick={() => requireControllerProof('Deploy', () => void act('keys:deploy', selected))}>
                      Deploy
                    </button>
                  </div>
                </section>

                <section className="card">
                  <h3>Controller Proof</h3>
                  <div className="controller-proof">
                    <div className="risk-row">
                      <span className={`dot ${controllerVerified ? 'ok' : wallet ? 'warn' : 'err'}`} />
                      <b>{controllerVerified ? 'Verified' : 'Required'}</b>
                      <span className={controllerVerified ? 'ok-text' : wallet ? 'warn-text' : 'status-error'}>
                        {controllerVerified ? `nonce signed ${new Date(proof!.verifiedAt).toLocaleTimeString()}` : wallet ? 'sign a nonce with the controller wallet' : 'provision a wallet first'}
                      </span>
                    </div>
                    {proof ? (
                      <>
                        <textarea className="identity-proof-message mono" readOnly value={proof.message} />
                        <input
                          className="identity-proof-input mono"
                          value={proof.signature}
                          onChange={(e) => updateSignature(e.target.value)}
                          placeholder="Paste 0x signature from controller wallet"
                        />
                      </>
                    ) : null}
                    <div className="row-actions identity-actions">
                      <button className="btn" disabled={busy || !wallet} onClick={startChallenge}>New challenge</button>
                      <button className="btn primary" disabled={busy || !proof || !proof.signature} onClick={verifyControllerProof}>Verify signature</button>
                    </div>
                  </div>
                </section>
              </div>

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
                            <button className="btn" disabled={busy || !controllerVerified} onClick={() => requireControllerProof('Revoke session key', () => void act('keys:revoke', selected, s.id))}>
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
                      disabled={busy || !controllerVerified || issueBlocked}
                      onClick={issueSession}
                    >
                      Issue session key
                    </button>
                  </div>
                ) : null}
                <p className={issueBlocked ? 'warn-text small' : 'muted small'}>
                  Privileged key changes require controller proof. Full, uncapped, and non-expiring grants are blocked here until fresh-session and passkey/2FA enforcement is wired.
                </p>
              </section>

              <div className="identity-grid">
                <section className="card">
                  <h3>Human Operator Access</h3>
                  <div className="auth-list">
                    <div><StatusPill state={controllerVerified ? 'warn' : 'missing'} /><span>{controllerVerified ? 'Controller proof is present; Better Auth freshness still needs wiring.' : 'Controller proof is required before privileged mutations.'}</span></div>
                    <div><StatusPill state="warn" /><span>Fresh session plus passkey or 2FA remains required before key rotation, reveal, export, or rebinding.</span></div>
                    <div><StatusPill state="missing" /><span>Better Auth is not proof of ENS ownership, wallet control, ERC-8004 identity, or agent runtime authenticity.</span></div>
                  </div>
                </section>

                <section className="card">
                  <h3>Reputation Evidence</h3>
                  <div className="auth-list">
                    <div><StatusPill state={domain && controllerVerified ? 'warn' : 'missing'} /><span>{domain && controllerVerified ? 'Identity is controller-attested locally; reputation providers still need live reads.' : 'Reputation reads require a bound identity and controller proof.'}</span></div>
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
