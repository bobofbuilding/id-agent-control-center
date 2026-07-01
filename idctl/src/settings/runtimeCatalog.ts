/**
 * Per-runtime model catalog. Each agent runtime (harness) draws its models
 * from a backing inference provider:
 *   ollama runtime            ← ollama / lmstudio / openai-compatible (local servers)
 *   claude-* runtimes         ← anthropic provider (GET /v1/models with a key)
 *   codex runtime             ← openai provider
 *   cursor-cli runtime        ← (no public model API) curated only
 *   grok/gemini/copilot/kiro/q ← managed CLI runtimes; CLI-owned auth/models
 *
 * When a backing provider is configured and has a synced model list, we use it
 * (that IS "probing the runtime"). Otherwise we fall back to a curated list of
 * the current known models so the dropdown is never empty.
 */

import type { ProviderKind, ProviderProfile } from './schema.ts';

/** Switchable/visible managed agent runtimes (remote runtime excluded). */
export const RUNTIMES = [
  'claude-agent-sdk',
  'claude-code-cli',
  'claude-code-local',
  'codex',
  'cursor-cli',
  'grok',
  'gemini',
  'copilot',
  'kiro-cli',
  'q',
  'ollama',
];

export type RuntimeModelLaneKind = 'subscription' | 'local' | 'api';
export type RuntimeModelLaneSource = 'provider' | 'none';

export interface RuntimeModelLane {
  /** Neutral provider/model lane id. Not a manager harness id. */
  id: string;
  label: string;
  kind: RuntimeModelLaneKind;
  provider: string;
  providerKind: ProviderKind;
  models: string[];
  source: RuntimeModelLaneSource;
  lastCheckedMs: number | null;
  /** False until the manager exposes a provider-runtime execution contract. */
  selectable: false;
  detail: string;
}

const RUNTIME_LABELS: Record<string, string> = {
  'claude-agent-sdk': 'Claude API',
  'claude-code-cli': 'Claude Code',
  'claude-code-local': 'Claude local',
  codex: 'Codex',
  'cursor-cli': 'Cursor',
  grok: 'Grok Build',
  gemini: 'Gemini CLI',
  copilot: 'GitHub Copilot',
  'kiro-cli': 'Kiro',
  q: 'Amazon Q',
  ollama: 'Ollama / local',
};

export function runtimeDisplayLabel(runtime: string): string {
  if (runtime.startsWith('provider:')) {
    try { return decodeURIComponent(runtime.slice('provider:'.length)); } catch { return runtime.slice('provider:'.length); }
  }
  return RUNTIME_LABELS[runtime] ?? runtime.replace('claude-code-', 'claude-').replace('claude-agent-sdk', 'claude-sdk').replace('-cli', '');
}

/**
 * Native capability support an agent runtime may or may not be able to consume
 * directly. Capabilities assignment in IDACC is broader than this table: the
 * Capabilities page can attach MCP metadata, skills, and portable plugin package
 * state to any local/API/subscription runtime, then surfaces whether the current
 * runtime has a native adapter, MCP/tool surface, Skill/workspace surface, or
 * direct fallback.
 *
 * "plugins" below means native Claude Code plugin bundles. IDACC-level portable
 * plugin packages use "portablePlugins" and must declare runtime adapters such
 * as SKILL.md, MCP, native plugin, or direct fallback instead of pretending one
 * native plugin loader works everywhere.
 */
export type RuntimeCapability = 'mcp' | 'plugins' | 'portablePlugins' | 'skills';

