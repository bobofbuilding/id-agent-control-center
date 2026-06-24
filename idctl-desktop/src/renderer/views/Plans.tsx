import { useEffect, useMemo, useRef, useState } from 'react';
import { call, resolveCoordinator, type FleetStore } from '../store.ts';

/**
 * Plans tab (under Work): request a plan from an agent, save it, view it,
 * update it (each update is a new version with a changelog note), and browse
 * the per-plan changelog.
 */

type PlanStatus = 'draft' | 'active' | 'done' | 'archived';
type PlanRevision = { version: number; at: number; note: string; content: string };
interface Plan {
  id: string; title: string; request: string; agent?: string; team: string;
  status: PlanStatus; content: string; version: number; revisions: PlanRevision[];
  createdAt: number; updatedAt: number;
}
type PlanSummary = { id: string; title: string; status: PlanStatus; version: number; agent?: string; team: string; updatedAt: number };

// Brain plans: the LIVE, read-only plan set the brain maintains on disk.
type BrainPlan = { num?: string; title: string; file: string; status?: string; effort?: string; notes?: string };
type BrainPlansResp = { dir: string | null; plans: BrainPlan[] };
function brainStatusClass(s?: string): string {
  const t = (s || '').toLowerCase();
  if (/done|✅/.test(t)) return 'st-done';
  if (/partial|🔄|progress/.test(t)) return 'st-active';
  if (/hold|🛑|block/.test(t)) return 'st-blocked';
  return 'st-paused'; // pending / unknown
}

const STATUSES: PlanStatus[] = ['draft', 'active', 'done', 'archived'];
const STATUS_CLASS: Record<PlanStatus, string> = { draft: 'st-paused', active: 'st-active', done: 'st-done', archived: 'st-blocked' };

function qArg(s: string): string { return `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`; }
function clip(s: string, n: number): string { const t = s.replace(/\s+/g, ' ').trim(); return t.length > n ? t.slice(0, n) + '…' : t; }
function newId(): string { return `plan_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`; }
function ago(ts: number): string {
  const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (s < 60) return `${s}s ago`; if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`; return `${Math.round(s / 86400)}d ago`;
}
const GEN_PROMPT = (req: string) =>
  `Create a clear, structured implementation plan for this request. Use Markdown: a one-line overview, then numbered phases with concrete steps, dependencies, and risks/considerations. Be specific and actionable.\n\nRequest: ${req}`;
const UPDATE_PROMPT = (content: string, instr: string) =>
  `Here is the current plan (Markdown):\n\n${content}\n\nRevise it according to these instructions: ${instr}\n\nReturn the COMPLETE updated plan in Markdown (the full document, not just the changes).`;

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
    setViewVer(null); setShowLog(false); setConfirmDel(false);
    setDetail(await call<Plan | null>('plans:get', id).catch(() => null));
  }

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
        createdAt: now, updatedAt: now,
      };
      await call('plans:save', plan); // persist even if the tab was unmounted
      if (!aliveRef.current) return;
      setReq(''); setShowNew(false); setMsg('plan generated ✓');
      await reload();
      setDetail(plan); setViewVer(null); setShowLog(false);
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
    const who = base.agent && store.agents.some((a) => a.name === base.agent) ? base.agent : genAgent;
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

  /** Field edit (title/status): merge onto the LATEST stored plan so it can't
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

  return (
    <>
      <section className="card">
        <div className="row-actions" style={{ alignItems: 'center', marginBottom: 6 }}>
          <h3 style={{ margin: 0 }}>Brain plans</h3>
          <span className="muted small">· {brain.plans.length} · ⟳ live</span>
          <span className="grow" />
          {brain.dir
            ? <span className="muted small mono" title={brain.dir}>{brain.dir.replace(/^.*\/projects\//, '…/')}</span>
            : <span className="warn-text small">brain plans dir not found</span>}
        </div>
        {brain.plans.length === 0 ? (
          <p className="muted small">{brain.dir ? 'No plans in the brain index yet.' : 'Could not locate the brain plans directory (projects root not detected — set it in Projects).'}</p>
        ) : (
          <div className="skill-catalog">
            {brain.plans.map((p) => {
              const isOpen = brainOpen === p.file;
              return (
                <div className={`skill-card${isOpen ? ' editing' : ''}`} key={p.file}>
                  <div className="skill-card-head" style={{ cursor: 'pointer' }} onClick={() => void openBrain(p.file)}>
                    {p.status ? <span className={`st-badge ${brainStatusClass(p.status)}`}>{p.status}</span> : null}
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
            })}
          </div>
        )}
      </section>

      <h3 style={{ margin: '14px 0 4px' }}>Your drafts</h3>
      <div className="row-actions" style={{ marginBottom: 8, alignItems: 'center' }}>
        <span className="muted small">{plans.length} plan{plans.length === 1 ? '' : 's'}</span>
        <span className="grow" />
        {msg ? <span className={`small ${/failed|timed out|expired|cancelled/.test(msg) ? 'status-error' : 'muted'}`}>{msg}</span> : null}
        {busy ? <button className="btn" onClick={cancel}>Cancel</button> : null}
        <button className="btn primary" disabled={busy} onClick={() => setShowNew((v) => !v)}>{showNew ? '− Cancel' : '+ Request a plan'}</button>
      </div>

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

      <div className="skill-catalog">
        {plans.map((p) => {
          const isOpen = detail?.id === p.id;
          return (
            <div className={`skill-card${isOpen ? ' editing' : ''}`} key={p.id}>
              <div className="skill-card-head" style={{ cursor: 'pointer' }} onClick={() => void open(p.id)}>
                <span className={`st-badge ${STATUS_CLASS[p.status]}`}>{p.status}</span>
                <span className="b">{p.title}</span>
                <span className="muted small">· v{p.version}{p.agent ? ` · ${p.agent}` : ''}</span>
                <span className="grow" />
                <span className="muted small">{ago(p.updatedAt)}</span>
                <span className="muted">{isOpen ? '▾' : '▸'}</span>
              </div>

              {isOpen && detail ? (
                <div className="plan-detail">
                  <div className="row-actions" style={{ gap: 8, flexWrap: 'wrap', alignItems: 'center', marginBottom: 6 }}>
                    <input className="chat-title" style={{ flex: '0 1 320px' }} value={detail.title} disabled={busy} onChange={(e) => setDetail({ ...detail, title: e.target.value })} onBlur={(e) => void patchPlan({ title: e.target.value })} />
                    <select className="cell-select small" value={detail.status} disabled={busy} onChange={(e) => void patchPlan({ status: e.target.value as PlanStatus })}>
                      {STATUSES.map((s) => <option key={s} value={s}>{s}</option>)}
                    </select>
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

                  <div className="row-actions" style={{ gap: 6, marginTop: 8, alignItems: 'flex-start' }}>
                    <textarea style={{ flex: 1, minHeight: 38 }} placeholder="update the plan — e.g. “add a rollback step to phase 3” (creates a new version + changelog entry)" value={updInstr} disabled={busy} onChange={(e) => setUpdInstr(e.target.value)} />
                    <button className="btn primary" disabled={busy || !updInstr.trim()} onClick={() => void updatePlan()}>{busy ? '…' : 'Update'}</button>
                  </div>
                </div>
              ) : null}
            </div>
          );
        })}
        {plans.length === 0 ? <p className="muted center pad">No plans yet. <b>+ Request a plan</b> and an agent will draft one — then update it anytime and it keeps a changelog.</p> : null}
      </div>
    </>
  );
}
