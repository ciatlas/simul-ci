// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { copyText } from '../src/lib/clipboard';
import { downloadText } from '../src/lib/download';

describe('copying text', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('says so once the clipboard took the text', async () => {
    const written: string[] = [];
    const clipboard = {
      writeText: (text: string) => {
        written.push(text);
        return Promise.resolve();
      },
    };
    expect(await copyText('workflow: ci.yml\n', clipboard)).toBe(true);
    expect(written).toEqual(['workflow: ci.yml\n']);
  });

  it('writes to the page’s clipboard when given none', async () => {
    const writeText = vi.fn(() => Promise.resolve());
    vi.stubGlobal('navigator', { clipboard: { writeText } });
    expect(await copyText('plan')).toBe(true);
    expect(writeText).toHaveBeenCalledWith('plan');
  });

  it('says it did not when the browser refuses the write, however it refuses', async () => {
    const denied = { writeText: () => Promise.reject(new DOMException('denied', 'NotAllowedError')) };
    expect(await copyText('plan', denied)).toBe(false);
    const thrown = {
      writeText: (): Promise<void> => {
        throw new TypeError('no gesture');
      },
    };
    expect(await copyText('plan', thrown)).toBe(false);
  });

  it('says it did not on a page with no clipboard, or one without writeText', async () => {
    vi.stubGlobal('navigator', {});
    expect(await copyText('plan')).toBe(false);
    vi.stubGlobal('navigator', undefined);
    expect(await copyText('plan')).toBe(false);
    expect(await copyText('plan', {} as Clipboard)).toBe(false);
  });
});

describe('downloading text', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  /** Object URLs as the browser hands them out, with the Blob behind each, and the ones revoked. */
  function objectUrls() {
    const blobs: Blob[] = [];
    vi.spyOn(URL, 'createObjectURL').mockImplementation((blob) => {
      blobs.push(blob as Blob);
      return `blob:https://simulci.test/${blobs.length}`;
    });
    const revoked = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined);
    return { blobs, revoked };
  }

  /** The links clicked while `fn` runs, as they were at the click; the browser's own navigation is held back. */
  function clicks(fn: () => void) {
    const seen: { download: string; href: string; hidden: HTMLElement['hidden']; inPage: boolean }[] = [];
    const onClick = (event: Event): void => {
      const a = event.target as HTMLAnchorElement;
      seen.push({ download: a.download, href: a.href, hidden: a.hidden, inPage: a.isConnected });
      event.preventDefault();
    };
    document.addEventListener('click', onClick);
    try {
      fn();
    } finally {
      document.removeEventListener('click', onClick);
    }
    return seen;
  }

  it('clicks a hidden link to an object URL of the text, named for the file, and takes it out again', async () => {
    const { blobs } = objectUrls();
    const seen = clicks(() =>
      downloadText('ci.test.yml', 'workflow: ci.yml\n', 'application/yaml', document, () => undefined),
    );
    expect(seen).toEqual([
      { download: 'ci.test.yml', href: 'blob:https://simulci.test/1', hidden: true, inPage: true },
    ]);
    expect(document.querySelector('a')).toBeNull();
    expect(blobs).toHaveLength(1);
    expect(blobs[0]!.type).toBe('application/yaml;charset=utf-8');
    expect(await blobs[0]!.text()).toBe('workflow: ci.yml\n');
  });

  it('revokes the URL only once the deferred callback runs, after the click handed it over', () => {
    const { revoked } = objectUrls();
    const later: (() => void)[] = [];
    clicks(() => downloadText('plan.txt', 'plan', 'text/plain', document, (fn) => later.push(fn)));
    expect(revoked).not.toHaveBeenCalled();
    expect(later).toHaveLength(1);
    later[0]!();
    expect(revoked).toHaveBeenCalledWith('blob:https://simulci.test/1');
  });

  it('defers the revoke to a timer on the page’s document by default', () => {
    vi.useFakeTimers();
    const { revoked } = objectUrls();
    const seen = clicks(() => downloadText('plan.mmd', 'flowchart LR', 'text/plain'));
    expect(seen.map((s) => s.download)).toEqual(['plan.mmd']);
    expect(revoked).not.toHaveBeenCalled();
    vi.runAllTimers();
    expect(revoked).toHaveBeenCalledWith('blob:https://simulci.test/1');
  });
});
