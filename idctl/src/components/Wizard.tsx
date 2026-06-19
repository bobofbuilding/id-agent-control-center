/**
 * Wizard — a tiny multi-step form. Each step is either free `text` (optionally
 * secret-masked) or a `choice` (rendered via Select). Enter advances; Esc
 * cancels the whole wizard. Used by SettingsView for add/edit of managers and
 * providers. The parent is responsible for setCapture(true) while it's mounted.
 */

import { useState } from 'react';
import { Box, Text, useInput } from 'ink';
import TextInput from 'ink-text-input';
import { Select } from './Select.tsx';
import { theme } from '../app/theme.ts';

export interface WizardStep {
  key: string;
  label: string;
  type: 'text' | 'choice';
  placeholder?: string;
  secret?: boolean;
  initial?: string;
  optional?: boolean;
  choices?: { label: string; value: string; hint?: string }[];
}

interface Props {
  title: string;
  steps: WizardStep[];
  onSubmit: (values: Record<string, string>) => void;
  onCancel: () => void;
}

export function Wizard({ title, steps, onSubmit, onCancel }: Props) {
  const [i, setI] = useState(0);
  const [values, setValues] = useState<Record<string, string>>(() => {
    const v: Record<string, string> = {};
    for (const s of steps) if (s.initial != null) v[s.key] = s.initial;
    return v;
  });
  const [text, setText] = useState(steps[0]?.initial ?? '');

  const step = steps[i];

  // Esc cancels at any step.
  useInput((_in, key) => {
    if (key.escape) onCancel();
  });

  if (!step) return null;

  function advance(value: string) {
    const next = { ...values, [step.key]: value };
    setValues(next);
    if (i + 1 >= steps.length) {
      onSubmit(next);
    } else {
      setI(i + 1);
      setText(steps[i + 1]?.initial ?? '');
    }
  }

  return (
    <Box flexDirection="column" borderStyle="round" borderColor={theme.accent} paddingX={1}>
      <Text bold color={theme.accent}>
        {title} <Text color={theme.dim}>· step {i + 1}/{steps.length}</Text>
      </Text>
      <Box marginTop={1} flexDirection="column">
        <Text>{step.label}{step.optional ? <Text color={theme.dim}> (optional)</Text> : null}:</Text>
        {step.type === 'text' ? (
          <Box>
            <Text color={theme.accent}>❯ </Text>
            <TextInput
              value={text}
              onChange={setText}
              onSubmit={(v) => advance(v.trim())}
              placeholder={step.placeholder}
              mask={step.secret ? '•' : undefined}
            />
          </Box>
        ) : (
          <Select
            items={(step.choices ?? []).map((c) => ({ key: c.value, label: c.label, value: c.value, hint: c.hint }))}
            onSelect={(it) => advance(it.value)}
          />
        )}
      </Box>
      <Text color={theme.dim}>Enter next · Esc cancel</Text>
    </Box>
  );
}
