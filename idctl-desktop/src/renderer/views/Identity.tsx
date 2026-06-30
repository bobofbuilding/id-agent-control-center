import { useEffect, useMemo, useState } from 'react';
import { call, type FleetStore, type TeamAgent } from '../store.ts';
import type { Agent } from '../../../../idctl/src/api/types.ts';
import type { AgentAccount, KeyAuthorityTarget, KeyCapabilities, LegacyKeyAuthority, SessionKey, SessionScope } from '../../../../idctl/src/keys/types.ts';

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

interface BrainControllerLink {
  agent_id?: string;
  agentId?: string;
  role?: string;
  authority_level?: string;
  authorityLevel?: string;
  status?: string;
}

interface BrainController {
  controller_id?: string;
  controllerId?: string;
  scope_user_id?: string;
  type?: string;
  label?: string;
  name?: string;
  primary_wallet?: string;
  primaryWallet?: string;
  status?: string;
  agent_links?: BrainControllerLink[];
  agentLinks?: BrainControllerLink[];
}

type BrainControllerReport = {
  generatedAt?: string;
  route?: string;
  total?: number;
  activeLinks?: number;
  controllers?: BrainController[];
  warnings?: string[];
} | null;

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

function legacyAuthorityTarget(authority: string, agents: IdentityAgent[]): IdentityAgent | undefined {
  const sep = authority.indexOf(':');
  if (sep < 0) return undefined;
  const team = authority.slice(0, sep);
  const name = authority.slice(sep + 1);
  return agents.find((a) => (a.team ?? 'default') === team && a.name === name);
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

function identityAgentStamp(a: IdentityAgent): string {
  return JSON.stringify({
    id: a.id,
    name: a.name,
    team: a.team ?? 'default',
    status: a.status ?? '',
    runtime: a.runtime ?? '',
    model: a.model ?? '',
    domain: identityValue(a, 'idchain_domain'),
    wallet: controllerWallet(a),
  });
}

function brainControllerLinks(c: BrainController): BrainControllerLink[] {
  return c.agent_links ?? c.agentLinks ?? [];
}

function brainLinkAgentId(link: BrainControllerLink): string {
  return String(link.agent_id ?? link.agentId ?? '').trim();
}

function brainControllerName(c: BrainController | undefined): string {
  if (!c) return 'none';
  return c.label || c.name || c.controller_id || c.controllerId || 'unnamed controller';
}

function brainControllerForAgent(
  report: BrainControllerReport,
  agent: IdentityAgent | undefined,
  duplicateNames: Set<string>,
): { state: EvidenceState; note: string; controller?: BrainController; ambiguous?: boolean } {
  if (!agent) return { state: 'missing', note: 'select an agent' };
  if (!report) return { state: 'warn', note: 'Brain /controllers unavailable; Brain Agents controller fallbacks are not verified' };
  const controllers = report.controllers ?? [];
  const team = agent.team ?? 'default';
  const strongIds = new Set([
    agent.id,
    `${team}/${agent.name}`,
    `${team}:${agent.name}`,
    `agent:${team}/${agent.name}`,
    `agent:${team}:${agent.name}`,
  ].filter(Boolean));
  const bareIds = new Set([agent.name, `agent:${agent.name}`]);
  const strong = controllers.find((c) => brainControllerLinks(c).some((link) => strongIds.has(brainLinkAgentId(link)) && (link.status ?? 'active') === 'active'));
  if (strong) return { state: 'verified', note: `Brain controller linked: ${brainControllerName(strong)}`, controller: strong };
  const bare = controllers.find((c) => brainControllerLinks(c).some((link) => bareIds.has(brainLinkAgentId(link)) && (link.status ?? 'active') === 'active'));
  if (bare) {
    if (duplicateNames.has(agent.name)) {
      return { state: 'warn', note: `Bare Brain controller link is ambiguous for duplicate agent name ${agent.name}`, controller: bare, ambiguous: true };
    }
    return { state: 'self', note: `Brain controller linked by bare agent id: ${brainControllerName(bare)}`, controller: bare };
  }
  return { state: 'warn', note: `No active Brain controller link for ${team}/${agent.name}` };
}

function sessionStamp(s: SessionKey): string {
  return JSON.stringify({
    id: s.id,
    address: s.address,
    status: s.status,
    validUntil: s.validUntil,
    scope: s.scope.label,
    spendLimitWei: s.scope.spendLimitWei,
  });
}
function accountStamp(a: AgentAccount | null | undefined): string {
  return JSON.stringify(a ? {
    agent: a.agent,
    smartAccount: a.smartAccount,
    owner: a.owner,
    deployed: a.deployed,
    chainId: a.chainId,
    sessions: a.sessions.map(sessionStamp).sort(),
  } : null);
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
  const [legacyMsg, setLegacyMsg] = useState<string | null>(null);
  const [proofs, setProofs] = useState<Record<string, ControllerProof>>({});
  const [legacyKeys, setLegacyKeys] = useState<LegacyKeyAuthority[]>([]);
  const [brainControllers, setBrainControllers] = useState<BrainControllerReport>(null);

  const identityAgents = useMemo(() => {
    const all = store.allAgents.length ? store.allAgents : store.agents.map((a) => ({ ...a, team: store.team ?? 'default' }));
    const sorted = uniqueAgents(all).sort((a, b) => Number(hasWallet(b)) - Number(hasWallet(a)) || (a.team ?? '').localeCompare(b.team ?? '') || a.name.localeCompare(b.name));
    return sorted;
  }, [store.allAgents, store.agents, store.team]);
  const duplicateNames = useMemo(() => {
    const counts = new Map<string, number>();
    for (const agent of identityAgents) counts.set(agent.name, (counts.get(agent.name) ?? 0) + 1);
    return new Set([...counts.entries()].filter(([, count]) => count > 1).map(([name]) => name));
  }, [identityAgents]);
  const authorityTargets = useMemo<KeyAuthorityTarget[]>(() => identityAgents.map((a) => ({ name: a.name, team: a.team ?? 'default' })), [identityAgents]);
  const authorityTargetKey = useMemo(() => authorityTargets.map((a) => `${a.team ?? ''}:${a.name}`).join('|'), [authorityTargets]);
  const accountKeys = useMemo(() => identityAgents.map(agentKey), [identityAgents]);
  const selAgent = (sel ? identityAgents.find((a) => agentKey(a) === sel) : undefined) ?? identityAgents.find(hasWallet) ?? identityAgents[0];
  const selected = selAgent?.name;
  const selectedKey = selAgent ? agentKey(selAgent) : '';
  const acct = selectedKey ? accounts[selectedKey] : undefined;
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
  const brainSelectedController = useMemo(() => brainControllerForAgent(brainControllers, selAgent, duplicateNames), [brainControllers, selAgent, duplicateNames]);
  const brainControllerMatches = useMemo(
    () => identityAgents.map((agent) => brainControllerForAgent(brainControllers, agent, duplicateNames)),
    [brainControllers, identityAgents, duplicateNames],
  );
  const brainLinkedAgents = brainControllerMatches.filter((match) => match.state === 'verified' || match.state === 'self').length;
  const brainAmbiguousLinks = brainControllerMatches.filter((match) => match.ambiguous).length;
  const brainControllerNeedsReview = !brainControllers || (brainControllers.activeLinks ?? 0) === 0 || brainSelectedController.state === 'warn' || brainAmbiguousLinks > 0;
  const brainControllerLabel = brainControllers
    ? `Brain controllers ${brainLinkedAgents}/${identityAgents.length}`
    : 'Brain controllers --';
  const brainControllerTitle = brainControllers
    ? [
      `Route: ${brainControllers.route ?? '/controllers'}`,
      `Controllers: ${brainControllers.total ?? 0}`,
      `Active links: ${brainControllers.activeLinks ?? 0}`,
      `Linked current agents: ${brainLinkedAgents}/${identityAgents.length}`,
      brainAmbiguousLinks ? `Ambiguous bare-name links: ${brainAmbiguousLinks}` : '',
      brainControllers.generatedAt ? `Read: ${brainControllers.generatedAt}` : '',
      ...(brainControllers.warnings ?? []),
    ].filter(Boolean).join('\n')
    : 'Brain /controllers unavailable; Brain Agents controller fallback should not be trusted.';
  function controllerProofValidFor(agent: IdentityAgent): boolean {
    return proofMatchesWallet(proofs[agentKey(agent)], controllerWallet(agent));
  }

  async function freshIdentityAgents(): Promise<IdentityAgent[] | null> {
    const groups = await call<{ team: string; agents: Agent[] }[]>('agents:allTeams').catch(() => null);
    if (groups) return uniqueAgents(groups.flatMap((g) => g.agents.map((a) => ({ ...a, team: g.team }))));
    const ag = await call<Agent[]>('agents').catch(() => null);
    return ag ? uniqueAgents(ag.map((a) => ({ ...a, team: store.team ?? 'default' }))) : null;
  }

  function findFreshIdentityAgent(list: IdentityAgent[], a: IdentityAgent): IdentityAgent | undefined {
    const team = a.team ?? 'default';
    return list.find((x) => (x.team ?? 'default') === team && x.id === a.id)
      ?? list.find((x) => (x.team ?? 'default') === team && x.name === a.name);
  }

  async function ensureSelectedFresh(action: string): Promise<IdentityAgent | null> {
    if (!selAgent) {
      setError('Select an agent first.');
      return null;
    }
    const list = await freshIdentityAgents();
    if (!list) {
      setError(`Could not verify the current agent before ${action}. Refresh and try again.`);
      return null;
    }
    const current = findFreshIdentityAgent(list, selAgent);
    if (!current) {
      setError(`${selectedTeam ?? 'default'}/${selected ?? 'agent'} is no longer in the fleet snapshot. Refreshing Identity.`);
      store.refresh();
      return null;
    }
    if (identityAgentStamp(current) !== identityAgentStamp(selAgent)) {
      setError(`${selectedTeam ?? 'default'}/${selected ?? 'agent'} changed before ${action}. Refreshing Identity; review the current row before retrying.`);
      store.refresh();
      return null;
    }
    return current;
  }

  async function latestAccountFor(key: string): Promise<AgentAccount | null> {
    const list = await call<AgentAccount[]>('keys:list', [key]).catch(() => null);
    if (!list) return null;
    const next = list[0] ?? null;
    setAccounts((prev) => next ? { ...prev, [next.agent]: next } : prev);
    return next;
  }

  async function reload() {
    if (accountKeys.length === 0) return;
    try {
      const list = await call<AgentAccount[]>('keys:list', accountKeys);
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
    let live = true;
    call<BrainControllerReport>('brain:controllerReport')
      .then((report) => {
        if (live) setBrainControllers(report);
      })
      .catch(() => {
        if (live) setBrainControllers(null);
      });
    return () => {
      live = false;
    };
  }, [store.lastUpdated]);

  useEffect(() => {
    void reload();
  }, [accountKeys.join('|')]);

  useEffect(() => {
    if (!authorityTargets.length) {
      setLegacyKeys([]);
      return;
    }
    let live = true;
    call<LegacyKeyAuthority[]>('keys:legacyAuthority', authorityTargets)
      .then((rows) => {
        if (live) setLegacyKeys(rows);
      })
      .catch(() => {
        if (live) setLegacyKeys([]);
      });
    return () => {
      live = false;
    };
  }, [authorityTargetKey]);

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

  async function identityAction(action: 'register' | 'provision') {
    const fresh = await ensureSelectedFresh(action === 'register' ? 'registering identity' : 'provisioning wallet');
    if (!fresh) return;
    const team = fresh.team ?? 'default';
    if (!window.confirm(`${action === 'register' ? 'Register identity' : 'Provision wallet'} for ${team}/${fresh.name}?\n\n${action === 'register' ? 'This writes the public identity binding for the selected controller wallet.' : 'This creates or binds a controller wallet for the agent.'}`)) return;
    const afterConfirm = await ensureSelectedFresh(action === 'register' ? 'registering identity after review' : 'provisioning wallet after review');
    if (!afterConfirm) return;
    if (action === 'register' && !controllerProofValidFor(afterConfirm)) {
      setError('Controller proof expired or changed after confirmation. Sign a fresh challenge before registering identity.');
      return;
    }
    setError(null);
    setBusy(true);
    try {
      await call(action === 'register' ? 'identity:register' : 'wallet:provision', afterConfirm.name, afterConfirm.team ?? 'default');
      store.refresh();
      await reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : `${action} failed`);
    } finally {
      setBusy(false);
    }
  }

  async function startChallenge() {
    const fresh = await ensureSelectedFresh('starting controller challenge');
    if (!fresh) return;
    const currentWallet = controllerWallet(fresh);
    if (!currentWallet) return;
    const key = agentKey(fresh);
    setError(null);
    setBusy(true);
    try {
      const challenge = await call<ControllerProof>('identity:controllerChallenge', fresh.name, currentWallet, fresh.team);
      setProofs((prev) => ({ ...prev, [key]: challenge }));
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
    const fresh = await ensureSelectedFresh('verifying controller proof');
    if (!fresh) return;
    const key = agentKey(fresh);
    const currentProof = proofs[key];
    const currentWallet = controllerWallet(fresh);
    if (!currentProof) return;
    if (!isSignatureLike(currentProof.signature)) {
      setError('Paste a 0x-prefixed 65-byte signature from the controller wallet.');
      return;
    }
    setError(null);
    setBusy(true);
    try {
      const verified = await call<ControllerProof>('identity:controllerVerify', fresh.name, currentWallet, currentProof.signature, fresh.team);
      setProofs((prev) => ({ ...prev, [key]: verified }));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to verify controller signature');
    } finally {
      setBusy(false);
    }
  }

  async function createAccount() {
    const fresh = await ensureSelectedFresh('creating account');
    if (!fresh) return;
    if (!controllerProofValidFor(fresh)) {
      setError('Create account requires a signed controller-wallet challenge first.');
      return;
    }
    const key = agentKey(fresh);
    const reviewedAccount = await latestAccountFor(key);
    const team = fresh.team ?? 'default';
    if (!window.confirm(`Create account for ${team}/${fresh.name}?\n\nThis ensures a smart-account record for the selected agent.`)) return;
    const afterConfirm = await ensureSelectedFresh('creating account after review');
    if (!afterConfirm) return;
    if (!controllerProofValidFor(afterConfirm)) {
      setError('Controller proof expired or changed after confirmation. Sign a fresh challenge before creating the account.');
      return;
    }
    const latestAccount = await latestAccountFor(agentKey(afterConfirm));
    if (accountStamp(latestAccount) !== accountStamp(reviewedAccount)) {
      setError('Account state changed after confirmation. Identity has refreshed the latest account state; review and retry.');
      return;
    }
    await act('keys:ensure', afterConfirm.name, afterConfirm.team ?? 'default');
  }

  async function deployAccount() {
    const fresh = await ensureSelectedFresh('deploying account');
    if (!fresh) return;
    const key = agentKey(fresh);
    const latest = await latestAccountFor(key);
    if (latest?.deployed) {
      setError('Account is already deployed. Identity has refreshed the latest account state.');
      return;
    }
    const team = fresh.team ?? 'default';
    if (!window.confirm(`Deploy account for ${team}/${fresh.name}?\n\nThis deploys the selected smart account using the verified controller authority.`)) return;
    const afterConfirm = await ensureSelectedFresh('deploying account after review');
    if (!afterConfirm) return;
    if (!controllerProofValidFor(afterConfirm)) {
      setError('Controller proof expired or changed after confirmation. Sign a fresh challenge before deploying.');
      return;
    }
    const latestAfterConfirm = await latestAccountFor(agentKey(afterConfirm));
    if (!latestAfterConfirm || accountStamp(latestAfterConfirm) !== accountStamp(latest) || latestAfterConfirm.deployed) {
      setError('Account state changed after confirmation. Identity has refreshed the latest account state; review and retry.');
      return;
    }
    await act('keys:deploy', afterConfirm.name, afterConfirm.team ?? 'default');
  }

  async function issueSession() {
    const fresh = await ensureSelectedFresh('issuing session key');
    if (!presets || !fresh || issueBlocked) {
      setError(controllerVerified ? 'Choose a capped scope and finite TTL.' : 'Issue session key requires a signed controller-wallet challenge first.');
      return;
    }
    const team = fresh.team ?? 'default';
    const reviewedAccount = await latestAccountFor(agentKey(fresh));
    if (!window.confirm(`Issue session key for ${team}/${fresh.name}?\n\nScope: ${issueScope?.label ?? 'unknown'}\nTTL: ${issueTtl?.label ?? 'unknown'}\n\nThis creates a live spend-capped delegated key until it expires or is revoked.`)) return;
    const afterConfirm = await ensureSelectedFresh('issuing session key after review');
    if (!afterConfirm) return;
    if (!controllerProofValidFor(afterConfirm)) {
      setError('Controller proof expired or changed after confirmation. Sign a fresh challenge before issuing a key.');
      return;
    }
    const latestAccount = await latestAccountFor(agentKey(afterConfirm));
    if (accountStamp(latestAccount) !== accountStamp(reviewedAccount)) {
      setError('Account or session state changed after confirmation. Identity has refreshed the latest account state; review and retry.');
      return;
    }
    await act('keys:issue', afterConfirm.name, scopeIdx, presets.ttls[ttlIdx].ms, afterConfirm.team ?? 'default');
  }

  async function revokeSession(s: SessionKey) {
    const fresh = await ensureSelectedFresh('revoking session key');
    if (!fresh) return;
    const key = agentKey(fresh);
    const latest = await latestAccountFor(key);
    const current = latest?.sessions.find((row) => row.id === s.id);
    if (!current || current.status !== 'active' || sessionStamp(current) !== sessionStamp(s)) {
      setError('Session key changed before revoke. Identity has refreshed the latest account state; review and retry.');
      return;
    }
    const team = fresh.team ?? 'default';
    if (!window.confirm(`Revoke session key ${shortAddr(current.address)}?\n\nThis disables the active delegated key for ${team}/${fresh.name}.`)) return;
    const afterConfirm = await ensureSelectedFresh('revoking session key after review');
    if (!afterConfirm) return;
    if (!controllerProofValidFor(afterConfirm)) {
      setError('Controller proof expired or changed after confirmation. Sign a fresh challenge before revoking.');
      return;
    }
    const latestAfterConfirm = await latestAccountFor(agentKey(afterConfirm));
    const currentAfterConfirm = latestAfterConfirm?.sessions.find((row) => row.id === current.id);
    if (!currentAfterConfirm || currentAfterConfirm.status !== 'active' || sessionStamp(currentAfterConfirm) !== sessionStamp(current)) {
      setError('Session key changed after confirmation. Identity has refreshed the latest account state; review and retry.');
      return;
    }
    await act('keys:revoke', afterConfirm.name, currentAfterConfirm.id, afterConfirm.team ?? 'default');
  }

  async function copyLegacyAuthority(authority: string) {
    try {
      await navigator.clipboard.writeText(authority);
      setLegacyMsg(`Copied scoped authority ${authority}.`);
    } catch {
      setLegacyMsg(`Copy failed. Scoped authority: ${authority}`);
    }
  }

  return (
    <div className="view identity-view">
      <header className="view-head">
        <div>
          <h1>Identity & Keys</h1>
          <div className="muted small">Verify controller control, manage the agent account, and issue only scoped session keys.</div>
        </div>
        <div className="identity-head-status">
          <span className={caps?.live ? 'ok-text' : 'warn-text'}>{mockProviderWarning(caps)}</span>
          <span className={brainControllerNeedsReview ? 'warn-text' : 'ok-text'} title={brainControllerTitle}>{brainControllerLabel}</span>
        </div>
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

              {legacyKeys.length ? (
                <section className="card identity-legacy" role="status">
                  <div className="identity-legacy-head">
                    <h3>Legacy Authority Review</h3>
                    <StatusPill state="warn" />
                  </div>
                  <p className="muted small">
                    Older bare-name key records were found. They are not treated as current scoped authority, so choose a policy before copying, revoking, or deleting them.
                  </p>
                  <div className="risk-list">
                    {legacyKeys.map((row) => {
                      const firstAuthority = row.currentAuthorities[0] ?? '';
                      const target = row.currentAuthorities.map((a) => legacyAuthorityTarget(a, identityAgents)).find(Boolean);
                      return (
                        <div key={`${row.source}:${row.agent}`} className="risk-row">
                          <span className="dot warn" />
                          <b>{row.agent}</b>
                          <span>
                            <span className="warn-text">
                              {row.account ? 'account' : 'no account'}{row.deployed ? ' deployed' : ''}; {row.activeSessions}/{row.totalSessions} active sessions{row.nonExpiringSessions ? `, ${row.nonExpiringSessions} non-expiring` : ''}{' -> '}{row.currentAuthorities.join(', ')}
                            </span>
                            <span className="legacy-review-actions">
                              {target ? (
                                <button className="btn small" disabled={busy} onClick={() => { setSel(agentKey(target)); setLegacyMsg(`Selected ${agentKey(target)}. Recreate scoped account/session authority from the normal controls; legacy records stay blocked.`); }}>
                                  Select scoped agent
                                </button>
                              ) : null}
                              {firstAuthority ? (
                                <button className="btn small" disabled={busy} onClick={() => void copyLegacyAuthority(firstAuthority)}>
                                  Copy scoped authority
                                </button>
                              ) : null}
                            </span>
                          </span>
                        </div>
                      );
                    })}
                  </div>
                  {legacyMsg ? <div className="muted small" style={{ marginTop: 8 }}>{legacyMsg}</div> : null}
                </section>
              ) : null}

              <section className={`card ${brainControllerNeedsReview ? 'identity-legacy' : ''}`} role="status">
                <div className="identity-legacy-head">
                  <h3>Brain Controller Sync</h3>
                  <StatusPill state={brainSelectedController.state} />
                </div>
                <p className="muted small">
                  Read-only Brain <span className="mono">/controllers</span> evidence for accountable identity. It does not create, link, revoke, or promote controller records.
                </p>
                <div className="risk-list">
                  <div className="risk-row">
                    <span className={`dot ${dotTone(brainSelectedController.state)}`} />
                    <b>Selected agent</b>
                    <span className={statusTone(brainSelectedController.state)}>{brainSelectedController.note}</span>
                  </div>
                  <div className="risk-row">
                    <span className={`dot ${brainControllers && (brainControllers.activeLinks ?? 0) > 0 ? 'ok' : 'warn'}`} />
                    <b>Brain links</b>
                    <span className={brainControllers && (brainControllers.activeLinks ?? 0) > 0 ? 'ok-text' : 'warn-text'}>
                      {brainControllers ? `${brainControllers.activeLinks ?? 0} active links across ${brainControllers.total ?? 0} controllers; ${brainLinkedAgents}/${identityAgents.length} current agents matched` : 'route unavailable'}
                    </span>
                  </div>
                  <div className="risk-row">
                    <span className={`dot ${brainAmbiguousLinks ? 'warn' : 'ok'}`} />
                    <b>Fallback safety</b>
                    <span className={brainAmbiguousLinks ? 'warn-text' : 'muted'}>
                      {brainAmbiguousLinks ? `${brainAmbiguousLinks} bare-name Brain link${brainAmbiguousLinks === 1 ? '' : 's'} ambiguous across duplicate agent names` : 'Scoped or unique matches only; bare duplicate links stay review-only.'}
                    </span>
                  </div>
                </div>
              </section>

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
                    <button className="btn" disabled={busy || !wallet} onClick={() => void startChallenge()}>New challenge</button>
                    <button className="btn primary" disabled={busy || !proof || !proof.signature || controllerVerified} onClick={() => void verifyControllerProof()}>Verify signature</button>
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
                      <button className="btn" disabled={busy} onClick={() => void identityAction('provision')}>
                        Provision wallet
                      </button>
                    ) : null}
                    <button className="btn" disabled={busy || !controllerVerified} onClick={() => void createAccount()}>
                      Create account
                    </button>
                    <button className="btn" disabled={busy || !controllerVerified} onClick={() => void identityAction('register')}>
                      Register identity
                    </button>
                    <button className="btn primary" disabled={busy || acct.deployed || !controllerVerified} onClick={() => void deployAccount()}>
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
                            <button className="btn" disabled={busy || !controllerVerified} onClick={() => void revokeSession(s)}>
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
                    <button className="btn primary" disabled={busy || issueBlocked} onClick={() => void issueSession()}>
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
