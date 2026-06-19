import { useEffect, useState } from 'react';
import { call, type FleetStore } from '../store.ts';
import type { AgentAccount, KeyCapabilities, SessionScope } from '../../../../idctl/src/keys/types.ts';

function shortAddr(a?: string): string {
  return a ? `${a.slice(0, 6)}…${a.slice(-4)}` : '—';
}
function remaining(validUntil: number): string {
  if (validUntil === 0) return 'until revoked'; // non-expiring session key
  const ms = validUntil - Date.now();
  if (ms <= 0) return 'expired';
  const h = Math.round(ms / 3600_000);
  return h < 24 ? `${h}h left` : `${Math.round(h / 24)}d left`;
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

  return (
    <div className="view">
      <header className="view-head">
        <h1>Identity & Keys</h1>
        <span className="muted">
          {caps?.chainLabel}
          {caps && !caps.live ? ' · MOCK' : ''}
        </span>
      </header>
      <div className="cols">
        <section className="card" style={{ width: 220, flex: '0 0 220px' }}>
          <h3>Agents</h3>
          {store.agents.map((a) => (
            <button key={a.id} className={`target${a.name === selected ? ' active' : ''}`} onClick={() => setSel(a.name)}>
              {a.name}
            </button>
          ))}
        </section>

        <section className="card grow">
          {acct ? (
            <>
              <h3>{selected} — Safe account</h3>
              <div className="kv">
                <span>status</span>
                <b className={acct.deployed ? 'ok-text' : 'warn-text'}>
                  {acct.deployed ? '● deployed' : '○ counterfactual'}
                </b>
                <span>address</span>
                <b className="mono">{shortAddr(acct.smartAccount)}</b>
                <span>owner</span>
                <b className="mono">{shortAddr(acct.owner)}</b>
              </div>
              <div className="row-actions" style={{ marginTop: 10 }}>
                <button className="btn" disabled={busy} onClick={() => void act('keys:ensure', selected)}>
                  Create account
                </button>
                <button className="btn" disabled={busy || acct.deployed} onClick={() => void act('keys:deploy', selected)}>
                  Deploy
                </button>
              </div>

              <h3 style={{ marginTop: 18 }}>Session keys ({acct.sessions.length})</h3>
              <table className="grid">
                <tbody>
                  {acct.sessions.map((s) => (
                    <tr key={s.id}>
                      <td className="b">{s.scope.label}</td>
                      <td className="mono muted">{shortAddr(s.address)}</td>
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
                      <td colSpan={4} className="muted">
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
              <p className="muted small" style={{ marginTop: 8 }}>
                Mock provider (no chain). Swaps for a real Safe4337 + bundler with no UI change.
              </p>
            </>
          ) : (
            <p className="muted">Select an agent.</p>
          )}
        </section>
      </div>
    </div>
  );
}
