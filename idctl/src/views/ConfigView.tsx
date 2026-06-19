/**
 * ConfigView — teams + the persona library. Actions:
 *   s  /sync   — reconcile the active team against its YAML
 *   D  /deploy — nuke-and-recreate the active team from config (confirmed)
 *   N  new team — create a fresh team from the shipped default template
 *                 (`/deploy <name>` falls back to configs/default.yaml)
 *   L  load team — reveal an existing manager team, or deploy a server config
 *
 * idctl ships scoped to the default team (knownTeams allowlist); N/L grow it.
 */

import { useEffect, useState } from 'react';
import { Box, Text, useInput } from 'ink';
import Spinner from 'ink-spinner';
import { useAppCtx } from '../app/context.ts';
import { Confirm } from '../components/Confirm.tsx';
import { Wizard } from '../components/Wizard.tsx';
import { Select, type SelectItem } from '../components/Select.tsx';
import { theme, truncate } from '../app/theme.ts';
import type { LibraryEntry, ConfigEntry, TeamTemplate } from '../api/client.ts';
import { addKnownTeam, loadSettings } from '../settings/store.ts';
import { resolveConfigPath } from '../settings/paths.ts';

type Mode = 'list' | 'confirmDeploy' | 'newWizard' | 'confirmNew' | 'loadSelect';

interface LoadItem {
  name: string;
  kind: 'team' | 'config' | 'template';
  hint: string;
}

