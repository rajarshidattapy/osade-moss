/**
 * VS Code zoom: factor = 1.2 ^ level, Ctrl+= / Ctrl+- / Ctrl+0, clamped to ±8.
 */

export const ZOOM_STEP = 1.2;
export const ZOOM_MIN = -8;
export const ZOOM_MAX = 8;

export function clampZoomLevel(level: number): number {
  return Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, Math.round(level)));
}

export function zoomFactor(level: number): number {
  return Number((ZOOM_STEP ** clampZoomLevel(level)).toFixed(4));
}

export function levelFromFactor(factor: number): number {
  if (!(factor > 0) || !Number.isFinite(factor)) return 0;
  return clampZoomLevel(Math.log(factor) / Math.log(ZOOM_STEP));
}

export function parseZoomLevel(raw: string | null | undefined): number {
  if (raw == null || raw.trim() === '') return 0;
  const n = Number(raw);
  if (!Number.isFinite(n)) return 0;
  return clampZoomLevel(n);
}

export type ZoomAction = 'in' | 'out' | 'reset';

export function zoomActionFromInput(input: {
  type: string;
  key: string;
  code: string;
  control: boolean;
  meta: boolean;
  alt: boolean;
}): ZoomAction | null {
  if (input.type !== 'keyDown') return null;
  if (!(input.control || input.meta) || input.alt) return null;
  const { key, code } = input;
  if (code === 'Equal' || code === 'NumpadAdd' || key === '+' || key === '=') return 'in';
  if (code === 'Minus' || code === 'NumpadSubtract' || key === '-' || key === '_') return 'out';
  if (code === 'Digit0' || code === 'Numpad0' || key === '0') return 'reset';
  return null;
}
