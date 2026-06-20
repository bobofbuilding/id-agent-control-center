/**
 * Local LLM server discovery.
 *
 * Scans localhost for known local inference servers (Ollama, LM Studio,
 * llama.cpp, vLLM, …) by probing each one's model-listing endpoint, and returns
 * the ones that answer — with their model list — so the operator can add them as
 * inference backends in one click instead of hunting for ports.
 *
 * It reuses ProviderClient.probe(), so the detection logic (endpoint shape per
 * kind, status classification, model parsing) stays in exactly one place. Must
 * run where fetch-to-localhost is allowed (the Electron main process / Node),
 * never the sandboxed renderer.
 *
 * Candidates are pre-deduped by (port, path): when several products default to
 * the same port (llama.cpp / llamafile / LocalAI on 8080) a single probe can't
 * tell them apart, so we list one candidate and name the rest in `sharesPortWith`.
 */

import { ProviderClient, type ProbeStatus } from './ProviderClient.ts';
import type { ProviderKind, ProviderProfile } from './schema.ts';

export interface LocalServerCandidate {
  /** Stable kebab-case id (also the suggested provider name). */
  id: string;
  /** Friendly label for the picker / results list. */
  name: string;
  /** ProviderKind used to probe + to store if added. */
  kind: ProviderKind;
  /** The provider baseUrl to probe and to store when added. */
  baseUrl: string;
  /** Port the candidate listens on (display + collision notes). */
  port: number;
  /** Relative popularity, drives scan order + result ordering. */
  popularity: 'high' | 'medium' | 'low' | 'niche';
  /**
   * True for servers that require an auth token by default (LiteLLM, Open WebUI).
   * A keyless scan sees these as 'auth-error' (up, but no models listed) — still
   * worth surfacing, just flagged as needing a key.
   */
  needsKey?: boolean;
  /** Other products that share this port (a probe can't distinguish them). */
  sharesPortWith?: string[];
  notes?: string;
}

export interface DiscoveredServer {
  id: string;
  name: string;
  kind: ProviderKind;
  baseUrl: string;
  port: number;
  /** Probe outcome: 'live' (answered with models) or 'auth-error' (up, needs key). */
  status: ProbeStatus;
  models: string[];
  modelCount: number;
  needsKey?: boolean;
  sharesPortWith?: string[];
}

/**
 * The probe catalog — ports/paths verified from web research (see the
 * local-llm-discovery-research workflow), ordered roughly by prevalence. Each
 * entry is one distinct (port, path): where several products default to the same
 * socket (the 8080 cluster), one probe stands in for all of them.
 *
 * Deliberately omitted: Open WebUI (also 8080, but an auth-gated web UI proxy
 * whose model list needs a Bearer token — a keyless scan can't enumerate it).
 */