/**
 * Which runtimes can directly USE each native capability today. Do not use this
 * table as a blanket "can select target" gate for portable capabilities.
 *
 * MCP — hard runtime feature: the Claude runtimes embed the SDK/CLI MCP client,
 * codex received `-c mcp_servers.*` config injection (2026-06), and ollama now
 * ships the agentic tool-calling loop (id-agents OllamaHarness.runWithTools +
 * McpToolHub) so local models with tool support can call MCP tools. A non-tool
 * ollama model degrades gracefully to plain text. Grok Build, Gemini CLI,
 * GitHub Copilot CLI, Kiro CLI, and the legacy Amazon Q CLI are listed as
 * managed CLI runtimes with MCP-capable vendor surfaces, but manager execution
 * still depends on a matching harness/adapter. cursor-cli and the remote runtime
 * still don't consume our McpServerSpec.
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
  mcp: ['claude-agent-sdk', 'claude-code-cli', 'claude-code-local', 'codex', 'grok', 'gemini', 'copilot', 'kiro-cli', 'q', 'ollama'],
  skills: ['claude-agent-sdk', 'claude-code-cli', 'claude-code-local', 'codex', 'cursor-cli', 'grok', 'gemini', 'copilot', 'kiro-cli', 'q', 'ollama'],
  plugins: ['claude-agent-sdk', 'claude-code-cli', 'claude-code-local'],
  portablePlugins: ['claude-agent-sdk', 'claude-code-cli', 'claude-code-local', 'codex', 'cursor-cli', 'grok', 'gemini', 'copilot', 'kiro-cli', 'q', 'ollama'],
};

/** Short, user-facing reason a runtime can't use a capability (for tooltips). */
const CAPABILITY_DENY_REASON: Record<RuntimeCapability, string> = {
  mcp: 'This runtime has no native MCP client today; attach can still be stored as neutral metadata when a manager adapter, runtime change, or direct fallback is available.',
  skills: 'This runtime has no native skill workspace today; assignment can still be stored when a manager prompt-side adapter or direct fallback is available.',
  plugins: 'Native plugin loaders are runtime-specific; Claude Code plugin bundles load only on Claude-family runtimes.',
  portablePlugins: 'Portable plugin packages require a declared Skill, MCP, native, or fallback adapter for this runtime.',
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
 * Managed runtime ids to offer in runtime pickers. Provider availability is
 * surfaced separately through neutral model lanes so the picker stays open while
 * each runtime remains responsible for its own manager harness/adapter support.
 */
export function offerableRuntimes(_providers: ProviderForRuntime[], keep?: string): string[] {
  return Array.from(new Set([...(keep ? [keep] : []), ...RUNTIMES].filter(Boolean)));
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
  // These managed CLIs own model/account selection; keep fallback catalogs minimal.
  grok: ['default'],
  gemini: ['default'],
  copilot: ['default'],
  'kiro-cli': ['default'],
  q: ['default'],
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

export function providerModelLaneId(p: Pick<ProviderProfile, 'name'>): string {
  return `provider:${encodeURIComponent(p.name)}`;
}

export function providerModelLaneKind(p: ProviderProfile): RuntimeModelLaneKind {
  if (p.kind === 'anthropic' || p.kind === 'openai') return 'subscription';
  return isLocalProvider(p) ? 'local' : 'api';
}

export function providerModelLaneLabel(p: ProviderProfile): string {
  const kind = providerModelLaneKind(p);
  const prefix = kind === 'subscription' ? 'Subscription' : kind === 'local' ? 'Local' : 'API';
  return `${prefix} · ${p.name}`;
}

/**
 * Provider/model lanes are neutral catalog entries from Settings. They expose
 * every configured subscription, local, and API backend in Health/Fleet without
 * pretending the manager can execute a provider id directly as an agent harness.
 */
export function buildProviderModelLanes(providers: ProviderProfile[]): RuntimeModelLane[] {
  return providers
    .filter((p) => p.enabled !== false)
    .map((p) => {
      const models = p.lastSync?.models ?? [];
      const kind = providerModelLaneKind(p);
      const detail = kind === 'api'
        ? 'Configured API provider/model lane. Agent assignment needs a manager provider-runtime adapter before this can be selected as an execution harness.'
        : kind === 'local'
          ? 'Configured local provider/model lane. Agent assignment needs the manager harness to be pointed at this server before this can be selected directly.'
          : 'Configured subscription/API provider lane. Agent assignment uses the matching manager harness when available.';
      return {
        id: providerModelLaneId(p),
        label: providerModelLaneLabel(p),
        kind,
        provider: p.name,
        providerKind: p.kind,
        models,
        source: models.length ? 'provider' as const : 'none' as const,
        lastCheckedMs: p.lastSync?.at ?? null,
        selectable: false as const,
        detail,
      };
    });
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
