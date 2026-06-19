#!/usr/bin/env node
/** Bundle the Tauri frontend (shares the renderer; Tauri entry + adapter). */
import { build } from 'esbuild';
import { cpSync, mkdirSync, rmSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
rmSync(resolve(ROOT, 'dist-tauri'), { recursive: true, force: true });
mkdirSync(resolve(ROOT, 'dist-tauri'), { recursive: true });

await build({
  entryPoints: [resolve(ROOT, 'src/tauri/main.tsx')],
  outfile: resolve(ROOT, 'dist-tauri/renderer.js'),
  bundle: true,
  format: 'iife',
  platform: 'browser',
  target: 'safari16',
  jsx: 'automatic',
  sourcemap: true,
  loader: { '.ts': 'ts', '.tsx': 'tsx' },
  logLevel: 'info',
});

cpSync(resolve(ROOT, 'src/tauri/index.html'), resolve(ROOT, 'dist-tauri/index.html'));
console.log('built → dist-tauri/');
