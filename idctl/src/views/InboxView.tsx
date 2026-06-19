/**
 * InboxView — questions the manager (or its agents) are waiting on YOU to
 * answer. Sourced from GET /manager/inbox/pending; answers go back via
 * POST /manager/inbox/respond, which completes the query and wakes whoever
 * asked. This is the approval/clarification channel — e.g. an agent pausing
 * for sign-off before a destructive step.
 */

import { useEffect, useState } from 'react';
import { Box, Text, useInput } from 'ink';
import TextInput from 'ink-text-input';
import { useAppCtx } from '../app/context.ts';
import { Select, type SelectItem } from '../components/Select.tsx';
import { theme, ago, truncate } from '../app/theme.ts';
import type { InboxItem } from '../api/types.ts';

export function InboxView() {
  const { store, setCapture, flash } = useAppCtx();
  const inbox = store.inbox;

  const [cursor, setCursor] = useState(0);
  const [answering, setAnswering] = useState<InboxItem | null>(null);
  const [answer, setAnswer] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    setCapture(answering != null);
    return () => setCapture(false);
  }, [answering, setCapture]);

  useInput(
    (_i, key) => {
      if (key.escape) setAnswering(null);
    },
    { isActive: answering != null && !busy },
  );

  async function submit(text: string) {
    if (!answering || !text.trim()) return;
    setBusy(true);
    try {
      await store.client.inboxRespond(answering.query_id, text.trim(), answering.session_id ?? undefined);
      flash('replied ✓', 'ok');
      setAnswer('');
      setAnswering(null);
      store.refresh();
    } catch (err) {
      flash(`reply failed: ${err instanceof Error ? err.message : String(err)}`, 'err');
    } finally {
      setBusy(false);
    }
  }

  if (answering) {
    return (
      <Box flexDirection="column">
        <Text bold color={theme.accent}>
          Answer {answering.from ?? 'manager'}
        </Text>
        <Box marginTop={1} marginBottom={1} flexDirection="column">
          <Text color={theme.dim}>asked {ago(answering.timestamp)}:</Text>
          <Text>{answering.message}</Text>
        </Box>
        <Box>
          <Text color={theme.accent}>❯ </Text>
          <TextInput value={answer} onChange={setAnswer} onSubmit={submit} placeholder="your reply…" />
        </Box>
        <Text color={theme.dim}>{busy ? '… sending' : 'Enter send · Esc cancel'}</Text>
      </Box>
    );
  }

  const items: SelectItem<InboxItem>[] = inbox.map((it) => ({
    key: it.query_id,
    label: truncate(it.message, 52),
    value: it,
    hint: `${it.from ?? 'manager'} · ${ago(it.timestamp)}`,
  }));

  return (
    <Box flexDirection="column">
      <Text bold color={theme.accent}>
        Inbox <Text color={theme.dim}>· {inbox.length} awaiting reply</Text>
      </Text>
      <Box marginTop={1}>
        <Select
          items={items}
          index={cursor}
          onIndexChange={setCursor}
          onSelect={(it) => {
            setAnswer('');
            setAnswering(it.value);
          }}
          emptyText="(nothing waiting — the manager isn't blocked on you)"
          maxVisible={10}
        />
      </Box>
      {inbox.length > 0 ? <Text color={theme.dim}>Enter to answer · Esc to cancel</Text> : null}
    </Box>
  );
}
