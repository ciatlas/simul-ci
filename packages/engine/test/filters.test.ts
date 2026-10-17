import { compilePattern, matchesPatterns, pathsMatch, refMatches, refSubject } from '@simulci/engine';
import { describe, expect, it } from 'vitest';

/** Branch and tag examples from the docs' filter pattern cheat sheet (workflow syntax). */
const refCases: [string, string[], string[]][] = [
  ['feature/*', ['feature/my-branch', 'feature/your-branch'], ['feature/beta-a/my-branch', 'main']],
  ['feature/**', ['feature/beta-a/my-branch', 'feature/your-branch', 'feature/mona/the/octocat'], ['main']],
  ['main', ['main'], ['main-2', 'releases/main']],
  ['releases/mona-the-octocat', ['releases/mona-the-octocat'], ['releases/mona']],
  ['*', ['main', 'releases'], ['releases/mona-the-octocat']],
  ['**', ['all/the/branches', 'every/tag', 'main'], []],
  ['*feature', ['my-feature', 'mona-feature'], ['my-feature-branch', 'feature/x']],
  ['v2*', ['v2', 'v2.0', 'v2.9'], ['v1', 'v3.0']],
  ['v[12].[0-9]+.[0-9]+', ['v1.10.1', 'v2.0.0'], ['v3.0.0', 'v1.a.1']],
];

/** Path examples from the same cheat sheet. */
const pathCases: [string, string[], string[]][] = [
  ['*', ['README.md', 'server.rb'], ['docs/README.md']],
  ['*.jsx?', ['page.js', 'page.jsx'], ['page.ts']],
  ['**', ['all/the/files.md', 'README.md'], []],
  ['*.js', ['app.js', 'index.js'], ['src/app.js']],
  ['**.js', ['index.js', 'js/index.js', 'src/js/app.js'], ['app.ts']],
  ['docs/*', ['docs/README.md', 'docs/file.txt'], ['docs/mona/octocat.txt']],
  ['docs/**', ['docs/README.md', 'docs/mona/octocat.txt'], ['src/docs/x.md']],
  [
    'docs/**/*.md',
    ['docs/README.md', 'docs/mona/hello-world.md', 'docs/a/b/c/i-am-a-file.md'],
    ['docs/a.txt'],
  ],
  ['**/docs/**', ['docs/hello.md', 'dir/docs/my-file.txt', 'space/docs/plan/space.doc'], ['document/x']],
  ['**/README.md', ['README.md', 'js/README.md'], ['READMEs.md']],
  ['**/*src/**', ['a/src/app.js', 'my-src/code/js/app.js'], ['a/source/app.js']],
  ['**/*-post.md', ['my-post.md', 'path/their-post.md'], ['post.md']],
  [
    '**/migrate-*.sql',
    ['migrate-10909.sql', 'db/migrate-v1.0.sql', 'db/sept/migrate-v1.sql'],
    ['db/migrate.sql'],
  ],
];

describe('compilePattern', () => {
  it.each(refCases)('%s matches the refs the docs list', (pattern, yes, no) => {
    const p = compilePattern(pattern);
    for (const ref of yes) expect(p.regex.test(ref), ref).toBe(true);
    for (const ref of no) expect(p.regex.test(ref), ref).toBe(false);
  });

  it.each(pathCases)('%s matches the paths the docs list', (pattern, yes, no) => {
    const p = compilePattern(pattern);
    for (const path of yes) expect(p.regex.test(path), path).toBe(true);
    for (const path of no) expect(p.regex.test(path), path).toBe(false);
  });

  it('reads a leading ! as negation and keeps the rest literal', () => {
    expect(compilePattern('!README.js')).toMatchObject({ negated: true, pattern: '!README.js' });
    expect(compilePattern('!README.js').regex.test('README.js')).toBe(true);
    expect(compilePattern('a.b').regex.test('axb')).toBe(false);
    expect(compilePattern('a\\*b').regex.test('a*b')).toBe(true);
    expect(compilePattern('a\\*b').regex.test('axb')).toBe(false);
    expect(compilePattern('v1.[').regex.test('v1.[')).toBe(true);
  });
});

describe('matchesPatterns', () => {
  it('excludes with a negative pattern after a match and includes again with a later positive one', () => {
    expect(matchesPatterns('README.js', ['*.js', '!README.js'])).toBe(false);
    expect(matchesPatterns('app.js', ['*.js', '!README.js'])).toBe(true);
    expect(matchesPatterns('README.js', ['*.js', '!README.js', 'README.js'])).toBe(true);
    expect(matchesPatterns('docs/mona/README.md', ['docs/**', '!docs/mona/**'])).toBe(false);
  });

  it('selects nothing with only negative patterns', () => {
    expect(matchesPatterns('main', ['!main'])).toBe(false);
    expect(matchesPatterns('other', ['!main'])).toBe(false);
  });
});

describe('ref and path filters', () => {
  it('matches the ref name without the refs/heads or refs/tags prefix', () => {
    expect(refSubject('refs/heads/release/1.x')).toBe('release/1.x');
    expect(refSubject('refs/tags/v1')).toBe('v1');
    expect(refMatches('main', { include: ['main', 'release/**'] })).toBe(true);
    expect(refMatches('topic', { include: ['main', 'release/**'] })).toBe(false);
    expect(refMatches('topic', { ignore: ['main'] })).toBe(true);
    expect(refMatches('main', { ignore: ['main'] })).toBe(false);
    expect(refMatches('anything', {})).toBe(true);
  });

  it('runs on paths when any file matches and on paths-ignore unless every file matches', () => {
    expect(pathsMatch(['docs/a.md', 'src/x.ts'], { paths: ['src/**'] })).toBe(true);
    expect(pathsMatch(['docs/a.md'], { paths: ['src/**'] })).toBe(false);
    expect(pathsMatch(['docs/a.md'], { pathsIgnore: ['docs/**'] })).toBe(false);
    expect(pathsMatch(['docs/a.md', 'src/x.ts'], { pathsIgnore: ['docs/**'] })).toBe(true);
    expect(pathsMatch([], { paths: ['**'] })).toBe(false);
    expect(pathsMatch([], { pathsIgnore: ['**'] })).toBe(false);
    expect(pathsMatch(['x'], {})).toBe(true);
  });
});
