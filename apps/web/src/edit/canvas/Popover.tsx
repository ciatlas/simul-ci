import { type ReactNode, useLayoutEffect, useRef } from 'react';

/**
 * A popover at a card, a frame or an outline row (synthesis § 4.2): the platform's (`popover="auto"`), in the top
 * layer, so Escape and a click outside close it and a modal question opening over it closes it too. Base UI's
 * Popover with its positioning would cost the edit runtime about 9 kB gzipped more, and its Combobox 33 kB; this is a
 * fixed box placed beside or under its anchor, inside the window. Once shown it puts the focus on its
 * `data-autofocus` element (React's `autoFocus` runs before the box is shown, when nothing in it can take the focus),
 * and it gives the focus back to where it was when it closes with the focus inside it.
 */

export type Side = 'right' | 'below';

interface Box {
  left: number;
  top: number;
  width: number;
  height: number;
}

const GAP = 8;
const MARGIN = 8;

/** Where a box of `size` goes beside (`right`, else left of) or under (`below`, else above) its anchor, in the window. */
function placeAt(
  anchor: Box | undefined,
  size: { width: number; height: number },
  view: { width: number; height: number },
  side: Side,
): { left: number; top: number } {
  const clamp = (at: number, length: number, room: number): number =>
    Math.max(MARGIN, Math.min(at, room - length - MARGIN));
  if (!anchor) return { left: clamp((view.width - size.width) / 2, size.width, view.width), top: 80 };
  if (side === 'right') {
    const right = anchor.left + anchor.width + GAP;
    const left = right + size.width + MARGIN <= view.width ? right : anchor.left - GAP - size.width;
    return { left: clamp(left, size.width, view.width), top: clamp(anchor.top, size.height, view.height) };
  }
  const below = anchor.top + anchor.height + GAP;
  const top = below + size.height + MARGIN <= view.height ? below : anchor.top - GAP - size.height;
  return { left: clamp(anchor.left, size.width, view.width), top: clamp(top, size.height, view.height) };
}

export function AnchoredPopover({
  anchor,
  side,
  label,
  onClose,
  role = 'dialog',
  className = '',
  children,
}: {
  anchor: Element | undefined;
  side: Side;
  label: string;
  onClose: () => void;
  role?: 'dialog' | 'menu' | 'note';
  className?: string;
  children: ReactNode;
}) {
  const box = useRef<HTMLDivElement>(null);
  const closed = useRef(onClose);
  closed.current = onClose;
  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return undefined;
    const back = document.activeElement;
    // happy-dom, under the unit tests, has no popovers: the box simply shows.
    if (typeof el.showPopover === 'function') el.showPopover();
    const rect = anchor?.isConnected ? anchor.getBoundingClientRect() : undefined;
    const at = placeAt(rect, el.getBoundingClientRect(), { width: innerWidth, height: innerHeight }, side);
    el.style.left = `${at.left}px`;
    el.style.top = `${at.top}px`;
    el.querySelector<HTMLElement>('[data-autofocus]')?.focus();
    const toggled = (e: Event): void => {
      if ((e as ToggleEvent).newState === 'closed') closed.current();
    };
    el.addEventListener('toggle', toggled);
    return () => {
      el.removeEventListener('toggle', toggled);
      const inside = el.contains(document.activeElement) || document.activeElement === document.body;
      if (typeof el.hidePopover === 'function' && el.matches(':popover-open')) el.hidePopover();
      if (inside && back instanceof HTMLElement && back.isConnected) back.focus({ preventScroll: true });
    };
  }, [anchor, side]);
  return (
    <div
      ref={box}
      popover="auto"
      role={role}
      aria-label={label}
      className={`fixed inset-auto m-0 rounded-lg border border-border bg-surface p-3 text-text text-xs shadow-none ${className}`}
    >
      {children}
    </div>
  );
}
