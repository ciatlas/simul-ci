// Writes the JSON schemas the engine defines to schemas/<name>/v<n>.json. CI checks that the files are committed and
// current; GitHub Pages publishes the directory, so the `$id` URLs resolve.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { jsonSchemas, SCHEMA_VERSIONS } from '@simulci/engine';

const root = join(import.meta.dirname, '..');
for (const [name, schema] of Object.entries(jsonSchemas())) {
  const dir = join(root, 'schemas', name);
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `v${SCHEMA_VERSIONS[name as keyof typeof SCHEMA_VERSIONS]}.json`);
  writeFileSync(file, `${JSON.stringify(schema, null, 2)}\n`);
  console.log(`wrote ${file}`);
}
