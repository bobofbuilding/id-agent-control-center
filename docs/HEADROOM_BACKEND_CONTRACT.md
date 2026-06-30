# Headroom Backend Contract Candidate

IDACC now has a core deterministic context-budget layer. Headroom remains a candidate core compression engine until a runtime-neutral retrieval contract is proven without making the base id-agents manager harder to install or narrowing the platform to one runtime family.

## Minimal-Change Path

1. Keep live `/ask` dispatch on the existing manager route.
2. Measure current behavior with hidden context-budget stats and local chat-history replay.
3. Bundle and smoke-test an optional `idacc-context-retrieval` plugin candidate as a pilot resolver.
4. Attach the plugin through the existing id-agents plugin mechanism instead of requiring a new manager fork.
5. Treat plugin-only routing as pilot-scoped because id-agents plugins load only on Claude-family runtimes.
6. Promote Headroom retrieval-handle routing only when `/capabilities` can report the contract and every dispatch has direct fallback.

## Required Runtime Contract

- The manager or agent environment must advertise a context-retrieval capability before IDACC sends retrieval handles.
- A compressed prompt must include a stable retrieval handle, a source hash, an expiry, and a fallback summary.
- The agent must be able to resolve the handle before acting, or IDACC must keep the prompt on the direct route.
- Protected content classes stay direct: secrets, auth material, wallet/key material, instruction sidecars, active patches, and validator evidence.
- Every routed prompt must produce an audit record with token estimates, transform class, retrieval capability state, and fallback route.
- Persistent memory, Brain sync, task orchestration, goals, plans, schedules, routing, keys, and wallet flows must stay outside the retrieval plugin contract.

## Runtime Coverage Decision

- `idacc-context-retrieval` plugin: valid as a Claude-family pilot resolver.
- Headroom MCP: better core candidate surface because Claude, Codex, and Ollama can use MCP-capable tools.
- Manager retrieval contract: required before core activation because it lets IDACC feature-detect support and keep stock/stale managers on direct routing.
- Direct deterministic fallback: remains universal for all runtimes and protected content.

Plugin-only routing is not core-ready because it would exclude Codex, cursor-cli, Ollama, and future runtimes. The plugin path validates the shape of a resolver, not the final platform-wide dependency.

## Validation Gates

- Historical chat replay shows savings without exposing or persisting raw chat text.
- Deterministic smoke tests continue to prove protected-content direct fallback.
- A retrieval plugin smoke test proves store, resolve, hash-match, expiry, protected-content reject, and direct fallback.
- Manager `/capabilities` reports the retrieval contract version before IDACC enables handle routing.
- Quality review compares original objective, compressed prompt, resolved context, and final response for drift.

## Current Decision

The plugin path is validated for pilot work, not core activation. IDACC now bundles an `idacc-context-retrieval` candidate and a smoke test that verifies manifest shape, resolver instructions, source-hash checks, expiry, and protected-content rejection. The core Headroom path still requires runtime-neutral support through MCP or a manager-advertised retrieval contract, plus direct fallback, so token compression does not block AI orchestration or persistent memory features.
