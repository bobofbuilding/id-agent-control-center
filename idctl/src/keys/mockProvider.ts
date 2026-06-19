/**
 * MockKeyProvider — simulates the Safe-account + 4337-session-key model locally
 * so the Keys UX is fully testable with no bundler/testnet. State persists to
 * ~/.config/idctl/keys-mock.json so it survives across runs (realistic UX).
 * Addresses are deterministic sha256-derived stand-ins (clearly not real keys).
 *
 * Swap this for a Safe4337KeyProvider (same KeyProvider interface) to go live —
 * the views never change.
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import crypto from 'node:crypto';
import { configDir, resolveConfigPath } from '../settings/paths.ts';
import type { AgentAccount, KeyCapabilities, KeyProvider, SessionKey, SessionScope } from './types.ts';

const MOCK_CHAIN_ID = 84532; // Base Sepolia (target for the real wiring later)
const MOCK_OWNER = '0x' + 'a657'.padEnd(40, '0'); // stand-in owner Safe

function statePath(): string {
  return join(configDir(resolveConfigPath()), 'keys-mock.json');
}

/** Deterministic 20-byte hex address from a seed (clearly a mock, not a key). */
function mockAddr(seed: string): string {
  return '0x' + crypto.createHash('sha256').update(seed).digest('hex').slice(0, 40);
}

interface MockState {
  accounts: Record<string, Omit<AgentAccount, 'sessions'>>;
  sessions: Record<string, SessionKey[]>;
}

export class MockKeyProvider implements KeyProvider {
  private state: MockState = { accounts: {}, sessions: {} };

  constructor() {
    this.load();
  }

  capabilities(): KeyCapabilities {
    return { provider: 'mock', chainId: MOCK_CHAIN_ID, chainLabel: 'Base Sepolia (mock)', live: false };
  }

  private load(): void {
    try {
      if (existsSync(statePath())) this.state = JSON.parse(readFileSync(statePath(), 'utf8')) as MockState;
    } catch {
      this.state = { accounts: {}, sessions: {} };
    }
  }
  private save(): void {
    try {
      mkdirSync(configDir(resolveConfigPath()), { recursive: true, mode: 0o700 });
      writeFileSync(statePath(), JSON.stringify(this.state, null, 2) + '\n', { mode: 0o600 });
    } catch {
      /* best-effort */
    }
  }

  /** Recompute session status from expiry on read. validUntil===0 = until revoked. */
  private withStatus(s: SessionKey): SessionKey {
    if (s.status === 'revoked') return s;
    if (s.validUntil === 0) return { ...s, status: 'active' }; // never expires
    return { ...s, status: s.validUntil < Date.now() ? 'expired' : 'active' };
  }

  private assemble(agent: string): AgentAccount {
    const base = this.state.accounts[agent];
    const sessions = (this.state.sessions[agent] ?? []).map((s) => this.withStatus(s));
    return base
      ? { ...base, sessions }
      : { agent, smartAccount: mockAddr(`safe:${agent}`), owner: MOCK_OWNER, deployed: false, chainId: MOCK_CHAIN_ID, sessions };
  }

  async listAccounts(agents: string[]): Promise<AgentAccount[]> {
    return agents.map((a) => this.assemble(a));
  }

  async ensureAccount(agent: string, owner = MOCK_OWNER): Promise<AgentAccount> {
    if (!this.state.accounts[agent]) {
      this.state.accounts[agent] = {
        agent,
        smartAccount: mockAddr(`safe:${agent}`),
        owner,
        deployed: false,
        chainId: MOCK_CHAIN_ID,
      };
      this.save();
    }
    return this.assemble(agent);
  }

  async deployAccount(agent: string): Promise<AgentAccount> {
    const acct = await this.ensureAccount(agent);
    this.state.accounts[agent] = { ...this.state.accounts[agent]!, deployed: true };
    this.save();
    return this.assemble(agent);
  }

  async issueSession(agent: string, scope: SessionScope, ttlMs: number): Promise<SessionKey> {
    await this.ensureAccount(agent);
    const now = Date.now();
    const id = `sess_${now.toString(36)}_${crypto.randomBytes(3).toString('hex')}`;
    const key: SessionKey = {
      id,
      agent,
      address: mockAddr(`session:${agent}:${id}`),
      scope,
      createdAt: now,
      validUntil: ttlMs > 0 ? now + ttlMs : 0, // 0 = until revoked
      status: 'active',
    };
    (this.state.sessions[agent] ??= []).push(key);
    this.save();
    return key;
  }

  async revokeSession(agent: string, sessionId: string): Promise<void> {
    const list = this.state.sessions[agent] ?? [];
    const s = list.find((x) => x.id === sessionId);
    if (s) {
      s.status = 'revoked';
      this.save();
    }
  }
}

let singleton: KeyProvider | null = null;
/** The active key provider (mock today; Safe4337 once wired). */
export function getKeyProvider(): KeyProvider {
  if (!singleton) singleton = new MockKeyProvider();
  return singleton;
}
