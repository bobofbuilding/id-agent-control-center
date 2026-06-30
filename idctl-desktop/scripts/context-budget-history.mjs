import { replayContextBudgetFromChatHistory } from '../src/main/contextReplay.ts';

const report = replayContextBudgetFromChatHistory({
  limitSessions: process.env.IDACC_CONTEXT_REPLAY_SESSIONS,
  maxMessages: process.env.IDACC_CONTEXT_REPLAY_MESSAGES,
  sampleLimit: process.env.IDACC_CONTEXT_REPLAY_SAMPLES,
});

console.log('CONTEXT_BUDGET_HISTORY', JSON.stringify({
  scannedSessions: report.scannedSessions,
  scannedMessages: report.scannedMessages,
  eligibleMessages: report.eligibleMessages,
  skippedMessages: report.skippedMessages,
  originalTokens: report.totals.originalTokens,
  sentTokens: report.totals.sentTokens,
  savedTokens: report.totals.savedTokens,
  savingsRatio: Number(report.totals.savingsRatio.toFixed(4)),
  optimized: report.totals.optimized,
  protectedDirect: report.totals.protectedDirect,
  byTeam: report.totals.byTeam,
  byRoute: report.totals.byRoute,
  byTransform: report.totals.byTransform,
  byProtectedContent: report.totals.byProtectedContent,
  guardrails: report.guardrails,
}, null, 2));
