/** A path from the document root: map keys, and 0-based sequence indices. `['jobs', 'build', 'steps', 2, 'with', 'node-version']`. */
export type YamlPath = readonly (string | number)[];

/** A value as plain JSON: what YAML's core schema reads, aliases resolved. */
export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

export type Eol = '\n' | '\r\n';

export type FileKind = 'workflow' | 'action' | 'test' | 'other';

/** A range of UTF-16 offsets into the text, `to` exclusive. */
export interface Span {
  from: number;
  to: number;
}
