/**
 * Select — a minimal keyboard-driven vertical list. Up/Down (or j/k) to move,
 * Enter to choose. Kept dependency-free so the whole TUI rides on one list
 * idiom. Controlled selection via `index`/`onIndexChange` is optional; if
 * omitted it manages its own cursor.
 */

import { useState } from 'react';
import { Box, Text, useInput } from 'ink';
import { theme } from '../app/theme.ts';

export interface SelectItem<T> {
  key: string;
  label: string;
  value: T;
  hint?: string;
  color?: string;
}

interface Props<T> {
  items: SelectItem<T>[];
  isActive?: boolean;
  index?: number;
  onIndexChange?: (i: number) => void;
  onSelect?: (item: SelectItem<T>, i: number) => void;
  emptyText?: string;
  maxVisible?: number;
}

export function Select<T>({
  items,
  isActive = true,
  index,
  onIndexChange,
  onSelect,
  emptyText = '(nothing here)',
  maxVisible = 12,
}: Props<T>) {
  const [internal, setInternal] = useState(0);
  const cursor = index ?? internal;
  const setCursor = (i: number) => {
    onIndexChange ? onIndexChange(i) : setInternal(i);
  };

  useInput(
    (input, key) => {
      if (items.length === 0) return;
      if (key.upArrow || input === 'k') setCursor((cursor - 1 + items.length) % items.length);
      else if (key.downArrow || input === 'j') setCursor((cursor + 1) % items.length);
      else if (key.return) onSelect?.(items[cursor], cursor);
    },
    { isActive },
  );

  if (items.length === 0) {
    return <Text color={theme.dim}>{emptyText}</Text>;
  }

  // Windowed view so long lists stay on screen.
  const safeCursor = Math.min(cursor, items.length - 1);
  let start = 0;
  if (items.length > maxVisible) {
    start = Math.max(0, Math.min(safeCursor - Math.floor(maxVisible / 2), items.length - maxVisible));
  }
  const visible = items.slice(start, start + maxVisible);

  return (
    <Box flexDirection="column">
      {start > 0 && <Text color={theme.dim}> ↑ {start} more</Text>}
      {visible.map((item, i) => {
        const realIndex = start + i;
        const selected = realIndex === safeCursor;
        return (
          <Box key={item.key}>
            <Text color={selected ? theme.accent : undefined} inverse={selected && isActive}>
              {selected ? '❯ ' : '  '}
              <Text color={item.color}>{item.label}</Text>
              {item.hint ? <Text color={theme.dim}>  {item.hint}</Text> : null}
            </Text>
          </Box>
        );
      })}
      {start + maxVisible < items.length && (
        <Text color={theme.dim}> ↓ {items.length - (start + maxVisible)} more</Text>
      )}
    </Box>
  );
}
