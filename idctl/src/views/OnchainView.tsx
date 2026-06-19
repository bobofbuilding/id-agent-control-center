/**
 * OnchainView — agent Identity & Keys. Shows each agent's onchain identity
 * (OWS wallet / ENS / ID Chain, from metadata) plus its Safe smart account and
 * scoped ERC-4337 session keys (via KeyProvider — a local mock today, real
 * Safe4337 + bundler once wired). Actions: g register · c create account ·
 * D deploy · k new session key · x revoke.
 */

import { useEffect, useState } from 'react';
import { Box, Text, useInput } from 'ink';
import { useAppCtx } from '../app/context.ts';
import { Select, type SelectItem } from '../components/Select.tsx';
import { Confirm } from '../components/Confirm.tsx';
import { Wizard } from '../components/Wizard.tsx';
import { theme, truncate } from '../app/theme.ts';
import type { Agent } from '../api/types.ts';
import { getKeyProvider } from '../keys/mockProvider.ts';
import { SCOPE_PRESETS, TTL_PRESETS, type AgentAccount, type SessionKey } from '../keys/types.ts';

type Mode = 'list' | 'confirmRegister' | 'issueWizard' | 'revokeSelect';

function shortAddr(a?: string): string {
  return a ? `${a.slice(0, 6)}…${a.slice(-4)}` : '—';
}
function remaining(validUntil: number, now = Date.now()): string {
  const ms = validUntil - now;
  if (ms <= 0) return 'expired';
  const h = Math.round(ms / 3600_000);
  if (h < 24) return `${h}h left`;
  return `${Math.round(h / 24)}d left`;
}
function sessColor(s: SessionKey): string {
  return s.status === 'active' ? theme.ok : s.status === 'revoked' ? theme.err : theme.dim;
}

