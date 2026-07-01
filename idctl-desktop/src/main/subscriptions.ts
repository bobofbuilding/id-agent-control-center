/**
 * Managed subscription auth for CLI runtimes IDACC can inspect or launch.
 * These use each CLI's own browser/device OAuth flow, not metered API keys, so
 * IDACC never stores or displays provider credentials.
 */

import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { homedir } from 'node:os';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { shell } from 'electron';
import { runInTerminal } from './system.ts';

const execFileP = promisify(execFile);

export type SubProvider = 'claude' | 'chatgpt' | 'cursor' | 'grok' | 'gemini' | 'copilot' | 'kiro-cli' | 'q';

type LoginMode = 'spawn' | 'terminal';
type CommandSpec = [string, string[]];

interface SubProviderMeta {
  provider: SubProvider;
  runtime: string;
  label: string;
  bin: string;
  appPaths?: string[];
  login?: CommandSpec;
  loginMode?: LoginMode;
  logout?: CommandSpec;
  install?: string;
  installHint: string;
  installOpensApp?: boolean;
  postInstall?: string;
  statusNote?: string;
}

export interface SubStatus {
  provider: SubProvider;
  runtime: string;
  label: string;
  loggedIn: boolean;
  /** Whether the provider's CLI is installed at all. */
  installed?: boolean;
  /** Read-only evidence path/source for installed state. */
  installedSource?: string;
  /** Whether IDACC can check sign-in state without opening the interactive CLI. */
  statusSupported?: boolean;
  /** Whether IDACC can launch a sign-in/account-selection flow. */
  loginSupported?: boolean;
  /** Whether IDACC can sign out through a documented non-secret command. */
  logoutSupported?: boolean;
  /** Whether IDACC has a reviewed visible install command for this CLI. */
  installSupported?: boolean;
  plan?: string;
  email?: string;
  method?: string;
  detail?: string;
  postInstall?: string;
  installOpensApp?: boolean;
}

const SUB_PROVIDERS: SubProvider[] = ['claude', 'chatgpt', 'cursor', 'grok', 'gemini', 'copilot', 'kiro-cli', 'q'];

const SUB_META: Record<SubProvider, SubProviderMeta> = {
  claude: {
    provider: 'claude',
    runtime: 'claude-code-cli',
    label: 'Claude (Anthropic)',
    bin: 'claude',
    login: ['claude', ['auth', 'login']],
    logout: ['claude', ['auth', 'logout']],
    installHint: 'claude CLI not installed',
  },
  chatgpt: {
    provider: 'chatgpt',
    runtime: 'codex',
    label: 'OpenAI (ChatGPT)',
    bin: 'codex',
    login: ['codex', ['login']],
    logout: ['codex', ['logout']],
    installHint: 'codex CLI not installed',
  },
  cursor: {
    provider: 'cursor',
    runtime: 'cursor-cli',
    label: 'Cursor',
    bin: 'cursor-agent',
    login: ['cursor-agent', ['login']],
    logout: ['cursor-agent', ['logout']],
    install: 'curl https://cursor.com/install -fsS | bash',
    installHint: 'cursor-agent not installed',
  },
  grok: {
    provider: 'grok',
    runtime: 'grok',
    label: 'xAI Grok Build',
    bin: 'grok',
    install: 'curl -fsSL https://x.ai/cli/install.sh | bash',
    installHint: 'grok CLI not installed',
    postInstall: 'After install, IDACC will detect the grok binary. IDACC does not open Grok from Settings; run grok in Terminal only when you choose to sign in.',
    statusNote: 'Installed. Grok account state is owned by its CLI; IDACC does not open it automatically.',
  },
  gemini: {
    provider: 'gemini',
    runtime: 'gemini',
    label: 'Google Gemini CLI',
    bin: 'gemini',
    install: 'npm install -g @google/gemini-cli',
    installHint: 'gemini CLI not installed',
    postInstall: 'After install, IDACC will detect the gemini binary. Account selection remains inside Gemini /auth, outside IDACC.',
    statusNote: 'Installed. Gemini account selection lives inside the CLI /auth flow; IDACC does not open it automatically.',
  },
  copilot: {
    provider: 'copilot',
    runtime: 'copilot',
    label: 'GitHub Copilot CLI',
    bin: 'copilot',
    install: 'npm install -g @github/copilot',
    installHint: 'copilot CLI not installed',
    postInstall: 'After install, IDACC will detect the copilot binary. Account selection remains inside Copilot /login, outside IDACC.',
    statusNote: 'Installed. Copilot sign-in lives inside its CLI /login flow; IDACC does not open it automatically.',
  },
  'kiro-cli': {
    provider: 'kiro-cli',
    runtime: 'kiro-cli',
    label: 'Kiro CLI',
    bin: 'kiro-cli',
    appPaths: ['/Applications/Kiro.app', '/Applications/Kiro CLI.app'],
    login: ['kiro-cli', ['login']],
    loginMode: 'terminal',
    logout: ['kiro-cli', ['logout']],
    install: 'curl -fsSL https://cli.kiro.dev/install | bash',
    installHint: 'kiro-cli not installed',
    installOpensApp: true,
    postInstall: 'The official macOS installer may open Kiro once to finish CLI setup. IDACC will re-check for kiro-cli after install; sign-in is still a separate action.',
  },
  q: {
    provider: 'q',
    runtime: 'q',
    label: 'Amazon Q CLI (legacy)',
    bin: 'q',
    login: ['q', ['login']],
    loginMode: 'terminal',
    logout: ['q', ['logout']],
    installHint: 'q CLI not installed; current Amazon Q CLI docs point users to Kiro CLI.',
    statusNote: 'Legacy Amazon Q CLI is treated as available when present; Kiro CLI is the current managed path.',
  },
};

