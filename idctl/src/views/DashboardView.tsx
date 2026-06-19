/**
 * DashboardView — the live fleet at a glance plus full lifecycle control.
 *
 * Left: selectable agent list (status · runtime · model). Right: the live
 * activity feed sourced from the /events stream. Enter on an agent opens an
 * action menu: start / stop / rebuild / probe / change model / delete. Delete
 * (and any other destructive op) routes through a confirm gate.
 */

import { useEffect, useState } from 'react';
import { Box, Text, useInput } from 'ink';
import TextInput from 'ink-text-input';
import { useAppCtx } from '../app/context.ts';
import { Select, type SelectItem } from '../components/Select.tsx';
import { Confirm } from '../components/Confirm.tsx';
import { theme, statusColor, ago, truncate, shortRuntime, shortModel } from '../app/theme.ts';
import type { Agent } from '../api/types.ts';

type Mode = 'list' | 'actions' | 'model' | 'confirmDelete';

export function DashboardView() {
  const { store, setCapture, flash } = useAppCtx();
  const { agents, events } = store;

  const [cursor, setCursor] = useState(0);
  const [mode, setMode] = useState<Mode>('list');
  const [modelInput, setModelInput] = useState('');
  const [busy, setBusy] = useState<string | null>(null);

  const selected: Agent | undefined = agents[Math.min(cursor, agents.length - 1)];

  // Keep the App shell's global keys gated whenever we're in an interactive
  // sub-mode so keystrokes don't leak into view-switching.
  useEffect(() => {
    setCapture(mode !== 'list');
    return () => setCapture(false);
  }, [mode, setCapture]);

  async function run(label: string, fn: () => Promise<unknown>) {
    setBusy(label);
    try {
      await fn();
      flash(`${label} ✓`, 'ok');
    } catch (err) {
      flash(`${label} failed: ${err instanceof Error ? err.message : String(err)}`, 'err');
    } finally {
      setBusy(null);
      setMode('list');
    }
  }

  const agentItems: SelectItem<Agent>[] = agents.map((a) => ({
    key: a.id,
    label: a.name.padEnd(11).slice(0, 11),
    value: a,
    color: undefined,
    hint: `${statusColor(a.status) === theme.ok ? '●' : '○'}${a.status.slice(0, 7).padEnd(7)} ${shortRuntime(a.runtime ?? a.type).padEnd(7)} ${shortModel(a.model)}`,
  }));

  const actionItems: SelectItem<string>[] = selected
    ? [
        { key: 'start', label: 'start', value: 'start' },
        { key: 'stop', label: 'stop', value: 'stop' },
        { key: 'rebuild', label: 'rebuild', value: 'rebuild' },
        { key: 'probe', label: 'probe (verify /talk responds)', value: 'probe' },
        { key: 'model', label: `change model (now: ${selected.model ?? '—'})`, value: 'model' },
        { key: 'delete', label: 'delete', value: 'delete', color: theme.err },
      ]
    : [];

  // ----- interactive sub-modes ------------------------------------------
  if (mode === 'confirmDelete' && selected) {
    return (
      <Confirm
        title={`Delete agent "${selected.name}"?`}
        detail="Removes it from the team. Working-directory files are left in place."
        confirmLabel="delete agent"
        onConfirm={() => run(`delete ${selected.name}`, () => store.client.remote(`/delete ${selected.name}`))}
        onCancel={() => setMode('actions')}
      />
    );
  }

  return (
    <Box flexDirection="column">
      <Box>
        {/* Fleet list */}
        <Box flexDirection="column" width="55%" marginRight={2}>
          <Text bold color={theme.accent}>
            Fleet ({agents.length})
          </Text>
          <Select
            items={agentItems}
            isActive={mode === 'list'}
            index={cursor}
            onIndexChange={setCursor}
            onSelect={() => setMode('actions')}
            emptyText="(no agents — check the team or start the manager)"
            maxVisible={10}
          />
        </Box>

        {/* Activity feed */}
        <Box flexDirection="column" width="45%">
          <Text bold color={theme.accentAlt}>
            Activity
          </Text>
          <ActivityFeed events={events} />
        </Box>
      </Box>

      {/* Action menu / model input under the columns */}
      {mode === 'actions' && selected ? (
        <Box flexDirection="column" marginTop={1} borderStyle="round" borderColor={theme.accent} paddingX={1}>
          <Text bold>
            {selected.name}{' '}
            <Text color={theme.dim}>
              :{selected.port} · {selected.runtime ?? selected.type} · {selected.model}
            </Text>
          </Text>
          <Select
            items={actionItems}
            isActive={!busy}
            onSelect={(it) => {
              if (busy) return;
              const name = selected.name;
              switch (it.value) {
                case 'start':
                  run(`start ${name}`, () => store.client.remote(`/agent ${name} start`));
                  break;
                case 'stop':
                  run(`stop ${name}`, () => store.client.remote(`/agent ${name} stop`));
                  break;
                case 'rebuild':
                  run(`rebuild ${name}`, () => store.client.remote(`/agent ${name} rebuild`));
                  break;
                case 'probe':
                  run(`probe ${name}`, async () => {
                    const r = await store.client.probeOne(name);
                    if (r.failed > 0) throw new Error(r.results.find((x) => x.status !== 'ok')?.error ?? 'failed');
                  });
                  break;
                case 'model':
                  setModelInput(selected.model ?? '');
                  setMode('model');
                  break;
                case 'delete':
                  setMode('confirmDelete');
                  break;
              }
            }}
          />
          <Text color={theme.dim}>{busy ? `… ${busy}` : 'Enter run · Esc back'}</Text>
          <EscBack to={() => setMode('list')} active={!busy} />
        </Box>
      ) : null}

      {mode === 'model' && selected ? (
        <Box flexDirection="column" marginTop={1} borderStyle="round" borderColor={theme.accent} paddingX={1}>
          <Text>
            New model for <Text bold>{selected.name}</Text>:
          </Text>
          <TextInput
            value={modelInput}
            onChange={setModelInput}
            onSubmit={(v) => {
              const m = v.trim();
              if (!m) return setMode('actions');
              run(`model ${selected.name}→${m}`, () => store.client.remote(`/model ${selected.name} ${m}`));
            }}
          />
          <Text color={theme.dim}>Enter apply · Esc back</Text>
          <EscBack to={() => setMode('actions')} active />
        </Box>
      ) : null}
    </Box>
  );
}

