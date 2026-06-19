/**
 * SettingsView — connect managers and inference backends, and assign discovered
 * models to agents. Three panes, switched with m / p / a:
 *
 *   m  Managers  — saved id-agents connections; Enter "uses" one (re-points the
 *                  live store + persists as default). n new · e edit · x delete.
 *   p  Providers — inference backends (ollama/lmstudio/openai-compatible/
 *                  anthropic/openai); Enter probes (liveness + model discovery).
 *                  n new · e edit · x delete · space enable/disable · d default.
 *   a  Assign    — pick a discovered model (left) and an eligible agent (right);
 *                  Enter assigns (restart required), R assigns + restarts now.
 *
 * What the manager CANNOT do over HTTP (shown inline): store provider configs,
 * change an agent's runtime, or point an agent at a different Ollama host — the
 * view only ever changes an agent's *model*, and warns that a restart is needed.
 */

import { useEffect, useMemo, useState } from 'react';
import { Box, Text, useInput } from 'ink';
import Spinner from 'ink-spinner';
import { useAppCtx } from '../app/context.ts';
import { Select, type SelectItem } from '../components/Select.tsx';
import { Confirm } from '../components/Confirm.tsx';
import { Wizard, type WizardStep } from '../components/Wizard.tsx';
import { theme, truncate } from '../app/theme.ts';
import {
  loadSettings,
  upsertManager,
  removeManager,
  setDefaultManager,
  upsertProvider,
  removeProvider,
  setDefaultProvider,
  toggleProviderEnabled,
  resolveProviderKey,
  resolveManagerKey,
  redactKey,
} from '../settings/store.ts';
import { defaultBaseUrl, kindNeedsKey, type IdctlConfig, type ManagerProfile, type ProviderProfile, type ProviderKind } from '../settings/schema.ts';
import { ProviderClient, type ProbeOutcome } from '../settings/ProviderClient.ts';
import { assignModel, assignableAgents, isAssignable, ineligibleReason } from '../settings/assign.ts';
import type { Agent } from '../api/types.ts';

type Pane = 'managers' | 'providers' | 'assign';
type Overlay =
  | { kind: 'none' }
  | { kind: 'mgr-wizard'; edit?: ManagerProfile }
  | { kind: 'prov-wizard'; edit?: ProviderProfile }
  | { kind: 'confirm-del-mgr'; m: ManagerProfile }
  | { kind: 'confirm-del-prov'; p: ProviderProfile }
  | { kind: 'confirm-restart'; agent: Agent; model: string };

const KINDS: { label: string; value: ProviderKind; hint: string }[] = [
  { label: 'ollama', value: 'ollama', hint: 'local · no key' },
  { label: 'lmstudio', value: 'lmstudio', hint: 'local · OpenAI-compatible' },
  { label: 'openai-compatible', value: 'openai-compatible', hint: 'vLLM/llama.cpp/LiteLLM…' },
  { label: 'anthropic', value: 'anthropic', hint: 'cloud · needs key' },
  { label: 'openai', value: 'openai', hint: 'cloud · needs key' },
];

