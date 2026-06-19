/**
 * Curated catalog of common MCP servers — so the operator picks a server and
 * fills labeled fields (a directory, a token) instead of memorizing the exact
 * `npx` incantation. Each entry builds a McpServerProfile deterministically.
 * The Test button verifies whatever is built actually launches and lists tools,
 * so a slightly-stale package name is self-correcting rather than silent.
 *
 * The filesystem/memory/sequential-thinking/everything entries are verified to
 * launch + list tools; the token-gated ones (github/brave/postgres) need the
 * operator's secret and should be Tested after filling it in.
 */

import type { McpServerProfile } from './schema.ts';

export interface McpCatalogInput {
  key: string;
  label: string;
  placeholder?: string;
  required?: boolean;
  secret?: boolean;        // render as a password field (tokens)
  default?: string;
  /** Where the value goes: a trailing CLI arg, or an env var. */
  target: 'arg' | 'env';
  envKey?: string;         // required when target === 'env'
}

export interface McpCatalogEntry {
  id: string;              // also the default server name
  name: string;            // friendly label
  description: string;
  command: string;         // e.g. 'npx'
  baseArgs: string[];      // e.g. ['-y', '@modelcontextprotocol/server-filesystem']
  inputs?: McpCatalogInput[];
}

export const MCP_CATALOG: McpCatalogEntry[] = [
  {
    id: 'filesystem',
    name: 'Filesystem',
    description: 'Read/write files in a directory you allow (read_file, write_file, list_directory, …).',
    command: 'npx',
    baseArgs: ['-y', '@modelcontextprotocol/server-filesystem'],
    inputs: [{ key: 'path', label: 'Directory', placeholder: '/tmp', default: '/tmp', required: true, target: 'arg' }],
  },
  {
    id: 'memory',
    name: 'Memory (knowledge graph)',
    description: 'A persistent knowledge graph the agent can write to and recall (entities, relations, observations).',
    command: 'npx',
    baseArgs: ['-y', '@modelcontextprotocol/server-memory'],
  },
  {
    id: 'sequential-thinking',
    name: 'Sequential Thinking',
    description: 'A structured step-by-step reasoning tool for complex problems.',
    command: 'npx',
    baseArgs: ['-y', '@modelcontextprotocol/server-sequential-thinking'],
  },
  {
    id: 'everything',
    name: 'Everything (reference/test)',
    description: 'The reference MCP server — echo, sampling, prompts. Great for testing the wiring.',
    command: 'npx',
    baseArgs: ['-y', '@modelcontextprotocol/server-everything'],
  },
  {
    id: 'github',
    name: 'GitHub',
    description: 'Repos, issues, PRs, search. Needs a GitHub personal access token.',
    command: 'npx',
    baseArgs: ['-y', '@modelcontextprotocol/server-github'],
    inputs: [{ key: 'token', label: 'GitHub token', placeholder: 'ghp_…', required: true, secret: true, target: 'env', envKey: 'GITHUB_PERSONAL_ACCESS_TOKEN' }],
  },
  {
    id: 'brave-search',
    name: 'Brave Search (web)',
    description: 'Web + local search via the Brave Search API. Needs a Brave API key.',
    command: 'npx',
    baseArgs: ['-y', '@modelcontextprotocol/server-brave-search'],
    inputs: [{ key: 'key', label: 'Brave API key', required: true, secret: true, target: 'env', envKey: 'BRAVE_API_KEY' }],
  },
  {
    id: 'postgres',
    name: 'Postgres (read-only)',
    description: 'Query a Postgres database read-only. Needs a connection string.',
    command: 'npx',
    baseArgs: ['-y', '@modelcontextprotocol/server-postgres'],
    inputs: [{ key: 'url', label: 'Connection URL', placeholder: 'postgresql://user:pass@host:5432/db', required: true, secret: true, target: 'arg' }],
  },
];

/** Build a registrable MCP server profile from a catalog entry + filled inputs. */
export function buildFromCatalog(entry: McpCatalogEntry, name: string, values: Record<string, string>): McpServerProfile {
  const args = [...entry.baseArgs];
  const env: Record<string, string> = {};
  for (const inp of entry.inputs ?? []) {
    const v = (values[inp.key] ?? inp.default ?? '').trim();
    if (!v) continue;
    if (inp.target === 'arg') args.push(v);
    else if (inp.target === 'env' && inp.envKey) env[inp.envKey] = v;
  }
  return {
    name: name.trim() || entry.id,
    transport: 'stdio',
    command: entry.command,
    args,
    ...(Object.keys(env).length > 0 && { env }),
    enabled: true,
  };
}
