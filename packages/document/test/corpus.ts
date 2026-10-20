import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

/** The repository root. */
export const ROOT = resolve(import.meta.dirname, '../../..');
const FIXTURES = resolve(import.meta.dirname, 'fixtures');

export interface CorpusFile {
  name: string;
  text: string;
  /** Whether the file is the package's own (stable, so goldens may be kept of it). */
  owned: boolean;
}

const yamlIn = (dir: string): string[] =>
  readdirSync(dir, { recursive: true, encoding: 'utf8' })
    .filter((f) => /\.ya?ml$/.test(f))
    .sort()
    .map((f) => join(dir, f));

/** The package's fixtures. */
export function fixtures(): CorpusFile[] {
  return yamlIn(FIXTURES).map((path) => ({
    name: relative(FIXTURES, path),
    text: readFileSync(path, 'utf8'),
    owned: true,
  }));
}

export function fixture(name: string): string {
  return readFileSync(join(FIXTURES, name), 'utf8');
}

/**
 * Real workflows: the app's samples, the routes lab, this repository's own and flowpact's release workflow (MIT).
 * Third-party workflows are not committed; the fixtures cover their styles.
 */
export function workflows(): CorpusFile[] {
  const dirs = ['apps/web/src/samples', 'fixtures/routes-lab/repo/.github', '.github/workflows'];
  const files = [
    ...dirs.flatMap((dir) => yamlIn(join(ROOT, dir))),
    join(ROOT, 'packages/engine/test/fixtures/flowpact-release.yml'),
  ];
  return files.map((path) => ({
    name: relative(ROOT, path),
    text: readFileSync(path, 'utf8'),
    owned: false,
  }));
}

/** Every corpus file, each also with CRLF line breaks and with CRLF and a byte order mark. */
export function corpus(): CorpusFile[] {
  return [...fixtures(), ...workflows()].flatMap((file) => [
    file,
    { ...file, name: `${file.name} (CRLF)`, text: crlf(file.text) },
    { ...file, name: `${file.name} (CRLF+BOM)`, text: `${BOM}${crlf(file.text)}` },
  ]);
}

/** U+FEFF, the byte order mark, which the store strips and puts back on save. */
export const BOM = '\uFEFF';

export const crlf = (text: string): string => text.replaceAll('\r\n', '\n').replaceAll('\n', '\r\n');