export function SettingsView() {
  const { store, setCapture, flash } = useAppCtx();
  const [cfg, setCfg] = useState<IdctlConfig>(() => loadSettings());
  const [pane, setPane] = useState<Pane>('managers');
  const [overlay, setOverlay] = useState<Overlay>({ kind: 'none' });

  const [mgrCursor, setMgrCursor] = useState(0);
  const [provCursor, setProvCursor] = useState(0);
  const [probes, setProbes] = useState<Record<string, ProbeOutcome>>({});
  const [probing, setProbing] = useState<string | null>(null);

  // Assign pane
  const [assignProvider, setAssignProvider] = useState<string | null>(null);
  const [assignSub, setAssignSub] = useState<'models' | 'agents'>('models');
  const [armedModel, setArmedModel] = useState<string | null>(null);
  const [modelCursor, setModelCursor] = useState(0);
  const [agentCursor, setAgentCursor] = useState(0);
  const [busy, setBusy] = useState(false);

  const reload = () => setCfg(loadSettings());
  useEffect(() => {
    setCapture(overlay.kind !== 'none');
    return () => setCapture(false);
  }, [overlay, setCapture]);

  // Pane switching (inactive while an overlay owns the keyboard).
  useInput(
    (input) => {
      if (input === 'm') setPane('managers');
      else if (input === 'p') setPane('providers');
      else if (input === 'a') setPane('assign');
    },
    { isActive: overlay.kind === 'none' },
  );

  const selectedManager = cfg.managers[Math.min(mgrCursor, cfg.managers.length - 1)];
  const selectedProvider = cfg.providers[Math.min(provCursor, cfg.providers.length - 1)];

  async function probeProvider(p: ProviderProfile) {
    setProbing(p.name);
    setAssignProvider(p.name);
    try {
      const out = await new ProviderClient(p, resolveProviderKey(p)).probe();
      setProbes((m) => ({ ...m, [p.name]: out }));
      flash(`${p.name}: ${out.status}${out.status === 'live' ? ` · ${out.models.length} models` : ''}`, out.ok ? 'ok' : 'err');
    } catch (err) {
      flash(`probe failed: ${err instanceof Error ? err.message : String(err)}`, 'err');
    } finally {
      setProbing(null);
    }
  }

  // ---------- overlays ----------
  if (overlay.kind === 'mgr-wizard') {
    const e = overlay.edit;
    const steps: WizardStep[] = e
      ? [
          { key: 'url', label: 'Manager URL', type: 'text', initial: e.url, placeholder: 'http://127.0.0.1:4100' },
          { key: 'team', label: 'Team', type: 'text', initial: e.team ?? '', optional: true },
          { key: 'apiKey', label: 'API key', type: 'text', secret: true, optional: true },
        ]
      : [
          { key: 'name', label: 'Profile name', type: 'text', placeholder: 'local' },
          { key: 'url', label: 'Manager URL', type: 'text', placeholder: 'http://127.0.0.1:4100' },
          { key: 'team', label: 'Team', type: 'text', optional: true, placeholder: 'default' },
          { key: 'apiKey', label: 'API key', type: 'text', secret: true, optional: true },
        ];
    return (
      <Wizard
        title={e ? `Edit manager "${e.name}"` : 'New manager'}
        steps={steps}
        onCancel={() => setOverlay({ kind: 'none' })}
        onSubmit={(v) => {
          const m: ManagerProfile = {
            name: e?.name ?? (v.name || 'manager'),
            url: (v.url || 'http://127.0.0.1:4100').trim(),
            team: v.team?.trim() || undefined,
            apiKey: v.apiKey?.trim() || undefined,
          };
          upsertManager(m);
          reload();
          flash(`saved manager ${m.name}`, 'ok');
          setOverlay({ kind: 'none' });
        }}
      />
    );
  }

  if (overlay.kind === 'prov-wizard') {
    const e = overlay.edit;
    const steps: WizardStep[] = e
      ? [
          { key: 'baseUrl', label: 'Base URL', type: 'text', initial: e.baseUrl },
          { key: 'apiKey', label: 'API key', type: 'text', secret: true, optional: true, initial: e.apiKey ?? '' },
        ]
      : [
          { key: 'kind', label: 'Backend kind', type: 'choice', choices: KINDS },
          { key: 'name', label: 'Profile name', type: 'text', placeholder: 'local-ollama' },
          { key: 'baseUrl', label: 'Base URL (blank = default for kind)', type: 'text', optional: true },
          { key: 'apiKey', label: 'API key (cloud backends need this)', type: 'text', secret: true, optional: true },
        ];
    return (
      <Wizard
        title={e ? `Edit provider "${e.name}"` : 'New inference backend'}
        steps={steps}
        onCancel={() => setOverlay({ kind: 'none' })}
        onSubmit={(v) => {
          const kind = (e?.kind ?? (v.kind as ProviderKind)) || 'ollama';
          const p: ProviderProfile = {
            name: e?.name ?? (v.name || kind),
            kind,
            baseUrl: (v.baseUrl?.trim() || defaultBaseUrl(kind)),
            apiKey: v.apiKey?.trim() || undefined,
            enabled: e?.enabled ?? true,
            default: e?.default,
          };
          upsertProvider(p);
          reload();
          flash(`saved provider ${p.name}`, 'ok');
          setOverlay({ kind: 'none' });
        }}
      />
    );
  }

  if (overlay.kind === 'confirm-del-mgr') {
    return (
      <Confirm
        title={`Delete manager "${overlay.m.name}"?`}
        confirmLabel="delete"
        onConfirm={() => { removeManager(overlay.m.name); reload(); flash('deleted', 'ok'); setOverlay({ kind: 'none' }); }}
        onCancel={() => setOverlay({ kind: 'none' })}
      />
    );
  }
  if (overlay.kind === 'confirm-del-prov') {
    return (
      <Confirm
        title={`Delete provider "${overlay.p.name}"?`}
        confirmLabel="delete"
        onConfirm={() => { removeProvider(overlay.p.name); reload(); flash('deleted', 'ok'); setOverlay({ kind: 'none' }); }}
        onCancel={() => setOverlay({ kind: 'none' })}
      />
    );
  }
  if (overlay.kind === 'confirm-restart') {
    const { agent, model } = overlay;
    return (
      <Confirm
        title={`Assign ${model} to "${agent.name}" and restart now?`}
        detail="Restarting interrupts the agent's current session so it loads the new model immediately."
        confirmLabel="assign + restart"
        onConfirm={async () => {
          setOverlay({ kind: 'none' });
          setBusy(true);
          try {
            const r = await assignModel(store.client, agent, model, { restart: true });
            flash(r.message + ' ✓', 'ok');
            store.refresh();
          } catch (err) {
            flash(`assign failed: ${err instanceof Error ? err.message : String(err)}`, 'err');
          } finally {
            setBusy(false);
          }
        }}
        onCancel={() => setOverlay({ kind: 'none' })}
      />
    );
  }

  // ---------- panes ----------
  return (
    <Box flexDirection="column">
      <Box>
        <PaneTab id="managers" active={pane} label="m Managers" />
        <PaneTab id="providers" active={pane} label="p Providers" />
        <PaneTab id="assign" active={pane} label="a Assign" />
      </Box>
      <Box marginTop={1}>
        {pane === 'managers' ? (
          <ManagersPane
            cfg={cfg}
            cursor={mgrCursor}
            setCursor={setMgrCursor}
            selected={selectedManager}
            overlayNone={overlay.kind === 'none'}
            onUse={(m) => {
              store.setConnection({ url: m.url, team: m.team, apiKey: resolveManagerKey(m) });
              setDefaultManager(m.name);
              reload();
              flash(`using manager ${m.name} (${m.url})`, 'ok');
            }}
            onNew={() => setOverlay({ kind: 'mgr-wizard' })}
            onEdit={(m) => setOverlay({ kind: 'mgr-wizard', edit: m })}
            onDelete={(m) => setOverlay({ kind: 'confirm-del-mgr', m })}
          />
        ) : pane === 'providers' ? (
          <ProvidersPane
            cfg={cfg}
            cursor={provCursor}
            setCursor={setProvCursor}
            selected={selectedProvider}
            probes={probes}
            probing={probing}
            overlayNone={overlay.kind === 'none'}
            onProbe={(p) => probeProvider(p)}
            onNew={() => setOverlay({ kind: 'prov-wizard' })}
            onEdit={(p) => setOverlay({ kind: 'prov-wizard', edit: p })}
            onDelete={(p) => setOverlay({ kind: 'confirm-del-prov', p })}
            onToggle={(p) => { toggleProviderEnabled(p.name); reload(); }}
            onDefault={(p) => { setDefaultProvider(p.name); reload(); }}
          />
        ) : (
          <AssignPane
            store={store}
            providerName={assignProvider}
            outcome={assignProvider ? probes[assignProvider] : undefined}
            sub={assignSub}
            setSub={setAssignSub}
            armed={armedModel}
            setArmed={setArmedModel}
            modelCursor={modelCursor}
            setModelCursor={setModelCursor}
            agentCursor={agentCursor}
            setAgentCursor={setAgentCursor}
            busy={busy}
            overlayNone={overlay.kind === 'none'}
            onAssignNoRestart={async (agent, model) => {
              setBusy(true);
              try {
                const r = await assignModel(store.client, agent, model, { restart: false });
                flash(r.message + ' ✓ (restart to apply)', 'ok');
                store.refresh();
              } catch (err) {
                flash(`assign failed: ${err instanceof Error ? err.message : String(err)}`, 'err');
              } finally {
                setBusy(false);
              }
            }}
            onAssignRestart={(agent, model) => setOverlay({ kind: 'confirm-restart', agent, model })}
          />
        )}
      </Box>
    </Box>
  );
}

