import { useEffect, useMemo, useRef, useState } from 'react';
import { call, resolveCoordinator, type FleetStore } from '../store.ts';

/**
 * Plans tab (under Work). Two sets:
 *  - Brain plans — the LIVE, read-only plan set the brain maintains on disk.
 *  - Your drafts — local AI-generated plans you can edit, version (with a changelog),
 *    organize (search / status filter / sort / tags / group), and revise with AI.
 * Both sets share one organizer toolbar (search / sort / group); each keeps its own
 * status filter (and drafts add tag filters).
 */

type PlanStatus = 'draft' | 'active' | 'done' | 'archived';
type PlanRevision = { version: number; at: number; note: string; content: string };
interface Plan {
  id: string; title: string; request: string; agent?: string; team: string;
  status: PlanStatus; content: string; version: number; revisions: PlanRevision[];
  tags?: string[]; createdAt: number; updatedAt: number;
}
type PlanSummary = { id: string; title: string; status: PlanStatus; version: number; agent?: string; team: string; updatedAt: number; tags?: string[] };

// Brain plans: the LIVE, read-only plan set the brain maintains on disk.
type BrainPlan = { num?: string; title: string; file: string; status?: string; effort?: string; notes?: string };
type BrainPlansResp = { dir: string | null; plans: BrainPlan[] };

type SortMode = 'recent' | 'title' | 'status';

const STATUSES: PlanStatus[] = ['draft', 'active', 'done', 'archived'];
const STATUS_CLASS: Record<PlanStatus, string> = { draft: 'st-paused', active: 'st-active', done: 'st-done', archived: 'st-blocked' };

const BRAIN_BUCKETS: { key: string; label: string }[] = [
  { key: 'done', label: 'Done' }, { key: 'partial', label: 'Partial' },
  { key: 'pending', label: 'Pending' }, { key: 'hold', label: 'On hold' },
];
function brainStatusKey(s?: string): string {
  const t = (s || '').toLowerCase();
  if (/done|✅/.test(t)) return 'done';
  if (/partial|🔄|progress/.test(t)) return 'partial';
  if (/hold|🛑|block/.test(t)) return 'hold';
  return 'pending';
}
const BRAIN_KEY_CLASS: Record<string, string> = { done: 'st-done', partial: 'st-active', pending: 'st-paused', hold: 'st-blocked' };

