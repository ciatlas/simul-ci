/**
 * The line table of a text. A line ends after its `\n`, as yaml's LineCounter counts them: a lone `\r` is not a line
 * break to YAML, so it is not one here. Lines and columns are 0-based inside the package; `offsetOf` and `position`
 * speak core's 1-based `Loc`.
 */
export class Lines {
  /** The offset where each line starts; the first is 0. */
  readonly starts: readonly number[];

  constructor(readonly text: string) {
    const starts = [0];
    for (let at = text.indexOf('\n'); at !== -1; at = text.indexOf('\n', at + 1)) starts.push(at + 1);
    this.starts = starts;
  }

  get count(): number {
    return this.starts.length;
  }

  /** The 0-based line holding an offset. A line break belongs to the line it ends. */
  lineAt(offset: number): number {
    let lo = 0;
    let hi = this.starts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (this.starts[mid]! <= offset) lo = mid;
      else hi = mid - 1;
    }
    return lo;
  }

  start(line: number): number {
    return this.starts[line] ?? this.text.length;
  }

  /** The offset after the line's break, or the end of the text on the last line. */
  end(line: number): number {
    return this.starts[line + 1] ?? this.text.length;
  }

  /** The offset of the line's break (`\r\n` or `\n`), or the end of the text on the last line. */
  breakAt(line: number): number {
    if (line + 1 >= this.starts.length) return this.text.length;
    const end = this.end(line);
    return this.text[end - 2] === '\r' ? end - 2 : end - 1;
  }

  /** The line's text without its break. */
  textOf(line: number): string {
    return this.text.slice(this.start(line), this.breakAt(line));
  }

  /** What a line holds, and the column of its first character that is not a space or a tab. */
  kind(line: number): { kind: 'blank' | 'comment' | 'content'; indent: number } {
    const text = this.textOf(line);
    const body = text.trimStart();
    const indent = text.length - body.length;
    if (body === '') return { kind: 'blank', indent };
    return { kind: body.startsWith('#') ? 'comment' : 'content', indent };
  }

  /** The 0-based column of an offset. */
  column(offset: number): number {
    return offset - this.start(this.lineAt(offset));
  }

  /** Whether only spaces and tabs come before the offset on its line. */
  startsLine(offset: number): boolean {
    return /^[ \t]*$/.test(this.text.slice(this.start(this.lineAt(offset)), offset));
  }

  /** The offset of a 1-based line and column, as core's `Loc`; clamped to the text. */
  offsetOf(line: number, column: number): number {
    const at = this.start(Math.min(Math.max(line, 1), this.count) - 1) + Math.max(column, 1) - 1;
    return Math.min(at, this.text.length);
  }

  /** The 1-based line and column of an offset, as core's `Loc`. */
  position(offset: number): { line: number; column: number } {
    const line = this.lineAt(offset);
    return { line: line + 1, column: offset - this.start(line) + 1 };
  }
}