function PaneTab({ id, active, label }: { id: Pane; active: Pane; label: string }) {
  const on = id === active;
  return (
    <Text>
      <Text color={on ? theme.accent : theme.dim} bold={on} inverse={on}>
        {' '}{label}{' '}
      </Text>
      <Text> </Text>
    </Text>
  );
}

// ---------------- Managers pane ----------------
function ManagersPane(props: {
  cfg: IdctlConfig;
  cursor: number;
  setCursor: (i: number) => void;
  selected?: ManagerProfile;
  overlayNone: boolean;
  onUse: (m: ManagerProfile) => void;
  onNew: () => void;
  onEdit: (m: ManagerProfile) => void;
  onDelete: (m: ManagerProfile) => void;
}) {
  useInput(
    (input) => {
      if (input === 'n') props.onNew();
      else if (props.selected && input === 'e') props.onEdit(props.selected);
      else if (props.selected && input === 'x') props.onDelete(props.selected);
    },
    { isActive: props.overlayNone },
  );

  const items: SelectItem<ManagerProfile>[] = props.cfg.managers.map((m) => ({
    key: m.name,
    label: m.name.padEnd(10).slice(0, 10),
    value: m,
    color: m.name === props.cfg.defaultManager ? theme.accent : undefined,
    hint: `${m.url}${m.team ? ` · ${m.team}` : ''}${m.apiKey ? ' · 🔑' : ''}${m.name === props.cfg.defaultManager ? ' ●default' : ''}`,
  }));
  return (
    <Box flexDirection="column">
      <Select
        items={items}
        index={props.cursor}
        onIndexChange={props.setCursor}
        onSelect={(it) => props.onUse(it.value)}
        emptyText="(no managers — press n to add one; default is http://127.0.0.1:4100)"
        maxVisible={10}
      />
      <Text color={theme.dim}>Enter use (connect) · n new · e edit · x delete</Text>
    </Box>
  );
}

