Task: sync-live-coordination-hr

Changes:
- `orgSync.buildOrgHierarchy` now keeps configured secondary leads and deterministically auto-covers any non-default/non-public teams missing from `leadsTeams`.
- The same research/security vs coder heuristic used by default secondary generation assigns uncovered teams, so `engineering-team` maps to `coder`.
- `Dashboard` Live coordination team rows now render the team lead and each team member with the existing live node state, not only team-level task text.

Expected result:
- `engineering-team` appears in Live coordination under `coder` after the next org hierarchy refresh.
- If a future team is still uncovered for any reason, Dashboard orphan-team fallback still renders it under the primary lead.
