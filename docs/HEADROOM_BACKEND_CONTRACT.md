# Headroom Backend Contract Candidate

IDACC now has a core deterministic context-budget layer. Headroom remains a candidate engine until a retrieval contract is proven without making the base id-agents manager harder to install.

## Minimal-Change Path

1. Keep live `/ask` dispatch on the existing manager route.
2. Measure current behavior with hidden context-budget stats and local chat-history replay.
3. Add an optional IDACC context-retrieval plugin only after replay evidence shows useful savings on real prompts.
4. Attach the plugin through the existing id-agents plugin mechanism instead of requiring a new manager fork.
5. Promote retrieval-handle routing only when `/capabilities` can report the contract and every dispatch has direct fallback.

## Required Runtime Contract

- The manager or agent environment must advertise a context-retrieval capability before IDACC sends retrieval handles.
- A compressed prompt must include a stable retrieval handle, a source hash, an expiry, and a fallback summary.
- The agent must be able to resolve the handle before acting, or IDACC must keep the prompt on the direct route.
- Protected content classes stay direct: secrets, auth material, wallet/key material, instruction sidecars, active patches, and validator evidence.
- Every routed prompt must produce an audit record with token estimates, transform class, retrieval capability state, and fallback route.

## Validation Gates

- Historical chat replay shows savings without exposing or persisting raw chat text.
- Deterministic smoke tests continue to prove protected-content direct fallback.
- A retrieval plugin smoke test proves compress, resolve, hash-match, expiry, and direct fallback.
- Manager `/capabilities` reports the retrieval contract version before IDACC enables handle routing.
- Quality review compares original objective, compressed prompt, resolved context, and final response for drift.

## Current Decision

The next safe integration step is validation, not activation. Historical conversation replay can be used as a local testing layer because it dry-runs the current optimizer against saved user messages and reports aggregate counts only. The optional plugin path is promising because id-agents already supports per-agent plugins, but it should remain a candidate until the retrieval smoke test and capability advertisement exist.
