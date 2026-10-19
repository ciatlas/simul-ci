import { type RefObject, useEffect, useRef } from 'react';

/**
 * A native `<dialog>` opened as a modal when it mounts: the browser traps the focus in it and gives the focus back on
 * close. Escape, a Close button calling `close()` and anything else that closes it end in the native `close` event,
 * which calls `onClose`.
 */
export function useModal(onClose: () => void): RefObject<HTMLDialogElement | null> {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const d = dialog.current;
    if (!d) return undefined;
    if (!d.open) d.showModal();
    const close = (): void => onClose();
    d.addEventListener('close', close);
    return () => d.removeEventListener('close', close);
  }, [onClose]);
  return dialog;
}
