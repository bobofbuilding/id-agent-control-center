/**
 * Computer Use BROKER — the single host-side controller (Phase 0).
 *
 * A loopback-only (127.0.0.1) HTTP server that is the ONLY thing which ever
 * touches the screen. The agent-facing MCP server is a dumb proxy that forwards
 * each tool call here over a bearer token; this broker is the one chokepoint
 * where ARM/DISARM (and, in later phases, the bless-list, one-driver lock, panic,
 * and audit) are ENFORCED — an agent can only REQUEST, only the broker ACTS.
 *
 * Phase 0 scope: screenshot (read-only, armed-gated) + a live JPEG frame pump to
 * the app's Computer Use pane. Input actions (click/type/…) return a structured
 * `blocked` so the model knows they aren't wired yet (Phase 1 adds them here).
 */
import http from 'node:http';
import { randomBytes } from 'node:crypto';
import { mkdirSync, writeFileSync, readFileSync, existsSync, copyFileSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { app } from 'electron';
import { capturePrimary, primaryDisplayInfo, type Frame } from './capture.ts';

const PORT_RANGE = [4180, 4181, 4182, 4183, 4184, 4185];
const PUMP_MS = 450;          // ~2.2 fps live pane (cheap, smooth enough to supervise)
const PUMP_MAX_WIDTH = 1280;  // downscale the pane stream; agent screenshots stay full-res
const PUMP_QUALITY = 55;

function cuDir(): string {
  const d = join(homedir(), '.config', 'idctl', 'computeruse');
  mkdirSync(d, { recursive: true, mode: 0o700 }); // 0700: the dir holds the broker token
  try { chmodSync(d, 0o700); } catch { /* tighten even if it pre-existed at a looser mode */ }
  return d;
}
function sessionFile(): string { return join(cuDir(), 'session.json'); }
/** Stable absolute path the attached MCP server is run from (copied from the bundle on launch). */
export function brokerServerPath(): string { return join(cuDir(), 'server.mjs'); }

interface BrokerState {
  server: http.Server | null;
  port: number;
  token: string;
  armed: boolean;
  watching: boolean;          // the live pane is on screen → only then do we run the frame pump
  onFrame: ((f: { jpegBase64: string; width: number; height: number; display: Frame['display']; ts: number; driver: 'agent' | 'none' }) => void) | null;
  pump: NodeJS.Timeout | null;
  lastSig: number;            // dirty-frame skip (FNV-1a over the jpeg bytes)
  lastAgent: string;          // most recent caller (for the pane label)
  actions: number;            // lifetime action count
  captureFailing: boolean;    // last pump capture returned null while armed (permission/relaunch hint)
}
const S: BrokerState = { server: null, port: 0, token: '', armed: false, watching: false, onFrame: null, pump: null, lastSig: 0, lastAgent: '', actions: 0, captureFailing: false };

const TOKEN_RE = /^[0-9a-f]{48}$/; // randomBytes(24).toString('hex')
function loadOrMakeToken(): { token: string } {
  try {
    const j = JSON.parse(readFileSync(sessionFile(), 'utf8'));
    if (j && typeof j.token === 'string' && TOKEN_RE.test(j.token)) return { token: j.token };
  } catch { /* generate fresh */ }
  return { token: randomBytes(24).toString('hex') };
}

/** Copy the bundled MCP server next to the session file so the agent runs a stable absolute path. */
function stageServerFile(): void {
  try {
    const src = app.isPackaged
      ? join(process.resourcesPath, 'computeruse-mcp', 'server.mjs')
      : join(__dirname, '../../resources/computeruse-mcp/server.mjs');
    if (existsSync(src)) copyFileSync(src, brokerServerPath());
  } catch { /* the view surfaces 'server unavailable' if attach later fails */ }
}

function writeSession(): void {
  const payload = JSON.stringify({ url: `http://127.0.0.1:${S.port}`, token: S.token, port: S.port, pid: process.pid, updatedAt: Date.now() });
  try { writeFileSync(sessionFile(), payload, { mode: 0o600 }); } catch { /* */ }
}

declare const __dirname: string;

async function listen(server: http.Server): Promise<number> {
  for (const p of PORT_RANGE) {
    const ok = await new Promise<boolean>((resolve) => {
      const onErr = () => { server.removeListener('error', onErr); resolve(false); };
      server.once('error', onErr);
      server.listen(p, '127.0.0.1', () => { server.removeListener('error', onErr); resolve(true); });
    });
    if (ok) return p;
  }
  throw new Error('no free loopback port for the computer-use broker');
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    let b = ''; let n = 0;
    req.on('data', (c) => { n += c.length; if (n > 1_000_000) { req.destroy(); resolve(''); return; } b += c; });
    req.on('end', () => resolve(b));
    req.on('error', () => resolve(''));
  });
}

