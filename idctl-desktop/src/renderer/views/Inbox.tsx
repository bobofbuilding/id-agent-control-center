import type { FleetStore } from '../store.ts';

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
          store.inbox.map((it) => (
            <div className="inbox-row" key={it.query_id}>
              <div className="inbox-from">{it.from ?? 'manager'}</div>
              <div className="inbox-msg">{it.message}</div>
            </div>
          ))
        )}
      </section>
    </div>
  );
}
