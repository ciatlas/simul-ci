/**
 * Writes text to the clipboard. False when the page has no clipboard (not a secure context) or the browser refuses
 * the write (no user gesture, a denied permission): the caller then selects the text and offers a download.
 */
export async function copyText(
  text: string,
  clipboard: Pick<Clipboard, 'writeText'> | undefined = globalThis.navigator?.clipboard,
): Promise<boolean> {
  if (!clipboard || typeof clipboard.writeText !== 'function') return false;
  try {
    await clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}
