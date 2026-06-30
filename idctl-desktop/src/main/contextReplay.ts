import { createHash } from 'node:crypto';
import { getChat, listChats } from './chatstore.ts';
import { type ContextBudgetMeasurement } from './contextBudget.ts';
import { optimizeAskCommandCore, quoteSlashArg } from '../shared/contextBudget.ts';

export interface ContextBudgetHistoryReplayOptions {
  team?: string;
  limitSessions?: number;
  maxMessages?: number;
  sampleLimit?: number;
}

export interface ContextBudgetHistoryReplaySample {
  sampleId: string;
  sessionHash: string;
  messageHash: string;
  team: string;
  target?: string;
  route: 'direct' | 'optimized-deterministic';
  changed: boolean;
  originalTokens: number;
  sentTokens: number;
  savedTokens: number;
  savingsRatio: number;
  transforms: string[];
  protectedContent: string[];
  reasons: string[];
}

export interface ContextBudgetHistoryReplayReport {
  corpus: 'local-chat-history';
  dryRunOnly: true;
  rawPromptPersisted: false;
  managerContacted: false;
  storage: 'none';
  scannedSessions: number;
  scannedMessages: number;
  eligibleMessages: number;
  skippedMessages: number;
  limits: {
    limitSessions: number;
    maxMessages: number;
    sampleLimit: number;
  };
  totals: ContextBudgetMeasurement;
  samples: ContextBudgetHistoryReplaySample[];
  guardrails: string[];
}

type MutableMeasurement = Omit<ContextBudgetMeasurement, 'savingsRatio'>;

function emptyMeasurement(): MutableMeasurement {
  return {
    inspected: 0,
    optimized: 0,
    direct: 0,
    protectedDirect: 0,
    originalTokens: 0,
    sentTokens: 0,
    savedTokens: 0,
    bySource: {},
    byTeam: {},
    byRoute: {},
    byTransform: {},
    byProtectedContent: {},
  };
}

function measurementView(bucket: MutableMeasurement): ContextBudgetMeasurement {
  return {
    ...bucket,
    savingsRatio: bucket.originalTokens > 0 ? bucket.savedTokens / bucket.originalTokens : 0,
  };
}

function addMapValue(map: Record<string, number>, key: string | undefined, amount = 1): void {
  const clean = String(key || 'unknown').replace(/\s+/g, ' ').trim().slice(0, 120) || 'unknown';
  map[clean] = (map[clean] ?? 0) + amount;
}

function stableHash(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

function boundedNumber(value: unknown, fallback: number, min: number, max: number): number {
  const n = Math.floor(Number(value));
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}

export function replayContextBudgetFromChatHistory(options: ContextBudgetHistoryReplayOptions = {}): ContextBudgetHistoryReplayReport {
  const requestedTeam = typeof options.team === 'string' && options.team.trim() ? options.team.trim() : undefined;
  const limitSessions = boundedNumber(options.limitSessions, 50, 1, 500);
  const maxMessages = boundedNumber(options.maxMessages, 500, 1, 5000);
  const sampleLimit = boundedNumber(options.sampleLimit, 12, 0, 50);
  const sessions = listChats(requestedTeam).slice(0, limitSessions);
  const totals = emptyMeasurement();
  const samples: ContextBudgetHistoryReplaySample[] = [];
  let scannedMessages = 0;
  let eligibleMessages = 0;
  let skippedMessages = 0;

  for (const summary of sessions) {
    const session = getChat(summary.id);
    if (!session) continue;
    const team = String(session.team || summary.team || requestedTeam || 'default').replace(/\s+/g, ' ').trim().slice(0, 120) || 'default';
    const target = String(session.target || 'lead').replace(/\s+/g, '').trim().slice(0, 120) || 'lead';
    for (const message of session.messages || []) {
      if (scannedMessages >= maxMessages) break;
      scannedMessages += 1;
      if (message.role !== 'you' || !String(message.text || '').trim()) {
        skippedMessages += 1;
        continue;
      }
      eligibleMessages += 1;
      const command = `/ask ${target} ${quoteSlashArg(message.text)}`;
      const decision = optimizeAskCommandCore(command, { source: 'history-replay:chat', team });
      totals.inspected += 1;
      totals.originalTokens += decision.originalTokens;
      totals.sentTokens += decision.sentTokens;
      totals.savedTokens += decision.savedTokens;
      if (decision.changed) totals.optimized += 1;
      else totals.direct += 1;
      if (decision.protectedContent.length) totals.protectedDirect += 1;
      addMapValue(totals.bySource, decision.source);
      addMapValue(totals.byTeam, team);
      addMapValue(totals.byRoute, decision.route);
      for (const transform of decision.transforms) addMapValue(totals.byTransform, transform);
      for (const protectedClass of decision.protectedContent) addMapValue(totals.byProtectedContent, protectedClass);
      if (samples.length < sampleLimit) {
        samples.push({
          sampleId: `hist_${stableHash(`${summary.id}:${message.id}`).slice(0, 12)}`,
          sessionHash: stableHash(summary.id).slice(0, 16),
          messageHash: stableHash(`${summary.id}:${message.id}`).slice(0, 16),
          team,
          target,
          route: decision.route,
          changed: decision.changed,
          originalTokens: decision.originalTokens,
          sentTokens: decision.sentTokens,
          savedTokens: decision.savedTokens,
          savingsRatio: decision.savingsRatio,
          transforms: decision.transforms,
          protectedContent: decision.protectedContent,
          reasons: decision.reasons,
        });
      }
    }
    if (scannedMessages >= maxMessages) break;
  }

  return {
    corpus: 'local-chat-history',
    dryRunOnly: true,
    rawPromptPersisted: false,
    managerContacted: false,
    storage: 'none',
    scannedSessions: sessions.length,
    scannedMessages,
    eligibleMessages,
    skippedMessages,
    limits: { limitSessions, maxMessages, sampleLimit },
    totals: measurementView(totals),
    samples,
    guardrails: [
      'Historical replay reads local chat files only; it never dispatches to the manager or agents.',
      'Replay output is aggregate plus hashes, token estimates, transforms, and protected-content labels only.',
      'Raw chat text, prompt previews, commands, secrets, auth material, wallet/key material, and attachments are never returned or persisted by this report.',
      'Replay uses the same deterministic context-budget decision function as live dispatch, so it validates current savings behavior without changing chat history.',
    ],
  };
}
