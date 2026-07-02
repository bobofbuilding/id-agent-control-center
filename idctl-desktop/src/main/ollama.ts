/**
 * Local-model management via Ollama's native HTTP API (same host the app
 * already uses for the OpenAI-compatible endpoint — /v1/... for inference,
 * /api/... for management). Lets the user list installed models and DOWNLOAD a
 * new one (`POST /api/pull`, which streams newline-delimited JSON progress).
 */

import { BrowserWindow } from 'electron';

const OLLAMA = (process.env.OLLAMA_HOST || 'http://127.0.0.1:11434').replace(/\/+$/, '');
const PROGRESS_CHANNEL = 'ollama:pull-progress';

export interface OllamaModel {
  name: string;
  size?: number;
  parameterSize?: string;
  digest?: string;
  modifiedAt?: string;
}

export interface OllamaCatalogModel {
  name: string;
  family: string;
  digest?: string;
  sizeLabel?: string;
  contextLabel?: string;
  inputLabel?: string;
  updatedLabel?: string;
  isMlx?: boolean;
}

export interface OllamaCatalogCheck {
  ok: boolean;
  checkedAt: number;
  source: 'ollama-library';
  watchedFamilies: string[];
  models: OllamaCatalogModel[];
  newModels: OllamaCatalogModel[];
  installedUpdates: Array<OllamaCatalogModel & { localDigest?: string }>;
  error?: string;
}

export type InstalledModelInput = string | { name?: string; model?: string; digest?: string };

const OLLAMA_LIBRARY_BASE = 'https://ollama.com/library';
const OLLAMA_LIBRARY_FAMILIES = [
  'gemma4',
  'qwen3',
  'llama3.2',
  'llama3.1',
  'gemma3',
  'phi4-mini',
  'qwen2.5-coder',
  'deepseek-r1',
  'mistral-nemo',
  'granite3.3',
];