/** Phase 0 action handler. Only screenshot mutates nothing; input is not yet wired. */
async function handleAction(body: { type?: string; agent?: string }): Promise<{ status: number; json: Record<string, unknown> }> {
  const type = String(body?.type || '');
  if (body?.agent) S.lastAgent = String(body.agent).slice(0, 64);
  if (type === 'status' || type === 'ping') {
    return { status: 200, json: { ok: true, armed: S.armed, phase: 0 } };
  }
  if (type === 'screenshot') {
    if (!S.armed) return { status: 200, json: { ok: false, blocked: true, reason: 'disarmed', message: 'Computer Use is off — open ID Agents Control Center → Computer Use and press Arm.' } };
    const f = await capturePrimary({ format: 'png' });
    if (!f) return { status: 200, json: { ok: false, blocked: true, reason: 'screen_recording_permission', message: 'Screen Recording permission is not granted to ID Agents Control Center.' } };
    S.actions++;
    return { status: 200, json: { ok: true, image: f.buf.toString('base64'), mimeType: 'image/png', width: f.width, height: f.height, display: f.display } };
  }
  // Input verbs exist in the schema so the model can discover them, but Phase 0
  // doesn't execute them — return a clear, non-fatal block.
  if (['mouse_move', 'left_click', 'right_click', 'double_click', 'type', 'key', 'scroll', 'left_click_drag'].includes(type)) {
    return { status: 200, json: { ok: false, blocked: true, reason: 'input_not_enabled', message: 'Input control ships in a later update; this build is screenshot + live-view only.' } };
  }
  return { status: 200, json: { ok: false, blocked: true, reason: 'unknown_action', message: `unknown action "${type}"` } };
}

export async function startBroker(onFrame: BrokerState['onFrame']): Promise<void> {
  if (S.server) { S.onFrame = onFrame; return; }
  S.onFrame = onFrame;
  S.token = loadOrMakeToken().token;
  stageServerFile();
  const server = http.createServer(async (req, res) => {
    const send = (status: number, json: unknown) => { const s = JSON.stringify(json); res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(s) }); res.end(s); };
    // DNS-rebinding / cross-origin defense: the legitimate caller is the MCP server
    // (Node fetch — no Origin header, Host = 127.0.0.1). A browser page POSTing here
    // would carry an Origin and/or a non-loopback Host. Reject those even though they
    // lack the token, so a hostile page can't even probe.
    if (req.headers['origin']) return send(403, { ok: false, blocked: true, reason: 'forbidden_origin' });
    const host = String(req.headers['host'] || '').split(':')[0];
    if (host && host !== '127.0.0.1' && host !== 'localhost') return send(403, { ok: false, blocked: true, reason: 'forbidden_host' });
    // Loopback-only is already enforced by binding 127.0.0.1; double-check the auth.
    const auth = req.headers['authorization'] || '';
    const tok = typeof auth === 'string' && auth.startsWith('Bearer ') ? auth.slice(7) : '';
    if (req.method === 'POST' && req.url === '/action') {
      if (tok !== S.token) return send(401, { ok: false, blocked: true, reason: 'bad_token' });
      let parsed: { type?: string; agent?: string } = {};
      try { parsed = JSON.parse(await readBody(req)); } catch { /* */ }
      const r = await handleAction(parsed);
      return send(r.status, r.json);
    }
    send(404, { ok: false, error: 'not found' });
  });
  S.port = await listen(server);
  S.server = server;
  writeSession();
}

function hashBuf(b: Buffer): number {
  // FNV-1a over the whole jpeg — full coverage (no false "unchanged" collisions),
  // ~negligible cost at this size/cadence. Static screen → identical → skipped.
  let h = 0x811c9dc5;
  for (let i = 0; i < b.length; i++) { h ^= b[i]; h = Math.imul(h, 0x01000193); }
  return h >>> 0;
}

async function pumpOnce(): Promise<void> {
  if (!S.armed || !S.watching || !S.onFrame) return;
  const f = await capturePrimary({ maxWidth: PUMP_MAX_WIDTH, format: 'jpeg', quality: PUMP_QUALITY });
  if (!f) { S.captureFailing = true; return; } // permission/relaunch — the view surfaces a hint
  S.captureFailing = false;
  if (!S.armed || !S.watching) return;
  const sig = hashBuf(f.buf);
  if (sig === S.lastSig) return; // unchanged screen → don't flood the renderer
  S.lastSig = sig;
  S.onFrame({ jpegBase64: f.buf.toString('base64'), width: f.width, height: f.height, display: f.display, ts: f.ts, driver: 'agent' });
}

/** The pump (full-screen capture) runs ONLY while armed AND someone is watching the
 *  live pane — so navigating away or hiding the view stops the capture entirely.
 *  (The agent's on-demand screenshot tool still works while armed, independent of this.) */
function reconcilePump(): void {
  const want = S.armed && S.watching;
  if (want && !S.pump) { S.lastSig = 0; S.pump = setInterval(() => { void pumpOnce(); }, PUMP_MS); void pumpOnce(); }
  else if (!want && S.pump) { clearInterval(S.pump); S.pump = null; }
}

export function armBroker(): { ok: boolean; port: number } {
  S.armed = true;
  reconcilePump();
  return { ok: true, port: S.port };
}

export function disarmBroker(): { ok: boolean } {
  S.armed = false;
  S.captureFailing = false;
  reconcilePump();
  return { ok: true };
}

/** The renderer calls this when the Computer Use view mounts (true) / unmounts (false). */
export function setWatching(on: boolean): { ok: boolean } {
  S.watching = !!on;
  reconcilePump();
  return { ok: true };
}

export function brokerStatus(): { armed: boolean; watching: boolean; port: number; url: string; lastAgent: string; actions: number; serverStaged: boolean; captureFailing: boolean } {
  return { armed: S.armed, watching: S.watching, port: S.port, url: S.port ? `http://127.0.0.1:${S.port}` : '', lastAgent: S.lastAgent, actions: S.actions, serverStaged: existsSync(brokerServerPath()), captureFailing: S.captureFailing };
}

export function stopBroker(): void {
  disarmBroker();
  try { S.server?.close(); } catch { /* */ }
  S.server = null;
}

/** Display geometry for the pane's coordinate overlay (Phase 0: informational). */
export function brokerDisplay() { return primaryDisplayInfo(); }
