import { useEffect, useMemo, useRef, useState } from 'react';
import { call, resolveCoordinator, type FleetStore } from '../store.ts';

/**
 * Plans tab (under Work). Two sets, one shared organizer (search / sort / group /
 * status + tag filters / archive) at the top:
 *  - Brain plans — the LIVE plan set the brain maintains on disk. Read-only content,
 *    but per-plan actions can AUDIT the real status (and write it back), find BLOCKERS,
 *    COMPILE the plan into tasks, or set it PENDING.
 *  - Your drafts — local AI-generated plans you can edit, version, organize, tag, and
 *    revise with AI. Marking a draft "done" auto-archives it.
 */

type PlanStatus = 'draft' | 'active' | 'done' | 'archived';
type PlanRevision = { version: number; at: number; note: string; content: string };
interface Plan {
  id: string; title: string; request: string; agent?: string; team: string;
  status: PlanStatus; content: string; version: number; revisions: PlanRevision[];
  tags?: string[]; createdAt: number; updatedAt: number;
}
type PlanSummary = { id: string; title: string; status: PlanStatus; version: number; agent?: string; team: string; updatedAt: number; tags?: string[] };
type BrainPlan = { num?: string; title: string; file: string; status?: string; effort?: string; notes?: string };
type BrainPlansResp = { dir: string | null; plans: BrainPlan[] };
type SortMode = 'recent' | 'title' | 'status';

// Auto-decompose IPC shapes (mirror main/work.ts) for "compile into tasks".
type SubTask = { title: string; description: string; agent: string; dependsOn: number[] };
type DecomposeResult = { ok: boolean; subtasks: SubTask[]; raw: string; error?: string };
type CreatedTask = { ok: boolean };
type CreatePlanResult = { created: CreatedTask[]; dispatched: number; deferred: number };
type TeamLead = { team: string; lead: string | null; activeCount: number; totalCount: number };
type FanoutResult = { team: string; lead?: string; status: 'dispatched' | 'no-active-agent' | 'failed'; queryId?: string; detail?: string };

const STATUSES: PlanStatus[] = ['draft', 'active', 'done', 'archived'];
const STATUS_CLASS: Record<PlanStatus, string> = { draft: 'st-paused', active: 'st-active', done: 'st-done', archived: 'st-blocked' };
const BRAIN_BUCKETS: { key: string; label: string }[] = [
  { key: 'done', label: 'Done' }, { key: 'partial', label: 'Partial' },
  { key: 'pending', label: 'Pending' }, { key: 'hold', label: 'On hold' },
];
const BRAIN_KEY_CLASS: Record<string, string> = { done: 'st-done', partial: 'st-active', pending: 'st-paused', hold: 'st-blocked' };
function brainStatusKey(s?: string): string {
  const t = (s || '').toLowerCase();
  if (/done|✅/.test(t)) return 'done';
  if (/partial|🔄|progress/.test(t)) return 'partial';
  if (/hold|🛑|block/.test(t)) return 'hold';
  return 'pending';
}

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
  `Review this implementation plan and list 3-6 concrete, high-value improvements as short imperative instructions, ONE per line, no preamble or numbering (e.g. "Add a rollback step to phase 3"). Plan:\n\n${content}`;
const AUDIT_PROMPT = (title: string, content: string) =>
  'Audit the TRUE current status of this implementation plan. Verify against the ACTUAL codebase and your knowledge — use your tools to check what is really implemented; do NOT just trust the plan\'s own claims. Reply with JSON ONLY (no prose, no fences): {"status":"DONE|PARTIAL|PENDING","summary":"<1-3 sentences: what is actually done and what remains>"}.\n\nPLAN: ' + title + '\n\n' + content;
const BLOCKERS_PROMPT = (title: string, content: string) =>
  'Identify the concrete BLOCKERS preventing this plan from progressing or completing — missing prerequisites, unmet dependencies, decisions needed, or risks that would stop it. Verify against the actual codebase where relevant. Reply with a SHORT markdown bullet list (3-6 bullets max); if there are none, reply exactly "No blockers found." PLAN: ' + title + '\n\n' + content;

