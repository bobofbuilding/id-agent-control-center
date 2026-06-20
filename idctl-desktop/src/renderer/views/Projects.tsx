import { useEffect, useMemo, useState } from 'react';
import { call, type FleetStore } from '../store.ts';
import type { ProjectEntry, ProjectStatus } from '../../../../idctl/src/settings/schema.ts';

const STATUSES: ProjectStatus[] = ['active', 'paused', 'blocked', 'done'];
const STATUS_LABEL: Record<ProjectStatus, string> = { active: 'active', paused: 'paused', blocked: 'blocked', done: 'done' };
const STATUS_CLASS: Record<ProjectStatus, string> = { active: 'st-active', paused: 'st-paused', blocked: 'st-blocked', done: 'st-done' };
const GIT_ACTIONS = ['fetch', 'pull', 'status', 'log', 'diff'] as const;

/** Git state of a project folder (computed in the main process). */
type GitInfo = {
  isRepo: boolean;
  branch?: string;
  remoteUrl?: string;
  upstreamUrl?: string;
  isFork?: boolean;
  ahead?: number;
  behind?: number;
  dirty?: boolean;
  compareRef?: string;
  error?: string;
};
type Readme = { found: boolean; name?: string; description?: string };

function newId(): string {
  return `p_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
}
function splitList(s: string): string[] {
  return s.split(/[,\n]/).map((x) => x.trim()).filter(Boolean);
}
const BLANK = { name: '', status: 'active' as ProjectStatus, description: '', team: '', tags: '', links: '', path: '', notes: '' };

/** Compact git status: branch + ahead/behind/fork + dirty. */
function GitStatus({ g }: { g?: GitInfo }) {
  if (!g) return <span className="muted small">checking…</span>;
  if (!g.isRepo) return <span className="muted small" title={g.error}>📁 folder (not a git repo)</span>;
  let label = 'up to date';
  let cls = 'ok-text';
  if (g.ahead == null || g.behind == null) { label = 'fetch to compare'; cls = 'muted'; }
  else if (g.ahead && g.behind) { label = `${g.ahead} ahead · ${g.behind} behind`; cls = 'warn-text'; }
  else if (g.behind) { label = `${g.behind} behind`; cls = 'warn-text'; }
  else if (g.ahead) { label = g.isFork ? `customized · ${g.ahead} ahead of upstream` : `${g.ahead} ahead`; cls = 'accent-text'; }
  else { label = g.isFork ? 'fork · in sync with upstream' : 'up to date'; cls = 'ok-text'; }
  return (
    <span className="git-badge">
      <span className="mono muted">⎇ {g.branch || '—'}</span>
      {g.isFork ? <span className="chip tag" title={`fork — upstream: ${g.upstreamUrl}`}>fork</span> : null}
      <span className={`small ${cls}`} title={g.compareRef ? `vs ${g.compareRef}` : undefined}>{label}</span>
      {g.dirty ? <span className="warn-text small" title="uncommitted local changes">● uncommitted</span> : null}
    </span>
  );
}

export function Projects({ store }: { store: FleetStore }) {
  const [projects, setProjects] = useState<ProjectEntry[]>([]);
  const [gitMap, setGitMap] = useState<Record<string, GitInfo>>({});
  const [gitOut, setGitOut] = useState<Record<string, { action: string; output: string }>>({});
  const [gitBusy, setGitBusy] = useState<string | null>(null);
  const [filter, setFilter] = useState<ProjectStatus | 'all'>('all');
  const [editing, setEditing] = useState<string | null>(null); // project id, 'new', or null
  const [form, setForm] = useState(BLANK);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState('');
  const [confirmDel, setConfirmDel] = useState<string | null>(null);

  async function loadGit(list: ProjectEntry[]) {
    const withPath = list.filter((p) => p.path);
    const pairs = await Promise.all(
      withPath.map(async (p) => [p.id, await call<GitInfo>('project:git', p.path).catch(() => ({ isRepo: false }) as GitInfo)] as const),
    );
    setGitMap(Object.fromEntries(pairs));
  }
  async function load() {
    const list = await call<ProjectEntry[]>('projects:list').catch(() => []);
    setProjects(list);
    void loadGit(list);
  }
  useEffect(() => { void load(); }, []);

  const shown = useMemo(
    () => projects.filter((p) => filter === 'all' || p.status === filter).sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0)),
    [projects, filter],
  );
  const counts = useMemo(() => {
    const c: Record<string, number> = { all: projects.length };
    for (const s of STATUSES) c[s] = projects.filter((p) => p.status === s).length;
    return c;
  }, [projects]);

  function openNew() { setForm(BLANK); setEditing('new'); setNote(''); }
  function openEdit(p: ProjectEntry) {
    setForm({ name: p.name, status: p.status, description: p.description ?? '', team: p.team ?? '', tags: (p.tags ?? []).join(', '), links: (p.links ?? []).join('\n'), path: p.path ?? '', notes: p.notes ?? '' });
    setEditing(p.id); setNote('');
  }
  /** Pick a folder and pre-fill name/description from its README. */
  async function browse() {
    const p = await call<string | null>('project:pickFolder').catch(() => null);
    if (!p) return;
    const r = await call<Readme>('project:readme', p).catch((): Readme => ({ found: false }));
    setForm((f) => ({ ...f, path: p, name: f.name.trim() || r?.name || '', description: f.description.trim() || r?.description || '' }));
    if (r?.found) setNote('folder + README read ✓');
  }
  async function readReadme() {
    const r = await call<Readme>('project:readme', form.path.trim()).catch((): Readme => ({ found: false }));
    if (r?.found) { setForm((f) => ({ ...f, name: r.name || f.name, description: r.description || f.description })); setNote('name/description filled from README ✓'); }
    else setNote('no README found in that folder');
  }
  /** Top-level: import a folder straight into a new-project form. */
  async function importFolder() {
    const p = await call<string | null>('project:pickFolder').catch(() => null);
    if (!p) return;
    const r = await call<Readme>('project:readme', p).catch((): Readme => ({ found: false }));
    setForm({ ...BLANK, path: p, name: r?.name || '', description: r?.description || '' });
    setEditing('new');
    setNote(r?.found ? 'imported folder — README read; review and Save' : 'imported folder (no README found)');
  }
  async function save() {
    const name = form.name.trim();
    if (!name) { setNote('name required'); return; }
    setBusy(true);
    try {
      const now = Date.now();
      const existing = editing && editing !== 'new' ? projects.find((p) => p.id === editing) : undefined;
      const entry: ProjectEntry = {
        id: existing?.id ?? newId(),
        name,
        status: form.status,
        description: form.description.trim() || undefined,
        team: form.team.trim() || undefined,
        tags: splitList(form.tags),
        links: splitList(form.links),
        path: form.path.trim() || undefined,
        notes: form.notes.trim() || undefined,
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
      };
      const list = await call<ProjectEntry[]>('projects:save', entry);
      setProjects(list);
      void loadGit(list);
      setEditing(null);
      setNote(`saved ${name} ✓`);
    } finally {
      setBusy(false);
    }
  }
  async function setStatus(p: ProjectEntry, status: ProjectStatus) {
    setProjects(await call<ProjectEntry[]>('projects:save', { ...p, status, updatedAt: Date.now() }));
  }
  async function remove(id: string) {
    setBusy(true);
    try {
      setProjects(await call<ProjectEntry[]>('projects:remove', id));
      setConfirmDel(null);
      setNote('deleted ✓');
    } finally {
      setBusy(false);
    }
  }
  async function runGit(p: ProjectEntry, action: string) {
    if (!p.path) return;
    setGitBusy(`${p.id}:${action}`);
    setGitOut((o) => ({ ...o, [p.id]: { action, output: `$ git ${action}…` } }));
    try {
      const r = await call<{ ok: boolean; output: string }>('project:gitRun', p.path, action);
      setGitOut((o) => ({ ...o, [p.id]: { action, output: r.output } }));
      const g = await call<GitInfo>('project:git', p.path).catch(() => null);
      if (g) setGitMap((m) => ({ ...m, [p.id]: g }));
    } finally {
      setGitBusy(null);
    }
  }

  return (
    <div className="view">
      <header className="view-head">
        <h1>Projects</h1>
        <div className="row-actions">
          <button className="btn" disabled={busy} onClick={() => void importFolder()}>Import folder…</button>
          <button className="btn primary" disabled={busy} onClick={() => (editing === 'new' ? setEditing(null) : openNew())}>
            {editing === 'new' ? '− Cancel' : '+ New project'}
          </button>
        </div>
      </header>

      <div className="row-actions" style={{ flexWrap: 'wrap', gap: 6 }}>
        {(['all', ...STATUSES] as const).map((s) => (
          <button key={s} className={`chip${filter === s ? ' on' : ''}`} onClick={() => setFilter(s)}>
            {s === 'all' ? 'all' : STATUS_LABEL[s]} {counts[s] ?? 0}
          </button>
        ))}
        {note ? <span className="muted small grow" style={{ textAlign: 'right' }}>{note}</span> : null}
      </div>

      {editing !== null ? (
        <section className="card">
          <h3>{editing === 'new' ? 'New project' : 'Edit project'}</h3>
          <div className="kv" style={{ gridTemplateColumns: '110px 1fr', gap: '8px 12px' }}>
            <span>name *</span>
            <b><input style={{ width: 320 }} placeholder="e.g. SkillMesh mainnet" value={form.name} onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))} /></b>
            <span>folder</span>
            <b style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
              <input style={{ flex: 1, minWidth: 220 }} className="mono" placeholder="/path/to/project — enables git tracking + README import" value={form.path} onChange={(e) => setForm((f) => ({ ...f, path: e.target.value }))} />
              <button className="btn small" onClick={() => void browse()}>Browse…</button>
              {form.path.trim() ? <button className="btn small" onClick={() => void readReadme()}>Read README</button> : null}
            </b>
            <span>status</span>
            <b>
              <select className="cell-select" value={form.status} onChange={(e) => setForm((f) => ({ ...f, status: e.target.value as ProjectStatus }))}>
                {STATUSES.map((s) => <option key={s} value={s}>{s}</option>)}
              </select>
            </b>
            <span>description</span>
            <b><textarea style={{ width: '100%', minHeight: 44 }} placeholder="one-line summary / goal" value={form.description} onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))} /></b>
            <span>team</span>
            <b>
              <select className="cell-select" value={form.team} onChange={(e) => setForm((f) => ({ ...f, team: e.target.value }))}>
                <option value="">(none)</option>
                {store.teams.map((t) => <option key={t.id} value={t.name}>{t.name}</option>)}
              </select>
            </b>
            <span>tags</span>
            <b><input style={{ width: '100%' }} placeholder="comma-separated" value={form.tags} onChange={(e) => setForm((f) => ({ ...f, tags: e.target.value }))} /></b>
            <span>links</span>
            <b><textarea style={{ width: '100%', minHeight: 40 }} placeholder="one URL per line (repo, dashboard, docs…)" value={form.links} onChange={(e) => setForm((f) => ({ ...f, links: e.target.value }))} /></b>
            <span>notes</span>
            <b><textarea style={{ width: '100%', minHeight: 60 }} placeholder="freeform notes" value={form.notes} onChange={(e) => setForm((f) => ({ ...f, notes: e.target.value }))} /></b>
          </div>
          <div className="row-actions" style={{ marginTop: 10 }}>
            <span className="grow" />
            <button className="btn" disabled={busy} onClick={() => setEditing(null)}>Cancel</button>
            <button className="btn primary" disabled={busy || !form.name.trim()} onClick={() => void save()}>Save</button>
          </div>
        </section>
      ) : null}

      <div className="skill-catalog">
        {shown.map((p) => {
          const g = gitMap[p.id];
          const out = gitOut[p.id];
          return (
            <div className="skill-card" key={p.id}>
              <div className="skill-card-head">
                <span className={`st-badge ${STATUS_CLASS[p.status]}`}>{STATUS_LABEL[p.status]}</span>
                <span className="b">{p.name}</span>
                {p.team ? <span className="muted small">· {p.team}</span> : null}
                <span className="grow" />
                <select className="cell-select small" value={p.status} disabled={busy} onChange={(e) => void setStatus(p, e.target.value as ProjectStatus)} title="Change status">
                  {STATUSES.map((s) => <option key={s} value={s}>{s}</option>)}
                </select>
                <button className="btn" disabled={busy} onClick={() => openEdit(p)}>Edit</button>
                {confirmDel === p.id ? (
                  <>
                    <button className="btn icon-danger" disabled={busy} onClick={() => void remove(p.id)}>Delete?</button>
                    <button className="btn" disabled={busy} onClick={() => setConfirmDel(null)}>Cancel</button>
                  </>
                ) : (
                  <button className="btn icon-danger" disabled={busy} title="Delete project (folder is left untouched)" onClick={() => setConfirmDel(p.id)}>✕</button>
                )}
              </div>
              {p.description ? <p className="muted small skill-desc">{p.description}</p> : null}

              {p.path ? (
                <div className="project-git">
                  <div className="row-actions" style={{ gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
                    <GitStatus g={g} />
                    <span className="grow" />
                    <button className="btn small" title="Open folder" onClick={() => void call('project:openFolder', p.path)}>open ↗</button>
                  </div>
                  <div className="muted small mono project-path" title={p.path}>{p.path}</div>
                  {g?.isRepo ? (
                    <div className="row-actions" style={{ gap: 6, marginTop: 6, flexWrap: 'wrap' }}>
                      {GIT_ACTIONS.map((act) => (
                        <button key={act} className="btn small" disabled={gitBusy === `${p.id}:${act}`} onClick={() => void runGit(p, act)}>
                          {gitBusy === `${p.id}:${act}` ? '…' : act}
                        </button>
                      ))}
                      {g.remoteUrl ? <a className="ext-link small" href={g.remoteUrl.replace(/\.git$/, '').replace(/^git@github\.com:/, 'https://github.com/')} target="_blank" rel="noreferrer" style={{ marginLeft: 'auto' }}>remote ↗</a> : null}
                    </div>
                  ) : null}
                  {out ? <pre className="git-out">{out.output}</pre> : null}
                </div>
              ) : null}

              {(p.tags ?? []).length > 0 ? (
                <div className="chips skill-tags">{(p.tags ?? []).map((t) => <span className="chip" key={t}>{t}</span>)}</div>
              ) : null}
              {(p.links ?? []).length > 0 ? (
                <div className="chips" style={{ marginTop: 8 }}>
                  {(p.links ?? []).map((l) => (
                    <a className="ext-link small" key={l} href={/^https?:\/\//i.test(l) ? l : `https://${l}`} target="_blank" rel="noreferrer">{l.replace(/^https?:\/\//i, '')}</a>
                  ))}
                </div>
              ) : null}
              {p.notes ? <p className="muted small" style={{ marginTop: 8, whiteSpace: 'pre-wrap' }}>{p.notes}</p> : null}
            </div>
          );
        })}
        {projects.length === 0 ? (
          <p className="muted center pad">No projects yet. <b>Import folder…</b> to pull one in from disk, or <b>+ New project</b> to add manually.</p>
        ) : shown.length === 0 ? (
          <p className="muted center pad">No projects with status “{filter}”.</p>
        ) : null}
      </div>
    </div>
  );
}
