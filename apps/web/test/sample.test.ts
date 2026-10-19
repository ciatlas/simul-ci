import { matchesPatterns } from '@simulci/engine';
import { describe, expect, it } from 'vitest';
import { type SampleKind, sampleOf } from '../src/scenario/sample';

/** Patterns from GitHub's filter cheat sheet and the shapes the lab repositories use, with the field each fills. */
const PATTERNS: [string, SampleKind][] = [
  ['main', 'branch'],
  ['release/**', 'branch'],
  ['feature/*', 'branch'],
  ['*', 'branch'],
  ['**', 'branch'],
  ['**/main', 'branch'],
  ['releases/v[0-9]+', 'branch'],
  ['feature-*-beta', 'branch'],
  ['mona/octo*', 'branch'],
  ['v*', 'tag'],
  ['v1.*', 'tag'],
  ['v*.*', 'tag'],
  ['*', 'tag'],
  ['**', 'tag'],
  ['release-*', 'tag'],
  ['v[12].[0-9]+.[0-9]+', 'tag'],
  ['v2?', 'tag'],
  ['?x', 'tag'],
  ['+x', 'tag'],
  ['src/**', 'path'],
  ['**', 'path'],
  ['*', 'path'],
  ['*.md', 'path'],
  ['**/*.md', 'path'],
  ['**.js', 'path'],
  ['docs/*', 'path'],
  ['docs/**/', 'path'],
  ['src/**/test.ts', 'path'],
  ['docs/readme.*', 'path'],
  ['*.jsx?', 'path'],
  ['a\\*b', 'path'],
  ['[!a]x', 'path'],
  ['[^a]x', 'path'],
  ['[a-c]x', 'path'],
  ['[x', 'path'],
  ['.github/workflows/*.yml', 'path'],
];

describe('the sample of a filter pattern', () => {
  it("matches its own pattern under the engine's matcher", () => {
    for (const [pattern, kind] of PATTERNS) {
      const sample = sampleOf(pattern, kind);
      expect(sample, pattern).toBeDefined();
      expect(matchesPatterns(sample!, [pattern]), `${pattern} → ${sample}`).toBe(true);
    }
  });

  it('reads like the name the field takes', () => {
    expect(sampleOf('main', 'branch')).toBe('main');
    expect(sampleOf('release/**', 'branch')).toBe('release/x');
    expect(sampleOf('v*', 'tag')).toBe('v1.0.0');
    expect(sampleOf('v1.*', 'tag')).toBe('v1.0');
    expect(sampleOf('v*.*', 'tag')).toBe('v1.0');
    expect(sampleOf('src/**', 'path')).toBe('src/example.ts');
    expect(sampleOf('**/*.md', 'path')).toBe('example.md');
    expect(sampleOf('docs/readme.*', 'path')).toBe('docs/readme.ts');
    expect(sampleOf('releases/v[0-9]+', 'branch')).toBe('releases/v0');
  });

  it('offers nothing for a pattern that selects nothing on its own', () => {
    expect(sampleOf('!release/old', 'branch')).toBeUndefined();
    expect(sampleOf('x[]', 'path')).toBeUndefined();
    expect(sampleOf('[z-a]', 'path')).toBeUndefined();
  });
});
