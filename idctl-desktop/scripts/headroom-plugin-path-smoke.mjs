import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { headroomPluginPathAudit } from '../src/main/headroomPlugin.ts';

const pluginDir = join(process.cwd(), 'resources', 'idacc-context-retrieval');
const manifest = JSON.parse(readFileSync(join(pluginDir, 'plugin.json'), 'utf8'));
assert.equal(manifest.name, 'idacc-context-retrieval');
assert.equal(manifest.entrypoint, 'SKILL.md');
assert.equal(manifest.idaccPortablePlugin?.neutral, true);
assert.ok(manifest.idaccPortablePlugin.adapters.skill.runtimes.includes('cursor-cli'));
assert.ok(manifest.idaccPortablePlugin.adapters.skill.runtimes.includes('grok'));
assert.ok(manifest.idaccPortablePlugin.adapters.mcp.runtimes.includes('codex'));
assert.ok(manifest.idaccPortablePlugin.adapters.mcp.runtimes.includes('gemini'));
assert.ok(manifest.idaccPortablePlugin.adapters.nativePlugin.runtimes.includes('claude-code-cli'));
assert.ok(manifest.idaccPortablePlugin.adapters.directFallback.runtimes.includes('ollama'));
assert.ok(manifest.idaccPortablePlugin.adapters.directFallback.runtimes.includes('kiro-cli'));

const smokeText = execFileSync(process.execPath, [join(pluginDir, 'tools', 'contract.mjs'), 'smoke'], { encoding: 'utf8' });
const smoke = JSON.parse(smokeText);
assert.equal(smoke.ok, true);
assert.equal(smoke.capabilities.resolve, true);
assert.equal(smoke.capabilities.sourceHashVerification, true);
assert.equal(smoke.protectedRejected, true);
assert.ok(!smokeText.includes('Authorization: Bearer'), 'plugin smoke output must not include protected text');
assert.ok(!smokeText.includes('aaaaaaaaaaaaaaaa'), 'plugin smoke output must not include token-like values');

const mcpSmoke = await smokeMcpResolver(pluginDir);
assert.ok(mcpSmoke.toolNames.includes('idacc_context_capabilities'));
assert.ok(mcpSmoke.toolNames.includes('idacc_context_store'));
assert.ok(mcpSmoke.toolNames.includes('idacc_context_resolve'));
assert.equal(mcpSmoke.capabilities.ok, true);
assert.equal(mcpSmoke.capabilities.supports.resolve, true);
assert.equal(mcpSmoke.stored.ok, true);
assert.equal(mcpSmoke.resolved.ok, true);
assert.equal(mcpSmoke.resolved.sourceHash, mcpSmoke.stored.handle.sourceHash);
assert.equal(mcpSmoke.protectedResult.isError, true);
assert.ok(!mcpSmoke.rawOutput.includes('Authorization: Bearer'), 'MCP smoke output must not include protected text');
assert.ok(!mcpSmoke.rawOutput.includes('bbbbbbbbbbbbbbbb'), 'MCP smoke output must not include token-like values');

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
assert.equal(audit.candidate.mcpOk, true);
assert.equal(audit.candidate.portableOk, true);
assert.deepEqual(audit.candidate.adapterCoverage.unsupportedRuntimes, []);
assert.equal(audit.manager.retrievalFeatureAdvertised, false);
assert.ok(audit.runtimeCoverage.portablePluginRuntimes.includes('cursor-cli'));
assert.ok(audit.runtimeCoverage.portablePluginRuntimes.includes('copilot'));
assert.ok(audit.runtimeCoverage.pluginOnlyWouldExclude.includes('codex'));
assert.ok(audit.runtimeCoverage.pluginOnlyWouldExclude.includes('grok'));
assert.ok(audit.runtimeCoverage.pluginOnlyWouldExclude.includes('ollama'));
assert.ok(audit.guardrails.some((line) => /Plugin-only routing is not core-eligible/.test(line)));
assert.ok(audit.guardrails.some((line) => /IDACC plugins are runtime-neutral only as portable packages/.test(line)));
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
assert.equal(advertised.modeMatrix.find((row) => row.mode === 'idacc-context-retrieval-mcp')?.coreEligible, true);
assert.equal(advertised.modeMatrix.find((row) => row.mode === 'idacc-portable-plugin-package')?.coreEligible, true);

console.log('HEADROOM_PLUGIN_PATH_SMOKE', JSON.stringify({
  candidate: audit.candidate,
  pilotReady: audit.pilotReady,
  coreReady: audit.coreReady,
  pluginRuntimes: audit.runtimeCoverage.pluginRuntimes,
  portablePluginRuntimes: audit.runtimeCoverage.portablePluginRuntimes,
  mcpRuntimes: audit.runtimeCoverage.mcpRuntimes,
  pluginOnlyWouldExclude: audit.runtimeCoverage.pluginOnlyWouldExclude,
  mcpToolNames: mcpSmoke.toolNames,
  advertisedCoreEligible: advertised.modeMatrix.find((row) => row.mode === 'manager-retrieval-contract')?.coreEligible,
}, null, 2));

