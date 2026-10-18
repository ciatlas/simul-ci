import { foldWrites, UNKNOWN_MARKER } from '@simulci/engine';
import { describe, expect, it } from 'vitest';

const fold = (script: string, file?: 'GITHUB_OUTPUT' | 'GITHUB_ENV') =>
  foldWrites(script, { file, unknownId: (n) => `u.${n}` });

describe('foldWrites', () => {
  it('reads literal echoes in every spelling, last write winning (lab 11)', () => {
    expect(fold('echo "k=first" >> "$GITHUB_OUTPUT"\necho "k=second" >> "$GITHUB_OUTPUT"\n')).toEqual({
      k: { known: true, value: 'second' },
    });
    expect(
      fold(
        'echo k=v >> $GITHUB_OUTPUT\necho \'x=y z\' >>"${GITHUB_OUTPUT}"\necho -n "n=1" >> "$GITHUB_OUTPUT"',
      ),
    ).toEqual({
      k: { known: true, value: 'v' },
      x: { known: true, value: 'y z' },
      n: { known: true, value: '1' },
    });
    expect(fold('printf "%s\\n" "p=q" >> "$GITHUB_OUTPUT"')).toEqual({ p: { known: true, value: 'q' } });
  });

  it('reads a redirected group and heredoc values (lab 11)', () => {
    const script = [
      '{',
      '  echo "m<<EOF"',
      '  echo "line one"',
      '  echo "line two"',
      '  echo "EOF"',
      '  echo "k=1"',
      '} >> "$GITHUB_OUTPUT"',
      'cat >> "$GITHUB_OUTPUT" <<EOF',
      'a=b',
      'EOF',
      '',
    ].join('\n');
    expect(fold(script)).toEqual({
      m: { known: true, value: 'line one\nline two' },
      k: { known: true, value: '1' },
      a: { known: true, value: 'b' },
    });
  });

  it('leaves shell expansions and unknown templates unknown', () => {
    expect(fold('echo "sha=$(git rev-parse HEAD)" >> "$GITHUB_OUTPUT"')).toEqual({
      sha: { known: false, unknowns: ['u.sha'] },
    });
    expect(fold('echo "v=$VALUE" >> "$GITHUB_OUTPUT"\necho "w=`date`" >> $GITHUB_OUTPUT')).toEqual({
      v: { known: false, unknowns: ['u.v'] },
      w: { known: false, unknowns: ['u.w'] },
    });
    expect(fold(`echo "x=${UNKNOWN_MARKER}" >> "$GITHUB_OUTPUT"`)).toEqual({
      x: { known: false, unknowns: ['u.x'] },
    });
    expect(fold('echo "k=known" >> "$GITHUB_OUTPUT"\necho "k=$LATER" >> "$GITHUB_OUTPUT"')).toEqual({
      k: { known: false, unknowns: ['u.k'] },
    });
  });

  it('turns conditional writes into candidates, with empty when no branch may write (lab 8)', () => {
    const leg2 = [
      'if [ "2" = "2" ]; then',
      '  echo "v=" >> "$GITHUB_OUTPUT"',
      'else',
      '  echo "v=2" >> "$GITHUB_OUTPUT"',
      'fi',
      'echo "w=2" >> "$GITHUB_OUTPUT"',
      '',
    ].join('\n');
    expect(fold(leg2)).toEqual({
      v: { known: false, unknowns: ['u.v'], oneOf: ['', '2'] },
      w: { known: true, value: '2' },
    });
    expect(fold('test -f x && echo "has=yes" >> "$GITHUB_OUTPUT"')).toEqual({
      has: { known: false, unknowns: ['u.has'], oneOf: ['yes', ''] },
    });
    expect(
      fold('echo "a=1" >> "$GITHUB_OUTPUT"\ncase $x in\n  y) echo "a=2" >> "$GITHUB_OUTPUT" ;;\nesac\n'),
    ).toEqual({ a: { known: false, unknowns: ['u.a'], oneOf: ['2', '1'] } });
    expect(
      fold('case $x in\n  y) echo "a=2" >> "$GITHUB_OUTPUT" ;;\nesac\necho "a=3" >> "$GITHUB_OUTPUT"\n'),
    ).toEqual({ a: { known: true, value: '3' } });
  });

  it('folds $GITHUB_ENV writes the same way', () => {
    expect(fold('echo "MODE=ci" >> "$GITHUB_ENV"\necho "X=1" >> $GITHUB_OUTPUT', 'GITHUB_ENV')).toEqual({
      MODE: { known: true, value: 'ci' },
    });
  });
});