// ---------------- Providers pane ----------------
function ProvidersPane(props: {
  cfg: IdctlConfig;
  cursor: number;
  setCursor: (i: number) => void;
  selected?: ProviderProfile;
  probes: Record<string, ProbeOutcome>;
  probing: string | null;
  overlayNone: boolean;
  onProbe: (p: ProviderProfile) => void;
  onNew: () => void;
  onEdit: (p: ProviderProfile) => void;
  onDelete: (p: ProviderProfile) => void;
  onToggle: (p: ProviderProfile) => void;
  onDefault: (p: ProviderProfile) => void;
}) {
  useInput(
    (input) => {
      const s = props.selected;
      if (input === 'n') props.onNew();
      else if (s && input === 'e') props.onEdit(s);
      else if (s && input === 'x') props.onDelete(s);
      else if (s && input === ' ') props.onToggle(s);
      else if (s && input === 'd') props.onDefault(s);
    },
    { isActive: props.overlayNone },
  );

  function statusLabel(p: ProviderProfile): string {
    if (props.probing === p.name) return 'probing…';
    const o = props.probes[p.name];
    if (!o) return 'not probed';
    if (o.status === 'live') return `live · ${o.models.length} models`;
    return o.status;
  }
  function statusColorFor(p: ProviderProfile): string {
    const o = props.probes[p.name];
    if (!o) return theme.dim;
    return o.status === 'live' ? theme.ok : o.status === 'auth-error' ? theme.warn : theme.err;
  }

  const items: SelectItem<ProviderProfile>[] = props.cfg.providers.map((p) => ({
    key: p.name,
    label: p.name.padEnd(12).slice(0, 12),
    value: p,
    color: p.enabled ? undefined : theme.dim,
    hint: `${p.kind}${p.default ? ' ●' : ''}  ${p.enabled ? 'on' : 'off'}  ${statusLabel(p)}`,
  }));

  return (
    <Box flexDirection="column">
      <Select
        items={items}
        index={props.cursor}
        onIndexChange={props.setCursor}
        onSelect={(it) => props.onProbe(it.value)}
        emptyText="(no providers — press n; e.g. ollama at http://127.0.0.1:11434)"
        maxVisible={8}
      />
      {props.selected ? (
        <Box marginTop={1} flexDirection="column">
          <Text color={statusColorFor(props.selected)}>
            {props.selected.name}: {props.selected.baseUrl}
            {props.probes[props.selected.name]?.message ? ` — ${props.probes[props.selected.name]!.message}` : ''}
          </Text>
        </Box>
      ) : null}
      <Text color={theme.dim}>Enter probe · n new · e edit · x del · space on/off · d default</Text>
    </Box>
  );
}

