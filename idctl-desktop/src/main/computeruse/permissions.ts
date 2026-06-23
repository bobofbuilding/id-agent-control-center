/**
 * macOS TCC permission detection + deep-links for Computer Use.
 *
 * - Screen Recording (needed to capture the screen) — detected via
 *   systemPreferences.getMediaAccessStatus('screen'). macOS has no programmatic
 *   "request" for screen capture; the prompt appears the first time we capture,
 *   and the grant only takes effect after the app is relaunched — so we detect +
 *   deep-link + offer a relaunch rather than silently failing.
 * - Accessibility (needed in Phase 1 to inject mouse/keyboard) — detected via
 *   systemPreferences.isTrustedAccessibilityClient(false) (false = don't prompt).
 */
import { app, shell, systemPreferences } from 'electron';

export interface CuPermissions {
  screenRecording: 'granted' | 'denied' | 'restricted' | 'not-determined' | 'unknown';
  /** Accessibility is only required for input (Phase 1); reported now so the UI can show both. */
  accessibility: boolean;
  platform: string;
}

export function getPermissions(): CuPermissions {
  if (process.platform !== 'darwin') {
    return { screenRecording: 'unknown', accessibility: false, platform: process.platform };
  }
  let screenRecording: CuPermissions['screenRecording'] = 'unknown';
  try {
    screenRecording = systemPreferences.getMediaAccessStatus('screen') as CuPermissions['screenRecording'];
  } catch { /* older electron / non-mac */ }
  let accessibility = false;
  try {
    accessibility = systemPreferences.isTrustedAccessibilityClient(false);
  } catch { /* */ }
  return { screenRecording, accessibility, platform: 'darwin' };
}

/** Is Accessibility (synthetic input) granted to this app? (false = don't prompt.) */
export function accessibilityGranted(): boolean {
  if (process.platform !== 'darwin') return false;
  try { return systemPreferences.isTrustedAccessibilityClient(false); } catch { return false; }
}

/** Open the exact System Settings pane for a permission. */
export async function openPermissionSettings(which: 'screen' | 'accessibility'): Promise<void> {
  const url = which === 'screen'
    ? 'x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture'
    : 'x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility';
  await shell.openExternal(url);
}

/** Relaunch the app (Screen Recording grants only take effect after a restart). */
export function relaunchApp(): void {
  app.relaunch();
  app.exit(0);
}
