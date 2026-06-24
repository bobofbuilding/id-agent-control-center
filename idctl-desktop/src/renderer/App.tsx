import { useEffect, useState } from 'react';
import { useFleet, call } from './store.ts';
import { PromptProvider } from './components/prompt.tsx';
import { ToastProvider } from './components/toast.tsx';
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
  { id: 'teams', label: 'HR Manager', icon: '⛌' },
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
    <ToastProvider>
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
    </ToastProvider>
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

type TeamLeadInfo = { team: string; lead: string | null; activeCount: number; totalCount: number };
function isLive(status?: string): boolean {
  const s = String(status || '').toLowerCase();
  return !!s && !/stop|offline|dead|exit|error|crash|down|disabled|sleep/.test(s);
}

function StatusBar({ store }: { store: ReturnType<typeof useFleet> }) {
  const dot =
    store.connection === 'online' ? 'ok' : store.connection === 'offline' ? 'err' : 'warn';
  // Running/total agents per team — drives "active teams / active agents" in the bar.
  const [leads, setLeads] = useState<TeamLeadInfo[]>([]);
  const names = store.teams.map((t) => t.name).filter(Boolean).join(',');
  useEffect(() => {
    const list = names ? names.split(',') : [];
    if (!list.length) { setLeads([]); return; }
    let live = true;
    const load = () => call<TeamLeadInfo[]>('work:teamLeads', list).then((r) => { if (live) setLeads(r); }).catch(() => {});
    void load();
    const iv = setInterval(load, 20000); // refresh running counts every 20s
    return () => { live = false; clearInterval(iv); };
  }, [names, store.team]);

  const viewAll = store.viewAll;
  const activeTeam = store.team ?? 'default';
  const cur = leads.find((l) => l.team === activeTeam);
  const curActive = cur ? cur.activeCount : store.agents.filter((a) => isLive(a.status)).length;
  const curTotal = cur ? cur.totalCount : store.agents.length;
  const liveTeams = leads.filter((l) => l.activeCount > 0).length;
  const totalActive = leads.reduce((s, l) => s + l.activeCount, 0);
  const totalAgents = leads.reduce((s, l) => s + l.totalCount, 0);
  // Active teams first (running agents), then idle; alphabetical within each.
  const sorted = [...store.teams].sort((a, b) => {
    const la = (leads.find((l) => l.team === a.name)?.activeCount ?? 0) > 0;
    const lb = (leads.find((l) => l.team === b.name)?.activeCount ?? 0) > 0;
    return la !== lb ? (la ? -1 : 1) : a.name.localeCompare(b.name);
  });

  return (
    <footer className="statusbar">
      <span className={`pill ${dot}`}>● {store.connection}</span>
      <span className="muted">{store.managerUrl || '—'}</span>
      <span className="sep">·</span>
      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
        view
        <select
          className="cell-select"
          style={{ fontSize: 12, fontWeight: 700 }}
          value={viewAll ? '__all__' : activeTeam}
          title="Holistic view (all teams) by default — the Dashboard & activity show the whole fleet. Pick a team to scope per-team pages. ● = running agents, ○ = idle; counts are running/total."
          onChange={(e) => {
            const v = e.target.value;
            if (v === '__all__') store.setViewAll(true);
            else { store.setViewAll(false); void store.setTeam(v); }
          }}
        >
          <option value="__all__">★ All teams{totalAgents ? ` ${totalActive}/${totalAgents}` : ''}</option>
          {(sorted.length ? sorted : [{ id: 'default', name: activeTeam, agentCount: store.agents.length }]).map((t) => {
            const l = leads.find((x) => x.team === t.name);
            const total = l ? l.totalCount : t.agentCount;
            const running = l ? l.activeCount : undefined;
            const live = (running ?? 0) > 0;
            return (
              <option key={t.id} value={t.name}>
                {live ? '● ' : '○ '}{t.name} {running != null ? `${running}/${total}` : `(${total})`}{running != null && !live ? ' · idle' : ''}
              </option>
            );
          })}
        </select>
      </span>
      <span className="sep">·</span>
      {viewAll ? (
        <span title="running / total agents across every team">{totalActive}/{totalAgents} agents active · {liveTeams} team{liveTeams === 1 ? '' : 's'} running</span>
      ) : (
        <>
          <span title="running / total agents in this team">{curActive}/{curTotal} agents active</span>
          {liveTeams ? (
            <>
              <span className="sep">·</span>
              <span className="muted" title="teams with at least one running agent">{liveTeams} team{liveTeams === 1 ? '' : 's'} running</span>
            </>
          ) : null}
        </>
      )}
      {store.connection === 'offline' && store.lastError ? (
        <span className="status-error">⚠ {store.lastError}</span>
      ) : null}
    </footer>
  );
}