function qArg(s: string): string { return `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`; }
function clip(s: string, n: number): string { const t = s.replace(/\s+/g, ' ').trim(); return t.length > n ? t.slice(0, n) + '…' : t; }
function newId(): string { return `plan_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`; }
function splitTags(s: string): string[] { return [...new Set(s.split(/[,\n]/).map((t) => t.trim()).filter(Boolean))]; }
function ago(ts: number): string {
  const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (s < 60) return `${s}s ago`; if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`; return `${Math.round(s / 86400)}d ago`;
}
function group<T>(items: T[], keyOf: (x: T) => string, buckets: { key: string; label: string }[]) {
  return buckets.map((b) => ({ ...b, items: items.filter((x) => keyOf(x) === b.key) })).filter((g) => g.items.length);
}

const GEN_PROMPT = (req: string) =>
  `Create a clear, structured implementation plan for this request. Use Markdown: a one-line overview, then numbered phases with concrete steps, dependencies, and risks/considerations. Be specific and actionable.\n\nRequest: ${req}`;
const UPDATE_PROMPT = (content: string, instr: string) =>
  `Here is the current plan (Markdown):\n\n${content}\n\nRevise it according to these instructions: ${instr}\n\nReturn the COMPLETE updated plan in Markdown (the full document, not just the changes).`;
const SUGGEST_PROMPT = (content: string) =>
  `Review this implementation plan and list 3-6 concrete, high-value improvements as short imperative instructions, ONE per line, no preamble or numbering (e.g. "Add a rollback step to phase 3", "Specify the DB migration order"). Plan:\n\n${content}`;

export function Plans({ store }: { store: FleetStore }) {
  const team = store.team ?? 'default';
  const coordinator = resolveCoordinator(store.agents, store.coordinator) ?? store.agents[0]?.name ?? '';
  const [plans, setPlans] = useState<PlanSummary[]>([]);
  const [detail, setDetail] = useState<Plan | null>(null); // the expanded plan
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');
  const [showNew, setShowNew] = useState(false);
  const [req, setReq] = useState('');
  const [agent, setAgent] = useState('');
  const [updInstr, setUpdInstr] = useState('');
  const [updAgent, setUpdAgent] = useState(''); // agent chosen to revise / suggest
  const [tagInput, setTagInput] = useState(''); // detail tags editor buffer
  const [showLog, setShowLog] = useState(false);
  const [viewVer, setViewVer] = useState<number | null>(null); // a past revision being viewed
  const [confirmDel, setConfirmDel] = useState(false);
  const aliveRef = useRef(true);          // skip UI updates after unmount
  const genTok = useRef(0);               // bump to abandon an in-flight dispatch
  useEffect(() => () => { aliveRef.current = false; }, []);
  function cancel() { genTok.current++; setBusy(false); setMsg('cancelled'); }

  const genAgent = (agent && store.agents.some((a) => a.name === agent) ? agent : coordinator);
  const okContent = (s: string) => { const t = (s || '').trim(); return t && t !== '(empty reply)' && t !== '(no reply)' ? t : ''; };
  const names = useMemo(() => store.agents.map((a) => a.name), [store.agents]);

  // ---- organizer (shared) ----
  const [q, setQ] = useState('');
  const [sort, setSort] = useState<SortMode>('recent');
  const [groupBy, setGroupBy] = useState(false);
  const [draftStatus, setDraftStatus] = useState<Set<string>>(new Set());
  const [tagFilter, setTagFilter] = useState<Set<string>>(new Set());
  const [brainStatus, setBrainStatus] = useState<Set<string>>(new Set());
  const toggle = (set: (u: (prev: Set<string>) => Set<string>) => void, v: string) =>
    set((prev) => { const n = new Set(prev); if (n.has(v)) n.delete(v); else n.add(v); return n; });

  async function reload() { setPlans(await call<PlanSummary[]>('plans:list', team).catch(() => [])); }
  useEffect(() => { void reload(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [team, store.lastUpdated]);

  // Brain plans: live, self-updating from <projectsRoot>/brain/plans (read-only).
  const [brain, setBrain] = useState<BrainPlansResp>({ dir: null, plans: [] });
  const [brainOpen, setBrainOpen] = useState<string | null>(null);
  const [brainContent, setBrainContent] = useState('');
  async function reloadBrain() { setBrain(await call<BrainPlansResp>('brain:plans').catch(() => ({ dir: null, plans: [] }))); }
  useEffect(() => {
    void reloadBrain();
    const id = setInterval(() => { void reloadBrain(); }, 10000); // self-update as the brain edits its files
    return () => clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [team, store.lastUpdated]);
  async function openBrain(file: string) {
    if (brainOpen === file) { setBrainOpen(null); setBrainContent(''); return; }
    setBrainOpen(file); setBrainContent('loading…');
    const r = await call<{ file: string; content: string } | null>('brain:plan', file).catch(() => null);
    if (aliveRef.current) setBrainContent(r?.content ?? '(could not read this plan)');
  }

  async function open(id: string) {
    if (detail?.id === id) { setDetail(null); return; } // toggle closed
    setViewVer(null); setShowLog(false); setConfirmDel(false); setUpdInstr('');
    const p = await call<Plan | null>('plans:get', id).catch(() => null);
    setDetail(p);
    setUpdAgent(p?.agent && names.includes(p.agent) ? p.agent : genAgent);
    setTagInput((p?.tags ?? []).join(', '));
  }

  const reviser = updAgent && names.includes(updAgent) ? updAgent : (detail?.agent && names.includes(detail.agent) ? detail.agent : genAgent);

  async function generate() {
    const request = req.trim();
    if (!request) { setMsg('describe what you want a plan for'); return; }
    if (!genAgent) { setMsg('no agent available to generate the plan'); return; }
    const tok = ++genTok.current;
    setBusy(true); setMsg(`generating plan with ${genAgent}…`);
    try {
      const content = okContent(await call<string>('dispatch', `/ask ${genAgent} ${qArg(GEN_PROMPT(request))}`));
      if (genTok.current !== tok) return; // cancelled
      if (!content) { if (aliveRef.current) setMsg('agent returned an empty plan — try again'); return; }
      const now = Date.now();
      const plan: Plan = {
        id: newId(), title: clip(request, 60), request, agent: genAgent, team, status: 'draft',
        content, version: 1, revisions: [{ version: 1, at: now, note: `Generated from: ${clip(request, 80)}`, content }],
        tags: [], createdAt: now, updatedAt: now,
      };
      await call('plans:save', plan); // persist even if the tab was unmounted
      if (!aliveRef.current) return;
      setReq(''); setShowNew(false); setMsg('plan generated ✓');
      await reload();
      setDetail(plan); setViewVer(null); setShowLog(false); setUpdAgent(genAgent); setTagInput('');
    } catch (err) {
      if (aliveRef.current && genTok.current === tok) setMsg(`generation failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      if (aliveRef.current && genTok.current === tok) setBusy(false);
    }
  }

  async function updatePlan() {
    const instr = updInstr.trim();
    if (!detail || !instr) return;
    const base = detail;
    const who = reviser;
    const tok = ++genTok.current;
    setBusy(true); setMsg(`updating plan with ${who}…`);
    try {
      const content = okContent(await call<string>('dispatch', `/ask ${who} ${qArg(UPDATE_PROMPT(base.content, instr))}`));
      if (genTok.current !== tok) return; // cancelled
      if (!content) { if (aliveRef.current) setMsg('agent returned an empty revision — kept the current version'); return; }
      const now = Date.now();
      const version = base.version + 1;
      const next: Plan = { ...base, content, version, agent: who, revisions: [...base.revisions, { version, at: now, note: instr, content }], updatedAt: now };
      await call('plans:save', next);
      if (!aliveRef.current) return;
      setDetail(next); setUpdInstr(''); setViewVer(null); setMsg(`updated to v${version} ✓`);
      await reload();
    } catch (err) {
      if (aliveRef.current && genTok.current === tok) setMsg(`update failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      if (aliveRef.current && genTok.current === tok) setBusy(false);
    }
  }

  /** Ask the agent to propose improvements; drop them into the instruction box for review. */
  async function suggest() {
    if (!detail) return;
    const who = reviser;
    const tok = ++genTok.current;
    setBusy(true); setMsg(`asking ${who} for improvements…`);
    try {
      const out = okContent(await call<string>('dispatch', `/ask ${who} ${qArg(SUGGEST_PROMPT(detail.content))}`));
      if (genTok.current !== tok) return;
      if (!out) { if (aliveRef.current) setMsg('no suggestions returned — try again'); return; }
      if (aliveRef.current) { setUpdInstr(out); setMsg('suggestions ready — review/edit below, then Update'); }
    } catch (err) {
      if (aliveRef.current && genTok.current === tok) setMsg(`suggest failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      if (aliveRef.current && genTok.current === tok) setBusy(false);
    }
  }

  /** Field edit (title/status/tags): merge onto the LATEST stored plan so it can't
   *  clobber a freshly-saved revision. */
  async function patchPlan(p: Partial<Plan>) {
    if (!detail) return;
    const cur = (await call<Plan | null>('plans:get', detail.id).catch(() => null)) ?? detail;
    const next = { ...cur, ...p, updatedAt: Date.now() };
    setDetail(next);
    await call('plans:save', next).catch(() => {});
    if (aliveRef.current) await reload();
  }
  async function remove() {
    if (!detail) return;
    await call('plans:remove', detail.id).catch(() => {});
    setDetail(null); setConfirmDel(false); setMsg('plan deleted ✓');
    await reload();
  }

  const shownContent = detail ? (viewVer != null ? detail.revisions.find((r) => r.version === viewVer)?.content ?? detail.content : detail.content) : '';
  const allDraftTags = useMemo(() => { const s = new Set<string>(); for (const p of plans) for (const t of p.tags ?? []) s.add(t); return [...s].sort(); }, [plans]);

  const organizedBrain = useMemo(() => {
    const ql = q.trim().toLowerCase();
    let list = brain.plans.filter((p) => {
      if (brainStatus.size && !brainStatus.has(brainStatusKey(p.status))) return false;
      if (!ql) return true;
      return p.title.toLowerCase().includes(ql) || (p.notes ?? '').toLowerCase().includes(ql) || (p.num ?? '').includes(ql);
    });
    if (sort === 'title') list = [...list].sort((a, b) => a.title.localeCompare(b.title));
    else if (sort === 'status') list = [...list].sort((a, b) => BRAIN_BUCKETS.findIndex((x) => x.key === brainStatusKey(a.status)) - BRAIN_BUCKETS.findIndex((x) => x.key === brainStatusKey(b.status)));
    return list; // 'recent' keeps the index order
  }, [brain.plans, q, brainStatus, sort]);

  const organizedDrafts = useMemo(() => {
    const ql = q.trim().toLowerCase();
    let list = plans.filter((p) => {
      if (draftStatus.size && !draftStatus.has(p.status)) return false;
      if (tagFilter.size && !(p.tags ?? []).some((t) => tagFilter.has(t))) return false;
      if (!ql) return true;
      return p.title.toLowerCase().includes(ql) || (p.agent ?? '').toLowerCase().includes(ql) || (p.tags ?? []).some((t) => t.toLowerCase().includes(ql));
    });
    if (sort === 'title') list = [...list].sort((a, b) => a.title.localeCompare(b.title));
    else if (sort === 'status') list = [...list].sort((a, b) => STATUSES.indexOf(a.status) - STATUSES.indexOf(b.status));
    return list; // 'recent' = plans:list order (updatedAt desc)
  }, [plans, q, draftStatus, tagFilter, sort]);

  // ---- card renderers ----
  const brainCard = (p: BrainPlan) => {
    const isOpen = brainOpen === p.file;
    return (
      <div className={`skill-card${isOpen ? ' editing' : ''}`} key={p.file}>
        <div className="skill-card-head" style={{ cursor: 'pointer' }} onClick={() => void openBrain(p.file)}>
          {p.status ? <span className={`st-badge ${BRAIN_KEY_CLASS[brainStatusKey(p.status)]}`}>{p.status}</span> : null}
          {p.num ? <span className="mono small muted">{p.num}</span> : null}
          <span className="b">{p.title}</span>
          {p.effort ? <span className="muted small">· {p.effort}</span> : null}
          <span className="grow" />
          {p.notes ? <span className="muted small" style={{ maxWidth: 300, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={p.notes}>{p.notes}</span> : null}
          <span className="muted">{isOpen ? '▾' : '▸'}</span>
        </div>
        {isOpen ? <pre className="plan-content">{brainContent}</pre> : null}
      </div>
    );
  };

  const draftCard = (p: PlanSummary) => {
    const isOpen = detail?.id === p.id;
    return (
      <div className={`skill-card${isOpen ? ' editing' : ''}`} key={p.id}>
        <div className="skill-card-head" style={{ cursor: 'pointer' }} onClick={() => void open(p.id)}>
          <span className={`st-badge ${STATUS_CLASS[p.status]}`}>{p.status}</span>
          <span className="b">{p.title}</span>
          <span className="muted small">· v{p.version}{p.agent ? ` · ${p.agent}` : ''}</span>
          {(p.tags ?? []).length ? <span className="muted small">· {(p.tags ?? []).join(', ')}</span> : null}
          <span className="grow" />
          <span className="muted small">{ago(p.updatedAt)}</span>
          <span className="muted">{isOpen ? '▾' : '▸'}</span>
        </div>
        {isOpen && detail ? (
          <div className="plan-detail">
            <div className="row-actions" style={{ gap: 8, flexWrap: 'wrap', alignItems: 'center', marginBottom: 6 }}>
              <input className="chat-title" style={{ flex: '0 1 280px' }} value={detail.title} disabled={busy} onChange={(e) => setDetail({ ...detail, title: e.target.value })} onBlur={(e) => void patchPlan({ title: e.target.value })} />
              <select className="cell-select small" value={detail.status} disabled={busy} onChange={(e) => void patchPlan({ status: e.target.value as PlanStatus })}>
                {STATUSES.map((s) => <option key={s} value={s}>{s}</option>)}
              </select>
              <input style={{ flex: '0 1 220px', fontSize: 12 }} placeholder="tags (comma-separated)" value={tagInput} disabled={busy} onChange={(e) => setTagInput(e.target.value)} onBlur={() => void patchPlan({ tags: splitTags(tagInput) })} title="categorize this plan" />
              <span className="grow" />
              <button className="btn small" disabled={busy} onClick={() => setShowLog((v) => !v)}>{showLog ? 'Hide changelog' : `Changelog (${detail.revisions.length})`}</button>
              {confirmDel ? (
                <>
                  <button className="btn icon-danger small" disabled={busy} onClick={() => void remove()}>Delete?</button>
                  <button className="btn small" disabled={busy} onClick={() => setConfirmDel(false)}>Cancel</button>
                </>
              ) : (
                <button className="btn icon-danger small" disabled={busy} title="Delete plan" onClick={() => setConfirmDel(true)}>✕</button>
              )}
            </div>

            {viewVer != null ? <div className="muted small" style={{ marginBottom: 4 }}>viewing v{viewVer} · <button className="link-btn" onClick={() => setViewVer(null)}>back to current (v{detail.version})</button></div> : null}
            <pre className="plan-content">{shownContent}</pre>

            {showLog ? (
              <div className="plan-log">
                <div className="muted small b" style={{ margin: '8px 0 4px' }}>Changelog</div>
                {[...detail.revisions].reverse().map((r) => (
                  <div className="feed-row" key={r.version}>
                    <span className="mono small">v{r.version}</span>
                    <span className="muted small">{ago(r.at)}</span>
                    <span className="small grow">{r.note}</span>
                    <button className="link-btn small" onClick={() => setViewVer(r.version === detail.version ? null : r.version)}>{r.version === detail.version ? 'current' : 'view'}</button>
                  </div>
                ))}
              </div>
            ) : null}

            <div className="row-actions" style={{ gap: 6, marginTop: 8, alignItems: 'center', flexWrap: 'wrap' }}>
              <span className="muted small">revise with</span>
              <select className="cell-select small" value={reviser} disabled={busy} onChange={(e) => setUpdAgent(e.target.value)} title="agent that revises this plan">
                {names.map((n) => <option key={n} value={n}>{n}</option>)}
              </select>
              <button className="btn small" disabled={busy} title="Ask the agent to propose improvements" onClick={() => void suggest()}>✦ Suggest improvements</button>
            </div>
            <div className="row-actions" style={{ gap: 6, marginTop: 6, alignItems: 'flex-start' }}>
              <textarea style={{ flex: 1, minHeight: 38 }} placeholder="update the plan — e.g. “add a rollback step to phase 3” (creates a new version + changelog entry)" value={updInstr} disabled={busy} onChange={(e) => setUpdInstr(e.target.value)} />
              <button className="btn primary" disabled={busy || !updInstr.trim()} onClick={() => void updatePlan()}>{busy ? '…' : 'Update'}</button>
            </div>
          </div>
        ) : null}
      </div>
    );
  };

  const statusChips = (ids: string[], active: Set<string>, onToggle: (id: string) => void, labelOf: (id: string) => string, classOf: (id: string) => string) => (
    <span className="chips">
      {ids.map((id) => (
        <button key={id} className={`chip${active.has(id) ? ' on' : ''}`} onClick={() => onToggle(id)} title={`filter: ${labelOf(id)}`}>
          <span className={`st-dot ${classOf(id)}`} /> {labelOf(id)}
        </button>
      ))}
    </span>
  );

  return (
    <>
      {/* Shared organizer */}
      <div className="row-actions" style={{ gap: 8, flexWrap: 'wrap', alignItems: 'center', marginBottom: 8 }}>
        <input className="catalog-search" placeholder="search plans…" value={q} onChange={(e) => setQ(e.target.value)} />
        <span className="muted small">sort</span>
        <select className="cell-select small" value={sort} onChange={(e) => setSort(e.target.value as SortMode)}>
          <option value="recent">most recent</option>
          <option value="title">title (A–Z)</option>
          <option value="status">status</option>
        </select>
        <label className="muted small" style={{ display: 'inline-flex', alignItems: 'center', gap: 6, cursor: 'pointer' }}>
          <input type="checkbox" checked={groupBy} onChange={(e) => setGroupBy(e.target.checked)} /> group by status
        </label>
        <span className="grow" />
        {msg ? <span className={`small ${/failed|timed out|expired|cancelled/.test(msg) ? 'status-error' : 'muted'}`}>{msg}</span> : null}
        {busy ? <button className="btn" onClick={cancel}>Cancel</button> : null}
      </div>

      <section className="card">
        <div className="row-actions" style={{ alignItems: 'center', marginBottom: 6, flexWrap: 'wrap', gap: 8 }}>
          <h3 style={{ margin: 0 }}>Brain plans</h3>
          <span className="muted small">· {organizedBrain.length}/{brain.plans.length} · ⟳ live</span>
          {statusChips(BRAIN_BUCKETS.map((b) => b.key), brainStatus, (id) => toggle(setBrainStatus, id), (k) => BRAIN_BUCKETS.find((b) => b.key === k)?.label ?? k, (k) => BRAIN_KEY_CLASS[k])}
          <span className="grow" />
          {brain.dir
            ? <span className="muted small mono" title={brain.dir}>{brain.dir.replace(/^.*\/projects\//, '…/')}</span>
            : <span className="warn-text small">brain plans dir not found</span>}
        </div>
        {brain.plans.length === 0 ? (
          <p className="muted small">{brain.dir ? 'No plans in the brain index yet.' : 'Could not locate the brain plans directory (projects root not detected — set it in Projects).'}</p>
        ) : organizedBrain.length === 0 ? (
          <p className="muted center pad">No brain plans match the filter.</p>
        ) : groupBy ? (
          group(organizedBrain, (p) => brainStatusKey(p.status), BRAIN_BUCKETS).map((g) => (
            <div key={g.key}>
              <div className="muted small b" style={{ margin: '8px 0 4px' }}>{g.label} · {g.items.length}</div>
              <div className="skill-catalog">{g.items.map(brainCard)}</div>
            </div>
          ))
        ) : (
          <div className="skill-catalog">{organizedBrain.map(brainCard)}</div>
        )}
      </section>

      <div className="row-actions" style={{ margin: '14px 0 4px', alignItems: 'center', flexWrap: 'wrap', gap: 8 }}>
        <h3 style={{ margin: 0 }}>Your drafts</h3>
        <span className="muted small">· {organizedDrafts.length}/{plans.length}</span>
        {statusChips(STATUSES, draftStatus, (id) => toggle(setDraftStatus, id), (s) => s, (s) => STATUS_CLASS[s as PlanStatus])}
        <span className="grow" />
        <button className="btn primary" disabled={busy} onClick={() => setShowNew((v) => !v)}>{showNew ? '− Cancel' : '+ Request a plan'}</button>
      </div>
      {allDraftTags.length ? (
        <div className="chips" style={{ marginBottom: 8 }}>
          <span className="muted small" style={{ marginRight: 4 }}>tags:</span>
          {allDraftTags.map((t) => (
            <button key={t} className={`chip${tagFilter.has(t) ? ' on' : ''}`} onClick={() => toggle(setTagFilter, t)}>{tagFilter.has(t) ? '✓ ' : ''}{t}</button>
          ))}
          {tagFilter.size ? <button className="btn small" onClick={() => setTagFilter(new Set())}>clear</button> : null}
        </div>
      ) : null}

      {showNew ? (
        <section className="card">
          <h3>Request a plan</h3>
          <div className="kv" style={{ gridTemplateColumns: '90px 1fr', gap: '8px 12px' }}>
            <span>agent</span>
            <b>
              <select className="cell-select" value={genAgent} disabled={busy} onChange={(e) => setAgent(e.target.value)}>
                {names.map((n) => <option key={n} value={n}>{n}</option>)}
              </select>
            </b>
            <span>request</span>
            <b><textarea style={{ width: '100%', minHeight: 70 }} placeholder="what should the plan accomplish? e.g. “migrate the brain to the self-improving facts model (Plan 22) in phases”" value={req} disabled={busy} onChange={(e) => setReq(e.target.value)} /></b>
          </div>
          <div className="row-actions" style={{ marginTop: 10 }}>
            <span className="grow" />
            <button className="btn primary" disabled={busy || !req.trim()} onClick={() => void generate()}>{busy ? 'Generating…' : 'Generate plan'}</button>
          </div>
        </section>
      ) : null}

      {plans.length === 0 ? (
        <p className="muted center pad">No plans yet. <b>+ Request a plan</b> and an agent will draft one — then update it anytime and it keeps a changelog.</p>
      ) : organizedDrafts.length === 0 ? (
        <p className="muted center pad">No drafts match the filter.</p>
      ) : groupBy ? (
        group(organizedDrafts, (p) => p.status, STATUSES.map((s) => ({ key: s, label: s }))).map((g) => (
          <div key={g.key}>
            <div className="muted small b" style={{ margin: '8px 0 4px' }}>{g.label} · {g.items.length}</div>
            <div className="skill-catalog">{g.items.map(draftCard)}</div>
          </div>
        ))
      ) : (
        <div className="skill-catalog">{organizedDrafts.map(draftCard)}</div>
      )}
    </>
  );
}
