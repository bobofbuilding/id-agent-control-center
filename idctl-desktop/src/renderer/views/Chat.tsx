import { useMemo, useRef, useState, useEffect } from 'react';
import { call, resolveCoordinator, agentsLeadFirst, type FleetStore } from '../store.ts';

interface Msg {
  id: number;
  role: 'you' | 'agent' | 'system';
  who: string;
  text: string;
  pending?: boolean;
}

export function Chat({ store }: { store: FleetStore }) {
  // The team's coordinator/lead is the default chat target — auto-selected.
  const defaultTarget = useMemo(
    () => resolveCoordinator(store.agents, store.coordinator) ?? 'lead',
    [store.agents, store.coordinator],
  );
  // `picked` is the user's chosen target, persisted per-team in localStorage so
  // the agent you started chatting with stays selected across navigation and app
  // restarts. Falls back to the coordinator when nothing valid is saved.
  const storeKey = `idctl.chat.target.${store.team ?? 'default'}`;
  const [picked, setPicked] = useState<string | null>(() => {
    try { return localStorage.getItem(`idctl.chat.target.${store.team ?? 'default'}`); } catch { return null; }
  });
  // Reload the saved pick when the team changes.
  useEffect(() => { try { setPicked(localStorage.getItem(storeKey)); } catch { /* ignore */ } }, [storeKey]);
  function pick(name: string) {
    setPicked(name);
    try { localStorage.setItem(storeKey, name); } catch { /* ignore */ }
  }
  const target = picked && store.agents.some((a) => a.name === picked) ? picked : defaultTarget;
  const orderedAgents = agentsLeadFirst(store.agents, store.coordinator);

  const [input, setInput] = useState('');
  const [msgs, setMsgs] = useState<Msg[]>([
    { id: 0, role: 'system', who: '', text: `Talking to the manager. Pick an agent on the right, type, and hit Send.` },
  ]);
  const idRef = useRef(1);
  const endRef = useRef<HTMLDivElement>(null);
  useEffect(() => endRef.current?.scrollIntoView({ behavior: 'smooth' }), [msgs]);

  async function send() {
    const text = input.trim();
    if (!text) return;
    setInput('');
    const myId = idRef.current++;
    const replyId = idRef.current++;
    setMsgs((m) => [
      ...m,
      { id: myId, role: 'you', who: 'you', text },
      { id: replyId, role: 'agent', who: target, text: '', pending: true },
    ]);
    try {
      const reply = await call<string>('dispatch', `/ask ${target} ${text}`);
      setMsgs((m) => m.map((x) => (x.id === replyId ? { ...x, text: reply, pending: false } : x)));
    } catch (err) {
      setMsgs((m) =>
        m.map((x) =>
          x.id === replyId ? { ...x, role: 'system', text: `✗ ${err instanceof Error ? err.message : String(err)}`, pending: false } : x,
        ),
      );
    }
  }

  return (
    <div className="view">
      <header className="view-head">
        <h1>Chat</h1>
        <span className="muted">→ {target}</span>
      </header>
      <div className="cols chat-cols">
        <section className="card chat">
          <div className="messages">
            {msgs.map((m) => (
              <div key={m.id} className={`msg ${m.role}`}>
                {m.role !== 'system' ? <div className="msg-who">{m.role === 'you' ? 'you' : m.who}</div> : null}
                <div className="msg-body">
                  {m.pending ? <span className="spin">▌ thinking…</span> : m.text}
                </div>
              </div>
            ))}
            <div ref={endRef} />
          </div>
          <div className="composer">
            <input
              className="composer-input"
              value={input}
              placeholder={`message ${target}…`}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault();
                  void send();
                }
              }}
            />
            <button className="btn primary" onClick={() => void send()}>
              Send
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