/** Candidate CLI dirs (GUI apps inherit a minimal PATH). */
function cliDirs(): string[] {
  const home = homedir();
  return Array.from(new Set([
    '/opt/homebrew/bin',
    `${home}/.local/bin`,
    `${home}/.grok/bin`,
    '/usr/local/bin',
    '/usr/bin',
    '/bin',
    ...(process.env.PATH ? process.env.PATH.split(':') : []),
  ]));
}

/** GUI apps inherit a minimal PATH; add the usual CLI locations. */
function cliEnv(): NodeJS.ProcessEnv {
  return { ...process.env, PATH: cliDirs().join(':') };
}

/** Is a CLI binary installed (resolvable on the augmented PATH)? */
function cliPath(bin: string): string | undefined {
  return cliDirs().map((d) => `${d}/${bin}`).find((p) => existsSync(p));
}

function expandHome(p: string): string {
  return p.replace(/^~(?=\/|$)/, homedir());
}

function installEvidence(meta: SubProviderMeta): { installed: boolean; source?: string; detail?: string; cliPath?: string } {
  const binPath = cliPath(meta.bin);
  if (binPath) return { installed: true, source: binPath, detail: `${meta.bin} found at ${binPath}`, cliPath: binPath };
  for (const app of meta.appPaths ?? []) {
    const p = expandHome(app);
    if (existsSync(p)) return { installed: true, source: p, detail: `App installed at ${p}, but ${meta.bin} is not on PATH yet.` };
  }
  return { installed: false };
}

