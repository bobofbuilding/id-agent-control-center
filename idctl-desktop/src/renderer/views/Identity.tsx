import { useEffect, useMemo, useState } from 'react';
import { call, type FleetStore, type TeamAgent } from '../store.ts';
import type { Agent } from '../../../../idctl/src/api/types.ts';
import type { AgentAccount, KeyCapabilities, SessionKey, SessionScope } from '../../../../idctl/src/keys/types.ts';

type EvidenceState = 'verified' | 'warn' | 'missing' | 'self';
type IdentityAgent = TeamAgent;

interface ControllerProof {
  agent: string;
  wallet: string;
  nonce: string;
  message: string;
  signature: string;
  verifiedAt: number;
  expiresAt: number;
}

interface ReviewRow {
  label: string;
  state: EvidenceState;
  note: string;
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
  a: { idchain_domain?: string | null; ows_wallet?: string | null; ows_address?: string | null; metadata?: unknown },
  key: 'idchain_domain' | 'ows_wallet' | 'ows_address' | 'skillmesh_address',
): string {
  const meta = a.metadata as { idchain_domain?: unknown; ows_wallet?: unknown; ows_address?: unknown; skillmesh_address?: unknown } | undefined;
  const direct = key === 'idchain_domain' ? a.idchain_domain : key === 'ows_wallet' ? a.ows_wallet : key === 'ows_address' ? a.ows_address : undefined;
  const value = direct ?? meta?.[key];
  return typeof value === 'string' ? value.trim() : '';
}

function isEthAddress(value: string): boolean {
  return /^0x[0-9a-fA-F]{40}$/.test(value.trim());
}

function controllerWallet(a: Agent | undefined): string {
  if (!a) return '';
  const candidates = [
    identityValue(a, 'ows_address'),
    identityValue(a, 'skillmesh_address'),
    identityValue(a, 'ows_wallet'),
  ];
  return candidates.find(isEthAddress) ?? '';
}

function hasWallet(a: Agent): boolean {
  return Boolean(controllerWallet(a));
}

function agentKey(a: IdentityAgent): string {
  return `${a.team ?? 'default'}:${a.name}`;
}

