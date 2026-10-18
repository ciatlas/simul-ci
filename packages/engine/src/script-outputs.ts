import type { Value } from './plan/types';
import { known, unknown } from './plan/values';

/**
 * Folds what an inline `run:` script writes to `$GITHUB_OUTPUT` (or `$GITHUB_ENV`) when the write is literal:
 * `echo "k=v" >> "$GITHUB_OUTPUT"`, a `{ … } >> "$GITHUB_OUTPUT"` group, a heredoc `k<<EOF … EOF`, `printf`.
 * A value with a shell expansion (`$VAR`, `$(…)`, backticks) or an unknown `${{ }}` is unknown. A write inside a
 * conditional (`if`, `case`, a loop, `&&`, `||`) gives candidates, not a value. The last write wins (lab 11).
 */

/** The marker `substituteTemplates` leaves for an unknown `${{ }}`; any value holding it is unknown. */
export const UNKNOWN_MARKER = '\u0000?\u0000';

export interface FoldOptions {
  /** `GITHUB_OUTPUT` (default) or `GITHUB_ENV`. */
  file?: 'GITHUB_OUTPUT' | 'GITHUB_ENV';
  /** Names an unknown value by the step: `<unknownId(name)>`. */
  unknownId: (name: string) => string;
}

interface Write {
  name: string;
  /** The literal value, or undefined when only the run knows it. */
  value: string | undefined;
  conditional: boolean;
}

/** The outputs (or env) a script writes, by name, as the run would read them after the step. */
export function foldWrites(script: string, opts: FoldOptions): Record<string, Value<string>> {
  const writes = scanWrites(script, opts.file ?? 'GITHUB_OUTPUT');
  const out: Record<string, Value<string>> = {};
  for (const name of [...new Set(writes.map((w) => w.name))]) {
    out[name] = foldName(
      writes.filter((w) => w.name === name),
      opts.unknownId(name),
    );
  }
  return out;
}

/** Last write wins; conditional writes make the value one of the literals seen (or empty, when none may run). */
function foldName(writes: Write[], unknownId: string): Value<string> {
  const lastUnconditional = writes
    .map((w, i) => [w, i] as const)
    .filter(([w]) => !w.conditional)
    .at(-1);
  const after = lastUnconditional ? writes.slice(lastUnconditional[1] + 1) : writes;
  if (after.length === 0) {
    const w = lastUnconditional![0];
    return w.value === undefined ? unknown([unknownId]) : known(w.value);
  }
  if (after.some((w) => w.value === undefined)) return unknown([unknownId]);
  const candidates = new Set<string>(after.map((w) => w.value!));
  if (lastUnconditional) {
    if (lastUnconditional[0].value === undefined) return unknown([unknownId]);
    candidates.add(lastUnconditional[0].value);
  } else candidates.add('');
  return unknown([unknownId], [...candidates]);
}

const OPEN = /^\s*(if|case|while|for|until)\b/;
const CLOSE = /^\s*(fi|esac|done)\b/;
const ELSE = /^\s*(else|elif)\b/;

interface Scan {
  redirect: RegExp;
  lines: string[];
  writes: Write[];
  depth: number;
  group?: { lines: string[]; conditional: boolean };
}

function scanWrites(script: string, file: string): Write[] {
  const scan: Scan = {
    redirect: new RegExp(`>>\\s*["']?\\$\\{?${file}\\}?["']?`),
    lines: script.split('\n'),
    writes: [],
    depth: 0,
  };
  for (let i = 0; i < scan.lines.length; i++) {
    // A `case` arm's `pattern)` prefix and its `;;` are not part of the command.
    const line = withoutTerminator(scan.lines[i]!).replace(/^(\s*)[^\s()]+\)\s+/, '$1');
    i = scan.group ? groupLine(scan, line, i) : scanLine(scan, line, i);
  }
  return scan.writes;
}

/** The line without a trailing `;` or `;;` (by hand: a `\\s*;;?\\s*$` regex is polynomial on long blank tails). */
function withoutTerminator(raw: string): string {
  let line = raw.trimEnd();
  if (line.endsWith(';;')) line = line.slice(0, -2);
  else if (line.endsWith(';')) line = line.slice(0, -1);
  return line.trimEnd();
}

/** The command after the last `&&` or `||`, which is what a redirect at the end of a chain applies to. */
function lastCommand(command: string): string {
  const at = Math.max(command.lastIndexOf('&&'), command.lastIndexOf('||'));
  return at === -1 ? command : command.slice(at + 2).trimStart();
}

