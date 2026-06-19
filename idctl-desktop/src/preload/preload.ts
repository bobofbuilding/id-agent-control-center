/**
 * Preload: exposes a tiny, safe `window.idagents` API to the renderer. The
 * renderer can only invoke the allowlisted bridge methods — no Node, no direct
 * network, no fs.
 */

import { contextBridge, ipcRenderer } from 'electron';

export interface IdAgentsApi {
  call<T = unknown>(method: string, ...args: unknown[]): Promise<{ ok: boolean; result?: T; error?: string }>;
  /** Subscribe to self-update status pushes from the main process. Returns an unsubscribe fn. */
  onUpdateStatus(cb: (status: unknown) => void): () => void;
}

const api: IdAgentsApi = {
  call: (method, ...args) => ipcRenderer.invoke('idagents:call', method, args),
  onUpdateStatus: (cb) => {
    const listener = (_e: unknown, status: unknown) => cb(status);
    ipcRenderer.on('update:status', listener);
    return () => ipcRenderer.removeListener('update:status', listener);
  },
};

contextBridge.exposeInMainWorld('idagents', api);
