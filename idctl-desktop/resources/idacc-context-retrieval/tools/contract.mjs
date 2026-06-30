#!/usr/bin/env node
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';

const VERSION = 1;
const MAX_BYTES = 2_000_000;
const HANDLE_RE = /^ctx_[a-zA-Z0-9_-]{12,80}$/;
const PROTECTED = [
  /\b(api[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret|authorization\s*:|bearer\s+[a-z0-9._-]{16,}|password\s*[=:]|passwd\s*[=:]|private[_ -]?key|secret[_-]?key|-----BEGIN\s+(?:RSA|OPENSSH|EC|PRIVATE)|sk-[a-z0-9_-]{16,}|gh[pousr]_[a-z0-9_]{16,}|github_pat_[a-z0-9_]{20,}|xox[baprs]-[a-z0-9-]{20,}|AKIA[0-9A-Z]{16}|AIza[0-9A-Za-z_-]{30,}|eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,})/i,
  /(?:\b(system prompt|developer message|agent instruction\s*-\s*coordination|coordination\s*&\s*behavior|instruction sidecar)\b|\.id-instructions\.md)/i,
  /(^|\n)(diff --git|@@\s|```(?:[a-z0-9_-]+)?\s*(?:import|export|function|class|const|let|var|def |package |use |fn |pragma |interface)|\+\+\+\s+b\/|---\s+a\/)/i,
  /\b(seed phrase|mnemonic|recovery phrase|session key|private wallet|controller signature|wallet private key|signing key)\b/i,
];

function sha256(text) {
  return createHash('sha256').update(String(text)).digest('hex');
}

function storeDir() {
  const raw = process.env.IDACC_CONTEXT_RETRIEVAL_STORE || join(tmpdir(), 'idacc-context-retrieval');
  const dir = resolve(raw);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

function fileFor(id) {
  if (!HANDLE_RE.test(String(id))) throw new Error('invalid handle id');
  return join(storeDir(), `${id}.json`);
}

function safeJson(value) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function jsonText(value) {
  return JSON.stringify(value);
}

function readStdin() {
  try {
    return readFileSync(0, 'utf8');
  } catch {
    return '';
  }
}

function parseInput(arg) {
  const raw = arg || readStdin();
  if (!raw.trim()) return {};
  try {
    return JSON.parse(raw);
  } catch {
    return { id: raw.trim() };
  }
}

function protectedContent(text) {
  return PROTECTED.some((pattern) => pattern.test(String(text || '')));
}

function storeRecord(input) {
  const content = String(input.content || '');
  if (!content.trim()) throw new Error('content required');
  const bytes = Buffer.byteLength(content, 'utf8');
  if (bytes > MAX_BYTES) throw new Error(`content too large (${bytes}/${MAX_BYTES} bytes)`);
  if (protectedContent(content)) throw new Error('protected content must stay direct');
  const ttlMs = Math.max(60_000, Math.min(24 * 60 * 60_000, Number(input.ttlMs) || 30 * 60_000));
  const id = `ctx_${randomUUID().replace(/-/g, '')}`;
  const now = Date.now();
  const record = {
    version: VERSION,
    id,
    createdAt: now,
    expiresAt: now + ttlMs,
    sourceHash: sha256(content),
    content,
  };
  const file = fileFor(id);
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(record, null, 2) + '\n', { mode: 0o600 });
  renameSync(tmp, file);
  return {
    ok: true,
    handle: {
      id,
      uri: `idacc-context://${id}`,
      sourceHash: record.sourceHash,
      expiresAt: record.expiresAt,
      contractVersion: VERSION,
    },
  };
}

