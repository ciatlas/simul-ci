import type { YamlPath } from './types';

/** Why an edit cannot be made, in the terms the author sees it. */
export type RefusalReason =
  // The whole file is locked (`WorkflowDocument.status`).
  | 'invalid-yaml'
  | 'duplicate-key'
  | 'multi-document'
  | 'directive'
  | 'generated'
  | 'too-large'
  // The target cannot be written in place.
  | 'alias'
  | 'shared-anchor'
  | 'anchor'
  | 'merge-key'
  | 'flow-shape'
  | 'unsupported-shape'
  // The target is not what the view thought.
  | 'not-found'
  | 'out-of-range'
  | 'moved'
  | 'stale'
  // The author's input.
  | 'invalid-id'
  | 'duplicate-id'
  | 'cycle'
  | 'exclusive-filter'
  | 'other-workflow'
  // simulci's own check of an edit failed (G6): nothing is written.
  | 'internal'
  // The store's, for files it holds read-only for both the pane and ops.
  | 'not-utf8'
  | 'mixed-eol';

/** A one-click way past a refusal. */
export type Fix =
  /** Retry the op with `ctx.shared = 'all'`: change every use of a shared anchor. */
  | { kind: 'shared-all'; label: string }
  /** "Edit in YAML": open the pane on the line. */
  | { kind: 'reveal'; label: string; line: number }
  /** Edit a generated file anyway, this session. */
  | { kind: 'unlock'; label: string }
  /** Undo the last transaction (it broke the YAML). */
  | { kind: 'undo'; label: string };

export interface Refusal {
  ok: false;
  reason: RefusalReason;
  message: string;
  file: string;
  /** 1-based. */
  line?: number;
  at?: YamlPath;
  fixes: Fix[];
}

export function refuse(
  reason: RefusalReason,
  file: string,
  message: string,
  more: { line?: number; at?: YamlPath; fixes?: Fix[] } = {},
): Refusal {
  const refusal: Refusal = { ok: false, reason, message, file, fixes: more.fixes ?? [] };
  if (more.line !== undefined) refusal.line = more.line;
  if (more.at !== undefined) refusal.at = more.at;
  return refusal;
}

/** The file's name as the author knows it: `ci.yml` for `.github/workflows/ci.yml`. */
export const fileName = (path: string): string => path.slice(path.lastIndexOf('/') + 1);

const reveal = (line: number, label = `Show line ${line}`): Fix => ({ kind: 'reveal', label, line });

/** yaml's error codes in the author's words; others keep yaml's own message. */
const WHAT: Record<string, string> = {
  BAD_INDENT: 'bad indentation',
  TAB_AS_INDENT: 'a tab used as indentation',
  MISSING_CHAR: 'a missing character',
  MULTILINE_IMPLICIT_KEY: 'a key that spans lines',
  BLOCK_AS_IMPLICIT_KEY: 'a `: ` inside a value, which needs quotes',
  UNEXPECTED_TOKEN: 'an unexpected character',
  BAD_SCALAR_START: 'a value that cannot start with that character',
  BAD_DQ_ESCAPE: 'a bad escape in a double-quoted string',
  BAD_ALIAS: 'a bad alias',
  BAD_DIRECTIVE: 'a bad directive',
};

export function invalidYaml(file: string, line: number, code: string, message: string): Refusal {
  const what = WHAT[code] ?? message.replace(/\.$/, '').replace(/^\w/, (c) => c.toLowerCase());
  return refuse(
    'invalid-yaml',
    file,
    `${fileName(file)} does not parse at line ${line} (${what}). Fix it in the YAML pane; the graph shows the last version that parsed.`,
    { line, fixes: [reveal(line), { kind: 'undo', label: 'Undo the last change' }] },
  );
}

export function duplicateKey(file: string, at: YamlPath, key: string, lines: [number, number]): Refusal {
  const where = at.length === 0 ? fileName(file) : at.join('.');
  return refuse(
    'duplicate-key',
    file,
    `${where} has two \`${key}:\` keys (lines ${lines[0]} and ${lines[1]}); GitHub rejects the file.`,
    { line: lines[1], at: [...at, key], fixes: [reveal(lines[1])] },
  );
}

const COUNT = ['no', 'one', 'two', 'three', 'four', 'five'];

export function multiDocument(file: string, documents: number, line: number): Refusal {
  return refuse(
    'multi-document',
    file,
    `${fileName(file)} holds ${COUNT[documents] ?? documents} YAML documents (\`---\` on line ${line}); GitHub reads only the first.`,
    { line, fixes: [reveal(line)] },
  );
}

export function directive(file: string, source: string, line: number): Refusal {
  return refuse(
    'directive',
    file,
    `${fileName(file)} starts with a \`${source}\` directive; edit it in the YAML pane.`,
    { line, fixes: [reveal(line)] },
  );
}

export function generated(file: string, marker: string, line: number | undefined): Refusal {
  const unlock: Fix = { kind: 'unlock', label: 'Edit it anyway' };
  const why =
    line === undefined
      ? marker === '.lock.yml'
        ? `is generated (its name ends in ${marker})`
        : `is marked generated ('${marker}')`
      : `says '${marker}' on line ${line}: it is generated`;
  return refuse('generated', file, `${fileName(file)} ${why}, and your edits would be overwritten.`, {
    ...(line === undefined ? {} : { line }),
    fixes: [unlock],
  });
}

export function tooLarge(file: string, bytes: number): Refusal {
  return refuse(
    'too-large',
    file,
    `${fileName(file)} is ${Math.round(bytes / 1024)} kB; edit files this large in the YAML pane.`,
    { fixes: [reveal(1, 'Edit in YAML')] },
  );
}
