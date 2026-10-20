/** Words as a sentence lists them: `a`, `a and b`, `a, b and c`; nothing for no words. */
export function listed(words: readonly string[]): string {
  if (words.length <= 1) return words[0] ?? '';
  return `${words.slice(0, -1).join(', ')} and ${words.at(-1)}`;
}
