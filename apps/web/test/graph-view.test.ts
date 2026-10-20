import { describe, expect, it } from 'vitest';
import { doubleClickZoom, mountView } from '../src/graph/view';

const LIMITS = { min: 0.2, max: 2 };

describe('where the viewport starts', () => {
  it('fits the first picture of a source, and of every source after it', () => {
    expect(mountView(undefined, 1)).toEqual({ fit: true });
    expect(mountView({ epoch: 1, viewport: { x: 10, y: 20, zoom: 0.8 } }, 2)).toEqual({ fit: true });
  });

  it('opens a picture of the same source where the author left it, its texts edited or not', () => {
    const viewport = { x: -120, y: 40, zoom: 1.5 };
    expect(mountView({ epoch: 3, viewport }, 3)).toEqual({ fit: false, viewport });
  });
});

describe('a double-click', () => {
  it('zooms in twice as far about the pointer, the point under it staying there', () => {
    const at = { x: 100, y: 50, zoom: 1 };
    const next = doubleClickZoom(at, { x: 300, y: 250 }, false, LIMITS);
    expect(next).toEqual({ x: -100, y: -150, zoom: 2 });
    // The flow point under the pointer: (300 - 100) / 1 before, (300 + 100) / 2 after.
    expect((300 - next.x) / next.zoom).toBe((300 - at.x) / at.zoom);
  });

  it('zooms out by half with Shift, and never past the canvas limits', () => {
    expect(doubleClickZoom({ x: 0, y: 0, zoom: 1 }, { x: 0, y: 0 }, true, LIMITS).zoom).toBe(0.5);
    expect(doubleClickZoom({ x: 0, y: 0, zoom: 1.5 }, { x: 0, y: 0 }, false, LIMITS).zoom).toBe(2);
    expect(doubleClickZoom({ x: 0, y: 0, zoom: 0.3 }, { x: 0, y: 0 }, true, LIMITS).zoom).toBe(0.2);
  });
});
