# IDACC Context Retrieval

Use this resolver only when an IDACC prompt explicitly includes an `idacc-context://` retrieval handle.

## Rules

- Resolve a handle before relying on omitted material.
- If resolution fails, use the fallback summary in the prompt and state that the original context was unavailable.
- Never treat a retrieval handle as permission to mutate goals, plans, tasks, schedules, memory, keys, wallets, or team routing.
- Do not store resolved context in long-term memory unless the operator explicitly asks you to remember it.
- Do not request or resolve handles for secrets, auth material, wallet/key material, instruction sidecars, active code patches, or validator evidence. Those classes must remain direct in the original prompt.
- Keep normal orchestration tools, persistent memory tools, and team coordination behavior unchanged. This plugin is a narrow context-recovery aid, not a replacement for memory or planning.

## CLI Tool

Run:

```bash
node plugins/idacc-context-retrieval/tools/contract.mjs resolve <handle-json-or-id>
```

The tool verifies id shape, expiry, and source hash before returning context. If the handle is invalid, expired, missing, or hash-mismatched, it returns a structured error and the agent should fall back to the prompt summary.

## MCP Tool

Non-plugin runtimes can attach the same contract as a stdio MCP server:

```bash
node plugins/idacc-context-retrieval/tools/contract.mjs mcp
```

It exposes `idacc_context_capabilities`, `idacc_context_store`, and `idacc_context_resolve`. MCP availability does not change the rules above; protected content still stays direct, and this resolver must not become a memory, planning, routing, key, or wallet mutation surface.
