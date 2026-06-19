/**
 * Per-runtime model catalog. Each agent runtime (harness) draws its models
 * from a backing inference provider:
 *   ollama runtime            ← ollama / lmstudio / openai-compatible (local servers)
 *   claude-* runtimes         ← anthropic provider (GET /v1/models with a key)
 *   codex runtime             ← openai provider
 *   cursor-cli runtime        ← (no public model API) curated only
 *
 * When a backing provider is configured and has a synced model list, we use it
 * (that IS "probing the runtime"). Otherwise we fall back to a curated list of
 * the current known models so the dropdown is never empty.
 */

import type { ProviderKind, ProviderProfile } from './schema.ts';

/** Switchable agent runtimes (matches HarnessType minus the remote runtime). */
export const RUNTIMES = ['claude-agent-sdk', 'claude-code-cli', 'claude-code-local', 'codex', 'cursor-cli', 'ollama'];

/** Current known models per runtime, used when no probeable provider is configured. */
export const RUNTIME_CURATED: Record<string, string[]> = {
  'claude-agent-sdk': ['claude-opus-4-8', 'claude-sonnet-4-6', 'claude-haiku-4-5'],
  'claude-code-cli': ['claude-opus-4-8', 'claude-sonnet-4-6', 'claude-haiku-4-5'],
  'claude-code-local': ['claude-opus-4-8', 'claude-sonnet-4-6', 'claude-haiku-4-5'],
  // Fallback only — the bridge merges the live list from ~/.codex/models_cache.json.
  codex: ['gpt-5.5', 'gpt-5.4', 'gpt-5.4-mini', 'gpt-5.3-codex-spark', 'gpt-5.3-codex'],
  'cursor-cli': ['sonnet-4', 'composer-2'],
  ollama: [],
};

/** Which runtimes a given provider kind supplies models for. */
export function providerKindToRuntimes(kind: ProviderKind): string[] {
  switch (kind) {
    case 'ollama':
    case 'lmstudio':
    case 'openai-compatible':
      return ['ollama']; // local model servers feed the ollama runtime
    case 'anthropic':
      return ['claude-agent-sdk', 'claude-code-cli', 'claude-code-local'];
    case 'openai':
      return ['codex'];
    default:
      return [];
  }
}

/**
 * Build the per-runtime model catalog from the configured providers' cached
 * sync results, merged over the curated defaults. Only enabled providers that
 * have synced models contribute.
 */
export function buildRuntimeCatalog(providers: ProviderProfile[]): Record<string, string[]> {
  const cat: Record<string, string[]> = {};
  for (const rt of RUNTIMES) cat[rt] = [...(RUNTIME_CURATED[rt] ?? [])];

  for (const p of providers) {
    if (p.enabled === false) continue;
    const models = p.lastSync?.models ?? [];
    if (!models.length) continue;
    for (const rt of providerKindToRuntimes(p.kind)) {
      cat[rt] = Array.from(new Set([...(cat[rt] ?? []), ...models]));
    }
  }
  return cat;
}
