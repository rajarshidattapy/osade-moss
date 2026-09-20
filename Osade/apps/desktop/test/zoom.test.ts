import { describe, expect, it } from 'vitest';

import {
  clampZoomLevel,
  levelFromFactor,
  parseZoomLevel,
  zoomActionFromInput,
  zoomFactor,
} from '../src/main/zoom.js';

function key(
  partial: Partial<{
    type: string;
    key: string;
    code: string;
    control: boolean;
    meta: boolean;
    alt: boolean;
  }>,
) {
  return {
    type: 'keyDown',
    key: '',
    code: '',
    control: false,
    meta: false,
    alt: false,
    ...partial,
  };
}

describe('zoom', () => {
  it('maps levels the way VS Code does: 1.2 ^ n', () => {
    expect(zoomFactor(0)).toBe(1);
    expect(zoomFactor(1)).toBe(1.2);
    expect(zoomFactor(-1)).toBe(0.8333);
    expect(levelFromFactor(1.2)).toBe(1);
    expect(levelFromFactor(1)).toBe(0);
  });

  it('clamps and parses saved values', () => {
    expect(clampZoomLevel(99)).toBe(8);
    expect(clampZoomLevel(-99)).toBe(-8);
    expect(parseZoomLevel('2')).toBe(2);
    expect(parseZoomLevel('nope')).toBe(0);
    expect(parseZoomLevel('')).toBe(0);
  });

  it('treats Ctrl+= / Ctrl++ as zoom in, Ctrl+- as out, Ctrl+0 as reset', () => {
    expect(zoomActionFromInput(key({ control: true, code: 'Equal', key: '=' }))).toBe('in');
    expect(zoomActionFromInput(key({ control: true, code: 'Equal', key: '+' }))).toBe('in');
    expect(zoomActionFromInput(key({ control: true, code: 'NumpadAdd', key: '+' }))).toBe('in');
    expect(zoomActionFromInput(key({ control: true, code: 'Minus', key: '-' }))).toBe('out');
    expect(zoomActionFromInput(key({ control: true, code: 'Digit0', key: '0' }))).toBe('reset');
    expect(zoomActionFromInput(key({ control: true, code: 'KeyK', key: 'k' }))).toBeNull();
    expect(zoomActionFromInput(key({ code: 'Equal', key: '=' }))).toBeNull();
  });
});
