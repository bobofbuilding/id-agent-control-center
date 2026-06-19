/**
 * AppContext threads the shared store and a few app-level callbacks down to
 * every view without prop-drilling.
 *
 *  - setCapture(true)  tells the App shell to stop handling global nav keys,
 *    so a view's text input can own the keyboard. Always pair true/false.
 *  - flash(msg)        shows a transient one-line message in the status hint.
 */

import { createContext, useContext } from 'react';
import type { ManagerStore } from '../store/useManager.ts';
import type { ViewId } from './views.ts';

export interface AppCtx {
  store: ManagerStore;
  setCapture: (capture: boolean) => void;
  flash: (message: string, kind?: 'info' | 'ok' | 'err') => void;
  /** Programmatically switch the active view (e.g. drill from overview → dash). */
  goto: (view: ViewId) => void;
  exit: () => void;
}

export const AppContext = createContext<AppCtx | null>(null);

export function useAppCtx(): AppCtx {
  const ctx = useContext(AppContext);
  if (!ctx) throw new Error('AppContext missing');
  return ctx;
}
