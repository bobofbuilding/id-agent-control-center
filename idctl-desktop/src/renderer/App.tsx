import { useEffect, useState } from 'react';
import { useFleet, call } from './store.ts';
import { PromptProvider } from './components/prompt.tsx';
import { Dashboard } from './views/Dashboard.tsx';
import { Chat } from './views/Chat.tsx';
import { Teams } from './views/Teams.tsx';
import { Inbox } from './views/Inbox.tsx';
import { Tasks } from './views/Tasks.tsx';
import { Health } from './views/Health.tsx';
import { Identity } from './views/Identity.tsx';
import { Modules } from './views/Modules.tsx';
import { Projects } from './views/Projects.tsx';
import { ComputerUse } from './views/ComputerUse.tsx';
import { Settings } from './views/Settings.tsx';

type ViewId = 'dashboard' | 'chat' | 'inbox' | 'tasks' | 'projects' | 'health' | 'identity' | 'schedule' | 'teams' | 'modules' | 'computer' | 'settings';

const NAV: { id: ViewId; label: string; icon: string }[] = [
  { id: 'dashboard', label: 'Dashboard', icon: '▦' },
  { id: 'chat', label: 'Chat', icon: '✦' },
  { id: 'inbox', label: 'Inbox', icon: '✉' },
  { id: 'tasks', label: 'Work', icon: '☑' },
  { id: 'projects', label: 'Projects', icon: '◆' },
  { id: 'health', label: 'Health', icon: '✚' },
  { id: 'identity', label: 'Identity & Keys', icon: '⬡' },
  { id: 'teams', label: 'Teams', icon: '⛌' },
  { id: 'modules', label: 'Capabilities', icon: '◫' },
  { id: 'computer', label: 'Computer Use', icon: '🖥' },
  { id: 'settings', label: 'Settings', icon: '⚙' },
];

interface UpdateStatus {
  current: string;
  latest?: string;
  available: boolean;
  staged: boolean;
  checking: boolean;
  notes?: string;
  error?: string;
}

export function App() {
  const store = useFleet();
  const [view, setView] = useState<ViewId>(() => {
    // 'schedule' is a Tasks tab now (not in NAV) but still a valid deep-link target.
    const valid = (id: string | null): id is ViewId => !!id && (NAV.some((n) => n.id === id) || id === 'schedule');
    const v = new URLSearchParams(window.location.search).get('view');
    if (valid(v)) return v;
    // Otherwise reopen on the view the user last had — e.g. after a self-update relaunch.
    let saved: string | null = null;
    try { saved = localStorage.getItem('idctl.view'); } catch { /* no storage */ }
    return valid(saved) ? saved : 'dashboard';
  });
  useEffect(() => { try { localStorage.setItem('idctl.view', view); } catch { /* no storage */ } }, [view]);
  const [version, setVersion] = useState<string>('');
  const [update, setUpdate] = useState<UpdateStatus | null>(null);
  const [applying, setApplying] = useState(false);
  const [dismissed, setDismissed] = useState<string>(''); // latest version the user said "Later" to

  useEffect(() => {
    call<string>('app:version').then(setVersion).catch(() => {});
    call<UpdateStatus>('update:status').then(setUpdate).catch(() => {});
    call<UpdateStatus>('update:check').then(setUpdate).catch(() => {}); // kick a check on launch
    const idagents = (window as { idagents?: { onUpdateStatus?: (cb: (s: unknown) => void) => () => void } }).idagents;
    const off = idagents?.onUpdateStatus?.((s) => setUpdate(s as UpdateStatus));
    return () => off?.();
  }, []);

  async function applyUpdate() {
    setApplying(true);
    try {
      await call('update:applyNow'); // app quits + relauncher swaps the bundle
    } catch {
      setApplying(false);
    }
  }

  return (
    <PromptProvider>
    <div className="app">
      <div className="titlebar">
        <span className="titlebar-name">ID Agents Control Center{version ? ` · v${version}` : ''}</span>
      </div>
      <div className="body">
        <nav className="sidebar">
          {NAV.map((n) => (
            <button
              key={n.id}
              className={`nav-item${view === n.id ? ' active' : ''}`}
              onClick={() => setView(n.id)}
            >
              <span className="nav-icon">{n.icon}</span>
              <span className="nav-label">{n.label}</span>
              {n.id === 'inbox' && store.inbox.length > 0 ? (
                <span className="nav-badge" title={`${store.inbox.length} pending message${store.inbox.length === 1 ? '' : 's'}`}>{store.inbox.length}</span>
              ) : null}
              {n.id === 'chat' && store.chatUnread > 0 ? (
                <span className="nav-badge" title={`${store.chatUnread} chat${store.chatUnread === 1 ? '' : 's'} with new replies`}>{store.chatUnread}</span>
              ) : null}
            </button>
          ))}
          {update?.available && update.staged && dismissed !== update.latest ? (
            <div className="sb-update" title={`Update downloaded — restart to apply v${update.latest}`}>
              <div className="uv-line">⬆ <span className="uv-from">v{update.current}</span> → <span className="uv-to">v{update.latest}</span></div>
              <div className="uv-actions">
                <button className="btn primary uv-go" disabled={applying} onClick={() => void applyUpdate()}>{applying ? 'Updating…' : 'Restart & update'}</button>
                <button className="uv-x" title="Later" onClick={() => setDismissed(update.latest ?? '')}>✕</button>
              </div>
            </div>
          ) : null}
        </nav>

        <main className="content">
          <Router view={view} store={store} />
          <StatusBar store={store} />
        </main>
      </div>
    </div>
    </PromptProvider>
  );
}

function Router({ view, store }: { view: ViewId; store: ReturnType<typeof useFleet> }) {
  switch (view) {
    case 'dashboard':
      return <Dashboard store={store} />;
    case 'chat':
      return <Chat store={store} />;
    case 'teams':
      return <Teams store={store} />;
    case 'inbox':
      return <Inbox store={store} />;
    case 'tasks':
      return <Tasks store={store} />;
    case 'health':
      return <Health store={store} />;
    case 'identity':
      return <Identity store={store} />;
    case 'schedule':
      return <Tasks store={store} initialTab="schedule" />;
    case 'modules':
      return <Modules store={store} />;
    case 'computer':
      return <ComputerUse store={store} />;
    case 'projects':
      return <Projects store={store} />;
    case 'settings':
      return <Settings store={store} />;
    default:
      return <Dashboard store={store} />;
  }
}

function StatusBar({ store }: { store: ReturnType<typeof useFleet> }) {
  const dot =
    store.connection === 'online' ? 'ok' : store.connection === 'offline' ? 'err' : 'warn';
  return (
    <footer className="statusbar">
      <span className={`pill ${dot}`}>● {store.connection}</span>
      <span className="muted">{store.managerUrl || '—'}</span>
      <span className="sep">·</span>
      <span>
        team <b>{store.team ?? 'default'}</b>
      </span>
      <span className="sep">·</span>
      <span>{store.agents.length} agents</span>
      {store.connection === 'offline' && store.lastError ? (
        <span className="status-error">⚠ {store.lastError}</span>
      ) : null}
    </footer>
  );
}
