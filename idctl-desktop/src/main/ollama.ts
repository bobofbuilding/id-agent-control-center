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
}

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
      }))
      .filter((m) => m.name);
    return { ok: true, models };
  } catch (e) {
    return { ok: false, models: [], error: e instanceof Error ? e.message : String(e) };
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
