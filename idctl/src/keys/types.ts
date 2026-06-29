/**
 * Agent key-management model: a Safe smart account per agent + scoped,
 * revocable, time-boxed ERC-4337 session keys. The TUI talks to a KeyProvider;
 * MockKeyProvider simulates everything locally so the UX is testable with no
 * bundler/testnet. A Safe4337KeyProvider (real bundler + manager endpoints)
 * implements the same interface later — no view changes needed.
 */

export interface SessionScope {
  /** Human label, e.g. "skill-publish", "registry-write". */
  label: string;
  /** Allowed target contract addresses ('*' = any). */
  targets: string[];
  /** Max native-token spend over the session lifetime, in wei (string). */
  spendLimitWei: string;
}

export type SessionStatus = 'active' | 'expired' | 'revoked';

export interface SessionKey {
  id: string;
  agent: string;
  /** The session signer address the agent uses to act. */
  address: string;
  scope: SessionScope;
  createdAt: number;
  /** Expiry (ms epoch); after this the key is invalid. */
  validUntil: number;
  status: SessionStatus;
}

export interface AgentAccount {
  agent: string;
  /** The agent's Safe smart-account address (counterfactual until deployed). */
  smartAccount: string;
  /** The controlling owner (a Safe multisig or owner EOA). */
  owner: string;
  /** Whether the Safe is deployed on-chain (vs counterfactual). */
  deployed: boolean;
  chainId: number;
  sessions: SessionKey[];
}

export interface KeyCapabilities {
  provider: 'mock' | 'safe-4337';
  chainId: number;
  /** Human label for the active chain, e.g. "Base Sepolia (mock)". */
  chainLabel: string;
  /** Whether the provider can actually deploy/broadcast (false for mock). */
  live: boolean;
}

export interface KeyAuthorityTarget {
  name: string;
  team?: string;
}

export interface LegacyKeyAuthority {
  agent: string;
  currentAuthorities: string[];
  source: 'mock-key-provider' | 'tauri-localStorage';
  account: boolean;
  deployed: boolean;
  totalSessions: number;
  activeSessions: number;
  nonExpiringSessions: number;
  note: string;
}

export interface KeyProvider {
  capabilities(): KeyCapabilities;
  /** All known agent accounts (creates nothing). */
  listAccounts(agents: string[]): Promise<AgentAccount[]>;
  /** Ensure an account exists for the agent (deterministic), returning it. */
  ensureAccount(agent: string, owner?: string): Promise<AgentAccount>;
  /** Mark the agent's Safe as deployed on-chain. */
  deployAccount(agent: string): Promise<AgentAccount>;
  /** Issue a scoped, expiring session key for the agent. */
  issueSession(agent: string, scope: SessionScope, ttlMs: number): Promise<SessionKey>;
  /** Revoke a session key. */
  revokeSession(agent: string, sessionId: string): Promise<void>;
}

/** Preset scopes offered in the issue-session wizard. */
export const SCOPE_PRESETS: SessionScope[] = [
  { label: 'registry-write', targets: ['*'], spendLimitWei: '0' },
  { label: 'skill-publish', targets: ['*'], spendLimitWei: '10000000000000000' /* 0.01 */ },
  { label: 'payments', targets: ['*'], spendLimitWei: '100000000000000000' /* 0.1 */ },
  { label: 'full (no spend cap)', targets: ['*'], spendLimitWei: '0' },
];

/**
 * TTL options (ms) offered in the issue-session wizard. `ms: 0` is the sentinel
 * for a non-expiring key — it stays active until explicitly revoked (stored as
 * validUntil: 0). The provider and views treat validUntil===0 as "until revoked".
 */
export const NO_EXPIRY_MS = 0;
export const TTL_PRESETS: { label: string; ms: number }[] = [
  { label: '1 hour', ms: 3600_000 },
  { label: '24 hours', ms: 86_400_000 },
  { label: '7 days', ms: 604_800_000 },
  { label: '30 days', ms: 2_592_000_000 },
  { label: 'Until revoked', ms: NO_EXPIRY_MS },
];
