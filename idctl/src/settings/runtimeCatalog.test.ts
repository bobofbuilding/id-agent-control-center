import assert from 'node:assert/strict';
import { buildProviderModelLanes, offerableRuntimes } from './runtimeCatalog.ts';
import type { ProviderProfile } from './schema.ts';

const providers = [
  { kind: 'anthropic', enabled: true, keySource: 'config', needsKey: true, lastSync: { status: 'live', modelCount: 3 } },
  { kind: 'openai', enabled: true, keySource: 'none', needsKey: true, lastSync: { status: 'live', modelCount: 4 } },
  { kind: 'openai-compatible', baseUrl: 'https://integrate.api.nvidia.com/v1', enabled: true, keySource: 'config', needsKey: true, lastSync: { status: 'preset', modelCount: 5 } },
  { kind: 'ollama', baseUrl: 'http://127.0.0.1:11434', enabled: true, needsKey: false, lastSync: { status: 'live', modelCount: 2 } },
];

const managed = [
  { runtime: 'codex', installed: true, loggedIn: true, statusSupported: true },
  { runtime: 'cursor-cli', installed: true, loggedIn: false, statusSupported: true },
  { runtime: 'grok', installed: true, loggedIn: false, statusSupported: false },
  { runtime: 'gemini', installed: true, loggedIn: false, statusSupported: true },
  { runtime: 'claude-code-cli', installed: true, loggedIn: true, statusSupported: true },
];

assert.deepEqual(
  offerableRuntimes(providers, undefined, managed),
  ['codex', 'grok', 'claude-code-cli', 'claude-code-local', 'claude-agent-sdk', 'ollama'],
  'runtime pickers should list only Settings-proven runtimes, not the whole catalog or an installed-but-not-usable Gemini CLI',
);

const providerLanes = buildProviderModelLanes([
  { name: 'openrouter', kind: 'openai-compatible', baseUrl: 'https://openrouter.ai/api/v1', enabled: true, needsKey: true, lastSync: { at: 1, status: 'live', modelCount: 2, models: ['openai/gpt-5.4', 'anthropic/claude-sonnet-4.6'] } },
  { name: 'NVIDIABuild-Autogen-73', kind: 'openai-compatible', baseUrl: 'https://integrate.api.nvidia.com/v1', enabled: true, needsKey: true, lastSync: { at: 1, status: 'preset', modelCount: 1, models: ['qwen/qwen3.5-397b-a17b'] } },
] satisfies ProviderProfile[]);

assert.deepEqual(
  providerLanes.map((lane) => ({ id: lane.id, label: lane.label, kind: lane.kind, selectable: lane.selectable, count: lane.models.length })),
  [
    { id: 'provider:openrouter', label: 'API · openrouter', kind: 'api', selectable: false, count: 2 },
    { id: 'provider:NVIDIABuild-Autogen-73', label: 'API · NVIDIABuild-Autogen-73', kind: 'api', selectable: false, count: 1 },
  ],
  'API providers should remain visible as read-only model lanes without becoming manager harness runtimes',
);

assert.deepEqual(
  offerableRuntimes([], 'cursor-cli', []),
  ['cursor-cli'],
  'current assigned runtimes should remain visible even when no longer newly available',
);

assert.deepEqual(
  offerableRuntimes([], undefined, [{ runtime: 'gemini', installed: true, loggedIn: false, statusSupported: false }]),
  [],
  'Gemini CLI should not become assignable from binary presence alone',
);

assert.deepEqual(
  offerableRuntimes([], undefined, [{ runtime: 'antigravity', installed: true, loggedIn: false, statusSupported: false }]),
  [],
  'Antigravity CLI should not become assignable until the manager exposes an Antigravity harness',
);

console.log('[runtimeCatalog.test] OK');
