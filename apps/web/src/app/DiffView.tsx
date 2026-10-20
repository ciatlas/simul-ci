import { diffLines, type Hunk, hunkHeader, hunksOf, linesOf, statsOf } from '../lib/line-diff';

/** A file's change as the page shows it: its hunks, and how many lines it adds and removes. */
export interface ShownDiff {
  hunks: Hunk[];
  added: number;
  removed: number;
}

/** The change from one text to another; an absent side is a file not there. */
export function diffOf(before: string | undefined, after: string | undefined): ShownDiff {
  const a = linesOf(before ?? '');
  const b = linesOf(after ?? '');
  const changes = diffLines(a, b);
  return { hunks: hunksOf(a, b, changes), ...statsOf(changes) };
}

/** Lines drawn per diff; the patch has the rest. */
const MAX_ROWS = 500;

/** A drawn line: a hunk's header, a line kept, removed or added (its line break left off), or git's no-newline note. */
interface Row {
  key: string;
  kind: '@' | ' ' | '-' | '+' | '\\';
  text: string;
}

const STYLE: Record<Row['kind'], string> = {
  '@': 'text-muted',
  ' ': '',
  '-': 'bg-danger-soft',
  '+': 'bg-run-soft',
  '\\': 'text-muted',
};

/** The diff's rows up to `max` lines of the hunks, and how many lines that leaves out. */
export function rowsOf(diff: ShownDiff, max = MAX_ROWS): { rows: Row[]; hidden: number } {
  const rows: Row[] = [];
  let shown = 0;
  diff.hunks.forEach((h, i) => {
    if (shown >= max) return;
    rows.push({ key: `${i}`, kind: '@', text: hunkHeader(h) });
    for (const [j, line] of h.lines.slice(0, max - shown).entries()) {
      rows.push({
        key: `${i}.${j}`,
        kind: line.kind,
        text: `${line.kind}${line.text.replace(/\r?\n$/, '')}`,
      });
      if (!line.text.endsWith('\n'))
        rows.push({ key: `${i}.${j}$`, kind: '\\', text: '\\ No newline at end of file' });
    }
    shown += h.lines.length;
  });
  const total = diff.hunks.reduce((sum, h) => sum + h.lines.length, 0);
  return { rows, hidden: Math.max(0, total - max) };
}

/** "+3 −1" on the surface; a screen reader hears it in words. */
export function DiffCounts({ diff }: { diff: ShownDiff }) {
  return (
    <span className="rounded bg-surface px-1 font-mono text-xs">
      <span aria-hidden="true">
        <span className="text-run">+{diff.added}</span> <span className="text-danger">−{diff.removed}</span>
      </span>
      <span className="sr-only">
        {diff.added} {diff.added === 1 ? 'line' : 'lines'} added, {diff.removed} removed
      </span>
    </span>
  );
}

/**
 * A unified diff as git prints it: each hunk's `@@` header, then its lines marked ` `, `-` or `+`, removed lines on
 * red and added ones on green; a last line without a line break says so. Long diffs stop after 500 lines. The region
 * scrolls, so it takes the focus for the keyboard.
 */
export function UnifiedDiff({ diff, label }: { diff: ShownDiff; label: string }) {
  const { rows, hidden } = rowsOf(diff);
  return (
    <pre
      aria-label={label}
      tabIndex={0}
      className="max-h-80 overflow-auto rounded border border-border bg-bg py-1 font-mono text-text text-xs leading-5"
    >
      {rows.map((row) => (
        <span key={row.key} className={`block px-2 ${STYLE[row.kind]}`}>
          {row.text}
        </span>
      ))}
      {hidden > 0 && (
        <span className="block px-2 text-muted">… {hidden} more lines: Download patch has them all</span>
      )}
    </pre>
  );
}
