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

const cmd = process.argv[2] || 'capabilities';
try {
  if (cmd === 'capabilities') safeJson(capabilities());
  else if (cmd === 'store') safeJson(storeRecord(parseInput(process.argv[3])));
  else if (cmd === 'resolve') safeJson(resolveRecord(parseInput(process.argv[3])));
  else if (cmd === 'smoke') await smoke();
  else {
    safeJson({ ok: false, error: 'unknown_command', command: cmd });
    process.exitCode = 2;
  }
} catch (err) {
  safeJson({ ok: false, error: err instanceof Error ? err.message : String(err) });
  process.exitCode = 1;
}
