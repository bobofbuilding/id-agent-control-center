/**
 * HealthView — fleet health + the dispatch-path probe. `p` probes every
 * running agent (POST a "reply OK" through each agent's /talk and wait for the
 * query to complete); Enter probes just the selected agent. A green probe is
 * direct evidence the agent's HTTP listener is up and the harness can complete
 * a dispatch; a red one carries the transport/LLM error string.
 */

import { useState } from 'react';
import { Box, Text, useInput } from 'ink';
import Spinner from 'ink-spinner';
import { useAppCtx } from '../app/context.ts';
import { Select, type SelectItem } from '../components/Select.tsx';
import { theme, statusColor, ago } from '../app/theme.ts';
import type { Agent, ProbeResult } from '../api/types.ts';

export function HealthView() {
  const { store, flash } = useAppCtx();
  const agents = store.agents;
  const [cursor, setCursor] = useState(0);
  const [probing, setProbing] = useState<string | null>(null);
  const [result, setResult] = useState<ProbeResult | null>(null);

  const selected = agents[Math.min(cursor, agents.length - 1)];

  async function probe(which: 'all' | string) {
    setProbing(which);
    setResult(null);
    try {
      const r = which === 'all' ? await store.client.probeAll() : await store.client.probeOne(which);
      setResult(r);
      flash(`probe: ${r.passed}/${r.probed} ok`, r.failed > 0 ? 'err' : 'ok');
    } catch (err) {
      flash(`probe failed: ${err instanceof Error ? err.message : String(err)}`, 'err');
    } finally {
      setProbing(null);
    }
  }

  useInput((input) => {
    if (input === 'p' && !probing) probe('all');
  });

  const items: SelectItem<Agent>[] = agents.map((a) => ({
    key: a.id,
    label: a.name.padEnd(12).slice(0, 12),
    value: a,
    color: statusColor(a.status),
    hint: `${a.status} · ${a.runtime ?? a.type ?? ''} · probed ${ago(a.last_probed_at ?? undefined)}`,
  }));

  return (
    <Box flexDirection="column">
      <Box>
        <Box flexDirection="column" width="50%" marginRight={2}>
          <Text bold color={theme.accent}>
            Agents
          </Text>
          <Select
            items={items}
            index={cursor}
            onIndexChange={setCursor}
            onSelect={(it) => probe(it.value.name)}
            emptyText="(no agents)"
            maxVisible={10}
          />
        </Box>
        <Box flexDirection="column" width="50%">
          <Text bold color={theme.accentAlt}>
            Probe result
          </Text>
          {probing ? (
            <Text color={theme.warn}>
              <Spinner type="dots" /> probing {probing}…
            </Text>
          ) : result ? (
            <ResultTable result={result} />
          ) : (
            <Text color={theme.dim}>press p to probe all · Enter to probe selected</Text>
          )}
        </Box>
      </Box>
      <Text color={theme.dim}>{probing ? '… probing' : 'p probe all · Enter probe selected · ↑↓ select'}</Text>
    </Box>
  );
}

function ResultTable({ result }: { result: ProbeResult }) {
  return (
    <Box flexDirection="column">
      <Text>
        <Text color={result.failed > 0 ? theme.err : theme.ok} bold>
          {result.passed}/{result.probed} ok
        </Text>{' '}
        <Text color={theme.dim}>team {result.team}</Text>
      </Text>
      {result.results.map((r) => (
        <Text key={r.name}>
          <Text color={r.status === 'ok' ? theme.ok : theme.err}>●</Text>{' '}
          <Text>{r.name.padEnd(12).slice(0, 12)}</Text>
          <Text color={theme.dim}> {r.duration_ms != null ? `${r.duration_ms}ms` : ''}</Text>
          {r.error ? <Text color={theme.err}> {r.error}</Text> : null}
        </Text>
      ))}
    </Box>
  );
}
