/**
 * Confirm — a blocking yes/no overlay for destructive actions (delete agent,
 * deploy, reset, manager restart). y/Enter confirms, n/Esc cancels. The whole
 * point is that nothing irreversible happens without an explicit keystroke.
 */

import { Box, Text, useInput } from 'ink';
import { theme } from '../app/theme.ts';

interface Props {
  title: string;
  detail?: string;
  confirmLabel?: string;
  onConfirm: () => void;
  onCancel: () => void;
}

export function Confirm({ title, detail, confirmLabel = 'confirm', onConfirm, onCancel }: Props) {
  useInput((input, key) => {
    if (input === 'y' || key.return) onConfirm();
    else if (input === 'n' || key.escape) onCancel();
  });

  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor={theme.err}
      paddingX={1}
      width={64}
    >
      <Text bold color={theme.err}>
        ⚠ {title}
      </Text>
      {detail ? <Text color={theme.dim}>{detail}</Text> : null}
      <Box marginTop={1}>
        <Text>
          <Text bold color={theme.err}>
            [y]
          </Text>{' '}
          {confirmLabel}
          {'    '}
          <Text bold>[n]</Text> cancel
        </Text>
      </Box>
    </Box>
  );
}
