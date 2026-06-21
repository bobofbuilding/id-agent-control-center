import { useMemo, useRef, useState, useEffect } from 'react';
import { call, resolveCoordinator, agentsLeadFirst, type FleetStore } from '../store.ts';
import type { ProjectEntry } from '../../../../idctl/src/settings/schema.ts';

type PickedFile = { path: string; name: string; size: number; isImage: boolean };
type SavedFile = { name: string; path: string; size: number; isImage: boolean };

interface Msg {
  id: number;
  role: 'you' | 'agent' | 'system';
  who: string;
  text: string;
  files?: { name: string; isImage: boolean }[];
  pending?: boolean;
}

/** Quote a free-text message as ONE token for the manager's tokenizer (matches
 *  client.ts qArg) — the double-quoted span survives newlines + special chars. */
function qArg(s: string): string {
  return `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}
function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

export function Chat({ store }: { store: FleetStore }) {
  const team = store.team ?? 'default';
  // The team's coordinator/lead is the default chat target — auto-selected.
  const defaultTarget = useMemo(
    () => resolveCoordinator(store.agents, store.coordinator) ?? 'lead',
    [store.agents, store.coordinator],
  );
  const storeKey = `idctl.chat.target.${team}`;
  const [picked, setPicked] = useState<string | null>(() => {
    try { return localStorage.getItem(`idctl.chat.target.${team}`); } catch { return null; }
  });
  useEffect(() => { try { setPicked(localStorage.getItem(storeKey)); } catch { /* ignore */ } }, [storeKey]);
  function pick(name: string) {
    setPicked(name);
    try { localStorage.setItem(storeKey, name); } catch { /* ignore */ }
  }
  const target = picked && store.agents.some((a) => a.name === picked) ? picked : defaultTarget;
  const orderedAgents = agentsLeadFirst(store.agents, store.coordinator);
  const targetAgent = store.agents.find((a) => a.name === target);

  // ── Project focus ─────────────────────────────────────────────────────────
  const [projects, setProjects] = useState<ProjectEntry[]>([]);
  useEffect(() => { void call<ProjectEntry[]>('projects:list').then(setProjects).catch(() => {}); }, []);
  const focusKey = `idctl.chat.project.${team}`;
  const [focusedId, setFocusedId] = useState<string>(() => {
    try { return localStorage.getItem(`idctl.chat.project.${team}`) ?? ''; } catch { return ''; }
  });
  useEffect(() => { try { setFocusedId(localStorage.getItem(focusKey) ?? ''); } catch { /* ignore */ } }, [focusKey]);
  function focus(id: string) {
    setFocusedId(id);
    try { id ? localStorage.setItem(focusKey, id) : localStorage.removeItem(focusKey); } catch { /* ignore */ }
  }
  const focused = projects.find((p) => p.id === focusedId);
  const focusedProjects = useMemo(
    () => [...projects].sort((a, b) => (a.status === b.status ? 0 : a.status === 'active' ? -1 : 1) || a.name.localeCompare(b.name)),
    [projects],
  );

  // Where uploaded files land — the focused project folder, else the target
  // agent's own workspace (which it can always read).
  const destDir = focused?.path || targetAgent?.workingDirectory || '';

  // ── Attachments ───────────────────────────────────────────────────────────
  const [attachments, setAttachments] = useState<PickedFile[]>([]);
  async function addAttachments() {
    const got = await call<PickedFile[]>('chat:pickFiles').catch(() => [] as PickedFile[]);
    if (got.length) setAttachments((a) => [...a, ...got.filter((g) => !a.some((x) => x.path === g.path))]);
  }
  function removeAttachment(path: string) {
    setAttachments((a) => a.filter((f) => f.path !== path));
  }

  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [msgs, setMsgs] = useState<Msg[]>([
    { id: 0, role: 'system', who: '', text: `Talking to the manager. Pick an agent on the right, optionally focus a project, attach files, and hit Send.` },
  ]);
  const idRef = useRef(1);
  const endRef = useRef<HTMLDivElement>(null);
  useEffect(() => endRef.current?.scrollIntoView({ behavior: 'smooth' }), [msgs]);

  function compose(text: string, saved: SavedFile[]): string {
    const parts: string[] = [];
    if (focused) {
      const repo = (focused.links ?? []).find((l) => /github\.com/i.test(l));
      parts.push(`[Focus: project "${focused.name}"${focused.path ? ` at ${focused.path}` : ''}${repo ? ` — repo ${repo}` : ''}]`);
    }
    if (text) parts.push(text);
    if (saved.length) {
      const lines = saved.map((f) => `- ${f.path}${f.isImage ? ' (image)' : ''}`).join('\n');
      parts.push(`[I attached ${saved.length} file(s); read them at these paths:\n${lines}]`);
    }
    return parts.join('\n\n');
  }

  async function send() {
    const text = input.trim();
    if ((!text && attachments.length === 0) || busy) return;
    setBusy(true);
    try {
      // Copy any attachments into a folder the agent can read.
      let saved: SavedFile[] = [];
      if (attachments.length) {
        if (!destDir) {
          setMsgs((m) => [...m, { id: idRef.current++, role: 'system', who: '', text: '✗ Nowhere to put the files — focus a project or pick an agent that has a workspace.' }]);
          return;
        }
        const res = await call<{ ok: boolean; files: SavedFile[]; skipped?: string[]; error?: string }>('chat:saveFiles', destDir, attachments.map((a) => a.path)).catch(() => ({ ok: false, files: [] as SavedFile[], skipped: [] as string[], error: 'copy failed' }));
        if (!res.ok) {
          setMsgs((m) => [...m, { id: idRef.current++, role: 'system', who: '', text: `✗ Couldn't attach files: ${res.error ?? 'unknown error'}` }]);
          return;
        }
        saved = res.files;
        const skipped = res.skipped ?? [];
        if (skipped.length) {
          setMsgs((m) => [...m, { id: idRef.current++, role: 'system', who: '', text: `⚠ Couldn't attach ${skipped.length} file(s): ${skipped.join(', ')}` }]);
        }
        // All attachments failed — don't send an empty "files only" message.
        if (saved.length === 0 && !text) { return; }
      }
      const message = compose(text, saved);
      const myId = idRef.current++;
      const replyId = idRef.current++;
      setMsgs((m) => [
        ...m,
        { id: myId, role: 'you', who: 'you', text: text || '(files only)', files: saved.map((f) => ({ name: f.name, isImage: f.isImage })) },
        { id: replyId, role: 'agent', who: target, text: '', pending: true },
      ]);
      setInput('');
      setAttachments([]);
      try {
        const reply = await call<string>('dispatch', `/ask ${target} ${qArg(message)}`);
        setMsgs((m) => m.map((x) => (x.id === replyId ? { ...x, text: reply, pending: false } : x)));
      } catch (err) {
        setMsgs((m) => m.map((x) => (x.id === replyId ? { ...x, role: 'system', text: `✗ ${err instanceof Error ? err.message : String(err)}`, pending: false } : x)));
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="view">
      <header className="view-head">
        <h1>Chat</h1>
        <div className="row-actions" style={{ alignItems: 'center', gap: 8 }}>
          <span className="muted small">focus</span>
          <select className="cell-select" value={focusedId} disabled={busy} onChange={(e) => focus(e.target.value)} title="Scope this chat to a project — its name, folder, and repo are sent as context.">
            <option value="">(no project)</option>
            {focusedProjects.map((p) => <option key={p.id} value={p.id}>{p.name}{p.status !== 'active' ? ` · ${p.status}` : ''}</option>)}
          </select>
          <span className="muted">→ {target}</span>
        </div>
      </header>
      {focused ? (
        <div className="chat-focus muted small">
          <b className="accent-text">◆ {focused.name}</b>
          {focused.path ? <span className="mono" title={focused.path}> · {focused.path}</span> : null}
          {focused.path ? <button className="link-btn" onClick={() => void call('project:openFolder', focused.path)}>open ↗</button> : null}
        </div>
      ) : null}

      <div className="cols chat-cols">
        <section className="card chat">
          <div className="messages">
            {msgs.map((m) => (
              <div key={m.id} className={`msg ${m.role}`}>
                {m.role !== 'system' ? <div className="msg-who">{m.role === 'you' ? 'you' : m.who}</div> : null}
                <div className="msg-body">
                  {m.pending ? <span className="spin">▌ thinking…</span> : m.text}
                </div>
                {m.files && m.files.length ? (
                  <div className="msg-files">
                    {m.files.map((f) => <span key={f.name} className="file-chip" title={f.name}>{f.isImage ? '🖼' : '📄'} {f.name}</span>)}
                  </div>
                ) : null}
              </div>
            ))}
            <div ref={endRef} />
          </div>

          {attachments.length ? (
            <div className="attach-row">
              {attachments.map((f) => (
                <span key={f.path} className="file-chip" title={`${f.path} · ${fmtBytes(f.size)}`}>
                  {f.isImage ? '🖼' : '📄'} {f.name} <span className="muted">{fmtBytes(f.size)}</span>
                  <button className="file-x" title="Remove" onClick={() => removeAttachment(f.path)}>✕</button>
                </span>
              ))}
              <span className="muted small" style={{ alignSelf: 'center' }}>→ {focused ? `${focused.name}/uploads` : 'agent workspace'}</span>
            </div>
          ) : null}

          <div className="composer">
            <button
              className="btn attach-btn"
              title={destDir ? `Attach files (saved to ${focused ? focused.name + '/uploads' : 'the agent workspace'})` : 'Focus a project or select an agent with a workspace to attach files'}
              disabled={busy || !destDir}
              onClick={() => void addAttachments()}
            >📎</button>
            <input
              className="composer-input"
              value={input}
              placeholder={focused ? `message ${target} about ${focused.name}…` : `message ${target}…`}
              disabled={busy}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault();
                  void send();
                }
              }}
            />
            <button className="btn primary" disabled={busy || (!input.trim() && attachments.length === 0)} onClick={() => void send()}>
              {busy ? '…' : 'Send'}
            </button>
          </div>
        </section>

        <aside className="card targets">
          <h3>Address</h3>
          {orderedAgents.map((a) => (
            <div key={a.id} className={`target-row${a.name === target ? ' active' : ''}`}>
              <button className="target" onClick={() => pick(a.name)}>
                {a.name}
              </button>
              <button
                className={`star${a.name === store.coordinator ? ' on' : ''}`}
                title={a.name === store.coordinator ? 'team coordinator (lead)' : 'set as coordinator (lead)'}
                onClick={() => void store.setCoordinator(a.name)}
              >
                {a.name === store.coordinator ? '★' : '☆'}
              </button>
            </div>
          ))}
          <p className="muted small" style={{ marginTop: 8 }}>
            ★ = coordinator. Chat defaults to it; name it anything.
          </p>
        </aside>
      </div>
    </div>
  );
}
