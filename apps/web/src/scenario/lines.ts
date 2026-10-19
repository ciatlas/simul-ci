/**
 * The Advanced rows the author writes as lines: variables as `name=value`, secrets and environments as one name per
 * line. The text stays the author's (the fields keep it in their own state); these read it into the scenario's
 * shape, write a value from outside back as text, and tell whether a text already spells a value.
 */

/** `NAME=value` lines; a line without `=` names a variable whose value is empty; nothing when no line names one. */
export function parseVars(text: string): Record<string, string> | undefined {
  const out = new Map<string, string>();
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    const at = line.indexOf('=');
    const name = (at === -1 ? line : line.slice(0, at)).trim();
    if (name) out.set(name, at === -1 ? '' : line.slice(at + 1).trim());
  }
  // fromEntries defines own keys, so a variable named `__proto__` stays a variable.
  return out.size ? Object.fromEntries(out) : undefined;
}

/** The lines of a vars record; a value of the wrong shape (a URL's) shows as its JSON, to be fixed. */
export function varsText(vars: unknown): string {
  if (typeof vars !== 'object' || vars === null || Array.isArray(vars)) return '';
  return Object.entries(vars)
    .map(([name, value]) => `${name}=${typeof value === 'string' ? value : jsonOf(value)}`)
    .join('\n');
}

export const sameVars = (text: string, vars: unknown): boolean => spells(parseVars(text), vars);

/** One name per line, each once, in the order written; nothing when no line holds a name. */
export function parseNames(text: string): string[] | undefined {
  const out = new Set<string>();
  for (const raw of text.split('\n')) {
    const name = raw.trim();
    if (name) out.add(name);
  }
  return out.size ? Array.from(out) : undefined;
}

export function namesText(names: unknown): string {
  if (!Array.isArray(names)) return '';
  return names.map((n) => (typeof n === 'string' ? n : jsonOf(n))).join('\n');
}

export const sameNames = (text: string, names: unknown): boolean => spells(parseNames(text), names);

/** The text with one more line, unless a line already holds it. */
export function withLine(text: string, line: string): string {
  if (text.split('\n').some((l) => l.trim() === line)) return text;
  if (text === '' || text.endsWith('\n')) return text + line;
  return `${text}\n${line}`;
}

const spells = (parsed: unknown, value: unknown): boolean =>
  JSON.stringify(parsed ?? null) === JSON.stringify(value ?? null);

const jsonOf = (value: unknown): string => JSON.stringify(value) ?? String(value);