/** A line inside a `{ … }` group: collected until the closing brace, which tells whether the group was redirected. */
function groupLine(scan: Scan, line: string, i: number): number {
  const group = scan.group!;
  if (!/^\s*\}/.test(line)) {
    group.lines.push(line);
    return i;
  }
  if (scan.redirect.test(line)) scan.writes.push(...parseGroup(group.lines, group.conditional));
  scan.group = undefined;
  return i;
}

/** A line outside a group: tracks conditionals, opens a group, or reads a redirected command. Returns the next line index. */
function scanLine(scan: Scan, line: string, i: number): number {
  if (OPEN.test(line)) scan.depth++;
  if (CLOSE.test(line)) scan.depth = Math.max(0, scan.depth - 1);
  if (/^\s*\{\s*$/.test(line)) {
    scan.group = { lines: [], conditional: scan.depth > 0 };
    return i;
  }
  if (!scan.redirect.test(line)) return i;
  const command = line.replace(scan.redirect, '').trim();
  const conditional = scan.depth > 0 || ELSE.test(line) || /(&&|\|\|)/.test(command);
  return redirectedCommand(scan, command, conditional, i);
}

/** A command redirected to the file: an `echo`/`printf`, or `cat <<EOF` whose body follows on the next lines. */
function redirectedCommand(scan: Scan, command: string, conditional: boolean, i: number): number {
  const heredoc = /<<-?\s*['"]?(\w+)['"]?$/.exec(command.trimEnd());
  if (!heredoc) {
    scan.writes.push(...parseGroup([lastCommand(command)], conditional));
    return i;
  }
  // cat >> "$GITHUB_OUTPUT" <<EOF … EOF: one `k=v` per line.
  const body: string[] = [];
  let j = i + 1;
  for (; j < scan.lines.length && scan.lines[j]!.trim() !== heredoc[1]; j++) body.push(scan.lines[j]!);
  scan.writes.push(
    ...parseGroup(
      body.map((l) => `echo ${JSON.stringify(l)}`),
      conditional,
    ),
  );
  return j;
}

/** `echo` and `printf` lines that each append `name=value`, with `name<<EOF … EOF` spanning several lines. */
function parseGroup(lines: string[], conditional: boolean): Write[] {
  const writes: Write[] = [];
  for (let i = 0; i < lines.length; i++) {
    const text = echoed(lines[i]!);
    if (text === null) continue;
    const literal = literalValue(text);
    if (literal === undefined) {
      const name = /^["']?([A-Za-z_][\w-]*)=/.exec(text)?.[1];
      if (name) writes.push({ name, value: undefined, conditional });
      continue;
    }
    const heredoc = /^([A-Za-z_][\w-]*)<<(\w+)$/.exec(literal);
    if (heredoc) {
      const read = heredocValue(lines, i + 1, heredoc[2]!);
      writes.push({ name: heredoc[1]!, value: read.value, conditional });
      i = read.next;
      continue;
    }
    const eq = literal.indexOf('=');
    if (eq > 0) writes.push({ name: literal.slice(0, eq), value: literal.slice(eq + 1), conditional });
  }
  return writes;
}

/** The lines echoed up to the terminator, joined; unknown when a line is not literal or the terminator never comes. */
function heredocValue(
  lines: string[],
  from: number,
  terminator: string,
): { value: string | undefined; next: number } {
  const body: string[] = [];
  for (let i = from; i < lines.length; i++) {
    const next = echoed(lines[i]!);
    const value = next === null ? undefined : literalValue(next);
    if (value === terminator)
      return { value: body.includes(UNKNOWN_MARKER) ? undefined : body.join('\n'), next: i };
    body.push(value === undefined ? UNKNOWN_MARKER : value);
  }
  return { value: undefined, next: lines.length };
}

/** The argument text of an `echo` or `printf` command, else null. */
function echoed(line: string): string | null {
  const m = /^\s*(?:echo(?:\s+-[neE]+)*|printf(?:\s+['"]%s\\n['"])?)\s+(.*)$/.exec(line.trim());
  return m ? m[1]!.trim() : null;
}

/** The literal a shell word denotes, or undefined when the shell would expand something in it. */
function literalValue(text: string): string | undefined {
  if (text.includes(UNKNOWN_MARKER) || /[`]|\$\(|\$\{?[A-Za-z_]/.test(text)) return undefined;
  const m = /^"((?:[^"\\]|\\.)*)"$|^'([^']*)'$|^([^\s"']+)$/.exec(text);
  if (!m) return undefined;
  if (m[1] !== undefined) return m[1].replace(/\\(.)/g, '$1');
  return m[2] ?? m[3]!;
}