// ---------------- Assign pane ----------------
function AssignPane(props: {
  store: ReturnType<typeof useAppCtx>['store'];
  providerName: string | null;
  outcome?: ProbeOutcome;
  sub: 'models' | 'agents';
  setSub: (s: 'models' | 'agents') => void;
  armed: string | null;
  setArmed: (m: string | null) => void;
  modelCursor: number;
  setModelCursor: (i: number) => void;
  agentCursor: number;
  setAgentCursor: (i: number) => void;
  busy: boolean;
  overlayNone: boolean;
  onAssignNoRestart: (agent: Agent, model: string) => void;
  onAssignRestart: (agent: Agent, model: string) => void;
}) {
  const models = props.outcome?.models ?? [];
  const eligible = useMemo(() => assignableAgents(props.store.agents), [props.store.agents]);

  // 'R' = assign + restart on the focused agent (Enter = assign w/o restart).
  useInput(
    (input) => {
      if (props.sub === 'agents' && input === 'R' && props.armed) {
        const a = eligible[Math.min(props.agentCursor, eligible.length - 1)];
        if (a) props.onAssignRestart(a, props.armed);
      }
    },
    { isActive: props.overlayNone && !props.busy },
  );

  if (!props.providerName || !props.outcome) {
    return (
      <Box flexDirection="column">
        <Text color={theme.dim}>Probe a provider first: press p, select one, Enter.</Text>
        <Text color={theme.dim}>Then return here (a) to assign a discovered model to an agent.</Text>
      </Box>
    );
  }

  const modelItems: SelectItem<string>[] = models.map((m) => ({
    key: m.id,
    label: truncate(m.id, 26),
    value: m.id,
    hint: m.detail ?? m.label,
  }));
  const agentItems: SelectItem<Agent>[] = props.store.agents.map((a) => ({
    key: a.id,
    label: a.name.padEnd(12).slice(0, 12),
    value: a,
    color: isAssignable(a) ? undefined : theme.dim,
    hint: isAssignable(a) ? `${a.runtime ?? a.type} · ${a.model ?? '—'}` : ineligibleReason(a),
  }));

  return (
    <Box flexDirection="column">
      <Box>
        <Box flexDirection="column" width="48%" marginRight={2}>
          <Text bold color={props.sub === 'models' ? theme.accent : theme.dim}>
            Models · {props.providerName}
          </Text>
          <Select
            items={modelItems}
            isActive={props.sub === 'models' && props.overlayNone}
            index={props.modelCursor}
            onIndexChange={props.setModelCursor}
            onSelect={(it) => { props.setArmed(it.value); props.setSub('agents'); }}
            emptyText={props.outcome.status === 'live' ? '(no models)' : `(${props.outcome.status})`}
            maxVisible={8}
          />
        </Box>
        <Box flexDirection="column" width="52%">
          <Text bold color={props.sub === 'agents' ? theme.accent : theme.dim}>
            Agents {props.armed ? <Text color={theme.ok}>← {truncate(props.armed, 18)}</Text> : null}
          </Text>
          <Select
            items={agentItems}
            isActive={props.sub === 'agents' && props.overlayNone && !props.busy}
            index={props.agentCursor}
            onIndexChange={props.setAgentCursor}
            onSelect={(it) => {
              if (!props.armed) return;
              if (!isAssignable(it.value)) return;
              props.onAssignNoRestart(it.value, props.armed);
            }}
            emptyText="(no agents)"
            maxVisible={8}
          />
        </Box>
      </Box>
      <Text color={theme.dim}>
        {props.busy
          ? '… assigning'
          : props.sub === 'models'
            ? 'Enter arm a model → then Agents'
            : `Enter assign (restart to apply) · R assign+restart now · ${eligible.length} eligible`}
      </Text>
      <Text color={theme.dim}>note: model change needs an agent restart · runtime &amp; Ollama host are manager-side (not set here)</Text>
    </Box>
  );
}
