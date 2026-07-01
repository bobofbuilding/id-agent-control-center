import assert from 'node:assert/strict';
import { offerableRuntimes } from './runtimeCatalog.ts';

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
  { runtime: 'gemini', installed: false, loggedIn: false, statusSupported: false },
  { runtime: 'claude-code-cli', installed: true, loggedIn: true, statusSupported: true },
];

assert.deepEqual(
  offerableRuntimes(providers, undefined, managed),
  ['codex', 'grok', 'claude-code-cli', 'claude-code-local', 'claude-agent-sdk', 'ollama'],
  'runtime pickers should list only Settings-proven runtimes, not the whole catalog',
);

assert.deepEqual(
  offerableRuntimes([], 'cursor-cli', []),
  ['cursor-cli'],
  'current assigned runtimes should remain visible even when no longer newly available',
);

console.log('[runtimeCatalog.test] OK');
