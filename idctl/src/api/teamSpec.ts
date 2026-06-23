// SPDX-License-Identifier: MIT
/**
 * Team-spec importer — turn a pasted, free-form team description into a structured
 * {team, agents[]} plan the Create-team flow can spawn. Deterministic and pure so
 * it's unit-testable and runs client-side with no model. Handles the common
 * "numbered/bulleted **bold name** + Role: …" markdown shape; the UI shows the
 * result for review/edit, and an optional AI parse (dispatch to a running agent)
 * covers messier free-form input.
 */

export interface SpecAgent {
  /** Slugged agent name (lowercase, hyphenated). */
  name: string;
  /** One-line role / responsibility, used to seed the agent's catalog role. */
  role: string;
}
export interface ParsedTeamSpec {
  /** Team name parsed from the spec (e.g. "For `brain`"), or null if none found. */
  team: string | null;
  agents: SpecAgent[];
}

/** Lowercase, hyphenated, validator-safe slug (manager validateName for agents/teams). */
export function slugName(s: string): string {
  return s
    .trim()
    .toLowerCase()
    .replace(/[`'"*]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
}

/** Manager-reserved command words that can't be agent/team names — mirrors
 *  id-agents/src/name-validation.ts. Exported so the import UI can pre-flight a
 *  collision instead of failing per-agent at spawn time. */
const RESERVED = new Set([
  'delete', 'list', 'create', 'deploy', 'sync', 'spawn', 'kill', 'stop', 'start',
  'rebuild', 'status', 'schedule', 'tasks', 'team', 'teams', 'ask', 'hey', 'news',
  'register', 'configs', 'registry', 'keys', 'meta', 'pay', 'heartbeat', 'heartbeats',
  'cancel', 'clear', 'update', 'help', 'sync-wallets', 'artifact', 'output', 'verify',
  'manager',
]);
export function isReservedName(name: string): boolean {
  return RESERVED.has((name || '').trim().toLowerCase());
}

// A line that starts an agent entry: a numbered or bulleted item whose first
// token is a **bold name**. The number/bullet prefix is required so a bare bold
// section heading (e.g. "**Recommended Agent Creations…**") is NOT taken as an agent.
const AGENT_HEADER = /^\s*(?:\d+[.)]|[-*+])\s+\*\*\s*([^*\n]+?)\s*\*\*\s*:?\s*(.*)$/;

/** Try to find the intended team name: `For \`x\``, "team: x", or "<x> team". */
function findTeamName(raw: string): string | null {
  // Strip markdown bold markers so a bolded heading like
  // "**Recommended Agent Creations For `brain`**" still matches at end-of-line.
  const text = raw.replace(/\*+/g, '');
  // Order matters: explicit markers win over the loose "for" pattern, so a real
  // `team: x` or `# X team` is never overridden by stray prose ending in "for …".
  const patterns = [
    /\bteam\s*[:=]\s*[`'"]?([a-zA-Z][\w .-]*?)[`'"]?\s*$/im, // "team: brain"
    /^#{1,6}\s+([a-zA-Z][\w .-]*?)\s+team\b/im,             // "# Brain team"
    // "…Creations For `brain`" — REQUIRE quotes/backticks around the name so
    // ordinary prose ("waiting for approval", "thanks for everything") doesn't match.
    /\bfor\s+[`'"]([a-zA-Z][\w .-]*?)[`'"]/i,
  ];
  for (const re of patterns) {
    const m = re.exec(text);
    if (m && m[1]) {
      const slug = slugName(m[1]);
      if (slug) return slug;
    }
  }
  return null;
}

/**
 * Parse a pasted team spec. Best-effort and forgiving: anything it can't recognize
 * simply yields fewer agents (the UI lets the user add/edit), never throws.
 */
export function parseTeamSpec(text: string): ParsedTeamSpec {
  const lines = (text || '').split(/\r?\n/);
  const agents: SpecAgent[] = [];
  const seen = new Set<string>();

  let current: { name: string; roleLines: string[] } | null = null;
  const flush = () => {
    if (!current) return;
    const name = slugName(current.name);
    if (name && !seen.has(name)) {
      seen.add(name);
      // Prefer a "Role: …" line; else the first non-empty continuation line.
      const roleLine = current.roleLines.find((l) => /^\s*role\s*:/i.test(l));
      const raw = roleLine
        ? roleLine.replace(/^\s*role\s*:/i, '')
        : (current.roleLines.find((l) => l.trim()) ?? '');
      const role = raw.replace(/\s+/g, ' ').trim().slice(0, 280);
      agents.push({ name, role });
    }
    current = null;
  };

  for (const line of lines) {
    const m = AGENT_HEADER.exec(line);
    // The bold token must be a single, name-like token (no internal whitespace).
    // This rejects prose bullets like "1. **Set up** your environment first" — whose
    // bold span is a sentence fragment — from being taken as agents to spawn.
    if (m && !/\s/.test(m[1].trim())) {
      flush();
      // m[1] = bold name; m[2] = any trailing text on the same line (e.g. "name** — role").
      current = { name: m[1], roleLines: m[2] ? [m[2]] : [] };
    } else if (current) {
      current.roleLines.push(line);
    }
  }
  flush();

  return { team: findTeamName(text), agents };
}