function normalizeHandle(input) {
  const raw = typeof input === 'string' ? { id: input } : input || {};
  const uri = typeof raw.uri === 'string' ? raw.uri : '';
  const id = String(raw.id || uri.replace(/^idacc-context:\/\//, '') || '').trim();
  if (!HANDLE_RE.test(id)) throw new Error('invalid handle id');
  return {
    id,
    sourceHash: typeof raw.sourceHash === 'string' ? raw.sourceHash : undefined,
  };
}

function resolveRecord(input) {
  const handle = normalizeHandle(input);
  const file = fileFor(handle.id);
  if (!existsSync(file)) return { ok: false, error: 'not_found', id: handle.id };
  const record = JSON.parse(readFileSync(file, 'utf8'));
  if (record.version !== VERSION || record.id !== handle.id) return { ok: false, error: 'invalid_record', id: handle.id };
  if (Date.now() > Number(record.expiresAt || 0)) return { ok: false, error: 'expired', id: handle.id };
  const content = String(record.content || '');
  const actualHash = sha256(content);
  if (actualHash !== record.sourceHash) return { ok: false, error: 'stored_hash_mismatch', id: handle.id };
  if (handle.sourceHash && handle.sourceHash !== actualHash) return { ok: false, error: 'handle_hash_mismatch', id: handle.id };
  return {
    ok: true,
    id: handle.id,
    sourceHash: actualHash,
    expiresAt: Number(record.expiresAt),
    content,
  };
}

function capabilities() {
  return {
    ok: true,
    name: 'idacc-context-retrieval',
    contractVersion: VERSION,
    handleScheme: 'idacc-context://',
    supports: {
      store: true,
      resolve: true,
      expiry: true,
      sourceHashVerification: true,
      protectedContentReject: true,
      listHandles: false,
      mutateMemory: false,
      mutateTasks: false,
      mutateRouting: false,
    },
  };
}

const MCP_TOOLS = [
  {
    name: 'idacc_context_capabilities',
    description: 'Report IDACC context retrieval handle capabilities and guardrails.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {},
    },
  },
  {
    name: 'idacc_context_store',
    description: 'Store non-protected context behind an expiring idacc-context:// retrieval handle.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['content'],
      properties: {
        content: { type: 'string' },
        ttlMs: { type: 'number', minimum: 60000, maximum: 86400000 },
      },
    },
  },
  {
    name: 'idacc_context_resolve',
    description: 'Resolve an idacc-context:// handle and verify id shape, expiry, and source hash.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        id: { type: 'string' },
        uri: { type: 'string' },
        sourceHash: { type: 'string' },
      },
    },
  },
];

function toolCallResult(value, isError = false) {
  return {
    content: [{ type: 'text', text: jsonText(value) }],
    ...(isError ? { isError: true } : {}),
  };
}

function writeRpc(payload) {
  const body = jsonText(payload);
  process.stdout.write(`Content-Length: ${Buffer.byteLength(body, 'utf8')}\r\n\r\n${body}`);
}

function rpcResult(id, result) {
  if (id === undefined || id === null) return;
  writeRpc({ jsonrpc: '2.0', id, result });
}

function rpcError(id, code, message) {
  if (id === undefined || id === null) return;
  writeRpc({ jsonrpc: '2.0', id, error: { code, message } });
}

function callMcpTool(name, args) {
  try {
    if (name === 'idacc_context_capabilities') return toolCallResult(capabilities());
    if (name === 'idacc_context_store') return toolCallResult(storeRecord(args || {}));
    if (name === 'idacc_context_resolve') return toolCallResult(resolveRecord(args || {}));
    return toolCallResult({ ok: false, error: 'unknown_tool', tool: name }, true);
  } catch (err) {
    return toolCallResult({ ok: false, error: err instanceof Error ? err.message : String(err) }, true);
  }
}