export function OnchainView() {
  const { store, setCapture, flash } = useAppCtx();
  const agents = store.agents;
  const kp = getKeyProvider();
  const caps = kp.capabilities();

  const [cursor, setCursor] = useState(0);
  const [mode, setMode] = useState<Mode>('list');
  const [busy, setBusy] = useState(false);
  const [accounts, setAccounts] = useState<Record<string, AgentAccount>>({});

  const selected: Agent | undefined = agents[Math.min(cursor, agents.length - 1)];
  const acct = selected ? accounts[selected.name] : undefined;

  async function reloadAccounts() {
    const list = await kp.listAccounts(agents.map((a) => a.name));
    setAccounts(Object.fromEntries(list.map((a) => [a.agent, a])));
  }
  useEffect(() => {
    reloadAccounts();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agents.length, store.lastUpdated]);

  useEffect(() => {
    setCapture(mode !== 'list');
    return () => setCapture(false);
  }, [mode, setCapture]);

  async function run(label: string, fn: () => Promise<unknown>) {
    setBusy(true);
    try {
      await fn();
      await reloadAccounts();
      flash(`${label} ✓`, 'ok');
    } catch (err) {
      flash(`${label} failed: ${err instanceof Error ? err.message : String(err)}`, 'err');
    } finally {
      setBusy(false);
      setMode('list');
    }
  }

  useInput(
    (input) => {
      if (busy || !selected) return;
      if (input === 'g') setMode('confirmRegister');
      else if (input === 'c') run(`create account ${selected.name}`, () => kp.ensureAccount(selected.name));
      else if (input === 'D') run(`deploy ${selected.name}`, () => kp.deployAccount(selected.name));
      else if (input === 'k') setMode('issueWizard');
      else if (input === 'x' && (acct?.sessions.some((s) => s.status === 'active') ?? false)) setMode('revokeSelect');
    },
    { isActive: mode === 'list' && !busy },
  );

  // ---- modal modes ----
  if (mode === 'confirmRegister' && selected) {
    return (
      <Confirm
        title={`Register "${selected.name}" onchain?`}
        detail="Registers/provisions the agent's ID Chain identity. May incur gas."
        confirmLabel="register"
        onConfirm={() => run(`register ${selected.name}`, () => store.client.remote(`/register ${selected.name}`))}
        onCancel={() => setMode('list')}
      />
    );
  }

  if (mode === 'issueWizard' && selected) {
    return (
      <Wizard
        title={`New session key for ${selected.name}`}
        steps={[
          {
            key: 'scope',
            label: 'Scope',
            type: 'choice',
            choices: SCOPE_PRESETS.map((s, i) => ({ value: String(i), label: s.label, hint: s.spendLimitWei === '0' ? 'no spend' : `${Number(s.spendLimitWei) / 1e18} cap` })),
          },
          { key: 'ttl', label: 'Expires in', type: 'choice', choices: TTL_PRESETS.map((t, i) => ({ value: String(i), label: t.label })) },
        ]}
        onCancel={() => setMode('list')}
        onSubmit={(v) => {
          const scope = SCOPE_PRESETS[Number(v.scope) || 0];
          const ttl = TTL_PRESETS[Number(v.ttl) || 0].ms;
          run(`issue ${scope.label}`, () => kp.issueSession(selected.name, scope, ttl));
        }}
      />
    );
  }

  if (mode === 'revokeSelect' && selected && acct) {
    const active = acct.sessions.filter((s) => s.status === 'active');
    const items: SelectItem<SessionKey>[] = active.map((s) => ({
      key: s.id,
      label: s.scope.label.padEnd(16).slice(0, 16),
      value: s,
      hint: `${shortAddr(s.address)} · ${remaining(s.validUntil)}`,
    }));
    return (
      <Box flexDirection="column" borderStyle="round" borderColor={theme.err} paddingX={1}>
        <Text bold color={theme.err}>
          Revoke a session key — {selected.name}
        </Text>
        <Select items={items} emptyText="(no active sessions)" onSelect={(it) => run(`revoke ${it.value.scope.label}`, () => kp.revokeSession(selected.name, it.value.id))} />
        <Text color={theme.dim}>Enter revoke · Esc cancel</Text>
        <EscClose to={() => setMode('list')} active={!busy} />
      </Box>
    );
  }

  // ---- list ----
  const items: SelectItem<Agent>[] = agents.map((a) => {
    const ac = accounts[a.name];
    const n = ac?.sessions.filter((s) => s.status === 'active').length ?? 0;
    return {
      key: a.id,
      label: a.name.padEnd(12).slice(0, 12),
      value: a,
      hint: ac ? `${shortAddr(ac.smartAccount)} ${ac.deployed ? '●' : '○'} · ${n} session${n === 1 ? '' : 's'}` : '(no account)',
    };
  });

  const idchain = selected?.idchain_domain ?? (selected?.metadata?.idchain_domain as string) ?? undefined;
  const wallet = selected?.ows_wallet ?? (selected?.metadata?.ows_wallet as string) ?? undefined;

  return (
    <Box flexDirection="column">
      <Box>
        <Box flexDirection="column" width="42%" marginRight={2}>
          <Text bold color={theme.accent}>
            Agents <Text color={theme.dim}>· {caps.chainLabel}</Text>
          </Text>
          <Select items={items} index={cursor} onIndexChange={setCursor} emptyText="(no agents)" maxVisible={10} />
        </Box>
        <Box flexDirection="column" width="58%">
          {selected ? (
            <>
              <Text bold>{selected.name}</Text>
              <Field label="ENS / ID Chain" value={idchain} />
              <Field label="OWS wallet" value={wallet ? shortAddr(wallet) : undefined} />
              <Box marginTop={1} flexDirection="column">
                <Text bold color={theme.accentAlt}>
                  Safe account {acct ? <Text color={acct.deployed ? theme.ok : theme.warn}>{acct.deployed ? '● deployed' : '○ counterfactual'}</Text> : null}
                </Text>
                <Field label="address" value={acct ? shortAddr(acct.smartAccount) : undefined} />
                <Field label="owner" value={acct ? shortAddr(acct.owner) : undefined} />
              </Box>
              <Box marginTop={1} flexDirection="column">
                <Text bold color={theme.accentAlt}>
                  Session keys ({acct?.sessions.length ?? 0})
                </Text>
                {(acct?.sessions ?? []).slice(-5).map((s) => (
                  <Text key={s.id}>
                    <Text color={sessColor(s)}>●</Text> <Text>{truncate(s.scope.label, 16).padEnd(16)}</Text>
                    <Text color={theme.dim}> {shortAddr(s.address)} · {s.status === 'active' ? remaining(s.validUntil) : s.status}</Text>
                  </Text>
                ))}
                {(acct?.sessions.length ?? 0) === 0 ? <Text color={theme.dim}>(none — press k to issue)</Text> : null}
              </Box>
            </>
          ) : (
            <Text color={theme.dim}>select an agent</Text>
          )}
        </Box>
      </Box>
      <Text color={theme.dim}>
        {busy ? '… working' : 'g register · c create account · D deploy · k new session · x revoke'}
        {!caps.live ? <Text color={theme.warn}> · MOCK (no chain) </Text> : null}
      </Text>
    </Box>
  );
}

function Field({ label, value }: { label: string; value?: string }) {
  return (
    <Text>
      <Text color={theme.dim}>{label.padEnd(15)}</Text>
      {value ? <Text>{value}</Text> : <Text color={theme.dim}>—</Text>}
    </Text>
  );
}

function EscClose({ to, active }: { to: () => void; active: boolean }) {
  useInput(
    (_i, key) => {
      if (key.escape) to();
    },
    { isActive: active },
  );
  return null;
}
