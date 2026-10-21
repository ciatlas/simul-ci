import type { Tri } from '@simulci/engine';

/** A run state in words, as the mark (graph/Mark.tsx) and the cards' labels say it to a screen reader. */
export const MARK_LABEL: Record<Tri, string> = { yes: 'runs', no: 'skipped', maybe: 'might run' };

/** Words as a sentence lists them: `a`, `a and b`, `a, b and c`; nothing for no words. */
export function listed(words: readonly string[]): string {
  if (words.length <= 1) return words[0] ?? '';
  return `${words.slice(0, -1).join(', ')} and ${words.at(-1)}`;
}
