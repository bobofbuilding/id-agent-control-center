const LABELS: Record<string, string> = {
  tasks: 'Tasks',
  health: 'Health & Probes',
  identity: 'Identity & Keys',
  schedule: 'Schedule & Heartbeats',
  settings: 'Settings — Managers, Inference Backends, Self-update',
};

export function Placeholder({ name }: { name: string }) {
  return (
    <div className="view">
      <header className="view-head">
        <h1>{LABELS[name] ?? name}</h1>
      </header>
      <section className="card grow center pad">
        <div className="muted" style={{ textAlign: 'center' }}>
          <div style={{ fontSize: 40, marginBottom: 12 }}>🚧</div>
          This panel is being ported from the CLI.
          <br />
          The data + actions already exist in the backend — wiring the GUI next.
        </div>
      </section>
    </div>
  );
}
