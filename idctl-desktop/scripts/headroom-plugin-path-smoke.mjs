import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { headroomPluginPathAudit } from '../src/main/headroomPlugin.ts';

const pluginDir = join(process.cwd(), 'resources', 'idacc-context-retrieval');
const manifest = JSON.parse(readFileSync(join(pluginDir, 'plugin.json'), 'utf8'));
assert.equal(manifest.name, 'idacc-context-retrieval');
assert.equal(manifest.entrypoint, 'SKILL.md');

const smokeText = execFileSync(process.execPath, [join(pluginDir, 'tools', 'contract.mjs'), 'smoke'], { encoding: 'utf8' });
const smoke = JSON.parse(smokeText);
assert.equal(smoke.ok, true);
assert.equal(smoke.capabilities.resolve, true);
assert.equal(smoke.capabilities.sourceHashVerification, true);
assert.equal(smoke.protectedRejected, true);
assert.ok(!smokeText.includes('Authorization: Bearer'), 'plugin smoke output must not include protected text');
assert.ok(!smokeText.includes('aaaaaaaaaaaaaaaa'), 'plugin smoke output must not include token-like values');

const audit = await headroomPluginPathAudit({
  managerCapabilities: {
    cc_api_version: 1,
    features: ['observability', 'agent-config', 'team-config', 'library'],
    routes: [{ method: 'GET', path: '/capabilities', group: 'core' }],
  },
  managerPlugins: [],
  headroomStatus: {
    cli: { found: false, error: 'fixture: not installed' },
    proxy: { url: 'http://127.0.0.1:8787/mcp', reachable: false, error: 'fixture: unavailable' },
  },
});
assert.equal(audit.coreReady, false, 'plugin path should not declare core ready by itself');
assert.equal(audit.pilotReady, true, 'bundled plugin + capabilities route should be enough for a validation pilot');
assert.equal(audit.candidate.bundled, true);
assert.equal(audit.candidate.manifestOk, true);
assert.equal(audit.candidate.skillOk, true);
assert.equal(audit.candidate.toolOk, true);
assert.equal(audit.candidate.smokeOk, true);
assert.equal(audit.manager.retrievalFeatureAdvertised, false);
assert.ok(audit.runtimeCoverage.pluginOnlyWouldExclude.includes('codex'));
assert.ok(audit.runtimeCoverage.pluginOnlyWouldExclude.includes('ollama'));
assert.ok(audit.guardrails.some((line) => /Plugin-only routing is not core-eligible/.test(line)));
assert.ok(audit.blockers.some((line) => /does not advertise a context-retrieval contract/.test(line)));

const advertised = await headroomPluginPathAudit({
  managerCapabilities: {
    cc_api_version: 1,
    features: ['context-retrieval'],
    routes: [{ method: 'GET', path: '/capabilities', group: 'core' }],
  },
  managerPlugins: [{ name: 'idacc-context-retrieval', hasManifest: true, source_path: pluginDir }],
  headroomStatus: {
    cli: { found: true, version: 'fixture' },
    proxy: { url: 'http://127.0.0.1:8787/mcp', reachable: true, httpStatus: 200 },
  },
});
assert.equal(advertised.manager.retrievalFeatureAdvertised, true);
assert.equal(advertised.manager.pluginListed, true);
assert.equal(advertised.headroom.cliFound, true);
assert.equal(advertised.modeMatrix.find((row) => row.mode === 'manager-retrieval-contract')?.coreEligible, true);
assert.equal(advertised.modeMatrix.find((row) => row.mode === 'headroom-mcp')?.coreEligible, true);

console.log('HEADROOM_PLUGIN_PATH_SMOKE', JSON.stringify({
  candidate: audit.candidate,
  pilotReady: audit.pilotReady,
  coreReady: audit.coreReady,
  pluginRuntimes: audit.runtimeCoverage.pluginRuntimes,
  mcpRuntimes: audit.runtimeCoverage.mcpRuntimes,
  pluginOnlyWouldExclude: audit.runtimeCoverage.pluginOnlyWouldExclude,
  advertisedCoreEligible: advertised.modeMatrix.find((row) => row.mode === 'manager-retrieval-contract')?.coreEligible,
}, null, 2));
