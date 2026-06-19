import { useEffect, useMemo, useState } from 'react';
import { call, type FleetStore } from '../store.ts';
import type { ProjectEntry, ProjectStatus } from '../../../../idctl/src/settings/schema.ts';

const STATUSES: ProjectStatus[] = ['active', 'paused', 'blocked', 'done'];
const STATUS_LABEL: Record<ProjectStatus, string> = { active: 'active', paused: 'paused', blocked: 'blocked', done: 'done' };
const STATUS_CLASS: Record<ProjectStatus, string> = { active: 'st-active', paused: 'st-paused', blocked: 'st-blocked', done: 'st-done' };

function newId(): string {
  return `p_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
}
function splitList(s: string): string[] {
  return s.split(/[,\n]/).map((x) => x.trim()).filter(Boolean);
}
const BLANK = { name: '', status: 'active' as ProjectStatus, description: '', team: '', tags: '', links: '', notes: '' };

export function Projects({ store }: { store: FleetStore }) {
  const [projects, setProjects] = useState<ProjectEntry[]>([]);
  const [filter, setFilter] = useState<ProjectStatus | 'all'>('all');
  const [editing, setEditing] = useState<string | null>(null); // project id, 'new', or null
  const [form, setForm] = useState(BLANK);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState('');
  const [confirmDel, setConfirmDel] = useState<string | null>(null);

  async function load() { setProjects(await call<ProjectEntry[]>('projects:list').catch(() => [])); }
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
    setForm({ name: p.name, status: p.status, description: p.description ?? '', team: p.team ?? '', tags: (p.tags ?? []).join(', '), links: (p.links ?? []).join('\n'), notes: p.notes ?? '' });
    setEditing(p.id); setNote('');
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
        notes: form.notes.trim() || undefined,
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
      };
      setProjects(await call<ProjectEntry[]>('projects:save', entry));
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

  return (
    <div className="view">
      <header className="view-head">
        <h1>Projects</h1>
        <button className="btn primary" disabled={busy} onClick={() => (editing === 'new' ? setEditing(null) : openNew())}>
          {editing === 'new' ? '− Cancel' : '+ New project'}
        </button>
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
        {shown.map((p) => (
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
                <button className="btn icon-danger" disabled={busy} title="Delete project" onClick={() => setConfirmDel(p.id)}>✕</button>
              )}
            </div>
            {p.description ? <p className="muted small skill-desc">{p.description}</p> : null}
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
        ))}
        {projects.length === 0 ? (
          <p className="muted center pad">No projects yet. Click <b>+ New project</b> to start tracking one.</p>
        ) : shown.length === 0 ? (
          <p className="muted center pad">No projects with status “{filter}”.</p>
        ) : null}
      </div>
    </div>
  );
}
