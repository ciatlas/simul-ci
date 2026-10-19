import type { Tri } from '@simulci/engine';

/**
 * The run-state mark: a filled circle runs, a ring is skipped, a half-filled ring might run. The shape carries the
 * state without the colour; the label names it for a screen reader. Text uses the engine's glyphs (● ○ ◐) instead.
 */

export const MARK_LABEL: Record<Tri, string> = { yes: 'runs', no: 'skipped', maybe: 'might run' };

const COLOUR: Record<Tri, string> = { yes: 'var(--run)', no: 'var(--skip)', maybe: 'var(--might)' };

export function Mark({ verdict, size = 10, title }: { verdict: Tri; size?: number; title?: string }) {
  const c = COLOUR[verdict];
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 10 10"
      role="img"
      aria-label={title ?? MARK_LABEL[verdict]}
      className="shrink-0"
    >
      <circle
        cx="5"
        cy="5"
        r="4"
        fill={verdict === 'yes' ? c : 'none'}
        stroke={c}
        strokeWidth={verdict === 'yes' ? 0 : 1.5}
      />
      {verdict === 'maybe' && <path d="M5 1 A4 4 0 0 1 5 9 Z" fill={c} />}
    </svg>
  );
}
