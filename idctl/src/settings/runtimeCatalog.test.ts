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
  { runtime: 'gemini', installed: true, loggedIn: false, statusSupported: true },
  { runtime: 'claude-code-cli', installed: true, loggedIn: true, statusSupported: true },
];

assert.deepEqual(
  offerableRuntimes(providers, undefined, managed),
  ['codex', 'grok', 'claude-code-cli', 'claude-code-local', 'claude-agent-sdk', 'ollama'],
  'runtime pickers should list only Settings-proven runtimes, not the whole catalog or an installed-but-not-usable Gemini CLI',
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