function shellQuote(arg: string): string {
  if (/^[A-Za-z0-9_./:=@%+-]+$/.test(arg)) return arg;
  return `'${arg.replace(/'/g, `'\\''`)}'`;
}

function commandLine([bin, args]: CommandSpec): string {
  return [bin, ...args].map(shellQuote).join(' ');
}

function truncateDetail(s: string): string {
  return s.replace(/\s+/g, ' ').trim().slice(0, 240);
}

function baseStatus(provider: SubProvider, patch: Partial<SubStatus>): SubStatus {
  const meta = SUB_META[provider];
  const evidence = installEvidence(meta);
  return {
    provider,
    runtime: meta.runtime,
    label: meta.label,
    loggedIn: false,
    installed: evidence.installed,
    installedSource: evidence.source,
    statusSupported: false,
    loginSupported: Boolean(meta.login),
    logoutSupported: Boolean(meta.logout),
    installSupported: Boolean(meta.install),
    installOpensApp: meta.installOpensApp,
    postInstall: meta.postInstall,
    detail: evidence.detail ?? meta.statusNote,
    ...patch,
  };
}

function notInstalled(provider: SubProvider): SubStatus {
  const meta = SUB_META[provider];
  return baseStatus(provider, { installed: false, detail: meta.installHint });
}

async function claudeStatus(): Promise<SubStatus> {
  if (!cliPath(SUB_META.claude.bin)) return notInstalled('claude');
  try {
    const { stdout } = await execFileP('claude', ['auth', 'status'], { env: cliEnv(), timeout: 8000 });
    const j = JSON.parse(stdout) as { loggedIn?: boolean; authMethod?: string; subscriptionType?: string; email?: string };
    return baseStatus('claude', { loggedIn: !!j.loggedIn, installed: true, statusSupported: true, plan: j.subscriptionType, email: j.email, method: j.authMethod });
  } catch (e: unknown) {
    return baseStatus('claude', { installed: true, statusSupported: true, detail: e instanceof Error ? truncateDetail(e.message) : truncateDetail(String(e)) });
  }
}

/** codex stores OAuth tokens at $CODEX_HOME/auth.json (default ~/.codex). */
function codexHome(): string {
  return process.env.CODEX_HOME || join(homedir(), '.codex');
}

/** Prettify an OpenAI `chatgpt_plan_type` token (best-effort; raw value as fallback). */
function prettyChatgptPlan(t: string): string {
  const map: Record<string, string> = {
    free: 'Free', plus: 'Plus', pro: 'Pro', prolite: 'Pro (lite)',
    team: 'Team', business: 'Business', enterprise: 'Enterprise', edu: 'Edu',
  };
  return map[t.toLowerCase()] ?? t.charAt(0).toUpperCase() + t.slice(1);
}

/**
 * Best-effort identity for a ChatGPT-authenticated codex install. `codex login
 * status` only prints "Logged in using ChatGPT" — the email and plan live in the
 * OAuth id_token (a JWT) inside ~/.codex/auth.json. We decode ONLY the JWT's
 * identity claims (email + plan); the access/refresh tokens are never read out.
 */
function codexAccount(): { email?: string; plan?: string } {
  try {
    const file = join(codexHome(), 'auth.json');
    if (!existsSync(file)) return {};
    const auth = JSON.parse(readFileSync(file, 'utf8')) as { tokens?: { id_token?: string } };
    const idToken = auth.tokens?.id_token;
    if (!idToken || idToken.split('.').length !== 3) return {};
    const payload = JSON.parse(Buffer.from(idToken.split('.')[1], 'base64url').toString('utf8')) as Record<string, unknown>;
    const email = typeof payload.email === 'string' ? payload.email : undefined;
    const authClaim = payload['https://api.openai.com/auth'] as { chatgpt_plan_type?: string } | undefined;
    const planType = authClaim?.chatgpt_plan_type;
    const plan = typeof planType === 'string' && planType ? prettyChatgptPlan(planType) : undefined;
    return { email, plan };
  } catch {
    return {};
  }
}

async function codexStatus(): Promise<SubStatus> {
  if (!cliPath(SUB_META.chatgpt.bin)) return notInstalled('chatgpt');
  try {
    const { stdout, stderr } = await execFileP('codex', ['login', 'status'], { env: cliEnv(), timeout: 8000 });
    const out = `${stdout}${stderr}`.trim();
    const loggedIn = /logged in/i.test(out);
    const acct = loggedIn ? codexAccount() : {};
    return baseStatus('chatgpt', { loggedIn, installed: true, statusSupported: true, plan: acct.plan, email: acct.email, detail: truncateDetail(out) });
  } catch (e: unknown) {
    const err = e as { stdout?: string; stderr?: string; message?: string };
    return baseStatus('chatgpt', { installed: true, statusSupported: true, detail: truncateDetail(err.stdout || err.stderr || err.message || '') });
  }
}

/** Cursor subscription via `cursor-agent status` (Pro/Business OAuth). */
async function cursorStatus(): Promise<SubStatus> {
  if (!cliPath(SUB_META.cursor.bin)) return notInstalled('cursor');
  try {
    const { stdout, stderr } = await execFileP('cursor-agent', ['status'], { env: cliEnv(), timeout: 8000 });
    const out = `${stdout}${stderr}`.trim();
    const loggedIn = /logged in|authenticated|signed in/i.test(out) && !/not logged in|not authenticated|signed out/i.test(out);
    const email = out.match(/[\w.+-]+@[\w.-]+\.\w+/)?.[0];
    return baseStatus('cursor', { loggedIn, installed: true, statusSupported: true, email, detail: truncateDetail(out) });
  } catch (e: unknown) {
    const err = e as { stdout?: string; stderr?: string; message?: string };
    return baseStatus('cursor', { installed: true, statusSupported: true, detail: truncateDetail(err.stdout || err.stderr || err.message || '') });
  }
}

async function whoamiStatus(provider: 'kiro-cli' | 'q', command: CommandSpec): Promise<SubStatus> {
  const meta = SUB_META[provider];
  const evidence = installEvidence(meta);
  if (!evidence.installed) return notInstalled(provider);
  if (!evidence.cliPath) {
    return baseStatus(provider, {
      installed: true,
      statusSupported: false,
      loginSupported: false,
      logoutSupported: false,
      detail: `${meta.label} is installed, but ${meta.bin} is not on PATH yet. Open the app once or add the CLI to PATH, then re-check.`,
    });
  }
  try {
    const { stdout, stderr } = await execFileP(command[0], command[1], { env: cliEnv(), timeout: 8000 });
    const out = `${stdout}${stderr}`.trim();
    const loggedIn = Boolean(out) && !/not logged in|not authenticated|signed out|no credentials|login required/i.test(out);
    const email = out.match(/[\w.+-]+@[\w.-]+\.\w+/)?.[0];
    return baseStatus(provider, { loggedIn, installed: true, statusSupported: true, email, detail: truncateDetail(out) });
  } catch (e: unknown) {
    const err = e as { stdout?: string; stderr?: string; message?: string };
    return baseStatus(provider, { installed: true, statusSupported: true, detail: truncateDetail(err.stdout || err.stderr || err.message || meta.statusNote || '') });
  }
}

async function cliPresenceStatus(provider: 'grok' | 'gemini' | 'copilot'): Promise<SubStatus> {
  const meta = SUB_META[provider];
  if (!cliPath(meta.bin)) return notInstalled(provider);
  return baseStatus(provider, { installed: true, statusSupported: false, detail: meta.statusNote });
}

async function providerStatus(provider: SubProvider): Promise<SubStatus> {
  switch (provider) {
    case 'claude': return claudeStatus();
    case 'chatgpt': return codexStatus();
    case 'cursor': return cursorStatus();
    case 'kiro-cli': return whoamiStatus('kiro-cli', ['kiro-cli', ['whoami']]);
    case 'q': return whoamiStatus('q', ['q', ['whoami']]);
    case 'grok':
    case 'gemini':
    case 'copilot':
      return cliPresenceStatus(provider);
  }
}

export async function subsStatus(): Promise<Record<SubProvider, SubStatus>> {
  const rows = await Promise.all(SUB_PROVIDERS.map(async (provider) => [provider, await providerStatus(provider)] as const));
  return Object.fromEntries(rows) as Record<SubProvider, SubStatus>;
}

/**
 * Kick off a visible CLI install. Opens the user's Terminal and runs the vendor's
 * official installer there — visible and abortable — and returns the command either
 * way so the UI can fall back to clipboard if macOS blocks Terminal automation.
 */
export async function subsInstall(provider: SubProvider): Promise<{ ok: boolean; ran: boolean; command?: string; error?: string; postInstall?: string; installOpensApp?: boolean }> {
  const meta = SUB_META[provider];
  if (!meta?.install) return { ok: false, ran: false, error: 'no installer available for this provider' };
  const r = await runInTerminal(meta.install);
  return { ok: r.ok, ran: r.ran, command: r.command, error: r.error, postInstall: meta.postInstall, installOpensApp: meta.installOpensApp };
}

/**
 * Launch the CLI OAuth/login flow. For fully non-interactive status/login CLIs we
 * spawn and open printed URLs; for TUI-first CLIs we open a real Terminal.
 */
export function subsSignin(provider: SubProvider): Promise<{ started: boolean; url?: string; command?: string; error?: string }> {
  const meta = SUB_META[provider];
  if (!meta?.login) return Promise.resolve({ started: false, error: 'no sign-in command available for this provider' });
  const [bin, args] = meta.login;
  if (!cliPath(bin)) {
    const evidence = installEvidence(meta);
    const detail = evidence.installed
      ? `${meta.label} is installed, but ${bin} is not on PATH yet. Open the app once or update PATH, then re-check.`
      : (meta.installHint ?? `${bin} is not installed`);
    return Promise.resolve({ started: false, error: detail });
  }
  if (meta.loginMode === 'terminal') {
    const cmd = commandLine(meta.login);
    return runInTerminal(cmd).then((r) => ({ started: r.ran, command: r.command, error: r.ran ? undefined : r.error }));
  }
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(bin, args, { env: cliEnv() });
    } catch (e) {
      return resolve({ started: false, error: e instanceof Error ? e.message : String(e) });
    }
    let url: string | undefined;
    let settled = false;
    const finish = () => {
      if (!settled) {
        settled = true;
        resolve({ started: true, url });
      }
    };
    const scan = (buf: Buffer) => {
      const m = buf.toString().match(/https?:\/\/[^\s'"]+/);
      if (m && !url) {
        url = m[0];
        void shell.openExternal(url).catch(() => {});
        finish();
      }
    };
    child.stdout?.on('data', scan);
    child.stderr?.on('data', scan);
    child.on('error', (e) => {
      if (!settled) {
        settled = true;
        resolve({ started: false, error: e.message });
      }
    });
    // If the CLI opened the browser itself without printing a URL, report started.
    setTimeout(finish, 6000);
  });
}

export async function subsSignout(provider: SubProvider): Promise<{ ok: boolean; error?: string }> {
  const meta = SUB_META[provider];
  if (!meta?.logout) return { ok: false, error: 'no sign-out command available for this provider' };
  const [bin, args] = meta.logout;
  try {
    await execFileP(bin, args, { env: cliEnv(), timeout: 15000 });
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}
