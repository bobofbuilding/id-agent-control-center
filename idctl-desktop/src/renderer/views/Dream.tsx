import { useEffect, useRef, useState } from 'react';
import { call, resolveCoordinator, type FleetStore } from '../store.ts';

/**
 * Dream tab (under Work). An agent runs an offline "dream" — a reflection pass over
 * its recent work and the shared brain — and returns a Markdown report with four
 * sections: Consolidation, Insights, Ideas, Simulations. Reports are saved here as a
 * morning digest. Ideas/Simulations are PROPOSALS for review, never auto-executed
 * (per the research: agents grade their own dreams too generously).
 */

type DreamSummary = { id: string; title: string; agent: string; team: string; createdAt: number };
interface Dream { id: string; title: string; agent: string; team: string; focus?: string; content: string; createdAt: number }

function qArg(s: string): string { return `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`; }
function dreamId(): string { return `dream_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`; }
function ago(ms: number): string {
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (s < 60) return `${s}s ago`; if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`; return `${Math.round(s / 86400)}d ago`;
}
const okText = (s: string) => { const t = (s || '').trim(); return t && t !== '(empty reply)' && t !== '(no reply)' ? t : ''; };

const DREAM_PROMPT = (focus: string) =>
  'Run a "dream" — an offline reflection pass over your recent work and the team\'s shared ' +
  'brain/memory. Use your memory/brain skills to ground it in what you actually know. Produce a ' +
  'concise **Dream Report** in Markdown with EXACTLY these four headings:\n\n' +
  '## Consolidation\nThe most important facts/learnings from recent work worth remembering (3-7 bullets) — candidates to write into the brain.\n\n' +
  '## Insights\nHigher-level patterns connecting multiple observations (2-5 bullets); note what each is based on.\n\n' +
  '## Ideas\nProposed new tasks or plans worth considering (2-5 bullets). These are PROPOSALS for human review — do NOT act on them.\n\n' +
  '## Simulations\nLikely near-future scenarios, outcomes, or risks for current work (2-4 bullets). Clearly SPECULATIVE.\n\n' +
  'Be specific and grounded. If a section has nothing meaningful, say so in one line.' +
  (focus.trim() ? `\n\nFocus this dream on: ${focus.trim()}` : '');

const NIGHTLY_OBJECTIVE =
  'Nightly dream: reflect over your recent work and the shared brain, then post a Dream Report ' +
  '(Consolidation / Insights / Ideas / Simulations). Ideas and Simulations are proposals only — do not act on them.';

const SUGGEST_FOCUS_PROMPT =
  'Based on your recent work and the team\'s shared brain/memory, what is the SINGLE most valuable thing to ' +
  'focus a reflection "dream" on right now? Reply with ONE short focus phrase ONLY — no preamble, no quotes, ' +
  'no markdown — e.g. "SkillMesh mainnet readiness blockers" or "where the org keeps duplicating work".';

export function Dream({ store }: { store: FleetStore }) {
  const team = store.team ?? 'default';
  const names = store.agents.map((a) => a.name);
  const coordinator = resolveCoordinator(store.agents, store.coordinator) ?? names[0] ?? '';
  const [dreams, setDreams] = useState<DreamSummary[]>([]);
  const [openId, setOpenId] = useState<string | null>(null);
  const [detail, setDetail] = useState<Dream | null>(null);
  const [agentSel, setAgentSel] = useState('');
  const [focus, setFocus] = useState('');
  const [dreaming, setDreaming] = useState(false);
  const [suggesting, setSuggesting] = useState(false);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');
  const alive = useRef(true);
  useEffect(() => () => { alive.current = false; }, []);

  const agent = agentSel && names.includes(agentSel) ? agentSel : coordinator;

  async function reload() { setDreams(await call<DreamSummary[]>('dreams:list', team).catch(() => [])); }
  useEffect(() => { void reload(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [team, store.lastUpdated]);

  async function open(id: string) {
    if (openId === id) { setOpenId(null); setDetail(null); return; }
    setOpenId(id); setDetail(null);
    const d = await call<Dream | null>('dreams:get', id).catch(() => null);
    if (alive.current) setDetail(d);
  }

  async function dreamNow() {
    if (!agent) { setMsg('no agent available to dream'); return; }
    setDreaming(true); setMsg(`${agent} is dreaming… (reflecting over recent work + the brain)`);
    try {
      const content = okText(await call<string>('dispatch', `/ask ${agent} ${qArg(DREAM_PROMPT(focus))}`));
      if (!alive.current) return;
      if (!content) { setMsg(`${agent} returned an empty dream — try again`); return; }
      const now = Date.now();
      const dream: Dream = { id: dreamId(), title: `${agent}'s dream · ${new Date(now).toLocaleString()}`, agent, team, focus: focus.trim() || undefined, content, createdAt: now };
      await call('dreams:save', dream);
      if (!alive.current) return;
      setFocus(''); setMsg('dream saved ✓');
      await reload();
      setOpenId(dream.id); setDetail(dream);
    } catch (e) {
      if (alive.current) setMsg(`dream failed: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      if (alive.current) setDreaming(false);
    }
  }

  /** AI drafting assist: ask the agent to propose a high-value focus, grounded in its recent
   *  work + the brain, and fill the focus field with it (the user can edit before dreaming). */
  async function suggestFocus() {
    if (!agent) { setMsg('no agent available to suggest a focus'); return; }
    setSuggesting(true); setMsg(`${agent} is suggesting a focus…`);
    try {
      const out = okText(await call<string>('dispatch', `/ask ${agent} ${qArg(SUGGEST_FOCUS_PROMPT)}`));
      if (!alive.current) return;
      const line = out.split('\n').map((l) => l.trim()).find(Boolean) ?? '';
      const clean = line.replace(/^["'`]+|["'`]+$/g, '').replace(/^[-*\d.\s]+/, '').slice(0, 160);
      if (!clean) { setMsg('no suggestion returned — try again or type your own'); return; }
      setFocus(clean); setMsg('focus suggested — edit it or ✦ Dream now');
    } catch (e) {
      if (alive.current) setMsg(`suggest failed: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      if (alive.current) setSuggesting(false);
    }
  }

  async function scheduleNightly() {
    if (!agent) return;
    setBusy(true); setMsg(`scheduling nightly dream for ${agent}…`);
    try {
      await call('addCalendarCheckin', agent, '03:00', 'mon,tue,wed,thu,fri,sat,sun', NIGHTLY_OBJECTIVE, { delivery: 'talk' });
      setMsg(`nightly dream scheduled for ${agent} at 03:00 ✓ — manage it under Loops → Scheduled objectives`);
    } catch (e) { setMsg(`schedule failed: ${e instanceof Error ? e.message : String(e)}`); }
    finally { setBusy(false); }
  }

  async function remove(id: string) {
    setBusy(true);
    try { await call('dreams:remove', id); if (openId === id) { setOpenId(null); setDetail(null); } await reload(); }
    finally { setBusy(false); }
  }

  const locked = dreaming || busy || suggesting;
  return (
    <>
      <section className="card">
        <div className="row-actions" style={{ alignItems: 'center', marginBottom: 6 }}>
          <h3 style={{ margin: 0 }}>Dream</h3>
          <span className="muted small">· idle reflection over recent work + the brain</span>
          <span className="grow" />
          {msg ? <span className={`small ${/failed|empty/.test(msg) ? 'status-error' : 'muted'}`}>{msg}</span> : null}
        </div>
        <p className="muted small" style={{ marginTop: 0 }}>
          An agent reflects offline and returns a report: <b>Consolidation</b> (facts worth keeping),
          <b> Insights</b> (patterns), <b>Ideas</b> (proposed tasks/plans), and <b>Simulations</b> (speculative futures).
          Ideas &amp; Simulations are <b>proposals for your review</b> — nothing is auto-executed.
        </p>
        <div className="kv" style={{ gridTemplateColumns: '90px 1fr', gap: '8px 10px', alignItems: 'center' }}>
          <span>agent</span>
          <span style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
            <select className="cell-select" value={agent} disabled={locked} onChange={(e) => setAgentSel(e.target.value)}>
              {names.map((n) => <option key={n} value={n}>{n}</option>)}
            </select>
            <input style={{ flex: '1 1 260px' }} placeholder="optional focus — e.g. “the SkillMesh mainnet readiness”, or ✦ Suggest" value={focus} disabled={locked} onChange={(e) => setFocus(e.target.value)} />
            <button className="btn" disabled={locked || !agent} title="Let the agent propose a high-value focus from its recent work + the brain" onClick={() => void suggestFocus()}>{suggesting ? 'Suggesting…' : '✦ Suggest focus'}</button>
            <button className="btn primary" disabled={locked || !agent} onClick={() => void dreamNow()}>{dreaming ? 'Dreaming…' : '✦ Dream now'}</button>
            <button className="btn" disabled={locked || !agent} title="Run this dream automatically every night at 03:00 (manage under Loops → Scheduled objectives)" onClick={() => void scheduleNightly()}>Schedule nightly</button>
          </span>
        </div>
      </section>

      <div className="skill-catalog">
        {dreams.map((d) => {
          const isOpen = openId === d.id;
          return (
            <div className={`skill-card${isOpen ? ' editing' : ''}`} key={d.id}>
              <div className="skill-card-head" style={{ cursor: 'pointer' }} onClick={() => void open(d.id)}>
                <span className="b">✦ {d.agent}</span>
                <span className="muted small">· {new Date(d.createdAt).toLocaleString()}</span>
                <span className="grow" />
                <span className="muted small">{ago(d.createdAt)}</span>
                <button className="btn icon-danger small" disabled={locked} title="Delete dream" onClick={(e) => { e.stopPropagation(); void remove(d.id); }}>✕</button>
                <span className="muted">{isOpen ? '▾' : '▸'}</span>
              </div>
              {isOpen ? (
                detail ? <pre className="plan-content">{detail.content}</pre> : <p className="muted small">loading…</p>
              ) : null}
            </div>
          );
        })}
        {dreams.length === 0 ? <p className="muted center pad">No dreams yet. Pick an agent and <b>✦ Dream now</b> — it’ll reflect over recent work and the brain, then post a report here.</p> : null}
      </div>
    </>
  );
}
