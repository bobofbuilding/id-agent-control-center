import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  auditPreview,
  optimizeAskCommandCore,
  quoteSlashArg,
  redactSensitiveText,
} from '../src/shared/contextBudget.ts';
import { contextBudgetDryRun, contextBudgetReport, optimizeAskCommand } from '../src/main/contextBudget.ts';

function largeBackgroundCommand() {
  const body = Array.from({ length: 1200 }, (_, i) =>
    i % 10 === 0
      ? `status line ${i}: task ref #${String(i).padStart(4, '0')} remains tied to the active goal and must stay visible`
      : `background material sentence ${i} with enough repeated explanatory context to consume tokens safely during the synthetic measurement phase.`,
  ).join('\n');
  return `/ask lead ${quoteSlashArg(`Objective: test token savings without changing required intent.\n\nraw content:\n${body}`)}`;
}

const oversized = optimizeAskCommandCore(largeBackgroundCommand(), { source: 'test:oversized', team: 'default' });
assert.equal(oversized.changed, true, 'oversized background context should be optimized');
assert.equal(oversized.route, 'optimized-deterministic');
assert.ok(oversized.savedTokens > 1000, `expected meaningful savings, got ${oversized.savedTokens}`);
assert.ok(oversized.transforms.some((t) => t.startsWith('background-section-compaction')), 'expected background compaction transform');
assert.ok(!oversized.command.includes('background material sentence 600'), 'compacted prompt should omit the synthetic middle');
assert.ok(oversized.command.includes('raw prompts are not persisted'), 'inline note should disclose no raw prompt persistence');

const protectedCases = [
  {
    name: 'authorization header',
    text: `Authorization: Bearer ${'a'.repeat(32)}\n${'context '.repeat(3000)}`,
    expected: 'secret/auth material',
  },
  {
    name: 'openai-like key',
    text: `api_key=sk-${'b'.repeat(40)}\n${'context '.repeat(3000)}`,
    expected: 'secret/auth material',
  },
  {
    name: 'github token',
    text: `github_pat_${'c'.repeat(28)}\n${'context '.repeat(3000)}`,
    expected: 'secret/auth material',
  },
  {
    name: 'seed phrase',
    text: `seed phrase: apple banana cherry delta echo foxtrot golf hotel india juliet kilo lima\n${'context '.repeat(3000)}`,
    expected: 'wallet/key material',
  },
  {
    name: 'active diff',
    text: `diff --git a/a.ts b/a.ts\n@@ -1 +1 @@\n-const x = 1\n+const x = 2\n${'context '.repeat(3000)}`,
    expected: 'source code or patch under active review',
  },
  {
    name: 'instruction sidecar',
    text: `.id-instructions.md\n${'context '.repeat(3000)}`,
    expected: 'system/developer/agent instruction source',
  },
];

for (const tc of protectedCases) {
  const decision = optimizeAskCommandCore(`/ask lead ${quoteSlashArg(tc.text)}`, { source: `test:${tc.name}` });
  assert.equal(decision.changed, false, `${tc.name} should stay direct`);
  assert.equal(decision.route, 'direct', `${tc.name} should use direct route`);
  assert.ok(decision.protectedContent.includes(tc.expected), `${tc.name} should detect ${tc.expected}`);
  assert.equal(decision.savedTokens, 0, `${tc.name} should not claim savings`);
}

const nonAsk = optimizeAskCommandCore('/task create "Do the thing"', { source: 'test:non-ask' });
assert.equal(nonAsk.changed, false, 'non-/ask commands should pass through');
assert.equal(nonAsk.reasons[0], 'not an /ask payload');

const sensitive = [
  'Authorization: Bearer abcdefghijklmnopqrstuvwxyz123456',
  'api_key=sk-abcdefghijklmnopqrstuvwxyz1234567890',
  'seed phrase: apple banana cherry delta echo foxtrot golf hotel india juliet kilo lima',
].join('\n');
const redacted = redactSensitiveText(sensitive);
assert.ok(redacted.redactions.length >= 3, 'redaction should report protected values');
assert.ok(!redacted.text.includes('abcdefghijklmnopqrstuvwxyz123456'), 'bearer value should be redacted');
assert.ok(!redacted.text.includes('sk-abcdefghijklmnopqrstuvwxyz1234567890'), 'api key should be redacted');
assert.ok(!redacted.text.includes('apple banana cherry'), 'seed phrase line should be redacted');