async function smokeMcpResolver(dir) {
  const storeDir = join(tmpdir(), `idacc-context-retrieval-mcp-smoke-${process.pid}-${Date.now()}`);
  const child = spawn(process.execPath, [join(dir, 'tools', 'contract.mjs'), 'mcp'], {
    env: { ...process.env, IDACC_CONTEXT_RETRIEVAL_STORE: storeDir },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const headerBreak = Buffer.from('\r\n\r\n');
  let stdoutBuffer = Buffer.alloc(0);
  let rawOutput = '';
  let exited = false;
  let nextId = 1;
  const pending = new Map();

  child.once('exit', (code, signal) => {
    exited = true;
    for (const [id, waiter] of pending.entries()) {
      clearTimeout(waiter.timer);
      waiter.reject(new Error(`MCP resolver exited before response ${id}: ${code ?? signal ?? 'unknown'}`));
    }
    pending.clear();
  });
  child.stdout.on('data', (chunk) => {
    stdoutBuffer = Buffer.concat([stdoutBuffer, chunk]);
    rawOutput += chunk.toString('utf8');
    consumeFrames();
  });
  child.stderr.on('data', (chunk) => {
    rawOutput += chunk.toString('utf8');
  });

  function consumeFrames() {
    while (stdoutBuffer.length) {
      const headerEnd = stdoutBuffer.indexOf(headerBreak);
      if (headerEnd < 0) return;
      const header = stdoutBuffer.subarray(0, headerEnd).toString('utf8');
      const match = /content-length:\s*(\d+)/i.exec(header);
      assert.ok(match, `missing MCP content-length header: ${header}`);
      const bodyStart = headerEnd + headerBreak.length;
      const bodyLength = Number(match[1]);
      if (stdoutBuffer.length < bodyStart + bodyLength) return;
      const body = stdoutBuffer.subarray(bodyStart, bodyStart + bodyLength).toString('utf8');
      stdoutBuffer = stdoutBuffer.subarray(bodyStart + bodyLength);
      const message = JSON.parse(body);
      const waiter = pending.get(message.id);
      if (!waiter) continue;
      pending.delete(message.id);
      clearTimeout(waiter.timer);
      if (message.error) waiter.reject(new Error(message.error.message || 'MCP error'));
      else waiter.resolve(message.result);
    }
  }

  function writeMessage(message) {
    const body = JSON.stringify(message);
    child.stdin.write(`Content-Length: ${Buffer.byteLength(body, 'utf8')}\r\n\r\n${body}`);
  }

  function call(method, params = {}) {
    const id = nextId++;
    const message = { jsonrpc: '2.0', id, method, params };
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`MCP call timed out: ${method}`));
      }, 3000);
      pending.set(id, { resolve, reject, timer });
      writeMessage(message);
    });
  }

  function notify(method, params = {}) {
    writeMessage({ jsonrpc: '2.0', method, params });
  }

  function parseTool(result) {
    assert.equal(result.content?.[0]?.type, 'text');
    return JSON.parse(result.content[0].text);
  }

  try {
    const initialized = await call('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'idacc-smoke', version: '0.0.0' },
    });
    assert.equal(initialized.serverInfo.name, 'idacc-context-retrieval');
    notify('notifications/initialized');
    const listed = await call('tools/list');
    const toolNames = listed.tools.map((tool) => tool.name);
    const capabilitiesResult = parseTool(await call('tools/call', { name: 'idacc_context_capabilities', arguments: {} }));
    const stored = parseTool(
      await call('tools/call', {
        name: 'idacc_context_store',
        arguments: { content: `Objective: MCP retrieval smoke.\n\n${'background context '.repeat(150)}`, ttlMs: 60_000 },
      }),
    );
    const resolved = parseTool(await call('tools/call', { name: 'idacc_context_resolve', arguments: stored.handle }));
    const protectedResult = await call('tools/call', {
      name: 'idacc_context_store',
      arguments: { content: `Authorization: Bearer ${'b'.repeat(32)}` },
    });
    return {
      toolNames,
      capabilities: capabilitiesResult,
      stored,
      resolved,
      protectedResult,
      rawOutput,
    };
  } finally {
    if (!exited) {
      child.stdin.end();
      child.kill();
      await new Promise((resolve) => child.once('exit', resolve));
    }
    rmSync(storeDir, { recursive: true, force: true });
  }
}