function handleRpcMessage(message) {
  const id = message?.id;
  const method = String(message?.method || '');
  if (!method) {
    rpcError(id, -32600, 'invalid request');
    return;
  }
  if (method === 'initialize') {
    rpcResult(id, {
      protocolVersion: message?.params?.protocolVersion || '2024-11-05',
      capabilities: { tools: {} },
      serverInfo: { name: CANDIDATE_NAME, version: '0.1.0' },
    });
    return;
  }
  if (method === 'notifications/initialized') return;
  if (method === 'tools/list') {
    rpcResult(id, { tools: MCP_TOOLS });
    return;
  }
  if (method === 'tools/call') {
    const params = message?.params || {};
    rpcResult(id, callMcpTool(String(params.name || ''), params.arguments || params.args || {}));
    return;
  }
  rpcError(id, -32601, `method not found: ${method}`);
}

function runMcp() {
  let buffer = Buffer.alloc(0);
  const headerBreak = Buffer.from('\r\n\r\n');
  process.stdin.on('data', (chunk) => {
    buffer = Buffer.concat([buffer, Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)]);
    while (buffer.length) {
      const headerEnd = buffer.indexOf(headerBreak);
      if (headerEnd >= 0) {
        const header = buffer.subarray(0, headerEnd).toString('utf8');
        const match = /content-length:\s*(\d+)/i.exec(header);
        if (!match) {
          rpcError(null, -32700, 'missing content-length');
          buffer = Buffer.alloc(0);
          return;
        }
        const length = Number(match[1]);
        const bodyStart = headerEnd + headerBreak.length;
        if (buffer.length < bodyStart + length) return;
        const body = buffer.subarray(bodyStart, bodyStart + length).toString('utf8');
        buffer = buffer.subarray(bodyStart + length);
        try {
          handleRpcMessage(JSON.parse(body));
        } catch {
          rpcError(null, -32700, 'parse error');
        }
        continue;
      }

      const asText = buffer.toString('utf8');
      if (/^content-length:/i.test(asText)) return;
      const newline = asText.indexOf('\n');
      if (newline < 0) return;
      const line = asText.slice(0, newline).trim();
      buffer = Buffer.from(asText.slice(newline + 1));
      if (!line) continue;
      try {
        handleRpcMessage(JSON.parse(line));
      } catch {
        rpcError(null, -32700, 'parse error');
      }
    }
  });
  process.stdin.resume();
}

async function smoke() {
  const root = join(tmpdir(), `idacc-context-retrieval-smoke-${process.pid}-${Date.now()}`);
  process.env.IDACC_CONTEXT_RETRIEVAL_STORE = root;
  try {
    const stored = storeRecord({ content: `Objective: smoke test retrieval.\n\nraw content:\n${'background context '.repeat(300)}`, ttlMs: 60_000 });
    const resolved = resolveRecord(stored.handle);
    if (!resolved.ok) throw new Error(`resolve failed: ${resolved.error}`);
    if (resolved.sourceHash !== stored.handle.sourceHash) throw new Error('hash mismatch');
    let rejected = false;
    try {
      storeRecord({ content: `Authorization: Bearer ${'a'.repeat(32)}` });
    } catch {
      rejected = true;
    }
    if (!rejected) throw new Error('protected content was not rejected');
    safeJson({
      ok: true,
      capabilities: capabilities().supports,
      resolvedBytes: Buffer.byteLength(resolved.content, 'utf8'),
      protectedRejected: rejected,
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

const CANDIDATE_NAME = 'idacc-context-retrieval';
const cmd = process.argv[2] || 'capabilities';
try {
  if (cmd === 'capabilities') safeJson(capabilities());
  else if (cmd === 'store') safeJson(storeRecord(parseInput(process.argv[3])));
  else if (cmd === 'resolve') safeJson(resolveRecord(parseInput(process.argv[3])));
  else if (cmd === 'smoke') await smoke();
  else if (cmd === 'mcp') runMcp();
  else {
    safeJson({ ok: false, error: 'unknown_command', command: cmd });
    process.exitCode = 2;
  }
} catch (err) {
  safeJson({ ok: false, error: err instanceof Error ? err.message : String(err) });
  process.exitCode = 1;
}
