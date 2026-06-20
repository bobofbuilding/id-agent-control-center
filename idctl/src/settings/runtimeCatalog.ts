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

/**
 * Capabilities an agent's runtime may or may not be able to consume. Attaching
 * a capability to an agent whose runtime can't use it is a silent dead-end (the
 * manager serializes it but the harness ignores it), so the UI gates on this.
 */
export type RuntimeCapability = 'mcp' | 'plugins' | 'skills';

/**
 * Which runtimes can actually USE each capability.
 *
 * MCP — hard runtime feature: the Claude runtimes embed the SDK/CLI MCP client,
 * and codex received `-c mcp_servers.*` config injection (2026-06). ollama has no
 * tool-calling loop yet (docs/LOCAL_MODEL_TOOL_CALLING_PLAN.md); cursor-cli and
 * the remote runtime don't consume our McpServerSpec either.
 *
 * skills — the manager deploys SKILL.md files to a runtime-aware dir for every
 * LOCAL runtime (`.claude/skills`, `.agents/skills` for codex/ollama,
 * `.cursor/skills`), so all local runtimes qualify; only the remote-endpoint
 * runtime (no workspace) is excluded. (getRuntimePaths in id-agents.)
 *
 * plugins — Claude Code plugin bundles; only the Claude-family runtimes load them.
 */
const RUNTIME_CAPABILITIES: Record<RuntimeCapability, string[]> = {
  mcp: ['claude-agent-sdk', 'claude-code-cli', 'claude-code-local', 'codex'],
  skills: ['claude-agent-sdk', 'claude-code-cli', 'claude-code-local', 'codex', 'cursor-cli', 'ollama'],
  plugins: ['claude-agent-sdk', 'claude-code-cli', 'claude-code-local'],
};

/** Short, user-facing reason a runtime can't use a capability (for tooltips). */
const CAPABILITY_DENY_REASON: Record<RuntimeCapability, string> = {
  mcp: 'This runtime has no MCP client. Claude and Codex runtimes can use MCP servers; local models gain MCP once the tool-calling loop ships.',
  skills: 'Skills deploy into a local agent workspace — a remote-endpoint runtime has none.',
  plugins: 'Plugins load only on the Claude-family runtimes (Claude Code plugin bundles).',
};

/** Does this runtime support the given capability? Unknown runtime → false. */
export function runtimeSupports(runtime: string | undefined, cap: RuntimeCapability): boolean {
  if (!runtime) return false;
  return RUNTIME_CAPABILITIES[cap]?.includes(runtime) ?? false;
}

/** Human-readable reason a runtime lacks a capability (empty if it has it). */
export function capabilityDenyReason(runtime: string | undefined, cap: RuntimeCapability): string {
  return runtimeSupports(runtime, cap) ? '' : CAPABILITY_DENY_REASON[cap];
}

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
 * Is this provider a LOCAL model server (its endpoint is on this machine)? The
 * ollama runtime's harness only reaches a local server (OLLAMA_BASE_URL →
 * 127.0.0.1), so a CLOUD openai-compatible aggregator (OpenRouter, Groq, …) must
 * NOT feed the ollama model picker — otherwise an operator can pick a model the
 * harness can't load and hit a runtime "model not found" at probe/run time.
 */
export function isLocalProvider(p: ProviderProfile): boolean {
  try {
    const host = new URL(p.baseUrl).hostname.toLowerCase();
    return host === '127.0.0.1' || host === 'localhost' || host === '0.0.0.0' || host === '::1' || host.endsWith('.local');
  } catch {
    return false;
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
      // The ollama runtime can only serve models from a LOCAL server — never let
      // a cloud openai-compatible provider's models into its picker.
      if (rt === 'ollama' && !isLocalProvider(p)) continue;
      cat[rt] = Array.from(new Set([...(cat[rt] ?? []), ...models]));
    }
  }
  return cat;
}
