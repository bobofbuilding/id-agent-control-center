/**
 * Screen capture for Computer Use — Phase 0, NO native module.
 *
 * Uses Electron's built-in desktopCapturer + screen APIs, so the capture is
 * attributed to THIS app bundle in macOS's Screen Recording permission list
 * (a recognizable name the user can grant), and there's nothing to compile or
 * unpack from the asar. The same single capture feeds BOTH the agent-facing
 * screenshot tool (full-res PNG, lossless so the model can read text) and the
 * live pane (downscaled JPEG, small + smooth).
 */
import { desktopCapturer, screen } from 'electron';

export interface DisplayInfo {
  id: number;
  /** Logical (points) bounds of the display — used for pane-click → host-coordinate mapping. */
  bounds: { x: number; y: number; width: number; height: number };
  scaleFactor: number;
}
export interface Frame {
  buf: Buffer;
  /** Pixel dimensions of `buf` (already downscaled for the pump; full-res for screenshots). */
  width: number;
  height: number;
  format: 'jpeg' | 'png';
  display: DisplayInfo;
  ts: number;
}

export function primaryDisplayInfo(): DisplayInfo {
  const d = screen.getPrimaryDisplay();
  return { id: d.id, bounds: d.bounds, scaleFactor: d.scaleFactor };
}

/**
 * Grab the primary display. Returns null when Screen Recording isn't granted
 * (the thumbnail comes back empty), so callers can surface the permission state
 * instead of streaming a black frame.
 */
export async function capturePrimary(opts: { maxWidth?: number; format?: 'jpeg' | 'png'; quality?: number }): Promise<Frame | null> {
  const disp = screen.getPrimaryDisplay();
  const scale = disp.scaleFactor || 1;
  const fullW = Math.max(1, Math.round(disp.size.width * scale));
  const fullH = Math.max(1, Math.round(disp.size.height * scale));
  const targetW = opts.maxWidth && opts.maxWidth < fullW ? Math.round(opts.maxWidth) : fullW;
  const targetH = Math.max(1, Math.round(targetW * (fullH / fullW)));
  let sources;
  try {
    sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: targetW, height: targetH } });
  } catch {
    return null; // permission denied / capture unavailable
  }
  const src = sources.find((s) => s.display_id === String(disp.id)) || sources[0];
  if (!src || src.thumbnail.isEmpty()) return null;
  const img = src.thumbnail;
  const sz = img.getSize();
  const format = opts.format ?? 'jpeg';
  const buf = format === 'jpeg' ? img.toJPEG(Math.min(100, Math.max(1, opts.quality ?? 60))) : img.toPNG();
  return { buf, width: sz.width, height: sz.height, format, display: { id: disp.id, bounds: disp.bounds, scaleFactor: scale }, ts: Date.now() };
}
