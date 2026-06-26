#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const pkgPath = join(root, 'idctl-desktop', 'package.json');
const wikiPath = join(root, 'docs', 'CONTROL_CENTER_WIKI.json');

const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
const wiki = JSON.parse(readFileSync(wikiPath, 'utf8'));
const problems = [];

if (wiki.appVersion !== pkg.version) {
  problems.push(`wiki appVersion ${wiki.appVersion ?? '(missing)'} does not match idctl-desktop/package.json ${pkg.version}`);
}

if (!/^\d{4}-\d{2}-\d{2}$/.test(String(wiki.updated ?? ''))) {
  problems.push(`wiki updated marker must be YYYY-MM-DD, got ${wiki.updated ?? '(missing)'}`);
}

if (!Array.isArray(wiki.pages) || wiki.pages.some((page) => typeof page.body !== 'string' || !page.body.trim())) {
  problems.push('every wiki page must have a non-empty markdown body field');
}

if (problems.length) {
  console.error('Wiki drift check failed:');
  for (const problem of problems) console.error(`- ${problem}`);
  process.exit(1);
}

console.log(`Wiki drift check passed: appVersion ${wiki.appVersion}, updated ${wiki.updated}`);