function EscBack({ to, active }: { to: () => void; active: boolean }) {
  useInput(
    (_i, key) => {
      if (key.escape) to();
    },
    { isActive: active },
  );
  return null;
}

function ActivityFeed({ events }: { events: ReturnType<typeof useAppCtx>['store']['events'] }) {
  if (events.length === 0) {
    return <Text color={theme.dim}>(waiting for events… dispatches, task changes, online/offline)</Text>;
  }
  const recent = events.slice(-9);
  return (
    <Box flexDirection="column">
      {recent.map((e) => {
        const subject = e.subject ?? (e.data?.name as string) ?? e.actor ?? '';
        return (
          <Text key={e.seq}>
            <Text color={topicColor(e.topic)}>{truncate(e.topic, 20).padEnd(20)}</Text>
            <Text> {truncate(String(subject), 16)}</Text>
            <Text color={theme.dim}> {ago(e.timestamp)}</Text>
          </Text>
        );
      })}
    </Box>
  );
}

function topicColor(topic: string): string {
  if (topic.includes('online') || topic.includes('delivered') || topic.includes('done')) return theme.ok;
  if (topic.includes('offline') || topic.includes('failed') || topic.includes('expired')) return theme.err;
  if (topic.includes('due') || topic.includes('pending')) return theme.warn;
  return theme.accent;
}
