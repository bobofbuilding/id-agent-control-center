/**
 * ChatView — the human interface to the agent manager.
 *
 * You talk conversationally to the team's manager agent (auto-detected: an
 * agent named `lead`/`manager`, else the first agent). It dispatches
 * `/ask <target> <msg>` and long-polls the reply, so the manager can fan work
 * out to its workers and answer you. Prefix a message with `@name` to address a
 * specific agent instead, or `@*` to broadcast.
 *
 * Focus model (vim-ish): you start in "type" mode (input owns the keyboard).
 * Esc drops to "nav" mode so the global 1-8/Tab view keys work again; i/Enter
 * returns to typing.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { Box, Text, useInput } from 'ink';
import TextInput from 'ink-text-input';
import Spinner from 'ink-spinner';
import { useAppCtx } from '../app/context.ts';
import { theme, truncate } from '../app/theme.ts';

interface Msg {
  id: number;
  role: 'you' | 'agent' | 'system';
  who: string;
  text: string;
  pending?: boolean;
}

export function ChatView() {
  const { store, setCapture, flash } = useAppCtx();

  const defaultTarget = useMemo(() => {
    const a = store.agents;
    return (
      a.find((x) => /^(lead|manager)$/i.test(x.name))?.name ??
      a.find((x) => /manager|lead/i.test(x.metadata?.description ?? ''))?.name ??
      a[0]?.name ??
      'lead'
    );
  }, [store.agents]);

  const [target, setTarget] = useState<string>(defaultTarget);
  const [input, setInput] = useState('');
  const [focused, setFocused] = useState(true);
  const [messages, setMessages] = useState<Msg[]>([
    { id: 0, role: 'system', who: '', text: `Talking to "${defaultTarget}". Type and Enter to send · @name to redirect · Esc to navigate.` },
  ]);
  const idRef = useRef(1);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    setCapture(focused);
    return () => setCapture(false);
  }, [focused, setCapture]);

  useEffect(() => () => abortRef.current?.abort(), []);

  // Nav-mode: a key to re-enter typing.
  useInput(
    (input2, key) => {
      if (input2 === 'i' || key.return) setFocused(true);
    },
    { isActive: !focused },
  );

  // Type-mode: Esc drops focus so the global view keys work again.
  useInput(
    (_i, key) => {
      if (key.escape) setFocused(false);
    },
    { isActive: focused },
  );

  function send(raw: string) {
    const text = raw.trim();
    if (!text) return;
    setInput('');

    let to = target;
    let body = text;
    const m = text.match(/^@(\S+)\s+([\s\S]+)$/);
    if (m) {
      to = m[1];
      body = m[2];
      setTarget(to);
    }

    const myId = idRef.current++;
    const replyId = idRef.current++;
    setMessages((prev) => [
      ...prev,
      { id: myId, role: 'you', who: 'you', text: `${m ? `@${to} ` : ''}${body}` },
      { id: replyId, role: 'agent', who: to, text: '', pending: true },
    ]);

    const ctrl = new AbortController();
    abortRef.current = ctrl;
    store.client
      .dispatch(`/ask ${to} ${body}`, {
        signal: ctrl.signal,
        onTick: (s) =>
          setMessages((prev) =>
            prev.map((x) => (x.id === replyId ? { ...x, text: `…${s}` } : x)),
          ),
      })
      .then((reply) =>
        setMessages((prev) =>
          prev.map((x) => (x.id === replyId ? { ...x, text: reply, pending: false } : x)),
        ),
      )
      .catch((err) => {
        const msg = err instanceof Error ? err.message : String(err);
        setMessages((prev) =>
          prev.map((x) =>
            x.id === replyId ? { ...x, role: 'system', text: `✗ ${msg}`, pending: false } : x,
          ),
        );
        flash(`dispatch failed: ${msg}`, 'err');
      });
  }

  const visible = messages.slice(-10);

  return (
    <Box flexDirection="column">
      <Text bold color={theme.accent}>
        Chat <Text color={theme.dim}>→ {target}</Text>
      </Text>

      <Box flexDirection="column" marginTop={1} minHeight={9}>
        {visible.map((msg) => (
          <Bubble key={msg.id} msg={msg} />
        ))}
      </Box>

      <Box marginTop={1}>
        {focused ? (
          <>
            <Text color={theme.accent}>❯ </Text>
            <TextInput
              value={input}
              onChange={setInput}
              onSubmit={send}
              focus={focused}
              placeholder={`message ${target}…`}
            />
          </>
        ) : (
          <Text color={theme.dim}>[i] type · [1-9/Tab] navigate · [q] quit</Text>
        )}
      </Box>
    </Box>
  );
}

function Bubble({ msg }: { msg: Msg }) {
  if (msg.role === 'system') {
    return <Text color={theme.dim}>{msg.text}</Text>;
  }
  const isYou = msg.role === 'you';
  const label = isYou ? 'you' : msg.who;
  const color = isYou ? theme.accentAlt : theme.ok;
  return (
    <Box flexDirection="column" marginBottom={1}>
      <Text color={color} bold>
        {label}
      </Text>
      {msg.pending ? (
        <Text color={theme.warn}>
          <Spinner type="dots" /> {msg.text || 'thinking…'}
        </Text>
      ) : (
        <Text>{clampLines(msg.text, 8)}</Text>
      )}
    </Box>
  );
}

/** Keep a reply from blowing out the pane; show the head and a tail marker. */
function clampLines(text: string, maxLines: number): string {
  const lines = text.split('\n');
  if (lines.length <= maxLines) return text;
  return lines.slice(0, maxLines).join('\n') + `\n… (+${lines.length - maxLines} more lines)`;
}
