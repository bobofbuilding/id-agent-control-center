import { useState } from 'react';
import { call, type FleetStore } from '../store.ts';
import type { InboxItem } from '../../../../idctl/src/api/types.ts';

export function Inbox({ store }: { store: FleetStore }) {
  return (
    <div className="view">
      <header className="view-head">
        <h1>Inbox</h1>
        <span className="muted">{store.inbox.length} awaiting reply</span>
      </header>
      <section className="card grow">
        {store.inbox.length === 0 ? (
          <div className="muted center pad">Nothing waiting — the manager isn't blocked on you.</div>
        ) : (
          store.inbox.map((it) => <InboxRow key={it.query_id} item={it} onDone={() => store.refresh()} />)
        )}
      </section>
    </div>
  );
}

/** One inbox item, with an inline reply box and a dismiss button. Replying (or
 *  dismissing) clears the item from the manager's pending queue; onDone refreshes
 *  the list so the row drops away. */
function InboxRow({ item, onDone }: { item: InboxItem; onDone: () => void }) {
  const [reply, setReply] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  async function send() {
    const msg = reply.trim();
    if (!msg) return;
    setBusy(true); setErr('');
    try { await call('inbox:respond', item.query_id, msg); onDone(); }
    catch (e) { setErr(e instanceof Error ? e.message : String(e)); setBusy(false); }
  }
  async function dismiss() {
    setBusy(true); setErr('');
    try { await call('inbox:dismiss', item.query_id); onDone(); }
    catch (e) { setErr(e instanceof Error ? e.message : String(e)); setBusy(false); }
  }

  return (
    <div className="inbox-row">
      <div className="inbox-from">{item.from ?? 'manager'}</div>
      <div className="inbox-msg">{item.message}</div>
      <div className="row-actions" style={{ marginTop: 8, gap: 8, alignItems: 'flex-start' }}>
        <textarea
          style={{ flex: 1, minHeight: 46, fontSize: 13, resize: 'vertical' }}
          placeholder="type a reply… (⌘/Ctrl+Enter to send)"
          value={reply}
          disabled={busy}
          onChange={(e) => setReply(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) void send(); }}
        />
        <button className="btn primary" disabled={busy || !reply.trim()} onClick={() => void send()}>
          {busy ? '…' : 'Send reply'}
        </button>
        <button className="btn" disabled={busy} onClick={() => void dismiss()} title="Clear without replying">
          Dismiss
        </button>
      </div>
      {err ? <p className="status-error small">{err}</p> : null}
    </div>
  );
}
