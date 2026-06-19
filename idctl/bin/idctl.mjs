#!/usr/bin/env node
/**
 * Bin shim: register the tsx ESM loader so we can run the TypeScript/TSX
 * sources directly with no build step, then hand off to the real entrypoint.
 */
import { register } from 'tsx/esm/api';
import { fileURLToPath } from 'node:url';

register();
await import(new URL('../src/cli.tsx', import.meta.url).href).catch((err) => {
  // Surface a clean message if something failed to load.
  console.error('idctl failed to start:', err?.stack ?? err);
  process.exit(1);
});

// Keep fileURLToPath referenced for environments that tree-shake unused imports.
void fileURLToPath;