export function Plans({ store }: { store: FleetStore }) {
  const team = store.team ?? 'default';
  const coordinator = resolveCoordinator(store.agents, store.coordinator) ?? store.agents[0]?.name ?? '';
  const [plans, setPlans] = useState<PlanSummary[]>([]);
  const [detail, setDetail] = useState<Plan | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');
  const [showNew, setShowNew] = useState(false);
  const [req, setReq] = useState('');
  const [agent, setAgent] = useState('');
  const [updInstr, setUpdInstr] = useState('');
  const [updAgent, setUpdAgent] = useState('');
  const [tagInput, setTagInput] = useState('');
  const [showLog, setShowLog] = useState(false);
  const [viewVer, setViewVer] = useState<number | null>(null);
  const [confirmDel, setConfirmDel] = useState(false);
  const aliveRef = useRef(true);
  const genTok = useRef(0);
  useEffect(() => () => { aliveRef.current = false; }, []);
  function cancel() { genTok.current++; setBusy(false); setMsg('cancelled'); }

  const genAgent = (agent && store.agents.some((a) => a.name === agent) ? agent : coordinator);
  const okContent = (s: string) => { const t = (s || '').trim(); return t && t !== '(empty reply)' && t !== '(no reply)' ? t : ''; };
  const names = useMemo(() => store.agents.map((a) => a.name), [store.agents]);

  // ---- organizer (shared, top) ----
  const [q, setQ] = useState('');
  const [sort, setSort] = useState<SortMode>('recent');
  const [groupBy, setGroupBy] = useState(false);
  const [showArchived, setShowArchived] = useState(false);
  const [draftStatus, setDraftStatus] = useState<Set<string>>(new Set());
  const [tagFilter, setTagFilter] = useState<Set<string>>(new Set());
  const [brainStatus, setBrainStatus] = useState<Set<string>>(new Set());
  const toggle = (set: (u: (prev: Set<string>) => Set<string>) => void, v: string) =>
    set((prev) => { const n = new Set(prev); if (n.has(v)) n.delete(v); else n.add(v); return n; });

  async function reload() { setPlans(await call<PlanSummary[]>('plans:list', team).catch(() => [])); }
  useEffect(() => { void reload(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [team, store.lastUpdated]);

  // ---- brain plans (live, read-only content) ----
  const [brain, setBrain] = useState<BrainPlansResp>({ dir: null, plans: [] });
  const [brainOpen, setBrainOpen] = useState<string | null>(null);
  const [brainContent, setBrainContent] = useState('');
  async function reloadBrain() { setBrain(await call<BrainPlansResp>('brain:plans').catch(() => ({ dir: null, plans: [] }))); }
  useEffect(() => {
    void reloadBrain();
    const id = setInterval(() => { void reloadBrain(); }, 10000);
    return () => clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [team, store.lastUpdated]);
  async function openBrain(file: string) {
    if (brainOpen === file) { setBrainOpen(null); setBrainContent(''); return; }
    setBrainOpen(file); setBrainContent('loading…');
    const r = await call<{ file: string; content: string } | null>('brain:plan', file).catch(() => null);
    if (aliveRef.current) setBrainContent(r?.content ?? '(could not read this plan)');
  }

  // ---- per-brain-plan actions ----
  const [busyFile, setBusyFile] = useState<string | null>(null); // one brain-plan action at a time
  const [audit, setAudit] = useState<Record<string, { from?: string; to?: string; summary: string }>>({});
  const [blockers, setBlockers] = useState<Record<string, string>>({});
  const [compileFor, setCompileFor] = useState<string | null>(null); // plan file showing the lane picker
  const [compileLane, setCompileLane] = useState('doing');
  const COMPILE_LANES = [{ id: 'backlog', label: 'Backlog' }, { id: 'holding', label: 'Holding' }, { id: 'todo', label: 'To Do' }, { id: 'doing', label: 'Doing (work now)' }];
  const [fanFor, setFanFor] = useState<string | null>(null);          // plan file showing the team fan-out picker
  const [fanPick, setFanPick] = useState<Set<string>>(new Set());     // teams chosen for this plan
  const [fanInfo, setFanInfo] = useState<TeamLead[]>([]);             // active-lead + running counts per team
  const allTeams = useMemo(() => store.teams.map((t) => t.name).filter(Boolean), [store.teams]);

  // Load active-lead info for every team when a fan-out picker opens.
  useEffect(() => {
    if (!fanFor || !allTeams.length) return;
    let live = true;
    call<TeamLead[]>('work:teamLeads', allTeams).then((r) => { if (live) setFanInfo(r); }).catch(() => { if (live) setFanInfo([]); });
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fanFor, store.teams.length]);

  /** Fan a brain plan out to several teams' ACTIVE leads — each runs it independently. */
  async function fanOutPlan(p: BrainPlan) {
    const teams = [...fanPick];
    if (!teams.length) return;
    setFanFor(null); setBusyFile(p.file);
    setMsg(`fanning “${p.title}” out to ${teams.length} team${teams.length > 1 ? 's' : ''}…`);
    try {
      const got = await call<{ file: string; content: string } | null>('brain:plan', p.file).catch(() => null);
      const obj = `Implement this plan for your team, end to end:\n\n# ${p.title}\n\n${got?.content ?? ''}`;
      const res = await call<FanoutResult[]>('work:fanout', obj, teams);
      const ok = res.filter((r) => r.status === 'dispatched');
      const bad = res.filter((r) => r.status !== 'dispatched');
      const parts = [
        ok.length ? `dispatched to ${ok.map((r) => `${r.team}/${r.lead}`).join(', ')}` : '',
        bad.length ? `skipped ${bad.map((r) => `${r.team} (${r.status === 'no-active-agent' ? 'no active agent' : 'failed'})`).join(', ')}` : '',
      ].filter(Boolean);
      if (aliveRef.current) setMsg(parts.join(' · ') || 'nothing dispatched');
      if (ok.length) setFanPick(new Set());
    } catch (err) {
      if (aliveRef.current) setMsg(`fan-out failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally { if (aliveRef.current) setBusyFile(null); }
  }
  type StatusWrite = { ok: boolean; from?: string; to?: string; error?: string };

  async function auditPlan(p: BrainPlan) {
    const who = genAgent;
    if (!who) { setMsg('no agent available to audit'); return; }
    setBusyFile(p.file); setMsg(`${who} is auditing “${p.title}” against the codebase…`);
    try {
      const got = await call<{ file: string; content: string } | null>('brain:plan', p.file).catch(() => null);
      const reply = okContent(await call<string>('dispatch', `/ask ${who} ${qArg(AUDIT_PROMPT(p.title, got?.content ?? ''))}`));
      const a = reply.indexOf('{'); const b = reply.lastIndexOf('}');
      const obj = a >= 0 && b > a ? (() => { try { return JSON.parse(reply.slice(a, b + 1)); } catch { return null; } })() : null;
      const status = String(obj?.status ?? '').trim();
      const summary = String(obj?.summary ?? '').trim() || reply.slice(0, 300);
      if (!status) { if (aliveRef.current) { setAudit((m) => ({ ...m, [p.file]: { summary } })); setMsg('audit returned no clear status'); } return; }
      const res = await call<StatusWrite>('brain:setPlanStatus', p.file, status).catch((): StatusWrite => ({ ok: false, error: 'write failed' }));
      if (!aliveRef.current) return;
      setAudit((m) => ({ ...m, [p.file]: { from: res.from, to: res.to, summary } }));
      setMsg(res.ok ? `“${p.title}”: ${res.from} → ${res.to} ✓` : `audited (write failed: ${res.error ?? 'n/a'})`);
      await reloadBrain();
    } catch (err) {
      if (aliveRef.current) setMsg(`audit failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally { if (aliveRef.current) setBusyFile(null); }
  }

  async function findBlockers(p: BrainPlan) {
    const who = genAgent;
    if (!who) { setMsg('no agent available'); return; }
    setBusyFile(p.file); setMsg(`${who} is checking “${p.title}” for blockers…`);
    try {
      const got = await call<{ file: string; content: string } | null>('brain:plan', p.file).catch(() => null);
      const reply = okContent(await call<string>('dispatch', `/ask ${who} ${qArg(BLOCKERS_PROMPT(p.title, got?.content ?? ''))}`));
      if (aliveRef.current) { setBlockers((m) => ({ ...m, [p.file]: reply || 'no response' })); setMsg(`blockers checked for “${p.title}”`); }
    } catch (err) {
      if (aliveRef.current) setMsg(`blockers check failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally { if (aliveRef.current) setBusyFile(null); }
  }

  // Compile a plan into tasks in a chosen lane. lane='doing' → the lead auto-sorts
  // (dependency order), assigns each task to its agent, and dispatches them to work
  // independently to completion (board auto-updates). Other lanes queue them unowned.
  async function compileToTasks(p: BrainPlan, lane: string) {
    const who = genAgent;
    if (!who) { setMsg('no agent available to compile tasks'); return; }
    const dispatch = lane === 'doing';
    setCompileFor(null); setBusyFile(p.file);
    setMsg(`${who} is compiling “${p.title}” into ${lane}…`);
    try {
      const got = await call<{ file: string; content: string } | null>('brain:plan', p.file).catch(() => null);
      const obj = `Implement this plan as a set of tasks for the team:\n\n# ${p.title}\n\n${got?.content ?? ''}`;
      const dec = await call<DecomposeResult>('work:decompose', obj, who);
      if (!dec.ok || !dec.subtasks.length) { if (aliveRef.current) setMsg(dec.error || 'could not split this plan into tasks'); return; }
      const res = await call<CreatePlanResult>('work:createPlan', obj, dec.subtasks, { lane, dispatch });
      const ok = res.created.filter((c) => c.ok).length;
      if (aliveRef.current) setMsg(dispatch
        ? `created + dispatched ${ok} task${ok === 1 ? '' : 's'} from “${p.title}” → Doing — the lead assigned & is working them; watch the Tasks board`
        : `queued ${ok} task${ok === 1 ? '' : 's'} from “${p.title}” → ${lane} — assign/drag to Doing on the board to start them`);
    } catch (err) {
      if (aliveRef.current) setMsg(`compile failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally { if (aliveRef.current) setBusyFile(null); }
  }

  async function setBrainPending(p: BrainPlan) {
    setBusyFile(p.file); setMsg(`marking “${p.title}” pending…`);
    try {
      const res = await call<StatusWrite>('brain:setPlanStatus', p.file, 'PENDING').catch((): StatusWrite => ({ ok: false, error: 'write failed' }));
      if (aliveRef.current) setMsg(res.ok ? `“${p.title}” → ⏳ PENDING ✓` : `failed: ${res.error ?? 'n/a'}`);
      await reloadBrain();
    } finally { if (aliveRef.current) setBusyFile(null); }
  }

  async function open(id: string) {
    if (detail?.id === id) { setDetail(null); return; }
    setViewVer(null); setShowLog(false); setConfirmDel(false); setUpdInstr('');
    const p = await call<Plan | null>('plans:get', id).catch(() => null);
    setDetail(p);
    const a = p?.agent;
    setUpdAgent(a && names.includes(a) ? a : genAgent);
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
      if (genTok.current !== tok) return;
      if (!content) { if (aliveRef.current) setMsg('agent returned an empty plan — try again'); return; }
      const now = Date.now();
      const plan: Plan = {
        id: newId(), title: clip(request, 60), request, agent: genAgent, team, status: 'draft',
        content, version: 1, revisions: [{ version: 1, at: now, note: `Generated from: ${clip(request, 80)}`, content }],
        tags: [], createdAt: now, updatedAt: now,
      };
      await call('plans:save', plan);
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
      if (genTok.current !== tok) return;
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

  /** Field edit (title/status/tags). Setting status to "done" auto-archives the draft. */
  async function patchPlan(p: Partial<Plan>) {
    if (!detail) return;
    const cur = (await call<Plan | null>('plans:get', detail.id).catch(() => null)) ?? detail;
    const next: Plan = { ...cur, ...p, updatedAt: Date.now() };
    if (p.status === 'done') next.status = 'archived'; // auto-archive on done
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
    return list;
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
    return list;
  }, [plans, q, draftStatus, tagFilter, sort]);

  // active vs archived (auto-archive: brain DONE + draft done/archived are "archived")
  const brainActive = organizedBrain.filter((p) => brainStatusKey(p.status) !== 'done');
  const brainArchived = organizedBrain.filter((p) => brainStatusKey(p.status) === 'done');
  const draftActive = organizedDrafts.filter((p) => p.status !== 'archived' && p.status !== 'done');
  const draftArchived = organizedDrafts.filter((p) => p.status === 'archived' || p.status === 'done');
  const archivedCount = brainArchived.length + draftArchived.length;

  const statusChips = (ids: string[], active: Set<string>, onToggle: (id: string) => void, labelOf: (id: string) => string, classOf: (id: string) => string) => (
    <span className="chips">
      {ids.map((id) => (
        <button key={id} className={`chip${active.has(id) ? ' on' : ''}`} onClick={() => onToggle(id)} title={`filter: ${labelOf(id)}`}>
          <span className={`st-dot ${classOf(id)}`} /> {labelOf(id)}
        </button>
      ))}
    </span>
  );

  const brainCard = (p: BrainPlan) => {
    const isOpen = brainOpen === p.file;
    const acting = busyFile === p.file;
    return (
      <div className={`skill-card${isOpen ? ' editing' : ''}`} key={p.file}>
        <div className="skill-card-head" style={{ cursor: 'pointer' }} onClick={() => void openBrain(p.file)}>
          {p.status ? <span className={`st-badge ${BRAIN_KEY_CLASS[brainStatusKey(p.status)]}`}>{p.status}</span> : null}
          {p.num ? <span className="mono small muted">{p.num}</span> : null}
          <span className="b">{p.title}</span>
          {p.effort ? <span className="muted small">· {p.effort}</span> : null}
          <span className="grow" />
          {p.notes ? <span className="muted small" style={{ maxWidth: 220, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={p.notes}>{p.notes}</span> : null}
          <span className="muted">{isOpen ? '▾' : '▸'}</span>
        </div>
        <div className="row-actions" style={{ gap: 6, padding: '0 8px 6px', flexWrap: 'wrap' }} onClick={(e) => e.stopPropagation()}>
          <button className="btn small" disabled={busyFile !== null} title="Verify the real status against the codebase and update it" onClick={() => void auditPlan(p)}>{acting ? '…' : '✦ Audit status'}</button>
          <button className="btn small" disabled={busyFile !== null} title="Ask an agent what's blocking this plan" onClick={() => void findBlockers(p)}>⚠ Find blockers</button>
          {compileFor === p.file ? (
            <span className="row-actions" style={{ gap: 4, alignItems: 'center' }}>
              <span className="muted small">into</span>
              <select className="cell-select small" value={compileLane} disabled={busyFile !== null} onChange={(e) => setCompileLane(e.target.value)}>
                {COMPILE_LANES.map((l) => <option key={l.id} value={l.id}>{l.label}</option>)}
              </select>
              <button className="btn small" disabled={busyFile !== null} onClick={() => void compileToTasks(p, compileLane)}>Go</button>
              <button className="btn small" disabled={busyFile !== null} onClick={() => setCompileFor(null)}>×</button>
            </span>
          ) : (
            <button className="btn small" disabled={busyFile !== null} title="Decompose this plan into tasks for the active team — pick a lane; Doing dispatches the lead to work them" onClick={() => setCompileFor(p.file)}>⤳ Compile to tasks</button>
          )}
          {fanFor === p.file ? (
            <span className="row-actions" style={{ gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
              <span className="muted small">to teams:</span>
              {allTeams.map((name) => {
                const info = fanInfo.find((t) => t.team === name);
                const canTake = (info?.activeCount ?? 0) > 0 && !!info?.lead;
                return (
                  <label key={name} className="small" title={!info ? 'checking…' : canTake ? `lead: ${info.lead} · ${info.activeCount}/${info.totalCount} running` : `${info.totalCount} agent(s), none running`}
                    style={{ display: 'inline-flex', alignItems: 'center', gap: 4, opacity: canTake ? 1 : 0.5, cursor: canTake && busyFile === null ? 'pointer' : 'not-allowed' }}>
                    <input type="checkbox" disabled={!canTake || busyFile !== null} checked={fanPick.has(name)}
                      onChange={(e) => setFanPick((prev) => { const n = new Set(prev); if (e.target.checked) n.add(name); else n.delete(name); return n; })} />
                    <span style={{ width: 6, height: 6, borderRadius: '50%', background: canTake ? '#3ccb78' : '#888', display: 'inline-block' }} />
                    {name}
                  </label>
                );
              })}
              <button className="btn small" disabled={busyFile !== null || !fanPick.size} onClick={() => void fanOutPlan(p)}>Go</button>
              <button className="btn small" disabled={busyFile !== null} onClick={() => { setFanFor(null); setFanPick(new Set()); }}>×</button>
            </span>
          ) : (
            <button className="btn small" disabled={busyFile !== null} title="Hand this plan to other teams' active leads — each team runs it independently (/ask <team>/<lead>)" onClick={() => { setFanFor(p.file); setFanPick(new Set()); }}>⇄ Fan out to teams</button>
          )}
          <span className="grow" />
          {brainStatusKey(p.status) !== 'pending' ? <button className="btn small" disabled={busyFile !== null} title="Reset this plan's status to ⏳ PENDING" onClick={() => void setBrainPending(p)}>⏳ Set pending</button> : null}
        </div>
        {audit[p.file] ? (
          <div className="muted small" style={{ padding: '0 8px 6px' }}>
            {audit[p.file].to ? <span className="ok-text">{audit[p.file].from} → {audit[p.file].to} · </span> : null}{audit[p.file].summary}
          </div>
        ) : null}
        {blockers[p.file] ? (
          <div className="small" style={{ padding: '0 8px 8px' }}>
            <div className="b warn-text" style={{ marginBottom: 2 }}>Blockers</div>
            <pre className="plan-content" style={{ maxHeight: 160, marginTop: 0 }}>{blockers[p.file]}</pre>
          </div>
        ) : null}
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
              <input className="chat-title" style={{ flex: '0 1 260px' }} value={detail.title} disabled={busy} onChange={(e) => setDetail({ ...detail, title: e.target.value })} onBlur={(e) => void patchPlan({ title: e.target.value })} />
              <select className="cell-select small" value={detail.status} disabled={busy} onChange={(e) => void patchPlan({ status: e.target.value as PlanStatus })}>
                {STATUSES.map((s) => <option key={s} value={s}>{s}</option>)}
              </select>
              <input style={{ flex: '0 1 200px', fontSize: 12 }} placeholder="tags (comma-separated)" value={tagInput} disabled={busy} onChange={(e) => setTagInput(e.target.value)} onBlur={() => void patchPlan({ tags: splitTags(tagInput) })} title="categorize this plan" />
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

  const renderList = (active: unknown[], renderCard: (x: never) => JSX.Element, keyOf: (x: never) => string, buckets: { key: string; label: string }[]) =>
    groupBy
      ? group(active as never[], keyOf, buckets).map((g) => (
          <div key={g.key}>
            <div className="muted small b" style={{ margin: '8px 0 4px' }}>{g.label} · {g.items.length}</div>
            <div className="skill-catalog">{(g.items as never[]).map(renderCard)}</div>
          </div>
        ))
      : <div className="skill-catalog">{(active as never[]).map(renderCard)}</div>;

  return (
    <>
      {/* Unified organizer */}
      <section className="card" style={{ marginBottom: 10 }}>
        <div className="row-actions" style={{ gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
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
          <label className="muted small" style={{ display: 'inline-flex', alignItems: 'center', gap: 6, cursor: 'pointer' }}>
            <input type="checkbox" checked={showArchived} onChange={(e) => setShowArchived(e.target.checked)} /> show archived{archivedCount ? ` (${archivedCount})` : ''}
          </label>
          <span className="grow" />
          {msg ? <span className={`small ${/failed|timed out|expired|cancelled|could not/.test(msg) ? 'status-error' : 'muted'}`}>{msg}</span> : null}
          {busy ? <button className="btn" onClick={cancel}>Cancel</button> : null}
          <button className="btn primary" disabled={busy} onClick={() => setShowNew((v) => !v)}>{showNew ? '− Cancel' : '+ Request a plan'}</button>
        </div>
        <div className="row-actions" style={{ gap: 10, flexWrap: 'wrap', alignItems: 'center', marginTop: 8 }}>
          <span className="muted small">brain:</span>
          {statusChips(BRAIN_BUCKETS.map((b) => b.key), brainStatus, (id) => toggle(setBrainStatus, id), (k) => BRAIN_BUCKETS.find((b) => b.key === k)?.label ?? k, (k) => BRAIN_KEY_CLASS[k])}
          <span className="muted small" style={{ marginLeft: 6 }}>drafts:</span>
          {statusChips(STATUSES, draftStatus, (id) => toggle(setDraftStatus, id), (s) => s, (s) => STATUS_CLASS[s as PlanStatus])}
          {allDraftTags.length ? (
            <>
              <span className="muted small" style={{ marginLeft: 6 }}>tags:</span>
              <span className="chips">
                {allDraftTags.map((t) => (
                  <button key={t} className={`chip${tagFilter.has(t) ? ' on' : ''}`} onClick={() => toggle(setTagFilter, t)}>{tagFilter.has(t) ? '✓ ' : ''}{t}</button>
                ))}
              </span>
            </>
          ) : null}
          {(brainStatus.size || draftStatus.size || tagFilter.size) ? <button className="btn small" onClick={() => { setBrainStatus(new Set()); setDraftStatus(new Set()); setTagFilter(new Set()); }}>clear filters</button> : null}
        </div>
      </section>

      {showNew ? (
        <section className="card">
          <h3 style={{ marginTop: 0 }}>Request a plan</h3>
          <div className="kv" style={{ gridTemplateColumns: '90px 1fr', gap: '8px 12px' }}>
            <span>agent</span>
            <b>
              <select className="cell-select" value={genAgent} disabled={busy} onChange={(e) => setAgent(e.target.value)}>
                {names.map((n) => <option key={n} value={n}>{n}</option>)}
              </select>
            </b>
            <span>request</span>
            <b><textarea style={{ width: '100%', minHeight: 70 }} placeholder="what should the plan accomplish?" value={req} disabled={busy} onChange={(e) => setReq(e.target.value)} /></b>
          </div>
          <div className="row-actions" style={{ marginTop: 10 }}>
            <span className="grow" />
            <button className="btn primary" disabled={busy || !req.trim()} onClick={() => void generate()}>{busy ? 'Generating…' : 'Generate plan'}</button>
          </div>
        </section>
      ) : null}

      <section className="card">
        <div className="row-actions" style={{ alignItems: 'center', marginBottom: 6 }}>
          <h3 style={{ margin: 0 }}>Brain plans</h3>
          <span className="muted small">· {brainActive.length} active{brainArchived.length ? ` · ${brainArchived.length} done` : ''} · ⟳ live</span>
          <span className="grow" />
          {brain.dir
            ? <span className="muted small mono" title={brain.dir}>{brain.dir.replace(/^.*\/projects\//, '…/')}</span>
            : <span className="warn-text small">brain plans dir not found</span>}
        </div>
        {brain.plans.length === 0 ? (
          <p className="muted small">{brain.dir ? 'No plans in the brain index yet.' : 'Could not locate the brain plans directory (projects root not detected — set it in Projects).'}</p>
        ) : brainActive.length === 0 && !showArchived ? (
          <p className="muted center pad">No active brain plans match the filter.{brainArchived.length ? ' (Done plans are archived — toggle “show archived”.)' : ''}</p>
        ) : (
          <>
            {renderList(brainActive, brainCard as (x: never) => JSX.Element, ((p: BrainPlan) => brainStatusKey(p.status)) as (x: never) => string, BRAIN_BUCKETS.filter((b) => b.key !== 'done'))}
            {showArchived && brainArchived.length ? (
              <div>
                <div className="muted small b" style={{ margin: '10px 0 4px' }}>Archived · Done ({brainArchived.length})</div>
                <div className="skill-catalog">{brainArchived.map(brainCard)}</div>
              </div>
            ) : null}
          </>
        )}
      </section>

      <section className="card">
        <div className="row-actions" style={{ alignItems: 'center', marginBottom: 6 }}>
          <h3 style={{ margin: 0 }}>Your drafts</h3>
          <span className="muted small">· {draftActive.length} active{draftArchived.length ? ` · ${draftArchived.length} archived` : ''}</span>
        </div>
        {plans.length === 0 ? (
          <p className="muted center pad">No plans yet. <b>+ Request a plan</b> and an agent will draft one — then update it anytime and it keeps a changelog.</p>
        ) : draftActive.length === 0 && !showArchived ? (
          <p className="muted center pad">No active drafts match the filter.{draftArchived.length ? ' (Toggle “show archived”.)' : ''}</p>
        ) : (
          <>
            {renderList(draftActive, draftCard as (x: never) => JSX.Element, ((p: PlanSummary) => p.status) as (x: never) => string, STATUSES.map((s) => ({ key: s, label: s })))}
            {showArchived && draftArchived.length ? (
              <div>
                <div className="muted small b" style={{ margin: '10px 0 4px' }}>Archived ({draftArchived.length})</div>
                <div className="skill-catalog">{draftArchived.map(draftCard)}</div>
              </div>
            ) : null}
          </>
        )}
      </section>
    </>
  );
}