export function ConfigView() {
  const { store, setCapture, flash } = useAppCtx();
  const [lib, setLib] = useState<{ libraryRoot: string; entries: LibraryEntry[] } | null>(null);
  const [templates, setTemplates] = useState<TeamTemplate[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [mode, setMode] = useState<Mode>('list');
  const [newName, setNewName] = useState('');
  const [newTemplate, setNewTemplate] = useState<string | null>(null);
  const [loadItems, setLoadItems] = useState<LoadItem[] | null>(null);
  const team = store.team ?? 'default';
  const known = loadSettings(resolveConfigPath()).knownTeams ?? null;

  useEffect(() => {
    let alive = true;
    store.client
      .libraryAgents()
      .then((l) => alive && setLib(l))
      .catch(() => alive && setLib(null));
    // Probe the upstream team library (≥0.1.96). Empty/[] on older managers.
    store.client
      .libraryTeams()
      .then((t) => alive && setTemplates(t))
      .catch(() => alive && setTemplates([]));
    return () => {
      alive = false;
    };
  }, [store.client]);

  /** Library path: install a template into a new team, then deploy it. */
  async function installAndDeploy(template: string, name: string) {
    setBusy(`install ${template}→${name}`);
    try {
      await store.client.installTeam(template, name);
      await store.client.deployTeam(name, { onTick: (s) => setBusy(`deploy ${name} (${s})`) });
      addKnownTeam(name);
      store.setTeam(name);
      flash(`created ${name} from ${template} ✓`, 'ok');
      store.refresh();
    } catch (err) {
      flash(`create failed: ${err instanceof Error ? err.message : String(err)}`, 'err');
    } finally {
      setBusy(null);
      setMode('list');
    }
  }

  useEffect(() => {
    setCapture(mode !== 'list');
    return () => setCapture(false);
  }, [mode, setCapture]);

  async function dispatch(label: string, cmd: string, after?: () => void) {
    setBusy(label);
    try {
      const reply = await store.client.dispatch(cmd, { onTick: (s) => setBusy(`${label} (${s})`) });
      flash(`${label} ✓ ${truncate(reply, 36)}`, 'ok');
      after?.();
      store.refresh();
    } catch (err) {
      flash(`${label} failed: ${err instanceof Error ? err.message : String(err)}`, 'err');
    } finally {
      setBusy(null);
      setMode('list');
    }
  }

  async function openLoad() {
    setBusy('loading teams…');
    try {
      const configs = await store.client.configs().catch(() => [] as ConfigEntry[]);
      const liveNames = new Set(store.teams.map((t) => t.name));
      const items: LoadItem[] = [];
      // Existing manager teams not already shown.
      for (const t of store.teams) {
        if (known && !known.includes(t.name)) items.push({ name: t.name, kind: 'team', hint: `live · ${t.agentCount} agents` });
      }
      // Library templates to install as new teams (upstream ≥0.1.96).
      for (const t of templates ?? []) {
        const n = typeof t.agents === 'number' ? t.agents : Array.isArray(t.agents) ? t.agents.length : undefined;
        items.push({ name: t.name, kind: 'template', hint: `template${n != null ? ` · ${n} agents` : ''}` });
      }
      // Deployable server configs that aren't already a live team.
      for (const c of configs) {
        if (!liveNames.has(c.name)) {
          const n = Array.isArray(c.agents) ? c.agents.length : c.agents;
          items.push({ name: c.name, kind: 'config', hint: `config${n != null ? ` · ${n} agents` : ''}` });
        }
      }
      setLoadItems(items);
      setMode('loadSelect');
    } finally {
      setBusy(null);
    }
  }

  useInput(
    (input) => {
      if (busy) return;
      if (input === 's') dispatch('sync', `/sync ${team}`);
      else if (input === 'D') setMode('confirmDeploy');
      else if (input === 'N') {
        setNewName('');
        setNewTemplate(null);
        setMode('newWizard');
      } else if (input === 'L') void openLoad();
    },
    { isActive: mode === 'list' && !busy },
  );

  const hasLibrary = (templates?.length ?? 0) > 0;

  // ----- modal modes -----
  if (mode === 'confirmDeploy') {
    return (
      <Confirm
        title={`Deploy team "${team}" from config?`}
        detail="Nukes and recreates the team's agents from configs/<team>.yaml. Running sessions are lost."
        confirmLabel="deploy"
        onConfirm={() => dispatch('deploy', `/deploy ${team}`)}
        onCancel={() => setMode('list')}
      />
    );
  }

  if (mode === 'newWizard') {
    // When the upstream team library exists, pick a template first; otherwise
    // fall back to the default-template clone (`/deploy <name>`).
    const steps = hasLibrary
      ? [
          {
            key: 'template',
            label: 'Template',
            type: 'choice' as const,
            choices: (templates ?? []).map((t) => ({
              value: t.name,
              label: t.name,
              hint: t.description ?? (typeof t.agents === 'number' ? `${t.agents} agents` : undefined),
            })),
          },
          { key: 'name', label: 'New team name (lowercase)', type: 'text' as const, placeholder: 'my-team' },
        ]
      : [{ key: 'name', label: 'New team name (lowercase)', type: 'text' as const, placeholder: 'my-team' }];
    return (
      <Wizard
        title={hasLibrary ? 'New team (from a library template)' : 'New team (from the default template)'}
        steps={steps}
        onCancel={() => setMode('list')}
        onSubmit={(v) => {
          const name = (v.name || '').trim().toLowerCase().replace(/\s+/g, '-');
          if (!name) return setMode('list');
          setNewName(name);
          setNewTemplate(v.template ?? null);
          setMode('confirmNew');
        }}
      />
    );
  }

  if (mode === 'confirmNew') {
    return (
      <Confirm
        title={`Create team "${newName}"?`}
        detail={
          newTemplate
            ? `Installs the "${newTemplate}" template as team "${newName}" and spawns its agents.`
            : 'Stands up a fresh team from configs/default.yaml (coder + researcher). Spawns real agent processes.'
        }
        confirmLabel="create team"
        onConfirm={() =>
          newTemplate
            ? installAndDeploy(newTemplate, newName)
            : dispatch(`create ${newName}`, `/deploy ${newName}`, () => {
                addKnownTeam(newName);
                store.setTeam(newName);
              })
        }
        onCancel={() => setMode('list')}
      />
    );
  }

  if (mode === 'loadSelect') {
    const items: SelectItem<LoadItem>[] = (loadItems ?? []).map((it) => ({
      key: `${it.kind}:${it.name}`,
      label: it.name.padEnd(16).slice(0, 16),
      value: it,
      color: it.kind === 'team' ? theme.ok : it.kind === 'template' ? theme.accent : theme.accentAlt,
      hint: it.hint,
    }));
    return (
      <Box flexDirection="column" borderStyle="round" borderColor={theme.accent} paddingX={1}>
        <Text bold color={theme.accent}>
          Load team
        </Text>
        <Select
          items={items}
          emptyText="(nothing to load — all manager teams already shown)"
          onSelect={(it) => {
            const v = it.value;
            if (v.kind === 'team') {
              // Reveal an existing live team — safe, no deploy.
              addKnownTeam(v.name);
              store.setTeam(v.name);
              flash(`loaded team ${v.name}`, 'ok');
              setMode('list');
            } else if (v.kind === 'template') {
              // Install a library template as a new team. Name it after the
              // template by default; user can rename later via New.
              void installAndDeploy(v.name, v.name);
            } else {
              // Deploy a server config (creates/recreates that team).
              dispatch(`deploy ${v.name}`, `/deploy ${v.name}`, () => {
                addKnownTeam(v.name);
                store.setTeam(v.name);
              });
            }
          }}
          maxVisible={10}
        />
        <Text color={theme.dim}>Enter load · green=live (reveal) · cyan=template (install) · magenta=config (deploy) · Esc</Text>
        <EscClose to={() => setMode('list')} active={!busy} />
      </Box>
    );
  }

  // ----- list -----
  const shownTeams = store.teams.filter((t) => !known || known.includes(t.name) || t.name === team);
  return (
    <Box flexDirection="column">
      <Box>
        <Box flexDirection="column" width="45%" marginRight={2}>
          <Text bold color={theme.accent}>
            Teams <Text color={theme.dim}>{known ? `(${shownTeams.length} known)` : '(all)'}</Text>
          </Text>
          {shownTeams.map((t) => (
            <Text key={t.id}>
              <Text color={t.name === team ? theme.accent : undefined}>
                {t.name === team ? '❯ ' : '  '}
                {t.name}
              </Text>
              <Text color={theme.dim}> · {t.agentCount} agents</Text>
            </Text>
          ))}
          <Box marginTop={1} flexDirection="column">
            <Text color={theme.dim}>active: {team}</Text>
            <Text color={theme.dim}>t switch · N new · L load</Text>
          </Box>
        </Box>
        <Box flexDirection="column" width="55%">
          <Text bold color={theme.accentAlt}>
            Persona library ({lib?.entries.length ?? 0})
          </Text>
          {lib == null ? (
            <Text color={theme.dim}>loading…</Text>
          ) : (
            lib.entries.slice(0, 9).map((e) => (
              <Text key={e.name}>
                <Text>{e.name.padEnd(18).slice(0, 18)}</Text>
                <Text color={theme.dim}>{e.shape ?? ''}</Text>
              </Text>
            ))
          )}
        </Box>
      </Box>
      <Box marginTop={1}>
        {busy ? (
          <Text color={theme.warn}>
            <Spinner type="dots" /> {busy}
          </Text>
        ) : (
          <Text color={theme.dim}>s sync · D deploy · N new team · L load team · t switch</Text>
        )}
      </Box>
    </Box>
  );
}

function EscClose({ to, active }: { to: () => void; active: boolean }) {
  useInput(
    (_i, key) => {
      if (key.escape) to();
    },
    { isActive: active },
  );
  return null;
}