function uniqueAgents(agents: IdentityAgent[]): IdentityAgent[] {
  const seen = new Set<string>();
  return agents.filter((a) => {
    const key = agentKey(a);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function statusLabel(state: EvidenceState): string {
  if (state === 'verified') return 'verified';
  if (state === 'warn') return 'review';
  if (state === 'self') return 'declared';
  return 'missing';
}

function StatusPill({ state }: { state: EvidenceState }) {
  return <span className={`id-pill ${state}`}>{statusLabel(state)}</span>;
}

function statusTone(state: EvidenceState): string {
  return state === 'verified' ? 'ok-text' : state === 'missing' ? 'status-error' : 'warn-text';
}

function dotTone(state: EvidenceState): string {
  return state === 'verified' ? 'ok' : state === 'missing' ? 'err' : 'warn';
}

function isSignatureLike(value: string): boolean {
  return /^0x[0-9a-fA-F]{130}$/.test(value.trim());
}

function proofMatchesWallet(proof: ControllerProof | undefined, wallet: string): boolean {
  return Boolean(proof?.verifiedAt && proof.expiresAt > Date.now() && proof.signature && wallet && proof.wallet.toLowerCase() === wallet.toLowerCase());
}

function isUnsafeScope(scope: SessionScope | undefined): boolean {
  return !scope || scope.label.toLowerCase().includes('full') || scope.spendLimitWei === '0';
}

function isUnsafeTtl(ttl: { label: string; ms: number } | undefined): boolean {
  return !ttl || !Number.isFinite(ttl.ms) || ttl.ms <= 0;
}

function mockProviderWarning(caps: KeyCapabilities | null): string {
  if (!caps) return 'Checking key provider...';
  return caps.live ? `${caps.chainLabel} live provider` : `${caps.chainLabel} mock provider; no on-chain authority is created.`;
}

function reviewRows(
  agent: Agent | undefined,
  acct: AgentAccount | undefined,
  domain: string,
  wallet: string,
  controllerVerified: boolean,
): ReviewRow[] {
  const active = acct?.sessions.filter((s) => s.status === 'active') ?? [];
  const nonExpiring = active.filter((s) => s.validUntil === 0).length;
  return [
    {
      label: 'Controller proof',
      state: controllerVerified ? 'verified' : wallet ? 'warn' : 'missing',
      note: controllerVerified ? 'fresh wallet challenge recorded' : wallet ? 'sign a challenge before privileged actions' : 'provision a controller wallet first',
    },
    {
      label: 'Public identity',
      state: domain && wallet ? (controllerVerified ? 'verified' : 'self') : 'missing',
      note: domain && wallet ? `${domain} -> ${shortAddr(wallet)}` : 'name or wallet is missing',
    },
    {
      label: 'Safe account',
      state: acct?.deployed ? 'verified' : acct?.smartAccount ? 'warn' : 'missing',
      note: acct?.smartAccount ? `${shortAddr(acct.smartAccount)} ${acct.deployed ? 'deployed' : 'not deployed'}` : 'no account found',
    },
    {
      label: 'Session keys',
      state: nonExpiring ? 'warn' : active.length ? 'verified' : 'warn',
      note: nonExpiring ? `${nonExpiring} non-expiring grant needs review` : `${active.length} active grant${active.length === 1 ? '' : 's'}`,
    },
    {
      label: 'Live trust checks',
      state: 'warn',
      note: agent ? 'ENSIP / manifest / reputation resolver reads are still pending' : 'select an agent',
    },
  ];
}

function activeSessionSort(a: SessionKey, b: SessionKey): number {
  if (a.status !== b.status) return a.status === 'active' ? -1 : 1;
  return b.createdAt - a.createdAt;
}

export function Identity({ store }: { store: FleetStore }) {
  const [caps, setCaps] = useState<KeyCapabilities | null>(null);
  const [accounts, setAccounts] = useState<Record<string, AgentAccount>>({});
  const [presets, setPresets] = useState<{ scopes: SessionScope[]; ttls: { label: string; ms: number }[] } | null>(null);
  const [sel, setSel] = useState<string | null>(null);
  const [scopeIdx, setScopeIdx] = useState(1);
  const [ttlIdx, setTtlIdx] = useState(1);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [proofs, setProofs] = useState<Record<string, ControllerProof>>({});

  const identityAgents = useMemo(() => {
    const all = store.allAgents.length ? store.allAgents : store.agents.map((a) => ({ ...a, team: store.team ?? 'default' }));
    const sorted = uniqueAgents(all).sort((a, b) => Number(hasWallet(b)) - Number(hasWallet(a)) || (a.team ?? '').localeCompare(b.team ?? '') || a.name.localeCompare(b.name));
    return sorted;
  }, [store.allAgents, store.agents, store.team]);
  const names = useMemo(() => [...new Set(identityAgents.map((a) => a.name))], [identityAgents]);
  const selAgent = (sel ? identityAgents.find((a) => agentKey(a) === sel) : undefined) ?? identityAgents.find(hasWallet) ?? identityAgents[0];
  const selected = selAgent?.name;
  const selectedKey = selAgent ? agentKey(selAgent) : '';
  const acct = selected ? accounts[selected] : undefined;
  const selectedTeam = selAgent?.team;
  const domain = selAgent ? identityValue(selAgent, 'idchain_domain') : '';
  const wallet = controllerWallet(selAgent);
  const proof = selectedKey ? proofs[selectedKey] : undefined;
  const controllerVerified = proofMatchesWallet(proof, wallet);
  const activeSessions = useMemo(() => [...(acct?.sessions ?? [])].sort(activeSessionSort), [acct]);
  const safeScopes = useMemo(
    () => (presets?.scopes ?? []).map((scope, idx) => ({ scope, idx })).filter(({ scope }) => !isUnsafeScope(scope)),
    [presets],
  );
  const finiteTtls = useMemo(
    () => (presets?.ttls ?? []).map((ttl, idx) => ({ ttl, idx })).filter(({ ttl }) => !isUnsafeTtl(ttl)),
    [presets],
  );
  const issueScope = presets?.scopes[scopeIdx];
  const issueTtl = presets?.ttls[ttlIdx];
  const issueBlocked = !controllerVerified || isUnsafeScope(issueScope) || isUnsafeTtl(issueTtl);
  const review = useMemo(() => reviewRows(selAgent, acct, domain, wallet, controllerVerified), [selAgent, acct, domain, wallet, controllerVerified]);
  const readyCount = review.filter((r) => r.state === 'verified').length;

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
    void reload();
  }, [names.join('|')]);

  useEffect(() => {
    const nextScope = safeScopes[0]?.idx;
    if (nextScope !== undefined && isUnsafeScope(presets?.scopes[scopeIdx])) setScopeIdx(nextScope);
    const nextTtl = finiteTtls[0]?.idx;
    if (nextTtl !== undefined && isUnsafeTtl(presets?.ttls[ttlIdx])) setTtlIdx(nextTtl);
  }, [presets, safeScopes, finiteTtls, scopeIdx, ttlIdx]);

  useEffect(() => {
    if (!selected || !wallet || controllerVerified) return;
    let live = true;
    call<ControllerProof | null>('identity:controllerStatus', selected, wallet, selectedTeam)
      .then((status) => {
        if (live && status) setProofs((prev) => ({ ...prev, [selectedKey]: status }));
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [selected, selectedKey, wallet, selectedTeam, controllerVerified]);

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

  async function identityAction(agent: string, action: 'register' | 'provision', team?: string) {
    if (!window.confirm(`${action === 'register' ? 'Register identity' : 'Provision wallet'} for ${team ?? 'default'}/${agent}?\n\n${action === 'register' ? 'This writes the public identity binding for the selected controller wallet.' : 'This creates or binds a controller wallet for the agent.'}`)) return;
    setError(null);
    setBusy(true);
    try {
      await call(action === 'register' ? 'identity:register' : 'wallet:provision', agent, team);
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
      const challenge = await call<ControllerProof>('identity:controllerChallenge', selected, wallet, selectedTeam);
      setProofs((prev) => ({ ...prev, [selectedKey]: challenge }));
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
      [selectedKey]: { ...proof, signature, verifiedAt: 0 },
    }));
  }

  async function verifyControllerProof() {
    if (!selected || !proof) return;
    if (!isSignatureLike(proof.signature)) {
      setError('Paste a 0x-prefixed 65-byte signature from the controller wallet.');
      return;
    }
    setError(null);
    setBusy(true);
    try {
      const verified = await call<ControllerProof>('identity:controllerVerify', selected, wallet, proof.signature, selectedTeam);
      setProofs((prev) => ({ ...prev, [selectedKey]: verified }));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to verify controller signature');
    } finally {
      setBusy(false);
    }
  }

  function requireControllerProof(label: string, fn: () => void) {
    if (!controllerVerified) {
      setError(`${label} requires a fresh signed controller-wallet challenge.`);
      return;
    }
    fn();
  }

  function issueSession() {
    if (!presets || !selected || issueBlocked) {
      setError(controllerVerified ? 'Choose a capped scope and finite TTL.' : 'Issue session key requires a signed controller-wallet challenge first.');
      return;
    }
    if (!window.confirm(`Issue session key for ${selectedTeam ?? 'default'}/${selected}?\n\nScope: ${issueScope?.label ?? 'unknown'}\nTTL: ${issueTtl?.label ?? 'unknown'}\n\nThis creates a live spend-capped delegated key until it expires or is revoked.`)) return;
    void act('keys:issue', selected, scopeIdx, presets.ttls[ttlIdx].ms, selectedTeam);
  }

  return (
    <div className="view identity-view">
      <header className="view-head">
        <div>
          <h1>Identity & Keys</h1>
          <div className="muted small">Verify controller control, manage the agent account, and issue only scoped session keys.</div>
        </div>
        <span className={caps?.live ? 'ok-text' : 'warn-text'}>{mockProviderWarning(caps)}</span>
      </header>

      <div className="cols identity-shell">
        <section className="card identity-agents">
          <h3>Agents</h3>
          {identityAgents.map((a) => {
            const agentWallet = controllerWallet(a);
            const agentProof = proofs[agentKey(a)];
            const verified = proofMatchesWallet(agentProof, agentWallet);
            return (
              <button key={agentKey(a)} className={`target${agentKey(a) === selectedKey ? ' active' : ''}`} onClick={() => setSel(agentKey(a))}>
                <span>{a.name}</span>
                <span className="muted small">{identityValue(a, 'idchain_domain') || a.team || a.status || 'unbound'}</span>
                <span className={verified ? 'ok-text small' : agentWallet ? 'warn-text small' : 'muted small'}>
                  {verified ? 'controller verified' : agentWallet ? `wallet ${shortAddr(agentWallet)}` : 'no wallet'}
                </span>
              </button>
            );
          })}
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
                    {selectedTeam ? <span className="muted small">{selectedTeam}</span> : null}
                    <StatusPill state={controllerVerified ? 'verified' : wallet ? 'warn' : 'missing'} />
                  </div>
                </div>
                <div className="identity-metrics">
                  <div><b>{readyCount}/{review.length}</b><span>ready checks</span></div>
                  <div><b>{activeSessions.filter((s) => s.status === 'active').length}</b><span>active keys</span></div>
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

              <section className="card identity-gate">
                <div>
                  <h3>Security Gate</h3>
                  <p className="muted">Privileged actions stay locked until the controller wallet signs a fresh challenge.</p>
                </div>
                <div className="controller-proof">
                  <div className="risk-row">
                    <span className={`dot ${controllerVerified ? 'ok' : wallet ? 'warn' : 'err'}`} />
                    <b>{controllerVerified ? 'Controller verified' : 'Controller proof required'}</b>
                    <span className={controllerVerified ? 'ok-text' : wallet ? 'warn-text' : 'status-error'}>
                      {controllerVerified ? `valid until ${new Date(proof!.expiresAt).toLocaleTimeString()}` : wallet ? `wallet ${shortAddr(wallet)}` : 'no controller wallet'}
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
                    <button className="btn primary" disabled={busy || !proof || !proof.signature || controllerVerified} onClick={verifyControllerProof}>Verify signature</button>
                  </div>
                </div>
              </section>

              <div className="identity-grid">
                <section className="card">
                  <h3>Account</h3>
                  <div className="kv identity-kv">
                    <span>Controller</span>
                    <b className={wallet ? 'mono' : 'muted'}>{wallet ? shortAddr(wallet) : 'not provisioned'}</b>
                    <span>Safe</span>
                    <b className="mono">{shortAddr(acct.smartAccount)}</b>
                    <span>Owner</span>
                    <b className="mono">{shortAddr(acct.owner)}</b>
                    <span>Chain</span>
                    <b>{acct.chainId}</b>
                  </div>
                  <div className="row-actions identity-actions">
                    {!wallet ? (
                      <button className="btn" disabled={busy} onClick={() => void identityAction(selected!, 'provision', selectedTeam)}>
                        Provision wallet
                      </button>
                    ) : null}
                    <button className="btn" disabled={busy} onClick={() => {
                      if (!window.confirm(`Create account for ${selectedTeam ?? 'default'}/${selected}?\n\nThis ensures a smart-account record for the selected agent.`)) return;
                      void act('keys:ensure', selected);
                    }}>
                      Create account
                    </button>
                    <button className="btn" disabled={busy || !controllerVerified} onClick={() => requireControllerProof('Register identity', () => void identityAction(selected!, 'register', selectedTeam))}>
                      Register identity
                    </button>
                    <button className="btn primary" disabled={busy || acct.deployed || !controllerVerified} onClick={() => requireControllerProof('Deploy account', () => {
                      if (!window.confirm(`Deploy account for ${selectedTeam ?? 'default'}/${selected}?\n\nThis deploys the selected smart account using the verified controller authority.`)) return;
                      void act('keys:deploy', selected, selectedTeam);
                    })}>
                      Deploy
                    </button>
                  </div>
                </section>

                <section className="card">
                  <h3>Security Review</h3>
                  <div className="risk-list">
                    {review.map((r) => (
                      <div key={r.label} className="risk-row">
                        <span className={`dot ${dotTone(r.state)}`} />
                        <b>{r.label}</b>
                        <span className={statusTone(r.state)}>{r.note}</span>
                      </div>
                    ))}
                  </div>
                </section>
              </div>

              <section className="card">
                <h3>Session Keys</h3>
                <table className="grid identity-table">
                  <thead>
                    <tr>
                      <th>Scope</th>
                      <th>Signer</th>
                      <th>Spend cap</th>
                      <th>Status</th>
                      <th>Action</th>
                    </tr>
                  </thead>
                  <tbody>
                    {activeSessions.map((s) => (
                      <tr key={s.id}>
                        <td className="b">{s.scope.label}</td>
                        <td className="mono muted">{shortAddr(s.address)}</td>
                        <td className={s.scope.spendLimitWei === '0' ? 'warn-text mono small' : 'mono small'}>
                          {s.scope.spendLimitWei === '0' ? 'uncapped' : s.scope.spendLimitWei}
                        </td>
                        <td className={s.status === 'active' ? 'ok-text' : s.status === 'revoked' ? 'status-error' : 'muted'}>
                          {s.status === 'active' ? remaining(s.validUntil) : s.status}
                        </td>
                        <td className="row-actions">
                          {s.status === 'active' ? (
                            <button className="btn" disabled={busy || !controllerVerified} onClick={() => requireControllerProof('Revoke session key', () => {
                              if (!window.confirm(`Revoke session key ${shortAddr(s.address)}?\n\nThis disables the active delegated key for ${selectedTeam ?? 'default'}/${selected}.`)) return;
                              void act('keys:revoke', selected, s.id, selectedTeam);
                            })}>
                              Revoke
                            </button>
                          ) : null}
                        </td>
                      </tr>
                    ))}
                    {activeSessions.length === 0 ? (
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
                    <select value={scopeIdx} onChange={(e) => setScopeIdx(Number(e.target.value))} disabled={!safeScopes.length}>
                      {safeScopes.map(({ scope, idx }) => (
                        <option key={idx} value={idx}>
                          {scope.label}
                        </option>
                      ))}
                    </select>
                    <select value={ttlIdx} onChange={(e) => setTtlIdx(Number(e.target.value))} disabled={!finiteTtls.length}>
                      {finiteTtls.map(({ ttl, idx }) => (
                        <option key={idx} value={idx}>
                          {ttl.label}
                        </option>
                      ))}
                    </select>
                    <button className="btn primary" disabled={busy || issueBlocked} onClick={issueSession}>
                      Issue scoped key
                    </button>
                  </div>
                ) : null}
                <p className="muted small">
                  This screen only issues finite, spend-capped keys. Full, uncapped, and non-expiring grants are blocked by the UI and bridge.
                </p>
              </section>

              <details className="card identity-details">
                <summary>Advanced evidence</summary>
                <div className="identity-detail-grid">
                  <div className="kv identity-kv">
                    <span>ENS / ID-chain</span>
                    <b className={domain ? 'mono' : 'muted'}>{domain || '-'}</b>
                    <span>Runtime</span>
                    <b>{selAgent?.runtime ?? '-'}</b>
                    <span>Model</span>
                    <b>{selAgent?.model ?? '-'}</b>
                    <span>Provider</span>
                    <b>{caps?.provider ?? '-'}</b>
                  </div>
                  <div className="auth-list">
                    <div><StatusPill state="warn" /><span>Live ENSIP-25/26 resolver checks are still pending.</span></div>
                    <div><StatusPill state="warn" /><span>Manifest hash and runtime signature verification are still pending.</span></div>
                    <div><StatusPill state="self" /><span>Better Auth proves operator login only; it is not wallet or agent identity proof.</span></div>
                  </div>
                </div>
              </details>
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
