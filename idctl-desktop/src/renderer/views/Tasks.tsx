import { useEffect, useState } from 'react';
import { call, type FleetStore } from '../store.ts';
import { usePrompt } from '../components/prompt.tsx';
import type { Task } from '../../../../idctl/src/api/types.ts';

function ref(t: Task): string {
  return t.shortId ?? t.name ?? t.uuid ?? t.title;
}
function statusClass(s: string): string {
  if (/done|complete/i.test(s)) return 'ok';
  if (/claim|progress|start/i.test(s)) return 'warn';
  return 'muted';
}

export function Tasks({ store }: { store: FleetStore }) {
  const [tasks, setTasks] = useState<Task[]>([]);
  const [busy, setBusy] = useState(false);
  const prompt = usePrompt();

  async function reload() {
    try {
      const t = await call<Task[]>('tasks');
      setTasks([...t].sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0)));
    } catch {
      setTasks([]);
    }
  }
  useEffect(() => {
    reload();
  }, [store.team, store.lastUpdated]);

  async function run(cmd: string) {
    setBusy(true);
    try {
      await call('remote', cmd);
      await reload();
    } finally {
      setBusy(false);
    }
  }
  async function newTask() {
    const title = await prompt({ title: 'New task title:', placeholder: 'what needs doing', okLabel: 'Add task' });
    if (title?.trim()) void run(`/task add ${title.trim()}`);
  }

  return (
    <div className="view">
      <header className="view-head">
        <h1>Tasks</h1>
        <button className="btn primary" disabled={busy} onClick={() => void newTask()}>
          + New task
        </button>
      </header>
      <section className="card grow">
        <table className="grid">
          <thead>
            <tr>
              <th>Task</th>
              <th>Status</th>
              <th>Owner</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {tasks.map((t) => (
              <tr key={ref(t)}>
                <td className="b">{t.title}</td>
                <td className={statusClass(t.status)}>{t.status}</td>
                <td className="muted">{t.ownerName ?? '—'}</td>
                <td className="row-actions">
                  <button className="btn" disabled={busy} onClick={() => void run(`/task ${ref(t)} claim`)}>
                    Claim
                  </button>
                  <button className="btn" disabled={busy} onClick={() => void run(`/task ${ref(t)} complete`)}>
                    Done
                  </button>
                </td>
              </tr>
            ))}
            {tasks.length === 0 ? (
              <tr>
                <td colSpan={4} className="muted center pad">
                  No tasks. Create one with “+ New task”.
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </section>
    </div>
  );
}
