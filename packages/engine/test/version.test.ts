import { readFileSync } from 'node:fs';
import { SCHEMA_VERSIONS, schemaUrl, VERSION } from '@simulci/engine';
import { describe, expect, it } from 'vitest';

describe('version', () => {
  it('matches the package version release-please maintains', () => {
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
      version: string;
    };
    expect(VERSION).toBe(pkg.version);
  });

  it('publishes one schema URL per document kind', () => {
    for (const name of Object.keys(SCHEMA_VERSIONS) as (keyof typeof SCHEMA_VERSIONS)[]) {
      expect(schemaUrl(name)).toBe(
        `https://ciatlas.github.io/simulci/schemas/${name}/v${SCHEMA_VERSIONS[name]}.json`,
      );
    }
  });
});
