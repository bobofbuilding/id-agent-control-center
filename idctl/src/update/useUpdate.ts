/**
 * useUpdate — background update check feeding the TUI banner. Checks shortly
 * after mount (jittered) then on an interval; when a newer version is found and
 * autoStage is on, downloads + verifies + stages it so the next launch applies
 * it. Mirrors useManager's loop discipline.
 */

import { useEffect, useRef, useState, useCallback } from 'react';
import { checkForUpdate } from './check.ts';
import { downloadAndVerify } from './download.ts';
import { stageUpdate, readPending } from './stage.ts';
import type { UpdateInfo } from './types.ts';

export interface UpdateState {
  available?: UpdateInfo;
  staged: boolean;
  busy: boolean;
  lastError?: string;
}

export interface UseUpdateOpts {
  repo?: string;
  manifestUrl?: string;
  intervalHours: number;
  autoStage: boolean;
  enabled: boolean;
}

export function useUpdate(opts: UseUpdateOpts): UpdateState & { checkNow: () => void } {
  const [state, setState] = useState<UpdateState>({ busy: false, staged: !!readPending() });
  const ran = useRef(false);

  const stageNow = useCallback(async (info: UpdateInfo) => {
    setState((s) => ({ ...s, busy: true }));
    try {
      const dl = await downloadAndVerify(info);
      stageUpdate(info, dl);
      setState((s) => ({ ...s, busy: false, staged: true, available: info }));
    } catch (e) {
      setState((s) => ({ ...s, busy: false, lastError: e instanceof Error ? e.message : String(e) }));
    }
  }, []);

  const checkNow = useCallback(async () => {
    if (!opts.enabled) return;
    setState((s) => ({ ...s, busy: true }));
    const res = await checkForUpdate({
      repo: opts.repo,
      manifestUrl: opts.manifestUrl,
      intervalHours: opts.intervalHours,
      force: true,
    });
    if (res.status === 'available') {
      setState((s) => ({ ...s, busy: false, available: res.info }));
      if (opts.autoStage) void stageNow(res.info);
    } else {
      setState((s) => ({
        ...s,
        busy: false,
        lastError: res.status === 'error' ? res.message : undefined,
      }));
    }
  }, [opts, stageNow]);

  useEffect(() => {
    if (!opts.enabled || ran.current) return;
    ran.current = true;
    const t = setTimeout(checkNow, 2000 + Math.random() * 6000); // jitter
    const iv = setInterval(checkNow, Math.max(1, opts.intervalHours) * 3600_000);
    return () => {
      clearTimeout(t);
      clearInterval(iv);
    };
  }, [opts.enabled, opts.intervalHours, checkNow]);

  return { ...state, checkNow };
}
