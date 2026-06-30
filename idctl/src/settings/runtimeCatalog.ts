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
 *
 * "plugins" below means native Claude Code plugin bundles. IDACC-level portable
 * plugin packages use "portablePlugins" and must declare runtime adapters such
 * as SKILL.md, MCP, native plugin, or direct fallback instead of pretending one
 * native plugin loader works everywhere.
 */
export type RuntimeCapability = 'mcp' | 'plugins' | 'portablePlugins' | 'skills';

/**
 * Which runtimes can actually USE each capability.
 *
 * MCP — hard runtime feature: the Claude runtimes embed the SDK/CLI MCP client,
 * codex received `-c mcp_servers.*` config injection (2026-06), and ollama now
 * ships the agentic tool-calling loop (id-agents OllamaHarness.runWithTools +
 * McpToolHub) so local models with tool support can call MCP tools. A non-tool
 * ollama model degrades gracefully to plain text. cursor-cli and the remote
 * runtime still don't consume our McpServerSpec.
 *
 * skills — the manager deploys SKILL.md files to a runtime-aware dir for every
 * LOCAL runtime (`.claude/skills`, `.agents/skills` for codex/ollama,
 * `.cursor/skills`), so all local runtimes qualify; only the remote-endpoint
 * runtime (no workspace) is excluded. (getRuntimePaths in id-agents.)
 *
 * plugins — Claude Code plugin bundles; only the Claude-family runtimes load them.
 *
 * portablePlugins — IDACC plugin packages that declare adapters. Every local
 * runtime can consume at least the instruction/fallback portion, while tool
 * adapters still gate independently through MCP or native plugin support.
 */
const RUNTIME_CAPABILITIES: Record<RuntimeCapability, string[]> = {
  mcp: ['claude-agent-sdk', 'claude-code-cli', 'claude-code-local', 'codex', 'ollama'],
  skills: ['claude-agent-sdk', 'claude-code-cli', 'claude-code-local', 'codex', 'cursor-cli', 'ollama'],
  plugins: ['claude-agent-sdk', 'claude-code-cli', 'claude-code-local'],
  portablePlugins: ['claude-agent-sdk', 'claude-code-cli', 'claude-code-local', 'codex', 'cursor-cli', 'ollama'],
};

/** Short, user-facing reason a runtime can't use a capability (for tooltips). */
const CAPABILITY_DENY_REASON: Record<RuntimeCapability, string> = {
  mcp: 'This runtime has no MCP client. Claude, Codex, and Ollama (local models with tool support) can use MCP servers — this runtime cannot.',
  skills: 'Skills deploy into a local agent workspace — a remote-endpoint runtime has none.',
  plugins: 'Plugins load only on the Claude-family runtimes (Claude Code plugin bundles).',
  portablePlugins: 'Portable plugin packages require a declared adapter for this runtime.',
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

/** Minimal provider shape needed to decide runtime availability. */
type ProviderForRuntime = { kind: string; enabled?: boolean; keySource?: string; lastSync?: { status?: string } };

/**
 * Is the Anthropic API backend usable — wired in (an enabled `anthropic`
 * provider), key found (resolved from config or env), AND a live connect/sync?
 * The `claude-agent-sdk` runtime is the only one that calls the metered Anthropic
 * API (it needs `ANTHROPIC_API_KEY`), so the picker gates it on this. The other
 * claude-* runtimes use the CLI subscription and don't need a provider.
 */
export function anthropicApiReady(providers: ProviderForRuntime[]): boolean {
  return providers.some(
    (p) =>
      p.kind === 'anthropic' &&
      p.enabled !== false &&
      (p.keySource === 'config' || p.keySource === 'env') &&
      p.lastSync?.status === 'live',
  );
}

/**
 * Runtimes to offer in the runtime picker given the configured providers. Today
 * the only conditional one is `claude-agent-sdk`, withheld until
 * anthropicApiReady(). Pass `keep` to always retain an agent's CURRENT runtime
 * even if it just became ineligible (so an existing SDK agent isn't broken).
 */
export function offerableRuntimes(providers: ProviderForRuntime[], keep?: string): string[] {
  const sdkOk = anthropicApiReady(providers);
  return RUNTIMES.filter((r) => r !== 'claude-agent-sdk' || sdkOk || r === keep);
}

/**
 * Reasoning-effort options PER RUNTIME. Only the subscription runtimes that read
 * ID_AGENT_EFFORT honor this, and each accepts a different scale:
 *   codex (`-c model_reasoning_effort`) → minimal | low | medium | high  (its ceiling is
 *      high; the harness maps a requested xhigh back down to high, so we don't offer it)
 *   claude-code-cli / -local (`--effort`) → low | medium | high | xhigh  (the harness maps
 *      minimal → low, so we start the scale at low)
 * Every other runtime (ollama, cursor-cli, claude-agent-sdk, remote) has no effort knob → [].
 * Passing an out-of-range value is SAFE — both harnesses validate against their own regex and
 * silently ignore anything else — but offering the runtime's real scale keeps the UI honest.
 */
export const RUNTIME_EFFORTS: Record<string, string[]> = {
  codex: ['minimal', 'low', 'medium', 'high'],
  'claude-code-cli': ['low', 'medium', 'high', 'xhigh'],
  'claude-code-local': ['low', 'medium', 'high', 'xhigh'],
};

/** The effort scale this runtime honors (empty if it has no reasoning-effort knob). */
export function effortOptions(runtime?: string): string[] {
  return RUNTIME_EFFORTS[runtime ?? ''] ?? [];
}

/** Does this runtime have a reasoning-effort knob at all? */
export function runtimeHasEffort(runtime?: string): boolean {
  return effortOptions(runtime).length > 0;
}

/**
 * Output speed options per runtime. Claude Code's interactive `/fast` toggle is
 * exposed in the UI for Claude Code runtimes only; other runtimes have no speed
 * knob.
 */
export const RUNTIME_SPEEDS: Record<string, string[]> = {
  'claude-code-cli': ['default', 'fast'],
  'claude-code-local': ['default', 'fast'],
};

/** The speed scale this runtime honors (empty if it has no speed knob). */
export function speedOptions(runtime?: string): string[] {
  return RUNTIME_SPEEDS[runtime ?? ''] ?? [];
}

/** Does this runtime have an output-speed knob at all? */
export function runtimeHasSpeed(runtime?: string): boolean {
  return speedOptions(runtime).length > 0;
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
