/**
 * Subscription auth for the Claude / ChatGPT runtimes. These use the CLIs'
 * OAuth login (claude.ai / ChatGPT), NOT the metered API — so an agent on the
 * claude-* or codex runtime runs on the user's subscription with no API key.
 *
 *   claude auth status | login | logout   → Claude (claude.ai) subscription
 *   codex  login status | login | logout  → ChatGPT subscription
 *
 * status is read-only; signin spawns the CLI which opens the browser for the
 * user to authenticate (we never handle credentials ourselves).
 */

import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { homedir } from 'node:os';
import { shell } from 'electron';

const execFileP = promisify(execFile);

/** GUI apps inherit a minimal PATH — add the usual CLI locations so claude/codex resolve. */
function cliEnv(): NodeJS.ProcessEnv {
  const home = homedir();
  const dirs = ['/opt/homebrew/bin', `${home}/.local/bin`, '/usr/local/bin', '/usr/bin', '/bin'];
  const existing = process.env.PATH ? process.env.PATH.split(':') : [];
  return { ...process.env, PATH: [...dirs, ...existing].join(':') };
}

export interface SubStatus {
  provider: 'claude' | 'chatgpt';
  loggedIn: boolean;
  plan?: string;
  email?: string;
  method?: string;
  detail?: string;
}

async function claudeStatus(): Promise<SubStatus> {
  try {
    const { stdout } = await execFileP('claude', ['auth', 'status'], { env: cliEnv(), timeout: 8000 });
    const j = JSON.parse(stdout) as { loggedIn?: boolean; authMethod?: string; subscriptionType?: string; email?: string };
    return { provider: 'claude', loggedIn: !!j.loggedIn, plan: j.subscriptionType, email: j.email, method: j.authMethod };
  } catch (e: unknown) {
    return { provider: 'claude', loggedIn: false, detail: e instanceof Error ? e.message : String(e) };
  }
}

async function codexStatus(): Promise<SubStatus> {
  try {
    const { stdout, stderr } = await execFileP('codex', ['login', 'status'], { env: cliEnv(), timeout: 8000 });
    const out = `${stdout}${stderr}`.trim();
    return { provider: 'chatgpt', loggedIn: /logged in/i.test(out), detail: out };
  } catch (e: unknown) {
    const err = e as { stdout?: string; message?: string };
    return { provider: 'chatgpt', loggedIn: false, detail: (err.stdout || err.message || '').trim() };
  }
}

export async function subsStatus(): Promise<{ claude: SubStatus; chatgpt: SubStatus }> {
  const [claude, chatgpt] = await Promise.all([claudeStatus(), codexStatus()]);
  return { claude, chatgpt };
}

/**
 * Launch the CLI OAuth login. The CLI opens the browser (we also open any URL
 * it prints, as a fallback). Resolves once the flow is underway — the user
 * completes sign-in in the browser, then re-checks status.
 */
export function subsSignin(provider: 'claude' | 'chatgpt'): Promise<{ started: boolean; url?: string; error?: string }> {
  const [bin, args] = provider === 'claude' ? ['claude', ['auth', 'login']] : ['codex', ['login']];
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

export async function subsSignout(provider: 'claude' | 'chatgpt'): Promise<{ ok: boolean; error?: string }> {
  const [bin, args] = provider === 'claude' ? ['claude', ['auth', 'logout']] : ['codex', ['logout']];
  try {
    await execFileP(bin, args, { env: cliEnv(), timeout: 15000 });
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}