export async function ollamaTags(): Promise<{ ok: boolean; models: OllamaModel[]; error?: string }> {
  try {
    const res = await fetch(`${OLLAMA}/api/tags`, { signal: AbortSignal.timeout(5000) });
    if (!res.ok) return { ok: false, models: [], error: `HTTP ${res.status}` };
    const j = (await res.json()) as { models?: Array<Record<string, unknown>> };
    const models = (j.models ?? [])
      .map((m) => ({
        name: String(m.name ?? m.model ?? ''),
        size: typeof m.size === 'number' ? m.size : undefined,
        parameterSize: (m.details as Record<string, unknown> | undefined)?.parameter_size as string | undefined,
        digest: typeof m.digest === 'string' ? m.digest : undefined,
        modifiedAt: typeof m.modified_at === 'string' ? m.modified_at : undefined,
      }))
      .filter((m) => m.name);
    return { ok: true, models };
  } catch (e) {
    return { ok: false, models: [], error: e instanceof Error ? e.message : String(e) };
  }
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function htmlText(s: string): string {
  return s
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeTag(name: string): string {
  return String(name || '').trim().replace(/^ollama:/i, '');
}

function digestComparable(digest?: string): string {
  return String(digest || '').trim().toLowerCase().replace(/^sha256:/, '');
}

function digestMatches(localDigest?: string, remoteDigest?: string): boolean {
  const local = digestComparable(localDigest);
  const remote = digestComparable(remoteDigest);
  return !!local && !!remote && (local === remote || local.startsWith(remote) || remote.startsWith(local));
}

function catalogRank(m: OllamaCatalogModel, installed: Set<string>): number {
  let score = 0;
  if (installed.has(m.name)) score += 100;
  if (m.updatedLabel && /today|yesterday|hour|minute/i.test(m.updatedLabel)) score += 50;
  if (m.isMlx) score += 30;
  if (m.family === 'gemma4') score += 20;
  if (/embed/i.test(m.name)) score -= 20;
  return score;
}

function parseLibraryTags(family: string, html: string): OllamaCatalogModel[] {
  const out = new Map<string, OllamaCatalogModel>();
  const re = new RegExp(`href="/library/(${escapeRe(family)}(?::|%3A)[^"#?]+)"`, 'g');
  let match: RegExpExecArray | null;
  while ((match = re.exec(html))) {
    const rawName = decodeURIComponent(match[1]);
    const name = normalizeTag(rawName);
    if (!name.includes(':') || out.has(name)) continue;
    const start = match.index;
    const end = Math.min(html.length, match.index + 2200);
    const windowText = htmlText(html.slice(start, end));
    const digest = windowText.match(/\b[a-f0-9]{12}\b/i)?.[0];
    const sizeLabel = windowText.match(/\b(?:\d+(?:\.\d+)?\s?(?:GB|MB)|(?:Small|Medium|Large)\s+Usage)\b/i)?.[0]?.replace(/\s+/g, ' ');
    const contextLabel = windowText.match(/\b\d+(?:K|M)?\s+context window\b/i)?.[0]?.replace(/\s+context window/i, '');
    const inputLabel = windowText.match(/\bText(?:,\s*Image|,\s*Audio|,\s*Video)*(?:,\s*\w+)*\s+input\b/i)?.[0]?.replace(/\s+input/i, '');
    const updatedLabel = windowText.match(/\b(?:today|yesterday|\d+\s+(?:second|minute|hour|day|week|month|year)s?\s+ago)\b/i)?.[0];
    out.set(name, {
      name,
      family,
      digest,
      sizeLabel,
      contextLabel,
      inputLabel,
      updatedLabel,
      isMlx: /(?:-mlx|-mxfp8|-nvfp4)/i.test(name) || /\bMLX\b/i.test(windowText),
    });
  }
  return [...out.values()];
}

async function fetchLibraryFamily(family: string): Promise<OllamaCatalogModel[]> {
  const res = await fetch(`${OLLAMA_LIBRARY_BASE}/${encodeURIComponent(family)}/tags`, {
    headers: { 'User-Agent': 'IDACC local-model-catalog-check' },
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) throw new Error(`${family}: HTTP ${res.status}`);
  return parseLibraryTags(family, await res.text());
}

export async function ollamaCatalogCheck(
  installedModels: InstalledModelInput[] = [],
  knownCatalogIds: string[] = [],
): Promise<OllamaCatalogCheck> {
  const checkedAt = Date.now();
  const installedRows = installedModels
    .map((m) => typeof m === 'string'
      ? { name: normalizeTag(m), digest: undefined as string | undefined }
      : { name: normalizeTag(String(m.name ?? m.model ?? '')), digest: typeof m.digest === 'string' ? m.digest : undefined })
    .filter((m) => m.name);
  const installed = new Set(installedRows.map((m) => m.name));
  const localByName = new Map(installedRows.map((m) => [m.name, m]));
  const known = new Set(knownCatalogIds.map(normalizeTag).filter(Boolean));
  const results = await Promise.allSettled(OLLAMA_LIBRARY_FAMILIES.map(fetchLibraryFamily));
  const errors = results
    .filter((r): r is PromiseRejectedResult => r.status === 'rejected')
    .map((r) => (r.reason instanceof Error ? r.reason.message : String(r.reason)));
  const byName = new Map<string, OllamaCatalogModel>();
  for (const r of results) {
    if (r.status !== 'fulfilled') continue;
    for (const model of r.value) byName.set(model.name, model);
  }
  const models = [...byName.values()].sort((a, b) =>
    catalogRank(b, installed) - catalogRank(a, installed) || a.name.localeCompare(b.name),
  );
  const newModels = models
    .filter((m) => !known.has(m.name) && !installed.has(m.name))
    .slice(0, 32);
  const installedUpdates = models
    .filter((m) => installed.has(m.name) && !!m.digest)
    .map((m) => ({ ...m, localDigest: localByName.get(m.name)?.digest }))
    .filter((m) => !!m.localDigest && !!m.digest && !digestMatches(m.localDigest, m.digest));
  return {
    ok: models.length > 0,
    checkedAt,
    source: 'ollama-library',
    watchedFamilies: OLLAMA_LIBRARY_FAMILIES,
    models: models.slice(0, 500),
    newModels,
    installedUpdates,
    error: errors.length ? errors.slice(0, 3).join('; ') : undefined,
  };
}

/** Delete an installed model (`DELETE /api/delete`). */
export async function ollamaRemove(model: string): Promise<{ ok: boolean; error?: string }> {
  const name = String(model || '').trim();
  if (!name || name.length > 128 || !/^[A-Za-z0-9][A-Za-z0-9._:@/-]*$/.test(name)) {
    return { ok: false, error: 'invalid model name' };
  }
  try {
    const res = await fetch(`${OLLAMA}/api/delete`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: name }),
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) {
      const t = await res.text().catch(() => '');
      return { ok: false, error: `HTTP ${res.status} ${t}`.trim() };
    }
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

function emit(progress: unknown): void {
  for (const w of BrowserWindow.getAllWindows()) w.webContents.send(PROGRESS_CHANNEL, progress);
}

/** Pull a model, streaming per-chunk progress to the renderer over PROGRESS_CHANNEL. */
export async function ollamaPull(model: string): Promise<{ ok: boolean; error?: string }> {
  const name = String(model || '').trim();
  // Ollama model refs: name[:tag][@digest], lowercase-ish; reject anything with
  // a slash that could escape or shell-special chars (we use HTTP, not a shell,
  // but keep the input tight anyway).
  if (!name || name.length > 128 || !/^[A-Za-z0-9][A-Za-z0-9._:@/-]*$/.test(name)) {
    return { ok: false, error: 'invalid model name' };
  }
  try {
    const res = await fetch(`${OLLAMA}/api/pull`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: name, stream: true }),
    });
    if (!res.ok || !res.body) {
      const t = await res.text().catch(() => '');
      const error = `HTTP ${res.status} ${t}`.trim();
      emit({ model: name, done: true, error });
      return { ok: false, error };
    }
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    let lastErr: string | undefined;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      const lines = buf.split('\n');
      buf = lines.pop() ?? '';
      for (const ln of lines) {
        const t = ln.trim();
        if (!t) continue;
        try {
          const o = JSON.parse(t) as { status?: string; total?: number; completed?: number; error?: string };
          if (o.error) lastErr = o.error;
          const pct = o.total ? Math.round(((o.completed ?? 0) / o.total) * 100) : undefined;
          emit({ model: name, status: o.status, total: o.total, completed: o.completed, pct, error: o.error });
        } catch {
          /* skip non-JSON line */
        }
      }
    }
    emit({ model: name, done: true, error: lastErr });
    return lastErr ? { ok: false, error: lastErr } : { ok: true };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    emit({ model: name, done: true, error: msg });
    return { ok: false, error: msg };
  }
}
