import { useState } from 'react';
import { call, type FleetStore } from '../store.ts';
import type { ProbeResult } from '../../../../idctl/src/api/types.ts';

export function Health({ store }: { store: FleetStore }) {
  const [result, setResult] = useState<ProbeResult | null>(null);
  const [probing, setProbing] = useState<string | null>(null);

  async function probe(which: 'all' | string) {
    setProbing(which);
    setResult(null);
    try {
      const r = await call<ProbeResult>(which === 'all' ? 'probeAll' : 'probeOne', ...(which === 'all' ? [] : [which]));
      setResult(r);
    } catch (err) {
      setResult({ team: store.team ?? '', probed: 0, passed: 0, failed: 1, results: [{ name: which, status: 'failed', error: err instanceof Error ? err.message : String(err) }] });
    } finally {
      setProbing(null);
    }
  }

  return (
    <div className="view">
      <header className="view-head">
        <h1>Health & Probes</h1>
        <button className="btn primary" disabled={!!probing} onClick={() => void probe('all')}>
          {probing === 'all' ? 'Probing…' : 'Probe all'}
        </button>
      </header>
      <div className="cols">
        <section className="card grow">
          <table className="grid">
            <thead>
              <tr>
                <th>Agent</th>
                <th>Status</th>
                <th>Runtime</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {store.agents.map((a) => (
                <tr key={a.id}>
                  <td className="b">{a.name}</td>
                  <td>
                    <span className={`dot ${/running|online/i.test(a.status) ? 'ok' : 'err'}`} /> {a.status}
                  </td>
                  <td className="muted">{a.runtime ?? a.type}</td>
                  <td className="row-actions">
                    <button className="btn" disabled={!!probing} onClick={() => void probe(a.name)}>
                      {probing === a.name ? '…' : 'Probe'}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
        <aside className="card feed">
          <h3>Probe result</h3>
          {result ? (
            <div>
              <p className={result.failed > 0 ? 'status-error' : 'ok-text'}>
                {result.passed}/{result.probed} ok
              </p>
              {result.results.map((r) => (
                <div className="feed-row" key={r.name}>
                  <span className={`dot ${r.status === 'ok' ? 'ok' : 'err'}`} />
                  <span>{r.name}</span>
                  <span className="muted t">{r.duration_ms != null ? `${r.duration_ms}ms` : ''}</span>
                  {r.error ? <div className="muted small">{r.error}</div> : null}
                </div>
              ))}
            </div>
          ) : (
            <p className="muted">Run a probe to verify each agent responds on its dispatch path.</p>
          )}
        </aside>
      </div>
    </div>
  );
}
