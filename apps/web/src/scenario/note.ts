/**
 * Where the assumed note draws (fields/kit.tsx): above its control, or below it when what clips the control (the
 * scrolling column, the window) leaves too little room above and more below.
 */

export type NoteSide = 'above' | 'below';

interface Span {
  top: number;
  bottom: number;
}

export function noteSide(control: Span, clip: Span, height: number): NoteSide {
  const above = control.top - clip.top;
  const below = clip.bottom - control.bottom;
  return above < height && below > above ? 'below' : 'above';
}

/** The overflow values that clip what spills out of a box. */
const CLIPPING = new Set(['auto', 'scroll', 'hidden', 'clip']);

/** The part of the window an element can be seen in: the window, cut by every ancestor that clips its overflow. */
export function clipOf(el: Element): Span {
  let top = 0;
  let bottom = window.innerHeight;
  for (let box = el.parentElement; box; box = box.parentElement) {
    if (!CLIPPING.has(getComputedStyle(box).overflowY)) continue;
    const inner = box.getBoundingClientRect().top + box.clientTop;
    top = Math.max(top, inner);
    bottom = Math.min(bottom, inner + box.clientHeight);
  }
  return { top, bottom };
}
