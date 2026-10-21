import type { Page } from '@playwright/test';

/**
 * A folder of the origin private file system for the browser pass: Open folder hands the page the OPFS directory
 * `repo` instead of the folder picker, and Chromium writes it through `createWritable` on the main thread as it writes
 * a picked folder. The specs write its bytes and read them back from Node.
 */

/** Makes Open folder hand the page the OPFS directory `repo`; before the page loads. */
export async function useOpfsFolder(page: Page): Promise<void> {
  await page.addInitScript(() => {
    (
      window as unknown as { showDirectoryPicker: () => Promise<FileSystemDirectoryHandle> }
    ).showDirectoryPicker = async () =>
      (await navigator.storage.getDirectory()).getDirectoryHandle('repo', { create: true });
  });
}

/** The OPFS folder `repo` holding exactly these files, written as bytes. */
export async function folderWith(page: Page, files: Record<string, number[]>): Promise<void> {
  await page.evaluate(async (tree) => {
    const root = await navigator.storage.getDirectory();
    await root.removeEntry('repo', { recursive: true }).catch(() => undefined);
    const repo = await root.getDirectoryHandle('repo', { create: true });
    for (const [path, content] of Object.entries(tree)) {
      const parts = path.split('/');
      const name = parts.pop()!;
      let dir = repo;
      for (const part of parts) dir = await dir.getDirectoryHandle(part, { create: true });
      const writable = await (await dir.getFileHandle(name, { create: true })).createWritable();
      await writable.write(new Uint8Array(content));
      await writable.close();
    }
  }, files);
}

/** A file of `repo` as bytes, and when it was last written; nothing when it is not there. */
export async function fileOf(
  page: Page,
  path: string,
): Promise<{ bytes: number[]; modified: number } | undefined> {
  return page.evaluate(async (where) => {
    let dir = await (await navigator.storage.getDirectory()).getDirectoryHandle('repo');
    const parts = where.split('/');
    const name = parts.pop()!;
    try {
      for (const part of parts) dir = await dir.getDirectoryHandle(part);
      const file = await (await dir.getFileHandle(name)).getFile();
      return { bytes: Array.from(new Uint8Array(await file.arrayBuffer())), modified: file.lastModified };
    } catch {
      return undefined;
    }
  }, path);
}
