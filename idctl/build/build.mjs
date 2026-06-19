#!/usr/bin/env bun
/**
 * Cross-compile idctl into standalone, dependency-free binaries with bun.
 *
 * idctl's runtime graph is pure ESM JS + one inline-base64 WASM (yoga-layout);
 * no native .node addons. ink and yoga use top-level await, so the bundle MUST
 * be ESM — which is exactly what `bun build --compile` produces, and bun can
 * cross-compile every target from a single host.
 *
 * react-devtools-core (ink's optional dev-only import) is resolved to the local
 * no-op stub via the `file:` dependency in package.json, so no bundler plugin
 * or --external flag is needed (the --external form crashes at runtime).
 *
 * Usage:
 *   bun build/build.mjs                 # build all POSIX targets
 *   bun build/build.mjs darwin-arm64    # build only matching targets (substring)
 */
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ENTRY = resolve(ROOT, 'src/cli.tsx');
const OUT = resolve(ROOT, 'dist');
mkdirSync(OUT, { recursive: true });

// Embed the package.json version into src/version.ts before compiling, so the
// binary knows its own version for self-update checks.
spawnSync('node', [resolve(ROOT, 'build/gen-version.mjs')], { stdio: 'inherit', cwd: ROOT });

const ALL = [
  { target: 'bun-darwin-arm64', out: 'idctl-darwin-arm64' },
  { target: 'bun-darwin-x64', out: 'idctl-darwin-x64' },
  { target: 'bun-linux-x64', out: 'idctl-linux-x64' },
  { target: 'bun-linux-x64-baseline', out: 'idctl-linux-x64-baseline' }, // pre-AVX2 CPUs
  { target: 'bun-linux-arm64', out: 'idctl-linux-arm64' },
  { target: 'bun-linux-x64-musl', out: 'idctl-linux-x64-musl' }, // Alpine
  { target: 'bun-linux-arm64-musl', out: 'idctl-linux-arm64-musl' },
];

const filter = process.argv.slice(2);
const targets = filter.length
  ? ALL.filter((t) => filter.some((f) => t.target.includes(f) || t.out.includes(f)))
  : ALL;

if (targets.length === 0) {
  console.error(`no targets match ${JSON.stringify(filter)}. Available:\n  ${ALL.map((t) => t.target).join('\n  ')}`);
  process.exit(1);
}

let failed = 0;
for (const { target, out } of targets) {
  const outfile = resolve(OUT, out);
  process.stdout.write(`→ ${target} → dist/${out}\n`);
  const r = spawnSync(
    'bun',
    ['build', ENTRY, '--compile', '--minify', '--sourcemap', `--target=${target}`, `--outfile=${outfile}`],
    { stdio: 'inherit', cwd: ROOT },
  );
  if (r.status !== 0) {
    console.error(`✗ ${target} failed (exit ${r.status})`);
    failed++;
  }
}

if (failed) {
  console.error(`\n${targets.length - failed}/${targets.length} targets built`);
  process.exit(1);
}
console.log(`\n✓ ${targets.length} binaries in dist/`);
console.log('Next: codesign darwin binaries, then `cd dist && shasum -a 256 idctl-* > SHASUMS256.txt`');
