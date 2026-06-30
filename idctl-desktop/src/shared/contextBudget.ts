export type ContextBudgetRoute = 'direct' | 'optimized-deterministic';

export interface ContextBudgetOptions {
  source?: string;
  team?: string;
  minPromptTokens?: number;
  lossyMinPromptTokens?: number;
}

export interface ContextBudgetDecision {
  command: string;
  originalCommand: string;
  changed: boolean;
  route: ContextBudgetRoute;
  source: string;
  team?: string;
  target?: string;
  originalTokens: number;
  sentTokens: number;
  savedTokens: number;
  savingsRatio: number;
  reasons: string[];
  guardrails: string[];
  protectedContent: string[];
  transforms: string[];
}

interface AskCommandParts {
  target: string;
  prompt: string;
}

const DEFAULT_MIN_PROMPT_TOKENS = 1800;
const DEFAULT_LOSSY_MIN_PROMPT_TOKENS = 6000;
const MIN_SAVED_TOKENS = 180;

const PROTECTED_PATTERNS: Array<[string, RegExp]> = [
  ['secret/auth material', /\b(api[_-]?key|access[_-]?token|authorization\s*:|bearer\s+[a-z0-9._-]{16,}|password\s*[=:]|private[_ -]?key|-----BEGIN\s+(?:RSA|OPENSSH|EC|PRIVATE))/i],
  ['system/developer/agent instruction source', /\b(system prompt|developer message|\.id-instructions\.md|agent instruction\s*-\s*coordination|coordination\s*&\s*behavior|instruction sidecar)\b/i],
  ['source code or patch under active review', /(^|\n)(diff --git|@@\s|```(?:[a-z0-9_-]+)?\s*(?:import|export|function|class|const|let|var|def |package |use |fn |pragma |interface)|\+\+\+\s+b\/|---\s+a\/)/i],
  ['wallet/key material', /\b(seed phrase|mnemonic|session key|private wallet|controller signature)\b/i],
];

const IMPORTANT_LINE_RE = /\b(goal|objective|task|status|blocker|decision|question|requirement|acceptance|ref|source|path|error|warning|done|partial|pending|paused|team|agent|owner|validator|evidence|instruction|guardrail)\b/i;
const BACKGROUND_MARKER_RE = /^(#{1,5}\s*)?(source excerpt|material excerpt|extracted text|raw extraction|raw content|transcript|logs?|build output|previous output|output from earlier steps|plan content|current plan|plan|context dump)\s*:?/i;

export function estimateTokens(text: string): number {
  const trimmed = String(text ?? '').trim();
  if (!trimmed) return 0;
  const words = trimmed.match(/\S+/g)?.length ?? 0;
  return Math.max(1, Math.ceil(Math.max(trimmed.length / 4, words * 1.3)));
}

export function quoteSlashArg(s: string): string {
  return `"${String(s ?? '').replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

function parseQuotedArg(raw: string): string {
  const s = raw.trim();
  if (!s.startsWith('"')) return s;
  let out = '';
  for (let i = 1; i < s.length; i += 1) {
    const ch = s[i];
    if (ch === '\\') {
      const next = s[i + 1];
      if (next === '"' || next === '\\') {
        out += next;
        i += 1;
      } else {
        out += ch;
      }
      continue;
    }
    if (ch === '"') return out + s.slice(i + 1).trimStart();
    out += ch;
  }
  return s.slice(1);
}

function parseAskCommand(command: string): AskCommandParts | null {
  const m = /^\/ask\s+(\S+)\s+([\s\S]+)$/i.exec(String(command ?? '').trim());
  if (!m) return null;
  const target = m[1].trim();
  const prompt = parseQuotedArg(m[2]);
  if (!target || !prompt.trim()) return null;
  return { target, prompt };
}

function protectedContent(prompt: string): string[] {
  const out: string[] = [];
  for (const [label, re] of PROTECTED_PATTERNS) {
    if (re.test(prompt)) out.push(label);
  }
  return out;
}

function normalizeBlankSpace(prompt: string): { text: string; changed: boolean } {
  const text = prompt
    .replace(/[ \t]+$/gm, '')
    .replace(/\n{4,}/g, '\n\n\n')
    .trim();
  return { text, changed: text !== prompt };
}

function dedupeRepeatedLongLines(prompt: string): { text: string; removed: number } {
  const seen = new Set<string>();
  const out: string[] = [];
  let removed = 0;
  for (const line of prompt.split(/\r?\n/)) {
    const key = line.replace(/\s+/g, ' ').trim();
    const eligible = key.length >= 120 && !/^[-*]\s+\[[ x]\]/i.test(key) && !IMPORTANT_LINE_RE.test(key);
    if (eligible && seen.has(key)) {
      removed += 1;
      continue;
    }
    if (eligible) seen.add(key);
    out.push(line);
  }
  return { text: out.join('\n'), removed };
}

function dedupeRepeatedBlocks(prompt: string): { text: string; removed: number } {
  const blocks = prompt.split(/\n{2,}/);
  const seen = new Set<string>();
  const out: string[] = [];
  let removed = 0;
  for (const block of blocks) {
    const key = block.replace(/\s+/g, ' ').trim();
    const eligible = key.length >= 600 && !PROTECTED_PATTERNS.some(([, re]) => re.test(block));
    if (eligible && seen.has(key)) {
      removed += 1;
      continue;
    }
    if (eligible) seen.add(key);
    out.push(block);
  }
  return { text: out.join('\n\n'), removed };
}

function compactBackgroundBlock(lines: string[], heading: string): { lines: string[]; changed: boolean; originalTokens: number; sentTokens: number } {
  const body = lines.join('\n');
  const originalTokens = estimateTokens(body);
  if (originalTokens < 2600 || protectedContent(body).length) {
    return { lines, changed: false, originalTokens, sentTokens: originalTokens };
  }
  const first = body.slice(0, 4800);
  const last = body.slice(-2400);
  const important = lines
    .filter((line) => IMPORTANT_LINE_RE.test(line))
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(0, 80);
  const compacted = [
    first.trimEnd(),
    '',
    `[IDACC context budget: compacted the middle of ${heading || 'this background context'} to reduce LLM input tokens. Status, goal, requirement, blocker, path, ref, and error lines detected in the omitted span are preserved below. The full original is kept in the local context-budget audit store.]`,
    ...important.map((line) => `- ${line.slice(0, 260)}`),
    '',
    last.trimStart(),
  ].filter(Boolean);
  const sentTokens = estimateTokens(compacted.join('\n'));
  return sentTokens < originalTokens
    ? { lines: compacted, changed: true, originalTokens, sentTokens }
    : { lines, changed: false, originalTokens, sentTokens: originalTokens };
}

function compactBackgroundSections(prompt: string, minTokens: number): { text: string; changed: boolean; sections: number } {
  if (estimateTokens(prompt) < minTokens) return { text: prompt, changed: false, sections: 0 };
  const lines = prompt.split(/\r?\n/);
  const out: string[] = [];
  let changed = false;
  let sections = 0;
  for (let i = 0; i < lines.length;) {
    const line = lines[i];
    if (!BACKGROUND_MARKER_RE.test(line.trim())) {
      out.push(line);
      i += 1;
      continue;
    }
    const block: string[] = [line];
    i += 1;
    while (i < lines.length && !BACKGROUND_MARKER_RE.test(lines[i].trim())) {
      block.push(lines[i]);
      i += 1;
    }
    const compacted = compactBackgroundBlock(block, line.trim());
    if (compacted.changed) {
      changed = true;
      sections += 1;
    }
    out.push(...compacted.lines);
  }
  return { text: out.join('\n'), changed, sections };
}

function savingsRatio(originalTokens: number, sentTokens: number): number {
  return originalTokens > 0 ? Math.max(0, (originalTokens - sentTokens) / originalTokens) : 0;
}

export function optimizeAskCommandCore(command: string, options: ContextBudgetOptions = {}): ContextBudgetDecision {
  const originalCommand = String(command ?? '');
  const source = options.source ?? 'unknown';
  const parts = parseAskCommand(originalCommand);
  if (!parts) {
    return {
      command: originalCommand,
      originalCommand,
      changed: false,
      route: 'direct',
      source,
      team: options.team,
      originalTokens: estimateTokens(originalCommand),
      sentTokens: estimateTokens(originalCommand),
      savedTokens: 0,
      savingsRatio: 0,
      reasons: ['not an /ask payload'],
      guardrails: ['non-/ask manager commands are passed through unchanged'],
      protectedContent: [],
      transforms: [],
    };
  }

  const originalTokens = estimateTokens(parts.prompt);
  const protectedHits = protectedContent(parts.prompt);
  const guardrails = [
    'never optimize secrets, auth material, instruction sidecars, active code patches, or wallet/key material',
    'use deterministic compaction only; no semantic rewriting or AI summarization in the hot path',
    'fall back to the exact original when savings are too small or a protected class is detected',
  ];
  if (protectedHits.length) {
    return {
      command: originalCommand,
      originalCommand,
      changed: false,
      route: 'direct',
      source,
      team: options.team,
      target: parts.target,
      originalTokens,
      sentTokens: originalTokens,
      savedTokens: 0,
      savingsRatio: 0,
      reasons: [`protected content detected: ${protectedHits.join(', ')}`],
      guardrails,
      protectedContent: protectedHits,
      transforms: [],
    };
  }

  const minPromptTokens = options.minPromptTokens ?? DEFAULT_MIN_PROMPT_TOKENS;
  if (originalTokens < minPromptTokens) {
    return {
      command: originalCommand,
      originalCommand,
      changed: false,
      route: 'direct',
      source,
      team: options.team,
      target: parts.target,
      originalTokens,
      sentTokens: originalTokens,
      savedTokens: 0,
      savingsRatio: 0,
      reasons: [`prompt below core context-budget threshold (${originalTokens}/${minPromptTokens} tokens)`],
      guardrails,
      protectedContent: [],
      transforms: [],
    };
  }

  const transforms: string[] = [];
  let prompt = parts.prompt;
  const normalized = normalizeBlankSpace(prompt);
  if (normalized.changed) {
    prompt = normalized.text;
    transforms.push('blank-space-normalization');
  }
  const lineDedupe = dedupeRepeatedLongLines(prompt);
  if (lineDedupe.removed) {
    prompt = lineDedupe.text;
    transforms.push(`dedupe-long-lines:${lineDedupe.removed}`);
  }
  const blockDedupe = dedupeRepeatedBlocks(prompt);
  if (blockDedupe.removed) {
    prompt = blockDedupe.text;
    transforms.push(`dedupe-large-blocks:${blockDedupe.removed}`);
  }
  const sectionCompaction = compactBackgroundSections(prompt, options.lossyMinPromptTokens ?? DEFAULT_LOSSY_MIN_PROMPT_TOKENS);
  if (sectionCompaction.changed) {
    prompt = sectionCompaction.text;
    transforms.push(`background-section-compaction:${sectionCompaction.sections}`);
  }

  const sentTokens = estimateTokens(prompt);
  const savedTokens = Math.max(0, originalTokens - sentTokens);
  const ratio = savingsRatio(originalTokens, sentTokens);
  if (!transforms.length || savedTokens < MIN_SAVED_TOKENS || ratio < 0.06) {
    return {
      command: originalCommand,
      originalCommand,
      changed: false,
      route: 'direct',
      source,
      team: options.team,
      target: parts.target,
      originalTokens,
      sentTokens: originalTokens,
      savedTokens: 0,
      savingsRatio: 0,
      reasons: ['no safe optimization cleared the minimum savings gate'],
      guardrails,
      protectedContent: [],
      transforms,
    };
  }

  return {
    command: `/ask ${parts.target} ${quoteSlashArg(prompt)}`,
    originalCommand,
    changed: true,
    route: 'optimized-deterministic',
    source,
    team: options.team,
    target: parts.target,
    originalTokens,
    sentTokens,
    savedTokens,
    savingsRatio: ratio,
    reasons: [`saved about ${savedTokens} input tokens with deterministic context budgeting`],
    guardrails,
    protectedContent: [],
    transforms,
  };
}
