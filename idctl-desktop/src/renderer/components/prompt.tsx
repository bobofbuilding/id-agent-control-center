/**
 * In-app text prompt — Electron's window.prompt() is unsupported (returns null),
 * so views use usePrompt() instead. Promise-based, modal, Enter/Esc to submit/cancel.
 */
import { createContext, useCallback, useContext, useState, type ReactNode } from 'react';

export interface PromptOptions {
  title: string;
  defaultValue?: string;
  placeholder?: string;
  okLabel?: string;
}
type PromptFn = (opts: PromptOptions) => Promise<string | null>;

const PromptCtx = createContext<PromptFn>(async () => null);
export const usePrompt = (): PromptFn => useContext(PromptCtx);

interface State extends PromptOptions {
  value: string;
  resolve: (v: string | null) => void;
}

export function PromptProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<State | null>(null);

  const prompt = useCallback<PromptFn>(
    (opts) =>
      new Promise<string | null>((resolve) => {
        setState({ ...opts, value: opts.defaultValue ?? '', resolve });
      }),
    [],
  );

  function close(v: string | null) {
    state?.resolve(v);
    setState(null);
  }

  return (
    <PromptCtx.Provider value={prompt}>
      {children}
      {state ? (
        <div className="modal-overlay" onMouseDown={() => close(null)}>
          <div className="modal" onMouseDown={(e) => e.stopPropagation()}>
            <div className="modal-title">{state.title}</div>
            <input
              autoFocus
              className="composer-input"
              value={state.value}
              placeholder={state.placeholder}
              onChange={(e) => setState((s) => (s ? { ...s, value: e.target.value } : s))}
              onKeyDown={(e) => {
                if (e.key === 'Enter') close(state.value);
                else if (e.key === 'Escape') close(null);
              }}
            />
            <div className="row-actions" style={{ marginTop: 14 }}>
              <button className="btn" onMouseDown={() => close(null)}>
                Cancel
              </button>
              <button className="btn primary" onMouseDown={() => close(state.value)}>
                {state.okLabel ?? 'OK'}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </PromptCtx.Provider>
  );
}