const preview = auditPreview(`${sensitive}\n${'safe context '.repeat(400)}`, 500);
assert.equal(preview.truncated, true, 'audit preview should truncate long text');
assert.ok(preview.preview.includes('[REDACTED:'), 'audit preview should redact sensitive text');
assert.ok(!preview.preview.includes('apple banana cherry'), 'audit preview must not expose seed phrase text');

const dryRun = contextBudgetDryRun(`/ask lead ${quoteSlashArg(sensitive + '\n' + 'context '.repeat(3000))}`, { source: 'test:dry-run' });
assert.equal('command' in dryRun, false, 'dry-run view must not expose raw command');
assert.equal('originalCommand' in dryRun, false, 'dry-run view must not expose raw original command');
assert.equal(dryRun.rawPromptPersisted, false);
assert.ok(dryRun.redactions.length >= 1, 'dry-run view should carry redaction metadata');
assert.ok(!dryRun.originalPreview.includes('apple banana cherry'), 'dry-run preview must redact seed phrase text');

const statsRoot = mkdtempSync(join(tmpdir(), 'idacc-context-budget-'));
try {
  process.env.IDCTL_CONFIG = join(statsRoot, 'config.json');
  const persistedOptimized = optimizeAskCommand(largeBackgroundCommand(), { source: 'test:persistent-large', team: 'default' });
  const persistedProtected = optimizeAskCommand(`/ask lead ${quoteSlashArg(protectedCases[0].text)}`, { source: 'test:persistent-protected', team: 'default' });
  const report = contextBudgetReport();
  assert.equal(report.frontendSurface, 'hidden');
  assert.equal(report.persisted.allTime.inspected, 2, 'persistent stats should count inspected decisions');
  assert.equal(report.persisted.allTime.optimized, 1, 'persistent stats should count optimized decisions');
  assert.equal(report.persisted.allTime.protectedDirect, 1, 'persistent stats should count protected direct decisions');
  assert.equal(report.persisted.allTime.savedTokens, persistedOptimized.savedTokens + persistedProtected.savedTokens);
  assert.equal(report.persisted.today.bySource['test:persistent-large'], 1);
  assert.equal(report.persisted.today.byProtectedContent['secret/auth material'], 1);
  assert.ok(existsSync(report.persisted.storageFile), 'stats file should be written');
  const statsText = readFileSync(report.persisted.storageFile, 'utf8');
  assert.ok(!statsText.includes('originalCommand'), 'persistent stats must not contain originalCommand');
  assert.ok(!statsText.includes('sentCommand'), 'persistent stats must not contain sentCommand');
  assert.ok(!statsText.includes('Authorization: Bearer'), 'persistent stats must not contain bearer header text');
  assert.ok(!statsText.includes('aaaaaaaaaaaaaaaa'), 'persistent stats must not contain token-like values');
} finally {
  rmSync(statsRoot, { recursive: true, force: true });
  delete process.env.IDCTL_CONFIG;
}

const measured = [oversized, ...protectedCases.map((tc) => optimizeAskCommandCore(`/ask lead ${quoteSlashArg(tc.text)}`, { source: `measure:${tc.name}` })), nonAsk];
const totals = measured.reduce((acc, d) => ({
  originalTokens: acc.originalTokens + d.originalTokens,
  sentTokens: acc.sentTokens + d.sentTokens,
  savedTokens: acc.savedTokens + d.savedTokens,
  optimized: acc.optimized + (d.changed ? 1 : 0),
  protectedDirect: acc.protectedDirect + (d.protectedContent.length ? 1 : 0),
}), { originalTokens: 0, sentTokens: 0, savedTokens: 0, optimized: 0, protectedDirect: 0 });

console.log(`CONTEXT_BUDGET_SMOKE ${JSON.stringify({
  cases: measured.length,
  originalTokens: totals.originalTokens,
  sentTokens: totals.sentTokens,
  savedTokens: totals.savedTokens,
  savingsRatio: totals.originalTokens ? Number((totals.savedTokens / totals.originalTokens).toFixed(4)) : 0,
  optimized: totals.optimized,
  protectedDirect: totals.protectedDirect,
}, null, 2)}`);