export const LOCAL_DISCOVERY_CANDIDATES: LocalServerCandidate[] = [
  { id: 'ollama', name: 'Ollama', kind: 'ollama', baseUrl: 'http://127.0.0.1:11434', port: 11434, popularity: 'high' },
  { id: 'lmstudio', name: 'LM Studio', kind: 'lmstudio', baseUrl: 'http://127.0.0.1:1234/v1', port: 1234, popularity: 'high' },
  {
    id: 'llamacpp', name: 'llama.cpp / llamafile / LocalAI', kind: 'openai-compatible',
    baseUrl: 'http://127.0.0.1:8080/v1', port: 8080, popularity: 'high',
    sharesPortWith: ['llama-server', 'llamafile', 'LocalAI'],
    notes: 'Port 8080 is shared by several OpenAI-compatible servers — a probe lists models but can\'t say which one.',
  },
  { id: 'vllm', name: 'vLLM', kind: 'openai-compatible', baseUrl: 'http://127.0.0.1:8000/v1', port: 8000, popularity: 'high' },
  { id: 'jan', name: 'Jan', kind: 'openai-compatible', baseUrl: 'http://127.0.0.1:1337/v1', port: 1337, popularity: 'high', notes: 'Jan\'s local API server is off until enabled in its settings.' },
  { id: 'textgen-webui', name: 'text-generation-webui', kind: 'openai-compatible', baseUrl: 'http://127.0.0.1:5000/v1', port: 5000, popularity: 'medium', notes: 'Only listens when launched with --api.' },
  { id: 'koboldcpp', name: 'KoboldCpp', kind: 'openai-compatible', baseUrl: 'http://127.0.0.1:5001/v1', port: 5001, popularity: 'medium' },
  { id: 'msty', name: 'Msty (Local AI)', kind: 'ollama', baseUrl: 'http://127.0.0.1:10000', port: 10000, popularity: 'medium', notes: 'Rebundled Ollama on an offset port.' },
  { id: 'gpt4all', name: 'GPT4All', kind: 'openai-compatible', baseUrl: 'http://127.0.0.1:4891/v1', port: 4891, popularity: 'medium', notes: 'Local API server is off by default.' },
  { id: 'cortex', name: 'Cortex', kind: 'openai-compatible', baseUrl: 'http://127.0.0.1:39281/v1', port: 39281, popularity: 'low', notes: 'Jan\'s underlying engine, standalone.' },
  { id: 'cortex-jan', name: 'Cortex (Jan-embedded)', kind: 'openai-compatible', baseUrl: 'http://127.0.0.1:39291/v1', port: 39291, popularity: 'low' },
  { id: 'litellm', name: 'LiteLLM proxy', kind: 'openai-compatible', baseUrl: 'http://127.0.0.1:4000/v1', port: 4000, popularity: 'low', needsKey: true },
];

/** Build a throwaway profile so we can reuse ProviderClient's probe logic. */
function candidateProfile(c: LocalServerCandidate): ProviderProfile {
  return { name: c.id, kind: c.kind, baseUrl: c.baseUrl, enabled: true };
}

/**
 * Probe all candidates concurrently and return the ones that are reachable. A
 * candidate counts as discovered when it answers 'live' (lists models) or, for
 * key-protected servers, 'auth-error' (proven up but needs a token). Everything
 * else (connection refused / timeout / non-LLM service on the port) is dropped.
 */
export async function discoverLocalServers(opts: {
  timeoutMs?: number;
  candidates?: LocalServerCandidate[];
  signal?: AbortSignal;
} = {}): Promise<DiscoveredServer[]> {
  const timeoutMs = opts.timeoutMs ?? 1000; // loopback — keep it tight
  const candidates = opts.candidates ?? LOCAL_DISCOVERY_CANDIDATES;

  const results = await Promise.all(
    candidates.map(async (c): Promise<DiscoveredServer | null> => {
      const outcome = await new ProviderClient(candidateProfile(c)).probe(opts.signal, timeoutMs).catch(() => null);
      if (!outcome) return null;
      // 'live' counts only when the body had the expected list shape (models[]
      // / data[]) — so a random 200-OK JSON service squatting on a probed port
      // can't impersonate an LLM backend, while a real-but-empty server still
      // shows. 'auth-error' (401/403) means a socket answered but refused without
      // a key — trust that only for servers we KNOW are key-gated (LiteLLM);
      // otherwise it's noise (e.g. macOS AirPlay on :5000 returns 403).
      const isHit = (outcome.status === 'live' && outcome.shaped === true) || (outcome.status === 'auth-error' && c.needsKey === true);
      if (!isHit) return null;
      return {
        id: c.id,
        name: c.name,
        kind: c.kind,
        baseUrl: c.baseUrl,
        port: c.port,
        status: outcome.status,
        models: outcome.models.map((m) => m.id),
        modelCount: outcome.models.length,
        needsKey: c.needsKey,
        sharesPortWith: c.sharesPortWith,
      };
    }),
  );

  return results.filter((x): x is DiscoveredServer => x != null);
}
