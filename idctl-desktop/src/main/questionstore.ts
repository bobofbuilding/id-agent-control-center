/**
 * Blocker-question store (main process). App-side queue of multiple-choice questions
 * an agent raised when a task is blocked on a decision only the user can make. One
 * JSON file per question under <config>/questions/. They render in the Inbox with
 * clickable options; answering dispatches the choice to the relevant agent (renderer
 * side) and removes the question. No manager changes — purely client-side.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, rmSync, renameSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';

function questionsDir(): string {
  const env = process.env.IDCTL_CONFIG?.trim();
  const base = env
    ? dirname(env)
    : process.env.XDG_CONFIG_HOME?.trim()?.startsWith('/')
      ? join(process.env.XDG_CONFIG_HOME.trim(), 'idctl')
      : join(homedir(), '.config', 'idctl');
  const dir = join(base, 'questions');
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

export interface BlockerQuestion {
  id: string;
  question: string;
  options: string[];
  agent: string;        // who to deliver the chosen answer to
  taskRef?: string;
  taskTitle?: string;
  team: string;
  createdAt: number;
}

function fileFor(id: string): string {
  const safe = String(id).replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 80);
  if (!safe) throw new Error('invalid question id');
  return join(questionsDir(), `${safe}.json`);
}

export function listQuestions(team?: string): BlockerQuestion[] {
  const dir = questionsDir();
  const out: BlockerQuestion[] = [];
  for (const f of readdirSync(dir)) {
    if (!f.endsWith('.json')) continue;
    try {
      const q = JSON.parse(readFileSync(join(dir, f), 'utf8')) as BlockerQuestion;
      if (team && q.team !== team) continue;
      if (q.question && Array.isArray(q.options) && q.options.length) out.push(q);
    } catch { /* skip corrupt */ }
  }
  return out.sort((a, b) => (a.createdAt ?? 0) - (b.createdAt ?? 0));
}

export function addQuestion(q: BlockerQuestion): { ok: boolean; id: string } {
  // Idempotent: the blocker scan / auto-pilot can re-raise the same decision repeatedly.
  // If an open question with the same task + question text already exists, reuse it instead
  // of writing a duplicate file (the cause of the same decision appearing twice in the Inbox).
  const incomingQuestion = String(q.question || '').slice(0, 600);
  if (q.taskRef && incomingQuestion) {
    const dup = listQuestions().find((e) => e.taskRef === q.taskRef && e.question === incomingQuestion);
    if (dup) return { ok: true, id: dup.id };
  }
  const id = q?.id || `q_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
  const payload: BlockerQuestion = {
    id,
    question: String(q.question || '').slice(0, 600),
    options: (Array.isArray(q.options) ? q.options : []).map((o) => String(o).slice(0, 200)).filter(Boolean).slice(0, 6),
    agent: String(q.agent || ''),
    taskRef: q.taskRef ? String(q.taskRef) : undefined,
    taskTitle: q.taskTitle ? String(q.taskTitle).slice(0, 200) : undefined,
    team: String(q.team || ''),
    createdAt: q.createdAt || Date.now(),
  };
  const f = fileFor(id);
  const tmp = `${f}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(payload, null, 2) + '\n', { mode: 0o600 });
  try { renameSync(tmp, f); } catch (e) { try { rmSync(tmp, { force: true }); } catch { /* */ } throw e; }
  return { ok: true, id };
}

export function removeQuestion(id: string): { ok: boolean } {
  try { rmSync(fileFor(id), { force: true }); return { ok: true }; } catch { return { ok: false }; }
}
