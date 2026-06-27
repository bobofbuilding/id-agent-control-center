#!/usr/bin/env node
import { existsSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const pkgPath = join(root, 'idctl-desktop', 'package.json');
const wikiPath = join(root, 'docs', 'CONTROL_CENTER_WIKI.json');

const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
const wiki = JSON.parse(readFileSync(wikiPath, 'utf8'));
const problems = [];

function changedFiles() {
  const files = new Set();
  const collect = (args) => {
    try {
      const out = execFileSync('git', args, { cwd: root, encoding: 'utf8' });
      for (const line of out.split(/\r?\n/).map((s) => s.trim()).filter(Boolean)) files.add(line);
    } catch {
      // Let the structural checks still run outside a git checkout.
    }
  };
  const base = process.env.IDCTL_WIKI_DRIFT_BASE;
  if (base) collect(['diff', '--name-only', `${base}...HEAD`]);
  collect(['diff', '--name-only', 'HEAD']);
  return files;
}

if (wiki.appVersion !== pkg.version) {
  problems.push(`wiki appVersion ${wiki.appVersion ?? '(missing)'} does not match idctl-desktop/package.json ${pkg.version}`);
}

if (!/^\d{4}-\d{2}-\d{2}$/.test(String(wiki.updated ?? ''))) {
  problems.push(`wiki updated marker must be YYYY-MM-DD, got ${wiki.updated ?? '(missing)'}`);
}

if (!Array.isArray(wiki.pages) || wiki.pages.some((page) => typeof page.body !== 'string' || !page.body.trim())) {
  problems.push('every wiki page must have a non-empty markdown body field');
}

if (Array.isArray(wiki.pages)) {
  const ids = new Set();
  const routes = new Set();
  const sourceToPages = new Map();

  for (const page of wiki.pages) {
    if (!page || typeof page !== 'object') continue;
    if (!page.id) problems.push('every wiki page must have an id');
    if (ids.has(page.id)) problems.push(`duplicate wiki page id ${page.id}`);
    ids.add(page.id);
    if (page.route) routes.add(page.route);
    if (!Array.isArray(page.sourceFiles) || !page.sourceFiles.length) {
      problems.push(`wiki page ${page.id ?? '(missing id)'} must list sourceFiles`);
      continue;
    }
    for (const file of page.sourceFiles) {
      if (typeof file !== 'string' || !file.trim()) {
        problems.push(`wiki page ${page.id} has an invalid sourceFiles entry`);
        continue;
      }
      if (!existsSync(join(root, file))) problems.push(`wiki page ${page.id} references missing source file ${file}`);
      sourceToPages.set(file, [...(sourceToPages.get(file) ?? []), page.id]);
    }
  }

  const requiredRoutes = ['dashboard', 'inbox', 'tasks', 'projects', 'health', 'identity', 'teams', 'modules', 'computer', 'settings', 'wiki'];
  for (const route of requiredRoutes) {
    if (!routes.has(route)) problems.push(`wiki is missing implemented route ${route}`);
  }

  const changed = changedFiles();
  const wikiChanged = changed.has('docs/CONTROL_CENTER_WIKI.json');
  const pageSourceChanges = [...changed].filter((file) => sourceToPages.has(file));
  if (pageSourceChanges.length && !wikiChanged) {
    const details = pageSourceChanges
      .map((file) => `${file} (${sourceToPages.get(file).join(', ')})`)
      .join('; ');
    problems.push(`page source changed without docs/CONTROL_CENTER_WIKI.json in the same worktree diff: ${details}`);
  }
}

if (problems.length) {
  console.error('Wiki drift check failed:');
  for (const problem of problems) console.error(`- ${problem}`);
  process.exit(1);
}

console.log(`Wiki drift check passed: appVersion ${wiki.appVersion}, updated ${wiki.updated}`);
