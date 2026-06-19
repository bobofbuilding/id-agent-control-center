/** Bottom status bar: connection, team, agent count, last refresh, hints. */

import { Box, Text } from 'ink';
import Spinner from 'ink-spinner';
import { theme, ago } from '../app/theme.ts';
import type { Connection } from '../store/useManager.ts';

interface Props {
  connection: Connection;
  managerUrl: string;
  team: string | undefined;
  agentCount: number;
  lastUpdated?: number;
  hint?: string;
  error?: string;
  update?: { version: string; staged: boolean };
}

export function StatusBar({ connection, managerUrl, team, agentCount, lastUpdated, hint, error, update }: Props) {
  return (
    <Box flexDirection="column" marginTop={1}>
      {update ? (
        <Text color={theme.accentAlt} bold>
          ⬆ idctl v{update.version} available
          {update.staged ? ' — staged, applies on restart' : ' — run `idctl upgrade` to install'}
        </Text>
      ) : null}
      {error && connection === 'offline' ? (
        <Text color={theme.err}>⚠ {error}</Text>
      ) : null}
      <Box>
        <ConnPill connection={connection} />
        <Text color={theme.dim}> {managerUrl}</Text>
        <Text color={theme.dim}> · </Text>
        <Text>team </Text>
        <Text color={theme.accent} bold>
          {team ?? 'default'}
        </Text>
        <Text color={theme.dim}> · </Text>
        <Text>{agentCount} agents</Text>
        <Text color={theme.dim}> · {ago(lastUpdated)}</Text>
      </Box>
      <Text color={theme.dim}>{hint ?? 'Tab/1-9 views · r refresh · t team · ? help · q quit'}</Text>
    </Box>
  );
}

function ConnPill({ connection }: { connection: Connection }) {
  if (connection === 'online') return <Text color={theme.ok}>● online</Text>;
  if (connection === 'offline') return <Text color={theme.err}>● offline</Text>;
  return (
    <Text color={theme.warn}>
      <Spinner type="dots" /> connecting
    </Text>
  );
}
